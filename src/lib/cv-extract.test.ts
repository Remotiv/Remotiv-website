/**
 * CV extraction failure classes (lib/cv-extract.ts): each kind of provider
 * failure comes back with its own reason, a success is unchanged, and the
 * null-returning wrapper still behaves as before. The Anthropic client is a
 * fake installed here; nothing leaves the machine.
 *
 *   node --test src/lib/cv-extract.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "server-only": "export {};",
  "@/lib/anthropic": `export const AI_MATCHING_MODEL = "claude-haiku-5-5";
export function getAnthropic() {
  const client = globalThis.__extractFakeAnthropic;
  if (!client) throw new Error("ANTHROPIC_API_KEY is not set");
  return client;
}`,
};
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { extractTalentFields, extractTalentFieldsFromCv } = await import("./cv-extract.ts");
console.error = () => {};

const CV = "Jane Example, senior engineer with eight years of TypeScript and Postgres.";
const GOOD = JSON.stringify({
  applicant_job_title: "Senior Engineer",
  role_category: "Engineering",
  years_experience: 8,
  degree: null,
  institution: null,
  city: "Lahore",
  country: "Pakistan",
  summary: "Eight years of TypeScript.",
  availability: "Available Now",
  work_type: "Full-time",
  notice_period: "1 Month",
  work_location: "Remote",
  skills: ["TypeScript", "Postgres"],
  employment_history: [],
});

/** A fake client that answers with `content` or throws `error`. `null` removes the client (missing key). */
function fakeModel({ content, error } = {}) {
  globalThis.__extractFakeAnthropic = {
    messages: {
      create: async () => {
        if (error) throw error;
        return { content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
}
const text = (t) => ({ type: "text", text: t });
const httpError = (status, message = "provider said no") =>
  Object.assign(new Error(message), { status });

test("success is unchanged: sanitised fields, and the wrapper returns them too", async () => {
  fakeModel({ content: [text(GOOD)] });
  const r = await extractTalentFields(CV);
  assert.equal(r.ok, true);
  assert.equal(r.fields.applicant_job_title, "Senior Engineer");
  assert.deepEqual(r.fields.skills, ["TypeScript", "Postgres"]);
  assert.equal((await extractTalentFieldsFromCv(CV)).applicant_job_title, "Senior Engineer");
});

test("a thinking block before the text still succeeds", async () => {
  fakeModel({ content: [{ type: "thinking", thinking: "", signature: "s" }, text(GOOD)] });
  assert.equal((await extractTalentFields(CV)).ok, true);
});

test("each failure has its own reason; the wrapper gives null for all of them", async () => {
  const cases = [
    ["no text", { content: [text(GOOD)] }, "", "no_text"],
    ["missing key", null, CV, "no_key"],
    ["401", { error: httpError(401, "invalid x-api-key") }, CV, "no_key"],
    ["403", { error: httpError(403, "forbidden") }, CV, "no_key"],
    ["402", { error: httpError(402, "payment required") }, CV, "billing"],
    [
      "400 about credit",
      { error: httpError(400, "Your credit balance is too low") },
      CV,
      "billing",
    ],
    ["429 about quota", { error: httpError(429, "insufficient_quota") }, CV, "billing"],
    [
      "429 rate limit",
      { error: httpError(429, "rate limit exceeded") },
      CV,
      "rate_limited_or_overloaded",
    ],
    ["529 overloaded", { error: httpError(529, "overloaded") }, CV, "rate_limited_or_overloaded"],
    [
      "timeout (AbortError)",
      { error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }) },
      CV,
      "timeout",
    ],
    ["timeout (SDK message)", { error: new Error("Request timed out.") }, CV, "timeout"],
    [
      "404 retired model",
      { error: httpError(404, "model: claude-haiku-4-5-20251001 not found") },
      CV,
      "model_error",
    ],
    ["500", { error: httpError(500, "internal") }, CV, "model_error"],
    ["network error, no status", { error: new Error("fetch failed") }, CV, "model_error"],
    ["empty reply", { content: [text("")] }, CV, "bad_reply"],
    [
      "thinking-only reply",
      { content: [{ type: "thinking", thinking: "", signature: "s" }] },
      CV,
      "bad_reply",
    ],
    ["non-JSON reply", { content: [text("Sure! Here is the profile: {name:")] }, CV, "bad_reply"],
  ];
  for (const [name, model, input, expected] of cases) {
    if (model === null) globalThis.__extractFakeAnthropic = undefined;
    else fakeModel(model);
    const r = await extractTalentFields(input);
    assert.deepEqual(r, { ok: false, reason: expected }, name);
    assert.equal(await extractTalentFieldsFromCv(input), null, `${name}: wrapper`);
  }
});

test("the failure classes are exactly the seven the admin screens know", async () => {
  const seen = new Set();
  for (const model of [
    { error: httpError(401) },
    { error: httpError(402) },
    { error: httpError(429) },
    { error: new Error("Request timed out.") },
    { error: httpError(404) },
    { content: [text("not json")] },
  ]) {
    fakeModel(model);
    seen.add((await extractTalentFields(CV)).reason);
  }
  seen.add((await extractTalentFields("")).reason);
  assert.deepEqual([...seen].sort(), [
    "bad_reply",
    "billing",
    "model_error",
    "no_key",
    "no_text",
    "rate_limited_or_overloaded",
    "timeout",
  ]);
});
