/**
 * The applicant detail read turns the model's dashes into hyphens in its seven
 * prose fields, and leaves everything else exactly as stored (commit D2).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/prose-dashes.test.ts"
 *
 * Runs the real fetchCompanyApplicant against a fake database row in which
 * EVERY text field carries an em and an en dash, then checks each field by
 * name: the prose fields come back with hyphens, and the quotes, the
 * employer's must-have wording, human feedback, screening answers and the
 * name come back untouched. The list's verdict goes through the same toScore,
 * read here as applicant.score.verdict. Synthetic data only.
 *
 * Dash characters are built from code points, so this file holds no glyph.
 */
// @ts-nocheck - same reason as the other node:test files here: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchCompanyApplicant } = await import("./actions.ts");

const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const DASH = new RegExp(`[${EN}${EM}]`);
/** One em and one en dash, the way the model writes them. */
const dashed = (s) => `${s} ${EM} more, 2019${EN}2021`;

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-0000000000aa";
const JOB = "b0000000-0000-0000-0000-0000000000bb";

const ctx = {
  companyId: CO,
  role: "owner",
  memberId: "m-1",
  memberName: "Test Owner",
  user: { id: "u-1", email: "owner@example.test" },
  company: { name: "Example Co" },
};

const applicationRow = {
  id: APP,
  first_name: dashed("Anne"),
  last_name: "Example",
  email: "anne@example.test",
  phone: null,
  linkedin_url: null,
  job_id: JOB,
  job_title_snapshot: "Sales lead",
  jobs: { title: "Sales lead" },
  city: null,
  country: null,
  years_experience: null,
  notice_period: null,
  availability: null,
  created_at: "2026-11-01T00:00:00.000Z",
  pipeline_stage: "applied",
  cv_path: null,
  cv_url: null,
  cv_delete_after: null,
  screening_answers: [
    {
      question_id: "q1",
      question: dashed("Years selling"),
      answer: dashed("Five"),
      answer_label: dashed("Five years"),
      matched: true,
      scored: true,
      essential: false,
    },
  ],
};

const scoreRow = {
  application_id: APP,
  status: "scored",
  overall_score: 64,
  human_adjusted_score: null,
  confidence: "medium",
  error: null,
  verdict: dashed("Partial fit"),
  dimension_scores: [
    {
      dimension: "requirements_match",
      score: 60,
      reasoning: dashed("Covers most"),
      quote: dashed("Led a team"),
    },
  ],
  evidence: [],
  strengths: [{ point: dashed("Broad sales"), quote: dashed("Closed deals") }],
  missing_requirements: [dashed("No SaaS")],
  must_haves: [
    { item: dashed("Fluent English"), status: "evidenced", quote: dashed("Native speaker") },
  ],
  concerns: [dashed("Short tenures")],
  summary: dashed("A generalist"),
  screening_score: 50,
  ai_model: "test-model",
  scored_at: "2026-11-02T00:00:00.000Z",
  human_feedback: dashed("Reviewer note"),
  adjusted_by_name: null,
  adjusted_at: null,
  job_criteria_version: 1,
};

function respond(table, calls) {
  const single = calls.some(([m]) => m === "maybeSingle" || m === "single");
  if (table === "job_applications" && single) return { data: applicationRow, error: null };
  if (table === "application_scores" && single) return { data: scoreRow, error: null };
  if (table === "jobs" && single) {
    return {
      data: {
        criteria_version: 1,
        scoring_must_haves: ["Fluent English"],
        ai_cv_scoring_enabled: true,
      },
      error: null,
    };
  }
  return { data: single ? null : [], error: null, count: 0 };
}

async function read() {
  const service = fakeService(respond);
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctx;
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await fetchCompanyApplicant(APP);
    assert.equal(r.ok, true, "the read must succeed against the fake");
    assert.ok(r.value?.scoreDetail, "a score detail must come back");
    return r.value;
  } finally {
    console.error = quiet;
  }
}

const hyphens = (s, what) => {
  assert.doesNotMatch(s, DASH, `${what} still has a dash: ${s}`);
  assert.match(s, / - more, 2019-2021$/, `${what}: ${s}`);
};
const keepsDash = (s, what) => assert.match(s ?? "", DASH, what);

test("the seven prose fields come back with hyphens", async () => {
  const v = await read();
  const d = v.scoreDetail;
  hyphens(v.applicant.score.verdict, "list verdict (toScore)");
  hyphens(d.verdict, "detail verdict");
  hyphens(d.summary, "summary");
  hyphens(d.dimensions[0].reasoning, "dimension reasoning");
  hyphens(d.strengths[0].point, "strength point");
  hyphens(d.missing_requirements[0], "missing requirement");
  hyphens(d.concerns[0], "concern");
});

test("quotes, must-have wording, human feedback, screening answers and names are untouched", async () => {
  const v = await read();
  const d = v.scoreDetail;
  assert.equal(d.dimensions[0].quote, scoreRow.dimension_scores[0].quote, "dimension quote");
  assert.equal(d.strengths[0].quote, scoreRow.strengths[0].quote, "strength quote");
  assert.equal(d.must_haves[0].item, scoreRow.must_haves[0].item, "must-have item");
  assert.equal(d.must_haves[0].quote, scoreRow.must_haves[0].quote, "must-have quote");
  assert.equal(d.human_feedback, scoreRow.human_feedback, "human feedback");
  assert.deepEqual(v.screening_answers, applicationRow.screening_answers, "screening answers");
  assert.equal(v.applicant.first_name, applicationRow.first_name, "first name");
  for (const s of [
    d.dimensions[0].quote,
    d.must_haves[0].item,
    d.human_feedback,
    v.applicant.first_name,
  ]) {
    keepsDash(s, "a verbatim field lost its dash");
  }
});

test("other dimension fields ride along unchanged", async () => {
  const d = (await read()).scoreDetail.dimensions[0];
  assert.equal(d.dimension, "requirements_match");
  assert.equal(d.score, 60);
});
