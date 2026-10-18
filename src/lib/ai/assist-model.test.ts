/**
 * The assist features on AI_MATCHING_MODEL (talent matching, CV extraction,
 * the job-wizard generators) after the move to Claude Haiku 5.5: every request
 * disables thinking and carries no sampling parameter; a reply whose first
 * block is a thinking block is read from its text block; a reply with no text
 * block fails exactly as an empty reply always did. The Anthropic client is a
 * fake installed here; nothing leaves the machine.
 *
 *   node --test src/lib/ai/assist-model.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
// Stubs for the three modules these libraries import that a bare Node process
// cannot load or must not reach. @/lib/anthropic keeps the REAL model constant
// (read from the source file) and hands out the fake client installed below.
const MODEL = readFileSync(new URL("../anthropic.ts", import.meta.url), "utf8").match(
  /export const AI_MATCHING_MODEL = "([^"]+)"/,
)[1];
const STUBS = {
  "server-only": "export {};",
  "@/lib/anthropic": `export const AI_MATCHING_MODEL = ${JSON.stringify(MODEL)};
export function getAnthropic() {
  const client = globalThis.__assistFakeAnthropic;
  if (!client) throw new Error("test: no fake Anthropic client installed");
  return client;
}`,
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

const { thinkingOffParams } = await import("./model-params.ts");
const { rankWithClaude } = await import("../ai-matching.ts");
const { extractBasicFieldsFromCv, extractTalentFieldsFromCv } = await import("../cv-extract.ts");
const { proposeSplit } = await import("./jd-split.ts");
const { generateJobDescription } = await import("./jd-generate.ts");
const { generateScreeningQuestions } = await import("./screening-questions.ts");
const { generateScoringCriteria } = await import("./scoring-criteria.ts");
const { generateInterviewQuestions } = await import("./interview-questions.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};
process.env.ANTHROPIC_API_KEY ??= "test-key-never-sent";

/** Install a fake client answering with `content`; returns the recorded requests. */
function fakeModel(content) {
  const requests = [];
  globalThis.__assistFakeAnthropic = {
    messages: {
      create: async (params) => {
        requests.push(params);
        return { content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return requests;
}
const THINKING = { type: "thinking", thinking: "", signature: "sig" };
const text = (t) => ({ type: "text", text: t });

const JOB = {
  title: "Backend Engineer",
  description: "Build the payments platform for a fintech serving small businesses.",
  responsibilities: "Own the ledger service.\nReview pull requests.",
  requirements: "TypeScript.\nPostgres.",
};
const JD_BOX =
  "About the role\nWe build payments.\nResponsibilities\nOwn the ledger.\nRequirements\nTypeScript.";
const JD_DRAFT = [
  "About the role",
  "We build payments software for small businesses.",
  "",
  "Responsibilities",
  "- Own the ledger service.",
  "",
  "Requirements",
  "- TypeScript and Postgres.",
].join("\n");

/**
 * Every site: the function, a valid text reply, how a success is recognised,
 * and what the site returns when the reply has no text block (today's "empty
 * reply" outcome, unchanged by the move).
 */
const SITES = [
  {
    name: "talent matching",
    run: () =>
      rankWithClaude("python developer", [
        {
          id: "c1",
          first_name: "A",
          last_name: null,
          job_title: "Developer",
          role_category: "Engineering",
          skills: ["Python"],
          city: null,
          country: null,
          years_experience: 3,
          summary: "s",
          availability: null,
          work_type: null,
          email: null,
          phone: null,
          cv_url: null,
          cv_path: null,
          github_url: null,
          linkedin_url: null,
          avatar_url: null,
          status: "approved",
          salary_min: null,
          salary_max: null,
        },
      ]),
    reply: JSON.stringify([{ candidate_id: "c1", match_percent: 80, why: "Python" }]),
    ok: (r) => r.ok === true && r.value[0]?.match_percent === 80,
    empty: (r) => r.ok === false,
  },
  {
    name: "CV extraction",
    run: () =>
      extractTalentFieldsFromCv("Jane Example, senior engineer with eight years of TypeScript."),
    reply: JSON.stringify({
      applicant_job_title: "Senior Engineer",
      role_category: "Engineering",
      years_experience: 8,
      degree: null,
      institution: null,
      city: null,
      country: null,
      summary: "Eight years of TypeScript.",
      availability: null,
      work_type: null,
      notice_period: null,
      work_location: null,
      skills: ["TypeScript"],
      employment_history: [],
    }),
    ok: (r) => r?.applicant_job_title === "Senior Engineer" && r.skills[0] === "TypeScript",
    empty: (r) => r === null,
  },
  {
    name: "CV basic fields",
    run: () => extractBasicFieldsFromCv("Jane Example. Email jane@example.com. Lahore, Pakistan."),
    reply: JSON.stringify({
      first_name: "Jane",
      last_name: "Example",
      email: "jane@example.com",
      phone: null,
      city: "Lahore",
      country: "Pakistan",
      linkedin_url: null,
    }),
    ok: (r) => r !== null && typeof r === "object",
    empty: (r) => r === null,
  },
  {
    name: "JD split",
    run: () => proposeSplit(JD_BOX),
    reply: JSON.stringify({
      groups: [
        { kind: "description", start: 1, end: 2 },
        { kind: "responsibilities", start: 3, end: 4 },
        { kind: "requirements", start: 5, end: 6 },
      ],
    }),
    ok: (r) => r.failure === null && r.groups.length === 3,
    empty: (r) => r.failure === "not_json",
  },
  {
    name: "JD generation",
    run: () => generateJobDescription({ title: "Backend Engineer", location: "Remote" }),
    reply: JD_DRAFT,
    ok: (r) => r.failure === null && r.text.includes("Responsibilities"),
    empty: (r) => r.failure === "empty",
  },
  {
    name: "screening questions",
    run: () => generateScreeningQuestions(JOB),
    reply: JSON.stringify({
      questions: [
        { question: "Years with TypeScript?", type: "numeric", ideal: "3", essential: true },
      ],
    }),
    ok: (r) => r.failure === null && r.questions.length >= 1,
    empty: (r) => r.failure === "not_json",
  },
  {
    name: "scoring criteria",
    run: () => generateScoringCriteria(JOB),
    reply: JSON.stringify({ cv: ["TypeScript"], interview: ["Explains trade-offs clearly"] }),
    ok: (r) => r.failure === null && r.cv.length === 1,
    empty: (r) => r.failure === "not_json",
  },
  {
    name: "interview questions",
    run: () => generateInterviewQuestions({ ...JOB, length: "standard" }),
    reply: JSON.stringify({
      questions: [
        {
          question: "Tell me about a hard bug.",
          competency: "Problem solving",
          rubric: "Root cause named.",
        },
      ],
    }),
    ok: (r) => r.failure === null && r.questions.length === 1,
    empty: (r) => r.failure === "not_json",
  },
];

test("the shared constant is the Haiku 5.5 alias, which model-params recognises", () => {
  assert.equal(MODEL, "claude-haiku-5-5");
  assert.deepEqual(thinkingOffParams(MODEL), { thinking: { type: "disabled" } });
});

for (const site of SITES) {
  test(`${site.name}: the request disables thinking and carries no sampling parameter`, async () => {
    const requests = fakeModel([text(site.reply)]);
    await site.run();
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.model, "claude-haiku-5-5");
    assert.deepEqual(req.thinking, { type: "disabled" });
    for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in req, false, key);
    assert.ok(typeof req.max_tokens === "number" && req.max_tokens > 0);
  });

  test(`${site.name}: a thinking block before the text block still parses`, async () => {
    fakeModel([THINKING, text(site.reply)]);
    const result = await site.run();
    assert.ok(site.ok(result), JSON.stringify(result).slice(0, 200));
  });

  test(`${site.name}: a reply with only a thinking block is today's empty-reply failure`, async () => {
    fakeModel([THINKING]);
    const result = await site.run();
    assert.ok(site.empty(result), JSON.stringify(result).slice(0, 200));
  });
}

test("the text block is read even when it is not first and a second text block follows", async () => {
  fakeModel([THINKING, text(JSON.stringify({ cv: ["Postgres"], interview: [] })), text("ignored")]);
  const r = await generateScoringCriteria(JOB);
  assert.deepEqual(r.cv, ["Postgres"]);
});
