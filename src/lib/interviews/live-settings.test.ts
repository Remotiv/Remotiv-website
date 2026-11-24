/**
 * Live settings v3: the question mix frozen at invite (lib/interviews/live-settings.ts)
 * and read back from the frozen copy (readLiveSettings in lib/interviews/types.ts).
 * v3 (#13, 23 Nov): every job question, no CV questions. v1 and v2 rows still
 * read as they were written. The database is a fake; nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-settings.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  // The live consent text as final, so the allowlist alone decides here. The
  // real text keeps live closed while it has placeholders: live-consent.test.ts.
  if (specifier === "@/lib/interviews/live-consent") {
    return { url: "data:text/javascript," + encodeURIComponent("export function liveConsentReady() { return true; }"), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { gateLiveInterviewInvite, FOLLOW_UP_RULES, FOLLOW_UP_RULES_VERSION } = await import(
  "./live-settings.ts"
);
const { readLiveSettings, LIVE_SETTINGS_VERSION, INTERVIEW_LENGTHS, MIN_QUESTIONS, MAX_QUESTIONS } =
  await import("./types.ts");
const { questionMixFor, QUESTION_MIX_POLICY_VERSION, TABLE_POLICY_VERSION } = await import(
  "./question-mix.ts"
);
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const CO = "7aad434d-0000-4000-8000-000000000001";
const JOB = "2d4a8cde-0000-4000-8000-000000000002";

/** The gate's result for a job with `questions` questions, the toggle on and a name, the company allowlisted. */
async function gateFor(questions = 6, questionsError = null) {
  const before = process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
  process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = CO;
  try {
    const service = fakeService((table) => {
      if (table === "jobs") {
        return {
          data: { avatar_interview_enabled: true, avatar_interviewer_name: "Sarah" },
          error: null,
        };
      }
      if (table === "interview_questions") {
        if (questionsError) return { data: null, error: questionsError };
        return {
          data: Array.from({ length: questions }, (_, i) => ({ id: `q-${i}` })),
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const gate = await gateLiveInterviewInvite(service, { jobId: JOB, companyId: CO });
    return { gate, service };
  } finally {
    if (before === undefined) delete process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
    else process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = before;
  }
}

async function frozenAtInvite(questions = 6) {
  const { gate } = await gateFor(questions);
  assert.equal(gate.ok, true, gate.error);
  return gate.settings;
}

/** A stored v1 row, as written before this commit. */
const V1_ROW = {
  v: 1,
  interviewer_name: "Sarah",
  language: "en",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: 1800,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: {
    when: "Only when the answer is thin.",
    scope: "Stay on the base question's criterion.",
    never: ["Reveal what a good answer contains."],
  },
};

/* ── frozen at invite ─────────────────────────────────────────── */

test("an invite freezes v3: every one of the job's questions, no CV questions", async () => {
  assert.equal(LIVE_SETTINGS_VERSION, 3);
  for (const n of [4, 6, 8]) {
    const settings = await frozenAtInvite(n);
    assert.equal(settings.v, 3);
    assert.deepEqual(settings.question_mix, {
      policy_version: QUESTION_MIX_POLICY_VERSION,
      session_minutes: 30,
      job_questions: n,
      cv_questions: 0,
      total: n,
    });
  }
  assert.equal(QUESTION_MIX_POLICY_VERSION, "question-mix-v2");
  const settings = await frozenAtInvite(6);
  assert.equal(settings.interviewer_name, "Sarah");
  assert.equal(settings.follow_up_rules_version, FOLLOW_UP_RULES_VERSION);
  assert.deepEqual(settings.follow_up_rules, FOLLOW_UP_RULES);
});

test("#19: fewer than 4 or more than 8 questions: the gate refuses with the approved text", async () => {
  for (const n of [0, 1, 3, 9, 12, 50]) {
    const { gate } = await gateFor(n);
    assert.deepEqual(
      gate,
      {
        ok: false,
        error:
          "This job needs 4 to 8 interview questions for an AI Video Interview. Please update the questions and try again.",
      },
      `${n} questions`,
    );
  }
  for (const n of [4, 5, 6, 7, 8]) {
    const { gate } = await gateFor(n);
    assert.equal(gate.ok, true, `${n} questions`);
  }
});

test("the count is read for this job in this company only; a failed read refuses the send", async () => {
  const { service } = await gateFor(6);
  const q = service.queries.find((x) => x.table === "interview_questions");
  assert.ok(q, "the job's questions are counted");
  assert.deepEqual(
    q.calls.filter((c) => c[0] === "eq"),
    [
      ["eq", "job_id", JOB],
      ["eq", "company_id", CO],
    ],
  );
  const failed = await gateFor(6, { message: "boom" });
  assert.deepEqual(failed.gate, { ok: false, error: "Couldn't send - please try again." });
});

test("the follow-up limit is still 2, frozen at invite, and a row claiming more is refused", async () => {
  const settings = await frozenAtInvite(6);
  assert.equal(settings.max_follow_ups_per_base_question, 2);
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    assert.equal(
      readLiveSettings({ ...settings, max_follow_ups_per_base_question: 3 }, "s-fu"),
      null,
    );
  } finally {
    console.error = orig;
  }
});

test("what was frozen reads back exactly, through the JSON the column stores", async () => {
  const settings = await frozenAtInvite();
  const stored = JSON.parse(JSON.stringify(settings));
  assert.deepEqual(readLiveSettings(stored, "s-1"), settings);
});

test("a v2 row invited under the table keeps its meaning: 4 job + 4 CV, policy v1", () => {
  const v2 = { ...V1_ROW, v: 2, question_mix: questionMixFor(30) };
  const read = readLiveSettings(JSON.parse(JSON.stringify(v2)), "s-v2");
  assert.equal(read.v, 2);
  assert.deepEqual(read.question_mix, {
    policy_version: TABLE_POLICY_VERSION,
    session_minutes: 30,
    job_questions: 4,
    cv_questions: 4,
    total: 8,
  });
  assert.equal(TABLE_POLICY_VERSION, "question-mix-v1");
});

test("a frozen session keeps its own counts: a later policy change never reaches it", () => {
  // Written under an older, different policy: 6 + 6 for 30 minutes.
  const older = {
    ...V1_ROW,
    v: 2,
    question_mix: {
      policy_version: "question-mix-v0",
      session_minutes: 30,
      job_questions: 6,
      cv_questions: 6,
      total: 12,
    },
  };
  const read = readLiveSettings(older, "s-2");
  assert.deepEqual(read.question_mix, older.question_mix);
  assert.notDeepEqual(read.question_mix, questionMixFor(30), "the frozen copy, not today's table");
});

test("a v1 row still reads, with no question mix", () => {
  const read = readLiveSettings(V1_ROW, "s-3");
  assert.equal(read.v, 1);
  assert.equal(read.question_mix, null);
  assert.equal(read.interviewer_name, "Sarah");
  // A stray mix on a v1 row is not believed: v1 predates it.
  assert.equal(
    readLiveSettings({ ...V1_ROW, question_mix: questionMixFor(30) }, "s-4").question_mix,
    null,
  );
});

test("a v2 or v3 row with a missing or broken mix is refused, and the session id is logged", () => {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    const good = questionMixFor(30);
    for (const mix of [
      undefined,
      null,
      [],
      { ...good, total: 9 },
      { ...good, job_questions: -1, total: 3 },
      { ...good, cv_questions: 1.5 },
      { ...good, total: 0, job_questions: 0, cv_questions: 0 },
      { ...good, policy_version: "" },
      { ...good, session_minutes: 0 },
    ]) {
      for (const v of [2, 3]) {
        assert.equal(readLiveSettings({ ...V1_ROW, v, question_mix: mix }, "s-bad"), null);
      }
    }
    assert.equal(readLiveSettings({ ...V1_ROW, v: 4 }, "s-v4"), null, "an unknown version");
  } finally {
    console.error = orig;
  }
  assert.ok(logs.every((l) => l.includes("s-bad") || l.includes("s-v4")));
  assert.ok(logs.some((l) => /question_mix/.test(l)));
});

/* ── async: untouched ─────────────────────────────────────────── */

test("async is untouched: its lengths and counts, and its send never freezes live settings", () => {
  assert.deepEqual(
    INTERVIEW_LENGTHS.map((l) => [l.id, l.questions, l.answerSeconds]),
    [
      ["short", 4, 60],
      ["standard", 5, 120],
      ["depth", 6, 150],
    ],
  );
  assert.deepEqual([MIN_QUESTIONS, MAX_QUESTIONS], [4, 6]);
  const actions = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/applicants/interview-actions.ts", import.meta.url),
    "utf8",
  );
  const start = actions.indexOf("export async function sendInterviewInvite(");
  const end = actions.indexOf("\n}\n", start);
  const asyncSend = actions.slice(start, end);
  assert.ok(start > 0 && asyncSend.includes('kind: "async"'));
  assert.doesNotMatch(
    asyncSend,
    /live_settings|question_mix|questionMixFor|gateLiveInterviewInvite/,
  );
});
