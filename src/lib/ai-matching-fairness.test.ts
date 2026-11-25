/**
 * #71 for AI talent matching: the ranking prompt carries the shared fairness
 * rules, the model is never sent a candidate's name (the id and the location
 * stay), and the result cache is keyed by the prompt's version so a ranking
 * made before a prompt change is never served after it.
 *
 *   node --test src/lib/ai-matching-fairness.test.ts
 *
 * rankWithClaude runs as shipped against a fake model client that records
 * what it was sent (the same stubs as ai/assist-model.test.ts). Synthetic.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
const MODEL = readFileSync(new URL("./anthropic.ts", import.meta.url), "utf8").match(
  /export const AI_MATCHING_MODEL = "([^"]+)"/,
)[1];
const STUBS = {
  "server-only": "export {};",
  "@/lib/anthropic": `export const AI_MATCHING_MODEL = ${JSON.stringify(MODEL)};
export function getAnthropic() { return globalThis.__matchFakeAnthropic; }`,
  "@/lib/supabase/server": `export function createServiceClient() {
  throw new Error("test: the database must not be reached");
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

const { MATCHING_PROMPT_VERSION, matchCacheKey, normalizeQuery, rankWithClaude } = await import(
  "./ai-matching.ts"
);
const { FAIRNESS_RULES } = await import("./ai/fairness.ts");
process.env.ANTHROPIC_API_KEY ??= "test-key-never-sent";

const CANDIDATE = {
  id: "c0ffee00-0000-4000-8000-000000000071",
  first_name: "Zarnigar",
  last_name: "Khattak-Abernethy",
  job_title: "Backend Developer",
  role_category: "Engineering",
  skills: ["Python", "Postgres"],
  city: "Lahore",
  country: "Pakistan",
  years_experience: 6,
  summary: "Builds payment services.",
  availability: null,
  work_type: null,
  email: "zarnigar@example.test",
  phone: "+920000000000",
  cv_url: null,
  cv_path: null,
  github_url: null,
  linkedin_url: null,
  avatar_url: null,
  status: "approved",
  salary_min: null,
  salary_max: null,
};

async function sent() {
  const requests = [];
  globalThis.__matchFakeAnthropic = {
    messages: {
      create: async (params) => {
        requests.push(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { candidate_id: CANDIDATE.id, match_percent: 80, why: "Python" },
              ]),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const out = await rankWithClaude("python developer in lahore", [CANDIDATE]);
  assert.equal(out.ok, true);
  assert.equal(requests.length, 1);
  return requests[0];
}

// Negative control: put the `name:` line back in candidateSummaryForPrompt
// and this test fails.
test("the model is never sent a candidate's name; the id and the location stay", async () => {
  const req = await sent();
  const payload = JSON.stringify({ system: req.system, messages: req.messages });
  for (const part of [CANDIDATE.first_name, CANDIDATE.last_name, "name:"]) {
    assert.ok(!payload.includes(part), `the prompt does not contain ${JSON.stringify(part)}`);
  }
  for (const contact of [CANDIDATE.email, CANDIDATE.phone]) {
    assert.ok(!payload.includes(contact), "no contact detail either");
  }
  const user = req.messages[0].content;
  assert.ok(user.includes(`id: ${CANDIDATE.id}`), "the id, so the answer can be joined back");
  assert.ok(user.includes("location: Lahore, Pakistan"), "the location stays");
});

test("the ranking prompt carries the shared fairness rules, whole", async () => {
  const req = await sent();
  assert.ok(req.system.includes(FAIRNESS_RULES));
});

// Negative control: drop MATCHING_PROMPT_VERSION from matchCacheKey (or the
// route back to its own key) and this test fails.
test("the cache key starts with the prompt version, so pre-fairness rankings are never reused", () => {
  assert.equal(MATCHING_PROMPT_VERSION, "matching-v2");
  const q = normalizeQuery("  Python   Developer ");
  assert.equal(matchCacheKey(q, null), "matching-v2:python developer");
  assert.equal(matchCacheKey(q, "user-1"), "matching-v2:python developer:user-1");
  assert.notEqual(matchCacheKey(q, null), q, "never the bare query of the old keys");
  const route = readFileSync(new URL("../app/api/ai-matching/route.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /const cacheKey = matchCacheKey\(normalized, tier === "subscriber" \? userId : null\);/,
    "the route builds its key only through matchCacheKey",
  );
  assert.equal((route.match(/getCached\(cacheKey\)|setCached\(cacheKey,/g) ?? []).length, 2);
});
