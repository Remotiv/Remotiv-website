/**
 * deleteInterview on a restarted AI Video Interview (F10 C6c): either
 * attempt's id deletes both attempts, every file and every child row, or
 * nothing. A session with no restart is deleted exactly as before.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/delete-restart-chain.test.ts"
 *
 * deleteInterview, application-deletion.ts's shared steps and the purge's
 * removeSessionObjects are the shipped code; the company context and the
 * hiring team are stubbed below; the database and storage are fake-live-db.mjs,
 * which refuses a first attempt deleted without its restart (migration 020's
 * previous_attempt_fk) and cascades a session's children. Set
 * DELETE_TRACE_OUT to write the no-restart cases' trace, for a diff against
 * HEAD's deleteInterview. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__deleteService; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__deleteCtx; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return globalThis.__deleteScope; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function canAccessJob(ctx, jobId) { const a = globalThis.__deleteTeam; return a ? a.includes(jobId) : true; }",
  ].join("\\n"),
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return false; }",
  "@/lib/interviews/review": "export async function listInterviewSessions() {} export async function readNotes() {}",
  "@/lib/interviews/scorecard": "export async function readScorecardFacts() {} export async function requestScorecard() {} export function scorecardRecoveryEligibility() {}",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven() { return true; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { deleteInterview } = await import("./actions.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000c6";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000c7";
const JOB = "b0000000-0000-4000-8000-0000000000c6";
const OTHER_JOB = "b0000000-0000-4000-8000-0000000000c7";
const APP = "a0000000-0000-4000-8000-0000000000c6";
const L1 = "d0000000-0000-4000-8000-0000000000c1";
const L2 = "d0000000-0000-4000-8000-0000000000c2";
const KEEP = "d0000000-0000-4000-8000-0000000000c3";
const FOREIGN = "d0000000-0000-4000-8000-0000000000c4";
const ASYNC = "d0000000-0000-4000-8000-0000000000c5";
const SOLO = "d0000000-0000-4000-8000-0000000000c8";
const NOT_YOURS = "That interview isn't in your workspace.";
const CANNOT =
  "Only an owner, admin, or someone on this job's hiring team can delete an interview.";
const LIVE_CHILDREN = [
  "interview_turns",
  "live_interview_scores",
  "live_interview_actions",
  "live_session_events",
  "live_video_pieces",
];

const session = (id, over = {}) => ({
  id,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind: "live",
  attempt: 1,
  previous_attempt_id: null,
  status: "invited",
  provider: null,
  provider_session_id: null,
  started_at: null,
  live_ended_at: null,
  delete_after: "2027-04-01T00:00:00.000Z",
  ...over,
});
const children = (id) => ({
  interview_turns: [{ id: `turn-${id}`, session_id: id, sequence: 1, media_path: `${id}/t1.wav` }],
  live_interview_scores: [{ session_id: id }],
  live_interview_actions: [{ id: `act-${id}`, session_id: id, action: "decide_restart" }],
  live_session_events: [{ id: `ev-${id}`, session_id: id, kind: "tab_closed" }],
  live_video_pieces: [
    { id: `pc-${id}`, session_id: id, piece_index: 0, media_path: `${id}/v0.webm` },
  ],
});

/** A restarted interview (L1 abandoned, L2 invited) beside other interviews that must stay. */
function world({ sessions, ctx = {}, scope = { scoped: false, jobIds: [] }, team = null } = {}) {
  const rows = sessions ?? [
    session(L1, {
      status: "abandoned",
      started_at: "2026-10-30T09:00:00.000Z",
      provider_session_id: "provider-1",
      live_ended_at: "2026-10-30T09:20:00.000Z",
    }),
    session(L2, { attempt: 2, previous_attempt_id: L1 }),
    session(KEEP),
    session(FOREIGN, { company_id: OTHER_CO, job_id: OTHER_JOB }),
  ];
  const kids = Object.fromEntries(LIVE_CHILDREN.map((t) => [t, []]));
  for (const r of rows) {
    for (const [t, list] of Object.entries(children(r.id))) kids[t].push(...list);
  }
  const db = fakeLiveDb({
    interview_sessions: rows,
    ...kids,
    background_jobs: rows.flatMap((r) => [
      { id: `job-t-${r.id}`, type: "transcribe", status: "queued", payload: { sessionId: r.id } },
      { id: `job-s-${r.id}`, type: "ai_scorecard", status: "queued", payload: { sessionId: r.id } },
    ]),
  });
  for (const r of rows) {
    for (const name of ["t1.wav", "v0.webm"]) {
      db.objects.set(`${r.id}/${name}`, {
        bytes: new Uint8Array([1]),
        contentType: "x",
        createdAt: new Date(),
      });
    }
  }
  // Every step, in order: table writes and storage removals.
  db.steps = [];
  const from = db.service.from.bind(db.service);
  db.service.from = (table) => {
    db.steps.push({ step: "query", at: db.service.queries.length, table });
    return from(table);
  };
  const storageFrom = db.service.storage.from.bind(db.service.storage);
  db.service.storage.from = (bucket) => {
    const b = storageFrom(bucket);
    return {
      ...b,
      remove: async (paths) => {
        db.steps.push({ step: "remove", paths: [...paths].sort() });
        return b.remove(paths);
      },
    };
  };
  globalThis.__deleteService = db.service;
  globalThis.__deleteCtx = {
    companyId: CO,
    role: "owner",
    memberId: "m-1",
    user: { id: "u-1" },
    ...ctx,
  };
  globalThis.__deleteScope = scope;
  globalThis.__deleteTeam = team;
  return db;
}

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}
const del = (id) => quietly(() => deleteInterview(id));
const ids = (db) => db.tables.interview_sessions.map((s) => s.id).sort();
const files = (db, id) => [...db.objects.keys()].filter((k) => k.startsWith(`${id}/`)).sort();
const kidsOf = (db, id) =>
  LIVE_CHILDREN.filter((t) => db.tables[t].some((r) => r.session_id === id));
/** The query steps as [table, write op or "read"], resolved after the fact. */
const writes = (db) =>
  db.steps.map((s) => {
    if (s.step === "remove") return ["storage", "remove", s.paths];
    const calls = db.service.queries[s.at].calls;
    const w = calls.find((c) => ["insert", "update", "upsert", "delete"].includes(c[0]));
    return w ? [s.table, w[0], w[1] ?? null, calls.filter((c) => c !== w)] : [s.table, "read"];
  });

function assertChainGone(db) {
  assert.deepEqual(ids(db), [FOREIGN, KEEP].sort(), "both attempts gone, the others kept");
  for (const id of [L1, L2]) {
    assert.deepEqual(files(db, id), [], `${id}: every file gone`);
    assert.deepEqual(kidsOf(db, id), [], `${id}: every child row gone`);
  }
  for (const id of [KEEP, FOREIGN]) {
    assert.equal(files(db, id).length, 2, `${id}: files kept`);
    assert.equal(kidsOf(db, id).length, LIVE_CHILDREN.length, `${id}: children kept`);
  }
}

// ── a, b: either id ─────────────────────────────────────────

test("a: deleting by attempt 1's id deletes both attempts, their files and their child rows", async () => {
  const db = world();
  assert.deepEqual(await del(L1), { ok: true });
  assertChainGone(db);
});

test("b: deleting by attempt 2's id deletes both: attempt 1 is never left behind", async () => {
  const db = world();
  assert.deepEqual(await del(L2), { ok: true });
  assertChainGone(db);
});

// ── c: a file that will not go ──────────────────────────────

test("c: a file that cannot be deleted keeps every row and says try again; the retry finishes", async () => {
  const db = world();
  db.failRemove(`${L2}/t1.wav`);
  assert.deepEqual(await del(L1), {
    ok: false,
    error:
      "Some recordings couldn't be deleted. The interview records were kept - please try again.",
  });
  assert.deepEqual(ids(db), [FOREIGN, KEEP, L1, L2].sort(), "no row deleted");
  assert.deepEqual(kidsOf(db, L1), LIVE_CHILDREN);
  assert.deepEqual(kidsOf(db, L2), LIVE_CHILDREN);
  assert.ok(!writes(db).some(([t, op]) => t === "interview_sessions" && op === "delete"));
  assert.deepEqual(await del(L2), { ok: true }, "a retry finishes the job");
  assertChainGone(db);
});

// ── d: another company ──────────────────────────────────────

test("d: another company's attempt id is not found, and nothing is touched", async () => {
  const db = world();
  const before = structuredClone(db.tables);
  const objects = [...db.objects.keys()].sort();
  assert.deepEqual(await del(FOREIGN), { ok: false, error: NOT_YOURS });
  assert.deepEqual(db.tables, before);
  assert.deepEqual([...db.objects.keys()].sort(), objects);
});

test("d: every session read on the way, the chain lookup included, is filtered to the company", async () => {
  const db = world();
  await del(L2);
  const reads = db.service.queries.filter(
    (q) => q.table === "interview_sessions" && q.calls.some((c) => c[0] === "select"),
  );
  assert.ok(reads.length >= 3, "the gate, the chain and the deletion's reads");
  for (const q of reads) {
    assert.ok(
      q.calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO),
      JSON.stringify(q.calls),
    );
  }
});

// ── e: the checks apply to every attempt ────────────────────

test("e: a viewer who may not delete one attempt is refused, and nothing is touched", async () => {
  const cases = [
    // attempt 2 on a job outside a hiring manager's scope: the gate refuses it
    ["scope", { role: "hiring_manager" }, { scoped: true, jobIds: [JOB] }, null, NOT_YOURS],
    // within scope, but not on that job's hiring team: deleting refuses it
    ["team", { role: "recruiter" }, { scoped: true, jobIds: [JOB, OTHER_JOB] }, [JOB], CANNOT],
  ];
  for (const [name, ctx, scope, team, error] of cases) {
    const rows = [
      session(L1, { status: "abandoned", live_ended_at: "2026-10-30T09:20:00.000Z" }),
      session(L2, { attempt: 2, previous_attempt_id: L1, job_id: OTHER_JOB }),
    ];
    for (const asked of [L1, L2]) {
      const db = world({ sessions: rows, ctx, scope, team });
      const before = structuredClone(db.tables);
      const objects = [...db.objects.keys()].sort();
      const r = await del(asked);
      assert.equal(r.ok, false, `${name} ${asked}`);
      if (asked === L1) assert.equal(r.error, error, name);
      assert.deepEqual(db.tables, before, `${name} ${asked}: nothing touched`);
      assert.deepEqual([...db.objects.keys()].sort(), objects);
    }
  }
});

// ── f: no restart, as before ────────────────────────────────

const traces = {};
after(() => {
  if (process.env.DELETE_TRACE_OUT) {
    writeFileSync(process.env.DELETE_TRACE_OUT, `${JSON.stringify(traces, null, 2)}\n`);
  }
});

test("f: an async session, and a live one never restarted, are deleted exactly as before", async () => {
  const cases = {
    async: [session(ASYNC, { kind: "async" }), session(KEEP)],
    "live, no restart": [session(SOLO), session(KEEP)],
  };
  for (const [name, rows] of Object.entries(cases)) {
    const db = world({ sessions: rows });
    const id = rows[0].id;
    const result = await del(id);
    assert.deepEqual(result, { ok: true }, name);
    assert.deepEqual(ids(db), [KEEP], name);
    assert.deepEqual(files(db, id), []);
    const w = writes(db).filter(([, op]) => op !== "read");
    assert.deepEqual(
      w.map(([t, op]) => [t, op]),
      [
        ["storage", "remove"],
        ["interview_sessions", "delete"],
      ],
      `${name}: no close and no job failed, as before`,
    );
    assert.deepEqual(
      db.tables.background_jobs.filter((j) => j.status !== "queued"),
      [],
      `${name}: queued jobs untouched, as before`,
    );
    traces[name] = { result, writes: w };

    const kept = world({ sessions: rows });
    kept.failRemove(`${id}/v0.webm`);
    const refused = await del(id);
    assert.deepEqual(refused, {
      ok: false,
      error: "1 recording couldn't be deleted, so nothing was removed. Please try again.",
    });
    assert.deepEqual(ids(kept), [id, KEEP].sort());
    traces[`${name}, file left`] = {
      result: refused,
      writes: writes(kept).filter(([, op]) => op !== "read"),
    };
  }
});

// ── g: queued jobs ──────────────────────────────────────────

test("g: both attempts' queued transcription and scoring jobs are failed before any file or row goes", async () => {
  const db = world();
  assert.deepEqual(await del(L1), { ok: true });
  for (const id of [L1, L2]) {
    for (const type of ["transcribe", "ai_scorecard"]) {
      const job = db.tables.background_jobs.find(
        (j) => j.type === type && j.payload.sessionId === id,
      );
      assert.deepEqual(
        [job.status, job.last_error],
        ["failed", "session deleted"],
        `${type} ${id}`,
      );
    }
  }
  for (const id of [KEEP, FOREIGN]) {
    assert.ok(
      db.tables.background_jobs
        .filter((j) => j.payload.sessionId === id)
        .every((j) => j.status === "queued"),
      `${id}: its jobs untouched`,
    );
  }
  const steps = writes(db).filter(([, op]) => op !== "read");
  const firstJob = steps.findIndex(([t]) => t === "background_jobs");
  const firstRemove = steps.findIndex(([t]) => t === "storage");
  const rowDelete = steps.findIndex(([t, op]) => t === "interview_sessions" && op === "delete");
  assert.ok(
    firstJob >= 0 && firstJob < firstRemove && firstRemove < rowDelete,
    JSON.stringify(steps.map(([t, op]) => [t, op])),
  );
  // Closed first: an open attempt is cancelled, the abandoned one is never written to.
  const close = steps.filter(([t, op]) => t === "interview_sessions" && op === "update");
  assert.equal(close.length, 2, "delete_after, then the open ones cancelled");
  assert.deepEqual(
    close[1][3].find((c) => c[0] === "in" && c[1] === "status"),
    ["in", "status", ["invited", "started"]],
  );
});
