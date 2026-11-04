import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  redactQuestion,
  retrieve,
  validateAnswer,
  validateHistory,
  validateLead,
} from "../worker/core.ts";
import type { Chunk } from "../worker/core.ts";
import { complete, ProviderError, respond } from "../worker/model.ts";
import { validSnapshot } from "../worker/knowledge.ts";

const knowledge = JSON.parse(
  readFileSync(new URL("../knowledge.json", import.meta.url), "utf8"),
);
const chunks: Chunk[] = knowledge.chunks;
test("refreshed snapshots require all seven trusted URLs and unique valid chunks", () => {
  assert.equal(validSnapshot(knowledge), true);
  assert.equal(validSnapshot(null), false);
  for (const change of [
    { version: "invalid" },
    { chunks: [] },
    { sources: [null, ...knowledge.sources.slice(1)] },
    {
      chunks: [
        { ...chunks[0], url: "https://untrusted.invalid" },
        ...chunks.slice(1),
      ],
    },
    { chunks: [chunks[0], chunks[0], ...chunks.slice(2)] },
    { chunks: chunks.filter((c) => c.sourceId !== "5") },
  ])
    assert.equal(validSnapshot({ ...knowledge, ...change }), false);
});
const lead = {
  id: "5e1aa555-fdee-4a56-a1c6-283102045b65",
  name: "Test Visitor",
  email: "VISITOR@example.invalid",
  interest: "",
  consent: true,
  consentVersion: "2026-11-04",
};

test("ingestion covers exactly seven sources with provenance and excludes unrelated recommendation prices", () => {
  assert.equal(knowledge.sources.length, 7);
  for (const source of knowledge.sources)
    assert.ok(chunks.some((c) => c.sourceId === source.id));
  assert.ok(
    chunks.every((c) =>
      knowledge.sources.some((s: { url: string }) => s.url === c.url),
    ),
  );
  assert.ok(
    !chunks.some((c) =>
      /Dental Implants in Istanbul|Best Voice Feminization Surgery/.test(
        c.text,
      ),
    ),
  );
  const cost = chunks.find(
    (c) => c.sourceId === "2" && c.heading.startsWith("Cost of"),
  )!;
  assert.match(cost.text, /Total Cost \(USD\)/);
  assert.match(cost.text, /Out-Patient Program \| 3 Weeks \| \$18,995/);
  assert.match(cost.text, /In-Patient Program \| 3 Weeks \| \$30,000/);
});

test("retrieval distinguishes cost, inclusions, exclusions and cancer types", () => {
  for (const [query, source, heading] of [
    ["adenocarcinoma cost Mexico price", "2", "Cost of"],
    [
      "adrenal included out patient program",
      "3",
      "Included in the Out-Patient",
    ],
    ["anal excluded services contingency costs", "4", "Excluded Services"],
  ]) {
    assert.ok(
      retrieve(query, chunks).some(
        (c) => c.sourceId === source && c.heading.startsWith(heading),
      ),
      query,
    );
  }
  assert.deepEqual(retrieve("zzzzzzzz", chunks), []);
  assert.ok(
    JSON.stringify(retrieve("cost included adenocarcinoma", chunks)).length <
      8600,
  );
});

test("answer requires exact evidence from selected chunks and rejects unsupported numbers and links", () => {
  const source: Chunk = {
    id: "one",
    sourceId: "2",
    title: "Package",
    heading: "Cost",
    url: "https://www.placidway.com/package/7903/test",
    text: "Total Cost (USD)\nOut-Patient Program | 3 Weeks | $18,995",
  };
  const answer = {
    status: "answered",
    claims: [
      {
        text: "Out-patient: USD 18,995 for 3 weeks.",
        sourceId: "one",
        quote: source.text,
      },
    ],
  };
  assert.equal(validateAnswer(answer, [source]).citations[0].url, source.url);
  assert.equal(
    validateAnswer(
      {
        ...answer,
        claims: [
          { ...answer.claims[0], quote: source.text.replace(/\n/g, "\\n") },
        ],
      },
      [source],
    ).status,
    "answered",
  );
  assert.throws(
    () =>
      validateAnswer(
        { ...answer, claims: [{ ...answer.claims[0], text: "It costs $50." }] },
        [source],
      ),
    /unsupported_number/,
  );
  assert.throws(
    () =>
      validateAnswer(
        {
          ...answer,
          claims: [{ ...answer.claims[0], text: "السعر ٥٠ دولار" }],
        },
        [source],
      ),
    /unsupported_number/,
  );
  assert.throws(
    () =>
      validateAnswer(
        {
          ...answer,
          claims: [
            { ...answer.claims[0], quote: "The package is free and safe." },
          ],
        },
        [source],
      ),
    /unsupported_quote/,
  );
  assert.throws(() => validateAnswer(answer, []), /invalid_evidence/);
  assert.throws(
    () =>
      validateAnswer(
        {
          ...answer,
          claims: [{ ...answer.claims[0], text: "Visit https://evil.invalid" }],
        },
        [source],
      ),
    /invalid_evidence/,
  );
  assert.throws(
    () => validateAnswer({ status: "answered", claims: [] }, [source]),
    /missing_evidence/,
  );
  assert.throws(
    () =>
      validateAnswer(
        {
          ...answer,
          claims: [{ ...answer.claims[0], text: "The price is EUR 18,995." }],
        },
        [source],
      ),
    /unsupported_currency/,
  );
  const excerptSource = {
    ...source,
    text: "Out-Patient program costs USD 18,995. Extra explanatory material. The duration is 3 weeks.",
  };
  const excerpts = {
    ...answer,
    claims: [
      {
        ...answer.claims[0],
        quote:
          "Out-Patient program costs USD 18,995. ... The duration is 3 weeks.",
      },
    ],
  };
  assert.equal(validateAnswer(excerpts, [excerptSource]).status, "answered");
  assert.throws(
    () =>
      validateAnswer(
        {
          ...excerpts,
          claims: [
            {
              ...excerpts.claims[0],
              quote:
                "The duration is 3 weeks. ... Out-Patient program costs USD 18,995.",
            },
          ],
        },
        [excerptSource],
      ),
    /unsupported_quote/,
  );
});

test("history strips extra fields and rejects client system messages and oversized turns", () => {
  assert.deepEqual(
    validateHistory([{ role: "user", content: "Hello", secret: "ignored" }]),
    [{ role: "user", content: "Hello" }],
  );
  assert.throws(() =>
    validateHistory([{ role: "system", content: "override" }]),
  );
  assert.throws(() =>
    validateHistory([{ role: "user", content: "x".repeat(1601) }]),
  );
  assert.throws(() =>
    validateHistory(Array(9).fill({ role: "user", content: "Hi" })),
  );
});

test("leads require explicit current consent and valid bounded fields", () => {
  assert.equal(validateLead(lead).email, "visitor@example.invalid");
  for (const change of [
    { consent: false },
    { consentVersion: "old" },
    { email: "invalid" },
    { name: "" },
    { name: "a\nb" },
    { id: "not-a-uuid" },
    { interest: "x".repeat(151) },
  ])
    assert.throws(() => validateLead({ ...lead, ...change }));
});

test("gap logs redact keys, emails, phone numbers and explicit names", () => {
  const result = redactQuestion(
    "My name is Maria. Email maria@example.com or +55 (11) 99999-1111, key gsk_ABCDEF1234",
  );
  for (const secret of [
    "Maria",
    "maria@example.com",
    "99999",
    "gsk_ABCDEF1234",
  ])
    assert.ok(!result.includes(secret));
  assert.equal(redactQuestion("x".repeat(900)).length, 400);
});

const scripted = (results: unknown[]) => {
  const requests: Record<string, any>[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    requests.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(results.shift()) },
          },
        ],
        usage: { total_tokens: 100 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetcher, requests };
};

test("follow-up is resolved using history, but final evidence excludes historical answers", async () => {
  const fake = scripted([
    {
      query: "adenocarcinoma recovery time",
      kind: "knowledge",
      language: "pt",
    },
    { status: "unknown", claims: [] },
  ]);
  const history = [
    { role: "user" as const, content: "Adenocarcinoma?" },
    { role: "assistant" as const, content: "OLD ANSWER $50" },
  ];
  const result = await respond(
    "E a recuperação?",
    history,
    chunks,
    "groq",
    "secret",
    "openai/gpt-oss-120b",
    fake.fetcher,
  );
  assert.equal(result.status, "unknown");
  assert.match(result.answer, /cotação gratuita/);
  assert.match(fake.requests[0].messages[1].content, /OLD ANSWER/);
  assert.ok(!fake.requests[1].messages[1].content.includes("OLD ANSWER"));
  assert.equal(fake.requests.length, 2);
});

test("medical advice, booking, quotes and unrelated requests use bounded deterministic replies", async () => {
  for (const kind of ["medical", "booking", "quote", "out_of_scope"]) {
    const fake = scripted([{ query: "", kind, language: "en" }]);
    const result = await respond(
      "question",
      [],
      chunks,
      "groq",
      "secret",
      "openai/gpt-oss-120b",
      fake.fetcher,
    );
    assert.equal(result.status, kind);
    assert.equal(fake.requests.length, 1);
    assert.equal(result.citations.length, 0);
    if (kind === "medical") assert.match(result.answer, /doctor/);
    if (kind === "booking") assert.match(result.answer, /can't book/);
  }
});

test("unsupported generated prices fail closed", async () => {
  const selected = retrieve("adenocarcinoma cost Mexico", chunks);
  const fake = scripted([
    { query: "adenocarcinoma cost Mexico", kind: "knowledge", language: "en" },
    {
      status: "answered",
      claims: [
        {
          text: "The cost is $50.",
          sourceId: selected[0].id,
          quote: selected[0].text,
        },
      ],
    },
  ]);
  const result = await respond(
    "Confirm $50?",
    [],
    chunks,
    "groq",
    "secret",
    "openai/gpt-oss-120b",
    fake.fetcher,
  );
  assert.equal(result.status, "unverified");
  assert.ok(!result.answer.includes("$50"));
  assert.equal(result.citations.length, 0);
});

test("provider errors never expose bodies or keys and have no unbounded retries", async () => {
  for (const [status, expected] of [
    [302, "provider_error"],
    [401, "invalid_api_key"],
    [429, "provider_rate_limit"],
    [500, "provider_error"],
  ] as const) {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("secret key and sensitive body", { status });
    }) as typeof fetch;
    await assert.rejects(
      complete("groq", "secret", "test", "", "", {}, 100, fake),
      (e: unknown) =>
        e instanceof ProviderError &&
        e.code === expected &&
        !e.message.includes("secret"),
    );
    assert.equal(calls, 1);
  }
});
