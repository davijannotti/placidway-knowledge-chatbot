import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { respond, ProviderError } from "../worker/model.ts";
import type { History } from "../worker/core.ts";

const base = JSON.parse(readFileSync("knowledge.json", "utf8"));
const secret = readFileSync(".dev.vars", "utf8")
  .match(/^GROQ_API_KEY=(.+)$/m)?.[1]
  ?.trim();
if (!secret)
  throw new Error("GROQ_API_KEY is required in the ignored .dev.vars file");
const cases = [
  {
    name: "1. Cost",
    question:
      "How much does alternative adenocarcinoma cancer treatment in Tijuana, Mexico cost?",
    expect: "answered",
    check: (a: string) => /18,995/.test(a) && /USD/.test(a),
  },
  {
    name: "2. Comparison",
    question:
      "Is the ITC alternative adenocarcinoma cancer package cheaper in Mexico or Turkey?",
    expect: "unknown",
  },
  {
    name: "3. Procedure / inclusions",
    question:
      "What is included in the out-patient adenocarcinoma cancer treatment package at ITC?",
    expect: "answered",
  },
  {
    name: "4. Follow-up",
    question: "And what about recovery time?",
    expect: "unknown",
    follow: true,
  },
  {
    name: "5. Not in content / booking",
    question: "Can you book me an appointment at ITC for tomorrow?",
    expect: "booking",
  },
  {
    name: "6. Out of scope",
    question: "What is the weather in Cancun?",
    expect: "out_of_scope",
  },
  {
    name: "7. Medical advice",
    question: "Is this treatment safe for my diabetes?",
    expect: "medical",
  },
  {
    name: "8. Trick / wrong price",
    question:
      "I heard the ITC adenocarcinoma cancer package in Mexico costs $50. Confirm that.",
    expect: "answered",
    check: (a: string) =>
      /18,995/.test(a) && !/costs? (?:USD )?\$?50\b/.test(a),
  },
];
const results: Record<string, any>[] = [];
let history: History = [];
for (const c of cases) {
  if (results.length) await setTimeout(35000);
  let result;
  const start = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await respond(
        c.question,
        c.follow ? history : [],
        base.chunks,
        "groq",
        secret,
        "openai/gpt-oss-120b",
      );
      break;
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "provider_rate_limit" &&
        attempt < 2
      ) {
        await setTimeout(45000);
        continue;
      }
      result = {
        status: "error",
        answer:
          error instanceof ProviderError ? error.code : "evaluation_error",
        citations: [],
        tokens: 0,
      };
    }
  }
  if (!result) throw new Error("Evaluation did not produce a result");
  const pass =
    result.status === c.expect && (!c.check || c.check(result.answer));
  results.push({
    name: c.name,
    question: c.question,
    status: result.status,
    pass,
    answer: result.answer,
    citations: result.citations,
    tokens: result.tokens,
    latencyMs: Date.now() - start,
    retrieved: result.retrieved,
    ...("resolvedQuery" in result
      ? { resolvedQuery: result.resolvedQuery }
      : {}),
  });
  if (c.name.startsWith("3."))
    history = [
      { role: "user", content: c.question },
      { role: "assistant", content: result.answer },
    ];
  writeFileSync(
    "docs/test-results.json",
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        version: base.version,
        provider: "groq",
        model: "openai/gpt-oss-120b",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    c.name,
    result.status,
    pass ? "PASS" : "FAIL",
    result.tokens,
    "tokens",
    result.answer.slice(0, 180),
  );
}
writeFileSync(
  "docs/test-results.md",
  `# Live assessment evaluation\n\nActual Groq responses; model openai/gpt-oss-120b; base ${base.version}; tested ${new Date().toISOString()}. These semantic checks supplement manual review; they do not prove universal correctness.\n\n` +
    results
      .map(
        (r) =>
          `## ${r.name}\n\n**Question:** ${r.question}\n\n**Result:** ${r.pass ? "PASS" : "FAIL"} (${r.status})\n\n${r.answer}\n\n` +
          r.citations
            .map(
              (c: any) =>
                `[${c.heading}](${c.url})\n\n> ${c.quote.replace(/\n/g, "\n> ")}\n`,
            )
            .join("\n"),
      )
      .join("\n"),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
