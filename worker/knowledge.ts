import bundled from "../knowledge.json" with { type: "json" };

const snapshotUrl =
  "https://raw.githubusercontent.com/davijannotti/placidway-knowledge-chatbot/main/knowledge.json";

export function validSnapshot(value: unknown): value is typeof bundled {
  const data = value as typeof bundled;
  if (
    !data ||
    typeof data.version !== "string" ||
    !/^[a-f0-9]{16}$/.test(data.version) ||
    typeof data.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !Array.isArray(data.sources) ||
    data.sources.length !== 7 ||
    !Array.isArray(data.chunks) ||
    data.chunks.length < 7 ||
    data.chunks.length > 600
  )
    return false;
  if (
    !bundled.sources.every((s) =>
      data.sources.some(
        (d) =>
          d && d.id === s.id && d.url === s.url && typeof d.title === "string",
      ),
    )
  )
    return false;
  const ids = new Set<string>();
  for (const c of data.chunks) {
    if (
      !c ||
      typeof c.id !== "string" ||
      ids.has(c.id) ||
      !bundled.sources.some((s) => s.id === c.sourceId && s.url === c.url) ||
      ![c.text, c.title, c.heading].every(
        (x) => typeof x === "string" && x.length > 0 && x.length <= 10000,
      )
    )
      return false;
    ids.add(c.id);
  }
  return bundled.sources.every((s) =>
    data.chunks.some((c) => c.sourceId === s.id),
  );
}

export async function loadKnowledge(ctx: ExecutionContext) {
  const key = new Request(snapshotUrl);
  try {
    const cached = await caches.default.match(key);
    if (cached) {
      const data = await cached.json();
      if (validSnapshot(data)) return { data, bundledFallback: false };
    }
    const response = await fetch(snapshotUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("snapshot_unavailable");
    const text = await response.text();
    if (text.length > 500000) throw new Error("snapshot_too_large");
    const data = JSON.parse(text);
    if (!validSnapshot(data)) throw new Error("snapshot_invalid");
    ctx.waitUntil(
      caches.default
        .put(
          key,
          new Response(text, {
            headers: {
              "Cache-Control": "public, max-age=300",
              "Content-Type": "application/json",
            },
          }),
        )
        .catch(() => {}),
    );
    return { data, bundledFallback: false };
  } catch {
    return { data: bundled, bundledFallback: true };
  }
}
