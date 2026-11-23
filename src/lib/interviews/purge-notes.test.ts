/**
 * #21: reviewers' interview notes go with the six-month purge. A purged
 * interview has none left, an interview inside its retention keeps them, a
 * failed delete is reported (the job fails and the session is not stamped),
 * and no note can be added once the retention date has passed.
 *
 *   node --test src/lib/interviews/purge-notes.test.ts
 *
 * runInterviewPurge and addInterviewNote run as shipped over
 * fake-live-db.mjs, with interview_notes seeded and one delete failure
 * injected. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__notesService; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__notesCtx; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false, jobIds: [] }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function roleAllowsJobAction() { return true; }",
  ].join("\\n"),
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return false; }",
  "@/lib/interviews/review": "export async function listInterviewSessions() {} export async function readNotes() { return []; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven() { return true; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { runInterviewPurge } = await import("./purge.ts");
const { addInterviewNote } = await import("../../app/ai-dashboard/(gated)/interviews/actions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const DAY = 86_400_000;
const CO = "a2a2a2a2-0000-4000-8000-000000000001";
const DUE = "a2a2a2a2-0000-4000-8000-0000000000d1";
const KEPT = "a2a2a2a2-0000-4000-8000-0000000000e1";
const past = (days) => new Date(Date.now() - days * DAY).toISOString();
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

const session = (id, over = {}) => ({
  id,
  company_id: CO,
  application_id: null,
  job_id: null,
  kind: "async",
  attempt: 1,
  previous_attempt_id: null,
  status: "submitted",
  submitted_at: past(181),
  started_at: past(181),
  expires_at: past(170),
  delete_after: past(1),
  purged_at: null,
  ...over,
});
const answer = (sessionId) => ({
  id: `${sessionId.slice(-2)}-a1`,
  session_id: sessionId,
  position: 1,
  question_text: "Question 1",
  video_path: `${sessionId}/1.webm`,
  transcript: "A synthetic answer.",
  transcript_segments: null,
  transcript_status: "done",
  transcript_error: null,
  duration_seconds: 60,
  recorded_at: past(181),
});
const note = (sessionId, n) => ({
  id: `${sessionId.slice(-2)}-n${n}`,
  session_id: sessionId,
  company_id: CO,
  member_id: "m-1",
  author_name: "A reviewer",
  body: `Synthetic note ${n} naming the candidate.`,
  created_at: past(170),
  updated_at: past(170),
});

function world() {
  const db = fakeLiveDb({
    interview_sessions: [session(DUE), session(KEPT, { delete_after: future(30) })],
    interview_answers: [answer(DUE), answer(KEPT)],
    interview_notes: [note(DUE, 1), note(DUE, 2), note(KEPT, 1)],
  });
  globalThis.__notesService = db.service;
  globalThis.__notesCtx = {
    companyId: CO,
    role: "owner",
    memberId: "m-1",
    memberName: "A reviewer",
    user: { id: "u-1" },
  };
  return db;
}

const quiet = async (fn) => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
};
const notesOf = (db, sessionId) =>
  db.tables.interview_notes.filter((n) => n.session_id === sessionId).map((n) => n.id);
const stamped = (db, id) =>
  db.tables.interview_sessions.find((s) => s.id === id).purged_at !== null;

// Negative control: remove the purgeInterviewNotes call and the purged
// interview keeps both notes.
test("a purged interview has no notes left; one inside its retention keeps them", async () => {
  const db = world();
  const { result, lines } = await quiet(() => runInterviewPurge({ id: "p-1", payload: {} }));
  assert.equal(result.complete, true);
  assert.deepEqual(notesOf(db, DUE), [], "purged: notes gone");
  assert.deepEqual(notesOf(db, KEPT), ["e1-n1"], "not due: kept");
  assert.equal(stamped(db, DUE), true);
  assert.equal(stamped(db, KEPT), false);
  assert.equal(result.notesDeleted, 2);
  assert.ok(
    lines.some((l) => /COMPLETE.* notes=2 /.test(l)),
    "the count is in the log line",
  );
});

// Negative control: make purgeInterviewNotes ignore its error and the run
// "completes", stamps the session, and the notes stay for ever.
test("a failed note delete fails the run, leaves the session unstamped, and the next run finishes it", async () => {
  const db = world();
  db.failNext("interview_notes", "delete");
  await assert.rejects(
    quiet(() => runInterviewPurge({ id: "p-1", payload: {} })),
    /purge: interview notes/,
  );
  assert.deepEqual(notesOf(db, DUE), ["d1-n1", "d1-n2"], "nothing was passed over silently");
  assert.equal(stamped(db, DUE), false, "not stamped: read again next run");

  const { result } = await quiet(() => runInterviewPurge({ id: "p-2", payload: {} }));
  assert.equal(result.complete, true);
  assert.deepEqual(notesOf(db, DUE), []);
  assert.equal(stamped(db, DUE), true);
});

// Negative control: remove the retention check in addInterviewNote and the
// first two cases insert a note the purge has already passed.
test("no note can be added once the retention date has passed", async () => {
  const closed =
    "This interview has passed its six-month retention date, so new notes can't be added.";

  const db = world();
  assert.deepEqual(await addInterviewNote(DUE, "Late thought."), { ok: false, error: closed });

  db.tables.interview_sessions.find((s) => s.id === DUE).purged_at = past(0);
  db.tables.interview_sessions.find((s) => s.id === DUE).delete_after = future(1);
  assert.deepEqual(await addInterviewNote(DUE, "Late thought."), { ok: false, error: closed });
  assert.deepEqual(notesOf(db, DUE), ["d1-n1", "d1-n2"], "nothing inserted");

  const open = await quiet(() => addInterviewNote(KEPT, "Inside retention."));
  assert.equal(open.result.ok, true, JSON.stringify(open.result));
  assert.equal(notesOf(db, KEPT).length, 2);
});

test("the retention read failing refuses the note rather than guessing", async () => {
  const db = world();
  // gateSession's read goes first; the retention read is the second select.
  const reads = [];
  const service = db.service;
  globalThis.__notesService = {
    ...service,
    from(table) {
      if (table === "interview_sessions") reads.push(table);
      if (table === "interview_sessions" && reads.length === 2) db.failNext(table, "select");
      return service.from(table);
    },
  };
  const r = await addInterviewNote(KEPT, "Inside retention.");
  assert.deepEqual(r, { ok: false, error: "Couldn't save that note. Please try again." });
  assert.equal(notesOf(db, KEPT).length, 1);
});

test("migration 068 deletes the notes of sessions already purged, and nothing else", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/068_purged_interview_notes_backfill.sql", import.meta.url),
    "utf8",
  );
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /delete from public\.interview_notes n/);
  assert.match(code, /s\.id = n\.session_id\s+and s\.purged_at is not null/);
  assert.doesNotMatch(code, /\b(alter|create|drop|truncate|update)\b/i, "data only");
});
