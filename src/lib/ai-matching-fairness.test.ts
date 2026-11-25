/**
 * #71 for AI talent matching: the ranking prompt carries the shared fairness
 * rules, the model is never sent a candidate's name (the id and the location
 * stay), the free-text summary reaches it with their name, emails and phone
 * numbers removed, and the result cache is keyed by the prompt's version so a
 * ranking made before a prompt change is never served after it.
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

const {
  MATCHING_PROMPT_VERSION,
  matchCacheKey,
  normalizeQuery,
  rankWithClaude,
  redactSummaryForPrompt,
} = await import("./ai-matching.ts");
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

async function sent(candidate = CANDIDATE) {
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
                { candidate_id: candidate.id, match_percent: 80, why: "Python" },
              ]),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const out = await rankWithClaude("python developer in lahore", [candidate]);
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
  assert.equal(MATCHING_PROMPT_VERSION, "matching-v3");
  const q = normalizeQuery("  Python   Developer ");
  assert.equal(matchCacheKey(q, null), "matching-v3:python developer");
  assert.equal(matchCacheKey(q, "user-1"), "matching-v3:python developer:user-1");
  assert.notEqual(matchCacheKey(q, null), q, "never the bare query of the old keys");
  const route = readFileSync(new URL("../app/api/ai-matching/route.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /const cacheKey = matchCacheKey\(normalized, tier === "subscriber" \? userId : null\);/,
    "the route builds its key only through matchCacheKey",
  );
  assert.equal((route.match(/getCached\(cacheKey\)|setCached\(cacheKey,/g) ?? []).length, 2);
});

/* ── the summary: the candidate writes it freely ─────────────── */

// Negative control: send c.summary as it is (skip redactSummaryForPrompt in
// candidateSummaryForPrompt) and this test fails.
test("the summary reaches the model without the candidate's name, any email or any phone number; the evidence stays", async () => {
  const req = await sent({
    ...CANDIDATE,
    summary:
      "I am Zarnigar KHATTAK-ABERNETHY. zarnigar has 6 years of Python (2019-2023 at Acme). " +
      "Khattak led the Zarnigarh office move. Email zarnigar.k@example.test or z@mail.example.test, " +
      "call +92 300 1234567 or 0300-1234567.",
  });
  const user = req.messages[0].content;
  const summaryLine = user.split("\n").find((l) => l.startsWith("summary: "));
  for (const gone of [
    "Zarnigar ",
    "zarnigar has",
    "KHATTAK-ABERNETHY",
    "Khattak led",
    "zarnigar.k@example.test",
    "z@mail.example.test",
    "+92 300 1234567",
    "0300-1234567",
  ]) {
    assert.ok(!summaryLine.includes(gone), `removed: ${gone}`);
  }
  for (const kept of ["6 years of Python", "2019-2023", "Acme", "Zarnigarh office"]) {
    assert.ok(summaryLine.includes(kept), `kept: ${kept}`);
  }
  assert.match(summaryLine, /\[removed\] has 6 years/);
});

test("redactSummaryForPrompt: whole words only, any case, Unicode names; job figures that look numeric stay", () => {
  const person = { first_name: "Zoë", last_name: "van der Berg" };
  assert.equal(
    redactSummaryForPrompt("ZOË and zoë, not Zoëtrope; Berg and van der Berg", person),
    "[removed] and [removed], not Zoëtrope; [removed] and [removed]",
  );
  assert.equal(
    redactSummaryForPrompt("Raised 1500000 PKR; 2015-2019 then 2020-2023; 12 years", person),
    "Raised 1500000 PKR; 2015-2019 then 2020-2023; 12 years",
    "a figure, year ranges and a count are not phone numbers",
  );
  assert.equal(
    redactSummaryForPrompt("Call (042) 3571-2345 today", person),
    "Call [removed] today",
  );
  assert.equal(
    redactSummaryForPrompt("Ali and Al wrote it", { first_name: "Al", last_name: null }),
    "Ali and [removed] wrote it",
  );
  assert.equal(
    redactSummaryForPrompt("A summary", { first_name: null, last_name: "" }),
    "A summary",
    "no name, nothing removed",
  );
});

// Negative control: judge each DIGIT_RUN whole again (`(run) => (phoneLike(run)
// ? REDACTED : run)` in place of phonesIn) and this test fails: two numbers
// side by side make one run of more digits than any phone, and both are kept.
test("phone numbers side by side are each removed; years, ranges and figures next to them stay", () => {
  const none = { first_name: null, last_name: null };
  const r = (s) => redactSummaryForPrompt(s, none);
  assert.equal(r("Call 0300-1234567 0321-7654321 now"), "Call [removed] [removed] now");
  assert.equal(r("Call +92 300 1234567 +92 321 7654321 now"), "Call [removed] [removed] now");
  assert.equal(r("Call 0300 1234567 or +92 321 7654321"), "Call [removed] or [removed]");
  assert.equal(r("Worked 2019-2023 0300-1234567 here"), "Worked 2019-2023 [removed] here");
  assert.equal(r("Worked 2019 - 2023 then 0300-1234567"), "Worked 2019 - 2023 then [removed]");
  assert.equal(r("0300-1234567 2019-2023"), "[removed] 2019-2023");
  // A new number starts at "0" or "+", even when the 15-digit cap would let
  // it join: without that, "0300" joins the first number and "7654321" leaks.
  assert.equal(r("Call 0300 1234567 0300 7654321 now"), "Call [removed] [removed] now");
  assert.equal(r("Call +92 300 1234567 +92 3217654 now"), "Call [removed] [removed] now");
  // A year never joins a number: without that, the range is removed with it.
  assert.equal(r("Worked 2019-2023 300 1234567"), "Worked 2019-2023 [removed]");
  assert.equal(r("Since 2019 3001234567 is mine"), "Since 2019 [removed] is mine");
  assert.equal(
    r("Managed 15000000000000000 PKR and 1500000 PKR over 12 years"),
    "Managed 15000000000000000 PKR and 1500000 PKR over 12 years",
    "a long figure is not a phone, nor a salary, nor a count",
  );
});
