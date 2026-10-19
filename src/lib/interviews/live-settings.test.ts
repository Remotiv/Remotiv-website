/**
 * Live settings v2: the question mix frozen at invite (lib/interviews/live-settings.ts)
 * and read back from the frozen copy (readLiveSettings in lib/interviews/types.ts).
 * The database is a fake; nothing leaves the machine.
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
  return next(specifier, context);
}`)}`,
);

const { gateLiveInterviewInvite, FOLLOW_UP_RULES, FOLLOW_UP_RULES_VERSION } = await import(
  "./live-settings.ts"
);
const { readLiveSettings, LIVE_SETTINGS_VERSION, INTERVIEW_LENGTHS, MIN_QUESTIONS, MAX_QUESTIONS } =
  await import("./types.ts");
const { questionMixFor, QUESTION_MIX_POLICY_VERSION } = await import("./question-mix.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const CO = "7aad434d-0000-4000-8000-000000000001";
const JOB = "2d4a8cde-0000-4000-8000-000000000002";

/** The gate's settings for a job with the toggle on and a name, the company allowlisted. */
async function frozenAtInvite() {
  const before = process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
  process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = CO;
  try {
    const service = fakeService((table) =>
      table === "jobs"
        ? {
            data: { avatar_interview_enabled: true, avatar_interviewer_name: "Sarah" },
            error: null,
          }
        : { data: null, error: null },
    );
    const gate = await gateLiveInterviewInvite(service, { jobId: JOB, companyId: CO });
    assert.equal(gate.ok, true, gate.error);
    return gate.settings;
  } finally {
    if (before === undefined) delete process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
    else process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = before;
  }
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

test("an invite freezes v2, with the mix for the session's length", async () => {
  const settings = await frozenAtInvite();
  assert.equal(LIVE_SETTINGS_VERSION, 2);
  assert.equal(settings.v, 2);
  assert.deepEqual(settings.question_mix, {
    policy_version: QUESTION_MIX_POLICY_VERSION,
    session_minutes: 30,
    job_questions: 4,
    cv_questions: 4,
    total: 8,
  });
  assert.deepEqual(settings.question_mix, questionMixFor(settings.max_session_seconds / 60));
  assert.equal(settings.interviewer_name, "Sarah");
  assert.equal(settings.follow_up_rules_version, FOLLOW_UP_RULES_VERSION);
  assert.deepEqual(settings.follow_up_rules, FOLLOW_UP_RULES);
});

test("what was frozen reads back exactly, through the JSON the column stores", async () => {
  const settings = await frozenAtInvite();
  const stored = JSON.parse(JSON.stringify(settings));
  assert.deepEqual(readLiveSettings(stored, "s-1"), settings);
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

test("a v2 row with a missing or broken mix is refused, and the session id is logged", () => {
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
      assert.equal(readLiveSettings({ ...V1_ROW, v: 2, question_mix: mix }, "s-bad"), null);
    }
    assert.equal(readLiveSettings({ ...V1_ROW, v: 3 }, "s-v3"), null, "an unknown version");
  } finally {
    console.error = orig;
  }
  assert.ok(logs.every((l) => l.includes("s-bad") || l.includes("s-v3")));
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
