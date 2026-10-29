/**
 * B7: deleting an applicant deletes their AI interviews (application-deletion.ts),
 * through both applicant deletions. The database and bucket are
 * fake-live-db.mjs, which applies the schema's cascades, the restart chain's
 * foreign key and the append-only guards on delete.
 *
 *   node --test src/lib/interviews/application-deletion.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__deletionService; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { deleteApplicationInterviews, FILES_LEFT, SESSION_DELETED } = await import(
  "./application-deletion.ts"
);
const { reservePieceUpload } = await import("./live-video.ts");
const { queueLiveTranscription, handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { requestLiveScoring } = await import("./live-scoring.ts");
const { saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { handleTranscribe } = await import("./transcribe.ts");
const { resolveSessionByToken } = await import("./session.ts");
const { handleInterviewPurge } = await import("./purge.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const DAY = 86_400_000;
const CO = "7aad434d-0000-4000-8000-0000000000d1";
const OTHER_CO = "7aad434d-0000-4000-8000-0000000000d2";
const JOB = "2d4a8cde-0000-4000-8000-0000000000d1";
const APP = "03e4863f-0000-4000-8000-0000000000d1";
/** The same person's other application, in the same company. */
const SAME_PERSON = "03e4863f-0000-4000-8000-0000000000d2";
const ASYNC = "5b0f2c1e-0000-4000-8000-0000000000d1";
const ASYNC_OPEN = "5b0f2c1e-0000-4000-8000-0000000000d2";
const LIVE_1 = "5b0f2c1e-0000-4000-8000-0000000000d3";
const LIVE_2 = "5b0f2c1e-0000-4000-8000-0000000000d4";
const KEEP = "5b0f2c1e-0000-4000-8000-0000000000d5";
/** Another company's session, carrying this application's id: never this application's. */
const FOREIGN = "5b0f2c1e-0000-4000-8000-0000000000d6";
const ANSWER = "a1a1a1a1-0000-4000-8000-0000000000d1";
const KEEP_ANSWER = "a1a1a1a1-0000-4000-8000-0000000000d2";
const TURN = "b2b2b2b2-0000-4000-8000-0000000000d1";
const MINE = [ASYNC, ASYNC_OPEN, LIVE_1, LIVE_2];
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

const session = (id, over) => ({
  id,
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  kind: "async",
  status: "submitted",
  attempt: 1,
  previous_attempt_id: null,
  token_hash: hashSessionToken(`token-for-${id}-0123456789`),
  expires_at: future(5),
  delete_after: future(180),
  consent_at: "2026-10-21T09:00:00.000Z",
  consent_version: "live-v1",
  live_ended_at: null,
  questions_snapshot: [],
  ...over,
});

function world() {
  const db = fakeLiveDb({
    companies: [
      { id: CO, name: "Northwind" },
      { id: OTHER_CO, name: "Elsewhere" },
    ],
    job_applications: [
      { id: APP, company_id_snapshot: CO, job_id: JOB, email: "sam@example.com" },
      { id: SAME_PERSON, company_id_snapshot: CO, job_id: JOB, email: "sam@example.com" },
    ],
    interview_sessions: [
      session(ASYNC),
      session(ASYNC_OPEN, { status: "invited" }),
      session(LIVE_1, { kind: "live", status: "abandoned", live_ended_at: "2026-10-28T09:00:00Z" }),
      session(LIVE_2, {
        kind: "live",
        status: "started",
        attempt: 2,
        previous_attempt_id: LIVE_1,
        started_at: new Date().toISOString(),
      }),
      session(KEEP, { application_id: SAME_PERSON }),
      session(FOREIGN, { company_id: OTHER_CO }),
    ],
    interview_answers: [
      {
        id: ANSWER,
        session_id: ASYNC,
        position: 1,
        video_path: `${ASYNC}/q1.webm`,
        transcript: "words",
        transcript_status: "pending",
        recorded_at: "2026-10-28T10:00:00.000Z",
      },
      { id: KEEP_ANSWER, session_id: KEEP, position: 1, video_path: `${KEEP}/q1.webm` },
    ],
    interview_session_scores: [{ session_id: ASYNC }, { session_id: KEEP }],
    interview_turns: [
      {
        id: TURN,
        session_id: LIVE_2,
        sequence: 2,
        speaker: "candidate",
        media_path: `${LIVE_2}/t2.wav`,
        media_mime_type: "audio/wav",
        transcript_status: "pending",
      },
    ],
    live_interview_scores: [{ session_id: LIVE_2 }],
    live_interview_actions: [{ id: "act-1", session_id: LIVE_2, action: "resolve_needs_check" }],
    live_session_events: [{ id: "ev-1", session_id: LIVE_2, kind: "tab_closed" }],
    live_video_pieces: [
      {
        id: "pc-1",
        session_id: LIVE_2,
        piece_index: 0,
        status: "confirmed",
        media_path: `${LIVE_2}/v0.webm`,
      },
    ],
    signed_url_logs: [{ id: "log-1", candidate_id: APP, source_table: "interview_answers" }],
    admin_access_logs: [{ id: "adm-1", session_id: LIVE_2, company_id: CO, application_id: APP }],
    usage_events: [{ id: "use-1", company_id: CO, type: "interview_sent" }],
    background_jobs: [
      {
        id: "j1",
        type: "transcribe",
        status: "queued",
        payload: { answerId: ANSWER, recordedAt: "x" },
      },
      {
        id: "j2",
        type: "transcribe",
        status: "queued",
        payload: { turnId: TURN, sessionId: LIVE_2, round: 1 },
      },
      { id: "j3", type: "ai_scorecard", status: "queued", payload: { sessionId: ASYNC } },
      { id: "j4", type: "ai_scorecard", status: "queued", payload: { sessionId: KEEP } },
      {
        id: "j5",
        type: "transcribe",
        status: "running",
        payload: { turnId: TURN, sessionId: LIVE_2, round: 0 },
      },
    ],
  });
  for (const path of [
    `${ASYNC}/q1.webm`,
    `${ASYNC_OPEN}/q1.webm`,
    `${LIVE_1}/t1.wav`,
    `${LIVE_2}/t2.wav`,
    `${LIVE_2}/v0.webm`,
    `${KEEP}/q1.webm`,
    `${FOREIGN}/q1.webm`,
  ]) {
    db.objects.set(path, {
      bytes: new Uint8Array([1]),
      contentType: "video/webm",
      createdAt: Date.now(),
    });
  }
  globalThis.__deletionService = db.service;
  return db;
}

const quiet = async (fn) => {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};
const run = (db, target = { companyId: CO, applicationId: APP }) =>
  quiet(() => deleteApplicationInterviews(db.service, target.companyId, target.applicationId));
const sessionIds = (db) => db.tables.interview_sessions.map((s) => s.id).sort();
const folder = (db, id) => [...db.objects.keys()].filter((p) => p.startsWith(`${id}/`));

test("B7: every interview of the application goes: async and live, every attempt, files then rows, children by cascade", async () => {
  const db = world();
  const result = await run(db);
  assert.deepEqual(result, { ok: true, sessions: 4 });
  assert.deepEqual(sessionIds(db), [KEEP, FOREIGN].sort());
  for (const id of MINE) assert.deepEqual(folder(db, id), [], `files of ${id}`);
  const of = (table) => db.tables[table].map((r) => r.session_id);
  assert.deepEqual(of("interview_answers"), [KEEP]);
  assert.deepEqual(of("interview_session_scores"), [KEEP]);
  for (const table of [
    "interview_turns",
    "live_interview_scores",
    "live_interview_actions",
    "live_session_events",
    "live_video_pieces",
  ]) {
    assert.deepEqual(of(table), [], table);
  }
  // The access logs (ids only) and the allowance's usage are not touched.
  assert.equal(db.tables.signed_url_logs.length, 1);
  assert.equal(db.tables.admin_access_logs.length, 1);
  assert.deepEqual(db.tables.usage_events, [
    { id: "use-1", company_id: CO, type: "interview_sent" },
  ]);
  // Their queued jobs failed; another application's stays queued; a running one is left to find nothing.
  const job = (id) => db.tables.background_jobs.find((j) => j.id === id);
  for (const id of ["j1", "j2", "j3"]) {
    assert.deepEqual([job(id).status, job(id).last_error], ["failed", SESSION_DELETED], id);
  }
  assert.equal(job("j4").status, "queued");
  assert.equal(job("j5").status, "running");
});

test("B7: the same person's other application, and its interview, are untouched", async () => {
  const db = world();
  await run(db);
  assert.ok(sessionIds(db).includes(KEEP));
  assert.deepEqual(folder(db, KEEP), [`${KEEP}/q1.webm`]);
  assert.ok(db.tables.interview_answers.some((a) => a.id === KEEP_ANSWER));
  assert.ok(db.tables.job_applications.some((a) => a.id === SAME_PERSON));
});

test("B7: another company's session is never touched, even carrying this application's id", async () => {
  const db = world();
  await run(db);
  const foreign = db.tables.interview_sessions.find((s) => s.id === FOREIGN);
  assert.equal(foreign.status, "submitted");
  assert.ok(Date.parse(foreign.delete_after) > Date.now(), "not closed");
  assert.deepEqual(folder(db, FOREIGN), [`${FOREIGN}/q1.webm`]);
  // And asking for this application from the other company finds nothing of this company's.
  const db2 = world();
  assert.deepEqual(await run(db2, { companyId: OTHER_CO, applicationId: APP }), {
    ok: true,
    sessions: 1,
  });
  assert.deepEqual(sessionIds(db2), [ASYNC, ASYNC_OPEN, LIVE_1, LIVE_2, KEEP].sort());
});

test("B7: a file that will not delete: nothing else is deleted, an honest message, and the retry finishes", async () => {
  const db = world();
  db.failRemove(`${LIVE_2}/v0.webm`);
  const first = await run(db);
  assert.deepEqual(first, { ok: false, error: FILES_LEFT });
  assert.equal(FILES_LEFT, "Some files could not be deleted yet - try again.");
  assert.deepEqual(sessionIds(db), [...MINE, KEEP, FOREIGN].sort(), "every row kept for the retry");
  assert.equal(db.tables.live_video_pieces.length, 1);
  // Closed, with existing states: retention over, open ones cancelled, terminal ones as they were.
  const status = (id) => db.tables.interview_sessions.find((s) => s.id === id);
  for (const id of MINE) assert.ok(Date.parse(status(id).delete_after) <= Date.now(), id);
  assert.deepEqual(
    MINE.map((id) => status(id).status),
    ["submitted", "cancelled", "abandoned", "cancelled"],
  );
  const again = await run(db);
  assert.deepEqual(again, { ok: true, sessions: 4 });
  assert.deepEqual(sessionIds(db), [KEEP, FOREIGN].sort());
  for (const id of MINE) assert.deepEqual(folder(db, id), []);
  // Once done, asking again is harmless.
  assert.deepEqual(await run(db), { ok: true, sessions: 0 });
});

test("B7: once deletion has started, uploads, transcription, scoring and exports are refused", async () => {
  const db = world();
  const reserve = () =>
    quiet(() =>
      reservePieceUpload(
        { token: `token-for-${LIVE_2}-0123456789`, piece: 1, mimeType: "video/webm" },
        { service: db.service },
      ),
    );
  // A piece reserved while the interview ran: the 30-minute window after an end would still
  // hand it a fresh upload URL.
  assert.equal((await reserve()).status, 200);
  db.failRemove(`${LIVE_2}/v0.webm`);
  await run(db);
  const live2 = db.tables.interview_sessions.find((s) => s.id === LIVE_2);
  assert.ok(live2.live_ended_at, "the cancel stamped the end: the window would be open");
  assert.equal((await reserve()).status, 409, "no upload URL once deletion has started");
  // The async link reads cancelled, which every candidate route refuses.
  const resolved = await resolveSessionByToken(`token-for-${ASYNC_OPEN}-0123456789`);
  assert.equal(resolved.session.state, "cancelled");
  // No new transcription job, no transcription run, no OpenAI call.
  const queued = await queueLiveTranscription(db.service, LIVE_2, async () => {
    throw new Error("must not enqueue");
  });
  assert.deepEqual(queued, { queued: 0, alreadyQueued: 0, failed: 0 });
  let whisper = 0;
  await quiet(() =>
    handleLiveTurnTranscribe(
      { id: "j9", payload: { turnId: TURN, sessionId: LIVE_2 } },
      undefined,
      {
        service: db.service,
        transcribe: async () => {
          whisper += 1;
          return { text: "x", segments: [] };
        },
      },
    ),
  );
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    throw new Error("no network in tests");
  };
  try {
    await quiet(() =>
      handleTranscribe({
        id: "j8",
        payload: { answerId: ANSWER, recordedAt: "2026-10-28T10:00:00.000Z" },
      }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(whisper, 0);
  assert.deepEqual(fetches, []);
  // No new scoring.
  const before = process.env.LIVE_INTERVIEW_SCORING_ENABLED;
  process.env.LIVE_INTERVIEW_SCORING_ENABLED = "true";
  try {
    assert.equal(
      await requestLiveScoring(db.service, LIVE_2, async () => {
        throw new Error("must not enqueue");
      }),
      false,
    );
  } finally {
    if (before === undefined) delete process.env.LIVE_INTERVIEW_SCORING_ENABLED;
    else process.env.LIVE_INTERVIEW_SCORING_ENABLED = before;
  }
  // No export saved, so no audio stored.
  const uploads = db.objects.size;
  await assert.rejects(
    quiet(() =>
      saveLiveExport(
        LIVE_2,
        { ...parseExport(FIXTURE), provider_session_id: FIXTURE.session_id },
        {
          service: db.service,
          fetchAudio: async () => {
            throw new Error("must not fetch audio");
          },
          now: () => Date.now(),
        },
      ),
    ),
    (err) => err.code === "past_retention",
  );
  assert.equal(db.objects.size, uploads);
});

test("B7: a file that arrives after the delete is in a folder nothing references: the orphan sweep removes it", async () => {
  const db = world();
  await run(db);
  const late = `${LIVE_2}/v1.webm`;
  db.objects.set(late, {
    bytes: new Uint8Array([1]),
    contentType: "video/webm",
    createdAt: Date.now(),
  });
  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));
  assert.ok(db.objects.has(late), "inside the 24-hour grace: kept, as for any upload");
  db.age(late, 2 * DAY);
  await quiet(() => handleInterviewPurge({ id: "purge-2", payload: {} }));
  assert.equal(db.objects.has(late), false);
  assert.deepEqual(folder(db, KEEP), [`${KEEP}/q1.webm`], "a live session's files are kept");
});

test("B7: an application with no interviews: nothing is written", async () => {
  const db = world();
  const before = structuredClone(db.tables);
  assert.deepEqual(
    await run(db, { companyId: CO, applicationId: "03e4863f-0000-4000-8000-0000000000ff" }),
    { ok: true, sessions: 0 },
  );
  assert.deepEqual(db.tables, before);
});

/* ── both applicant deletions use it ─────────────────────────────── */

const source = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const COMPANY = source("../../app/ai-dashboard/(gated)/applicants/actions.ts");
const ADMIN = source("../../app/admin/applications/actions.ts");

/** The body of `export async function deleteApplication(` in a file. */
function deleteApplicationBody(src) {
  const start = src.indexOf("export async function deleteApplication(");
  assert.ok(start >= 0, "deleteApplication is exported");
  const end = src.indexOf("\nexport ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("B7 wiring: the company's and the super admin's applicant delete both call the service before the row goes", () => {
  for (const [label, src] of [
    ["company", COMPANY],
    ["super admin", ADMIN],
  ]) {
    assert.match(
      src,
      /import \{ deleteApplicationInterviews \} from "@\/lib\/interviews\/application-deletion";/,
      label,
    );
    const body = deleteApplicationBody(src);
    const service = body.indexOf("deleteApplicationInterviews(");
    const rowDelete = body.search(/\.from\("job_applications"\)\s*\.delete\(\)/);
    assert.ok(service > 0 && rowDelete > service, `${label}: interviews first, then the row`);
    assert.match(
      body,
      /if \(!interviews\.ok\) return \{ success: false, error: interviews\.error \};/,
    );
  }
  // The super admin's also removes the CV file and the final-interview recordings now.
  const admin = deleteApplicationBody(ADMIN);
  const rowDelete = admin.search(/\.from\("job_applications"\)\s*\.delete\(\)/);
  const files = admin.indexOf("removeApplicationFiles(");
  assert.ok(files > 0 && files < rowDelete, "super admin: removeApplicationFiles before the row");
  // Scope first: the super admin reads the application within its scope before deleting anything.
  assert.ok(admin.indexOf(".or(scope)") < admin.indexOf("deleteApplicationInterviews("));
});

test("B7 wiring: the allowance is never touched by a deletion", () => {
  const service = source("./application-deletion.ts");
  assert.doesNotMatch(
    service,
    /usage_events|consume_allowance|release_allowance|interview-allowance/,
  );
});
