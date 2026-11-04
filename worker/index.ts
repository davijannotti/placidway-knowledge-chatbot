import { loadKnowledge } from "./knowledge.ts";
import { redactQuestion, validateHistory, validateLead } from "./core.ts";
import { ProviderError, providers, respond } from "./model.ts";
import type { Provider } from "./model.ts";

export interface Env {
  DB: D1Database;
  GROQ_API_KEY?: string;
  RATE_SALT: string;
  ALLOWED_ORIGIN: string;
  GROQ_MODEL?: string;
  SHARED_DAILY_LIMIT?: string;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("invalid_content_type");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 24000) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  const body = JSON.parse(new TextDecoder().decode(all));
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("invalid_body");
  return body;
}

async function ipHash(request: Request, salt: string) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      salt + ":" + ip + ":" + new Date().toISOString().slice(0, 10),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function reserve(
  db: D1Database,
  bucket: string,
  limit: number,
  expires: number,
) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(bucket,count,expires) VALUES(?1,1,?3)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ?2 RETURNING count`,
    )
    .bind(bucket, limit, expires)
    .first();
  return Boolean(row);
}

async function limitIP(request: Request, env: Env, route: string) {
  const hash = await ipHash(request, env.RATE_SALT);
  const now = Math.floor(Date.now() / 1000);
  const minute = Math.floor(now / 60),
    hour = Math.floor(now / 3600);
  const results = await Promise.all([
    reserve(
      env.DB,
      `${route}:${hash}:m:${minute}`,
      route === "chat" ? 6 : 3,
      (minute + 1) * 60,
    ),
    reserve(
      env.DB,
      `${route}:${hash}:h:${hour}`,
      route === "chat" ? 40 : 8,
      (hour + 1) * 3600,
    ),
  ]);
  if (!results.every(Boolean)) throw new ProviderError("request_limit", 429);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGIN || "").split(",");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      Vary: "Origin",
      ...(origin && allowed.includes(origin)
        ? { "Access-Control-Allow-Origin": origin }
        : {}),
    };
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (origin && !allowed.includes(origin))
      return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    const path = new URL(request.url).pathname;
    const snapshot =
      path === "/chat" || path === "/health" ? await loadKnowledge(ctx) : null;
    const knowledge = snapshot?.data;
    if (path === "/health" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return json({
          ok: true,
          version: knowledge!.version,
          fetchedAt: knowledge!.fetchedAt,
          bundledFallback: snapshot!.bundledFallback,
          sharedKeyConfigured: Boolean(env.GROQ_API_KEY),
          sources: knowledge!.sources,
        });
      } catch {
        return json({ error: "database_unavailable" }, 503);
      }
    }
    if (!["/chat", "/leads"].includes(path))
      return json({ error: "not_found" }, 404);
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    const start = Date.now(),
      id = crypto.randomUUID();
    let provider: Provider = "groq",
      model = env.GROQ_MODEL || providers.groq.model;
    let question = "";
    const log = (
      outcome: string,
      sourceIds: string[],
      tokens: number,
      error: string | null = null,
    ) => {
      if (path !== "/chat") return;
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO events(id,outcome,gap_question,source_ids,base_version,provider,model,latency_ms,tokens,error_code)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
        )
          .bind(
            id,
            outcome,
            ["unknown", "unverified"].includes(outcome)
              ? redactQuestion(question)
              : null,
            JSON.stringify(sourceIds),
            knowledge!.version,
            provider,
            model,
            Date.now() - start,
            tokens,
            error,
          )
          .run()
          .catch(() => {
            /* Do not expose or log request bodies on database failure. */
          }),
      );
    };
    try {
      const body = await readBody(request);
      if (path === "/leads") {
        const lead = validateLead(body);
        await limitIP(request, env, "lead");
        const result = await env.DB.prepare(
          `INSERT INTO leads(id,name,email,interest,consent_version) VALUES(?1,?2,?3,?4,'2026-11-04') ON CONFLICT(id) DO NOTHING`,
        )
          .bind(lead.id, lead.name, lead.email, lead.interest)
          .run();
        return json(
          {
            id: lead.id,
            status: "recorded_in_demo",
            forwardedToPlacidWay: false,
          },
          result.meta.changes ? 201 : 200,
        );
      }
      if (
        typeof body.question !== "string" ||
        !body.question.trim() ||
        body.question.length > 1600
      )
        return json({ error: "invalid_question" }, 400);
      question = body.question.trim();
      const history = validateHistory(body.history ?? []);
      if (
        body.provider !== undefined &&
        !Object.hasOwn(providers, String(body.provider))
      )
        return json({ error: "invalid_provider" }, 400);
      provider = (body.provider || "groq") as Provider;
      const ownKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (
        (body.apiKey !== undefined && typeof body.apiKey !== "string") ||
        ownKey.length > 512 ||
        /[\r\n]/.test(ownKey)
      )
        return json({ error: "invalid_api_key" }, 400);
      if (
        body.model !== undefined &&
        (typeof body.model !== "string" ||
          !/^[a-zA-Z0-9._:/-]{1,120}$/.test(body.model))
      )
        return json({ error: "invalid_model" }, 400);
      if (!ownKey && (provider !== "groq" || body.model))
        return json({ error: "own_key_required" }, 400);
      model = ownKey
        ? String(body.model || providers[provider].model)
        : env.GROQ_MODEL || providers.groq.model;
      const key = ownKey || env.GROQ_API_KEY;
      if (!key) return json({ error: "configuration_required" }, 503);
      await limitIP(request, env, "chat");
      if (!ownKey) {
        const day = Math.floor(Date.now() / 86400000);
        if (
          !(await reserve(
            env.DB,
            `shared:${day}`,
            Number(env.SHARED_DAILY_LIMIT || 40),
            (day + 1) * 86400,
          ))
        )
          throw new ProviderError("shared_quota_exhausted", 429);
      }
      const result = await respond(
        question,
        history,
        knowledge!.chunks,
        provider,
        key,
        model,
      );
      log(result.status, result.retrieved, result.tokens);
      return json({
        ...result,
        requestId: id,
        version: knowledge!.version,
        fetchedAt: knowledge!.fetchedAt,
        bundledFallback: snapshot!.bundledFallback,
        contactUrl: knowledge!.sources[0].url,
        showQuoteForm: ["unknown", "unverified", "quote", "booking"].includes(
          result.status,
        ),
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        log("error", [], 0, error.code);
        return json({ error: error.code, requestId: id }, error.status);
      }
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          /^(invalid_|consent_required|body_too_large)/.test(error.message))
      )
        return json({ error: "invalid_request" }, 400);
      log("error", [], 0, "service_unavailable");
      return json({ error: "service_unavailable", requestId: id }, 503);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare(
          "DELETE FROM leads WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')",
        ),
        env.DB.prepare(
          "DELETE FROM events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')",
        ),
        env.DB.prepare("DELETE FROM rate_limits WHERE expires < ?1").bind(
          Math.floor(Date.now() / 1000),
        ),
      ]),
    );
  },
};
