/**
 * F3: async interview scorecards at the six-month retention date
 * (async-score-purge.ts): the purge clears the AI's words and the candidate's
 * quotes and keeps the numbers; the review page never sends the words past
 * the date and says what was deleted. The database is fake-live-db.mjs; every
 * candidate here is synthetic.
 *
 *   node --test src/lib/interviews/async-score-purge.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__f3Service; }",
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return true; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function canAccessJob() { return true; }",
  ].join("\\n"),
  "@/app/ai-dashboard/(gated)/applicants/actions": "export async function updateApplicationStage() { return { success: true }; }",
  "../actions": [
    "addInterviewNote", "adjustAnswerScore", "adjustSessionScore", "deleteInterview", "deleteInterviewNote",
    "getAnswerPlaybackUrl", "revertAnswerScore", "revertSessionScore", "scoreInterview", "setInterviewArchived",
    "updateInterviewNote",
  ].map((n) => "export async function " + n + "() { return { ok: true }; }").join("\\n"),
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {} }; }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const { purgeAsyncScoreWords, retentionPassed, clearCriteriaQuotes } = await import(
  "./async-score-purge.ts"
);
const { handleInterviewPurge } = await import("./purge.ts");
const { loadInterviewSession, listInterviewSessions } = await import("./review.ts");
const { ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");
const { readFileSync } = await import("node:fs");

const DAY = 86_400_000;
const CO = "f3f3f3f3-0000-4000-8000-000000000001";
const JOB = "f3f3f3f3-0000-4000-8000-0000000000aa";
const DUE = "f3f3f3f3-0000-4000-8000-0000000000d1";
const OLD = "f3f3f3f3-0000-4000-8000-0000000000d2";
const LATER = "f3f3f3f3-0000-4000-8000-0000000000e1";
const LIVE = "f3f3f3f3-0000-4000-8000-0000000000f1";
const past = (days) => new Date(Date.now() - days * DAY).toISOString();
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};

const session = (id, over = {}) => ({
  id,
  company_id: CO,
  job_id: JOB,
  application_id: null,
  kind: "async",
  status: "submitted",
  delete_after: past(1),
  expires_at: past(170),
  created_at: past(181),
  submitted_at: past(180),
  started_at: past(180),
  questions_snapshot: [{ id: "q1", position: 1, question: "Tell me about a migration." }],
  scoring_snapshot: null,
  archived_at: null,
  invited_by_name: "Recruiter",
  ...over,
});

const answer = (sessionId, n, over = {}) => ({
  id: `${sessionId.slice(-2)}-a${n}`,
  session_id: sessionId,
  position: n,
  question_text: `Question ${n}`,
  video_path: `${sessionId}/${n}.webm`,
  transcript: "I moved the ledger to the new store over a weekend.",
  transcript_segments: [
    { start: 0, end: 4, text: "I moved the ledger to the new store over a weekend." },
  ],
  transcript_status: "done",
  transcript_error: null,
  duration_seconds: 60,
  recorded_at: past(180),
  ...over,
});

const WORDS = {
  reasoning: "Specific, owned the migration end to end.",
  evidence: [{ claim: "Owned it", quote: "I moved the ledger" }],
  strengths: [{ claim: "Owned it", quote: "I moved the ledger" }],
  concerns: [{ claim: "Rushed", quote: "over a weekend" }],
  missing: ["No rollback plan described"],
};
/** Every column the purge must leave exactly as it was. */
const KEPT_ANSWER = [
  "id",
  "answer_id",
  "session_id",
  "company_id",
  "status",
  "score",
  "confidence",
  "error",
  "input_tokens",
  "output_tokens",
  "ai_model",
  "prompt_version",
  "scored_at",
  "scored_by_job_id",
  "human_adjusted_score",
  "human_feedback",
  "adjusted_by",
  "adjusted_by_name",
  "adjusted_at",
  "created_at",
];
const KEPT_SESSION = [
  "id",
  "session_id",
  "company_id",
  "status",
  "overall_score",
  "verdict",
  "confidence",
  "error",
  "ai_model",
  "prompt_version",
  "scored_at",
  "scored_by_job_id",
  "human_adjusted_score",
  "human_feedback",
  "adjusted_by",
  "adjusted_by_name",
  "adjusted_at",
  "created_at",
];

const answerScore = (sessionId, n, over = {}) => ({
  id: `${sessionId.slice(-2)}-s${n}`,
  answer_id: `${sessionId.slice(-2)}-a${n}`,
  session_id: sessionId,
  company_id: CO,
  status: "scored",
  score: 70 + n,
  confidence: "high",
  error: null,
  input_tokens: 900,
  output_tokens: 120,
  ai_model: "model-x",
  prompt_version: "v8",
  scored_at: past(179),
  scored_by_job_id: "job-1",
  human_adjusted_score: n === 1 ? 65 : null,
  human_feedback: n === 1 ? "Weaker on rollback than the model thought." : null,
  adjusted_by: n === 1 ? "u-1" : null,
  adjusted_by_name: n === 1 ? "Reviewer" : null,
  adjusted_at: n === 1 ? past(178) : null,
  created_at: past(179),
  ...structuredClone(WORDS),
  ...over,
});

const sessionScore = (sessionId, over = {}) => ({
  id: `${sessionId.slice(-2)}-ss`,
  session_id: sessionId,
  company_id: CO,
  status: "scored",
  overall_score: 72,
  verdict: "Strong on ownership, light on risk.",
  summary: "Question 1 showed clear ownership. Based on 2 of 2 answers.",
  confidence: "medium",
  criteria: [
    { item: "Owns outcomes", status: "evidenced", quote: "I moved the ledger" },
    { item: "Plans for failure", status: "not_found", quote: "" },
  ],
  error: null,
  ai_model: "model-x",
  prompt_version: "v8",
  scored_at: past(179),
  scored_by_job_id: "job-1",
  human_adjusted_score: 68,
  human_feedback: "Adjusted after the panel.",
  adjusted_by: "u-1",
  adjusted_by_name: "Reviewer",
  adjusted_at: past(178),
  created_at: past(179),
  ...over,
});

function world() {
  const db = fakeLiveDb({
    interview_sessions: [
      session(DUE),
      // Purged by an earlier run, before this step existed: media and transcripts gone, words still in the scores.
      session(OLD, { delete_after: past(40) }),
      session(LATER, { delete_after: future(30) }),
      session(LIVE, { kind: "live", delete_after: future(30) }),
    ],
    interview_answers: [
      answer(DUE, 1),
      answer(DUE, 2),
      answer(OLD, 1, { video_path: null, transcript: null, transcript_segments: null }),
      answer(LATER, 1),
    ],
    interview_answer_scores: [
      answerScore(DUE, 1),
      answerScore(DUE, 2),
      // A skipped row holds no words: never written.
      answerScore(DUE, 3, {
        status: "skipped",
        score: null,
        error: "No transcript.",
        reasoning: null,
        evidence: [],
        strengths: [],
        concerns: [],
        missing: [],
      }),
      answerScore(OLD, 1),
      answerScore(LATER, 1),
    ],
    interview_session_scores: [sessionScore(DUE), sessionScore(OLD), sessionScore(LATER)],
    live_interview_scores: [
      {
        session_id: LIVE,
        company_id: CO,
        rev: 1,
        questions: [{ position: 1, score: 3, rationale: "r", quotes: ["q"] }],
      },
    ],
  });
  globalThis.__f3Service = db.service;
  return db;
}

const rowsOf = (db, table, sessionId) => db.tables[table].filter((r) => r.session_id === sessionId);
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));
const scoreWrites = (db) =>
  db.service.queries.filter(
    (q) =>
      ["interview_answer_scores", "interview_session_scores"].includes(q.table) &&
      q.calls.some((c) => c[0] === "update" || c[0] === "upsert" || c[0] === "insert"),
  ).length;

/* ── the purge ────────────────────────────────────────────────── */

test("a due session: every AI text field and quote is cleared; every number, status, verdict and note is kept", async () => {
  const db = world();
  const before = structuredClone(db.tables);
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));

  for (const row of rowsOf(db, "interview_answer_scores", DUE).filter(
    (r) => r.status === "scored",
  )) {
    assert.deepEqual(
      [row.reasoning, row.evidence, row.strengths, row.concerns, row.missing],
      [null, [], [], [], []],
      "the words",
    );
    const was = before.interview_answer_scores.find((r) => r.id === row.id);
    assert.deepEqual(pick(row, KEPT_ANSWER), pick(was, KEPT_ANSWER), "the numbers and notes");
  }
  const adjusted = rowsOf(db, "interview_answer_scores", DUE).find((r) => r.human_feedback);
  assert.equal(
    adjusted.human_feedback,
    "Weaker on rollback than the model thought.",
    "the reviewer note",
  );
  assert.equal(adjusted.human_adjusted_score, 65);

  const [s] = rowsOf(db, "interview_session_scores", DUE);
  assert.equal(s.summary, null);
  assert.deepEqual(s.criteria, [
    { item: "Owns outcomes", status: "evidenced", quote: "" },
    { item: "Plans for failure", status: "not_found", quote: "" },
  ]);
  assert.deepEqual(
    pick(s, KEPT_SESSION),
    pick(
      before.interview_session_scores.find((r) => r.session_id === DUE),
      KEPT_SESSION,
    ),
  );
  assert.equal(s.verdict, "Strong on ownership, light on risk.", "the verdict is kept");
  assert.equal(s.human_feedback, "Adjusted after the panel.", "the reviewer note is kept");
});

test("not yet due, and live sessions, are untouched", async () => {
  const db = world();
  const before = structuredClone(db.tables);
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));
  const was = { tables: before };
  assert.deepEqual(
    rowsOf(db, "interview_answer_scores", LATER),
    rowsOf(was, "interview_answer_scores", LATER),
  );
  assert.deepEqual(
    rowsOf(db, "interview_session_scores", LATER),
    rowsOf(was, "interview_session_scores", LATER),
  );
  assert.deepEqual(
    db.tables.live_interview_scores,
    before.live_interview_scores,
    "a live score is not touched",
  );
  const asyncOnly = await purgeAsyncScoreWords(db.service, [LIVE]);
  assert.deepEqual(asyncOnly, { answers: 0, sessions: 0 });
  assert.deepEqual(db.tables.live_interview_scores, before.live_interview_scores);
});

test("a session purged before this step existed is cleaned on the next run", async () => {
  const db = world();
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));
  const [a] = rowsOf(db, "interview_answer_scores", OLD);
  assert.deepEqual([a.reasoning, a.strengths, a.concerns, a.score], [null, [], [], 71]);
  assert.equal(rowsOf(db, "interview_session_scores", OLD)[0].summary, null);
});

test("a second run makes no writes; a row with no words is never written", async () => {
  const db = world();
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));
  // 3 answer rows with words (2 due, 1 old) + 2 session rows; the skipped row is not among them.
  assert.equal(scoreWrites(db), 5);
  const skipped = rowsOf(db, "interview_answer_scores", DUE).find((r) => r.status === "skipped");
  assert.equal(skipped.error, "No transcript.");
  await quiet(() => handleInterviewPurge({ id: "purge-2", payload: {} }));
  assert.equal(scoreWrites(db), 5, "nothing written the second time");
  assert.deepEqual(await purgeAsyncScoreWords(db.service, [DUE, OLD]), { answers: 0, sessions: 0 });
});

test("words written after a purge (a scorer that raced it) are cleared on the next run", async () => {
  const db = world();
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));
  Object.assign(rowsOf(db, "interview_answer_scores", DUE)[0], structuredClone(WORDS));
  rowsOf(db, "interview_session_scores", DUE)[0].summary = "Restored by a late job.";
  await quiet(() => handleInterviewPurge({ id: "purge-2", payload: {} }));
  assert.equal(rowsOf(db, "interview_answer_scores", DUE)[0].reasoning, null);
  assert.equal(rowsOf(db, "interview_session_scores", DUE)[0].summary, null);
});

test("the retention rule and the criteria helper", () => {
  const now = Date.parse("2027-02-01T00:00:00.000Z");
  assert.equal(retentionPassed("2027-02-01T00:00:00.000Z", now), true, "at the date");
  assert.equal(retentionPassed("2027-01-31T23:59:59.999Z", now), true);
  assert.equal(retentionPassed("2027-02-01T00:00:00.001Z", now), false);
  assert.equal(retentionPassed(null, now), false, "no date, never (as purge.ts)");
  assert.equal(retentionPassed("not a date", now), false);
  assert.deepEqual(clearCriteriaQuotes([{ item: "x", status: "evidenced", quote: "y" }]), [
    { item: "x", status: "evidenced", quote: "" },
  ]);
  assert.equal(clearCriteriaQuotes(null), null);
});

/* ── the review page ──────────────────────────────────────────── */

const ctx = {
  user: { id: "u-1", email: "r@company.test" },
  companyId: CO,
  role: "owner",
  memberName: "Reviewer",
  memberId: "m-1",
};

test("review page: past the date the words never leave the server, even before the purge has run", async () => {
  const db = world();
  const view = await loadInterviewSession(ctx, DUE);
  assert.equal(view.evidenceDeleted, true);
  // The scores as sent. (The transcript is the existing purge's: it goes on the same run.)
  const scoresSent = (v) =>
    JSON.stringify({ answers: v.answers.map((a) => a.score), session: v.score });
  for (const words of [
    "Specific, owned",
    "I moved the ledger",
    "over a weekend",
    "No rollback plan",
    "Owned it",
    "Rushed",
    "Question 1 showed",
  ]) {
    assert.ok(!scoresSent(view).includes(words), `"${words}" was sent`);
  }
  assert.equal(view.score.overall, 72);
  assert.equal(view.score.humanScore, 68);
  assert.equal(view.score.verdict, "Strong on ownership, light on risk.");
  assert.equal(view.score.adjustment.feedback, "Adjusted after the panel.");
  assert.deepEqual(
    view.score.criteria.map((c) => [c.item, c.status, c.quote]),
    [
      ["Owns outcomes", "evidenced", ""],
      ["Plans for failure", "not_found", ""],
    ],
  );
  assert.equal(view.answers[0].score.shownScore, 65);
  assert.equal(
    view.answers[0].score.adjustment.feedback,
    "Weaker on rollback than the model thought.",
  );
  // The database still holds them until the purge: it is the page that withholds them.
  assert.ok(rowsOf(db, "interview_answer_scores", DUE)[0].reasoning);

  const later = await loadInterviewSession(ctx, LATER);
  assert.equal(later.evidenceDeleted, false, "control: not yet due");
  for (const words of [
    "Specific, owned",
    "I moved the ledger",
    "No rollback plan",
    "Question 1 showed",
  ]) {
    assert.ok(scoresSent(later).includes(words), `control: "${words}" is sent before the date`);
  }
});

test("interviews list: the scores it sends carry no summary or quotes past the date", async () => {
  world();
  const list = await listInterviewSessions(ctx, { status: "all" });
  // The read reports failure as a value now, so this unwrap is also the
  // assertion that the fake database answered at all.
  assert.ok(list.ok, "the list read succeeded");
  const score = (id) => list.value.rows.find((r) => r.id === id)?.score;
  assert.ok(score(DUE) && score(LATER), "both rows are listed");
  assert.equal(score(DUE).summary, null);
  assert.deepEqual(
    score(DUE).criteria.map((c) => c.quote),
    ["", ""],
  );
  assert.equal(score(DUE).overall, 72);
  assert.equal(score(DUE).verdict, "Strong on ownership, light on risk.");
  assert.equal(
    score(LATER).summary,
    "Question 1 showed clear ownership. Based on 2 of 2 answers.",
    "control",
  );
  assert.equal(score(LATER).criteria[0].quote, "I moved the ledger", "control");
});

const render = (view) =>
  renderToStaticMarkup(createElement(ReviewClient, { session: view, viewerRole: "owner" }));

test("review page: says the evidence was deleted after six months and the scores remain", async () => {
  world();
  const html = render(await loadInterviewSession(ctx, DUE));
  assert.match(
    html,
    /The AI&#x27;s explanations and the quotes from the answers were deleted after six months\. The scores remain\./,
  );
  assert.match(
    html,
    /The AI&#x27;s summary was deleted after six months, with the recordings\. The scores remain\./,
  );
  assert.match(
    html,
    /The AI&#x27;s explanation and the quotes from this answer were deleted after six months\. The score remains\./,
  );
  assert.match(
    html,
    /Shown in the interview\. The quote was deleted after six months\./,
    "an evidenced criterion is not reported as not found",
  );
  assert.match(html, /Strong on ownership, light on risk\./, "the verdict");
  assert.doesNotMatch(html, /the score and its evidence remain/);
  for (const words of [
    /Specific, owned/,
    /No rollback plan/,
    /Question 1 showed/,
    />Owned it</,
    /Points to verify/,
  ]) {
    assert.doesNotMatch(html, words);
  }
  assert.doesNotMatch(html, /open each one for its reasoning and evidence/);

  const before = render(await loadInterviewSession(ctx, LATER));
  assert.doesNotMatch(before, /data-evidence-deleted/, "control: nothing deleted before the date");
  assert.match(before, /Specific, owned the migration end to end\./);
  assert.match(before, /Question 1 showed clear ownership/);
});

test("the reviewer note boxes carry the hint", async () => {
  world();
  const html = render(await loadInterviewSession(ctx, DUE));
  assert.match(html, /data-note-hint[^>]*>Don&#x27;t include personal details\.</);
  // The score-adjustment note opens on a click, so its hint is checked in the source.
  const client = readFileSync(
    new URL(
      "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const adjust = client.slice(
    client.indexOf("function AdjustForm("),
    client.indexOf("function AdjustForm(") + 4000,
  );
  assert.match(adjust, /\{NOTE_HINT\}/);
  assert.match(client, /const NOTE_HINT = "Don't include personal details\.";/);
});
