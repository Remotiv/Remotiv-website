// @ts-nocheck
/**
 * The interview purge's marker, its keyset paging and its report (#59).
 *
 *   node --test src/lib/interview-purge-decay.test.ts
 *
 * Lives beside lib/interviews rather than in it: that directory is another
 * session's during this change, and only purge.ts itself was touched there.
 *
 * What #59 measured on staging: 36 to 45 sessions per 18-second run, every run
 * ending "budget reached", because nothing marked a purged session and every
 * run re-walked the whole purged history first. The fix is `purged_at`
 * (migration 051): a finished session leaves the filter. That makes the loop
 * WRITE the table it pages, so it now pages by key on (delete_after, id)
 * with the cursor on the last row read, the #55a shape. The fake table here
 * is the same adversary as cv-purge.test.ts: every write moves the row, and a
 * `between` hook moves rows the loop has not read yet. Assertions are by ID
 * SET, never by count. The fake table does not need the real column: a row
 * without `purged_at` reads as null, as a freshly added column does.
 *
 * The negative controls in scripts/staging/negative-controls.mjs revert the
 * marker filter, the marker write, the `id` order key, the late-words sweep,
 * its place ahead of Phase 1, and the incomplete result, and require the
 * tests named there to go red.
 *
 * FOR WHOEVER EXTENDS THE OTHER FOUR: purge-turns, live-video,
 * async-score-purge and copy-honesty drive this handler through
 * test-support/fake-live-db.mjs, which ignores order, limit and gte and
 * parses or() only for `col.is.null` forms. Their fixtures never fill a page,
 * so they never build the cursor and prove nothing about paging. Paging is
 * proven here and nowhere else.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));

const { FakeTable, FakeStorage, fakeClient } = await import("./supabase/fake-table.ts");
const { runInterviewPurge, describeInterviewPurge, runInterviewOrphanSweep, handleInterviewPurge } =
  await import("./interviews/purge.ts");
const { TerminalJobError } = await import("./queue/failure-class.ts");

const PAST = "2026-04-01T00:00:00+00:00";

/** `n` due sessions sharing one delete_after, each with one answer holding a transcript. */
function world(n, over = () => ({})) {
  const sessions = Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(5, "0")}`,
    delete_after: PAST,
    purged_at: null,
    ...over(i),
  }));
  const answers = sessions.map((s, i) => ({
    id: `a-${i}`,
    session_id: s.id,
    video_path: null,
    transcript: `words of ${s.id}`,
    transcript_segments: null,
  }));
  return { sessions, answers };
}

/**
 * The service the purge builds for itself, through the test hook. Storage is
 * FakeStorage (lib/supabase/fake-table.ts): Supabase's list() semantics
 * exactly, 100 entries unless a limit is passed, offset-paged, folders that
 * vanish when emptied. `objects` maps a session folder to its object names;
 * `confirmable` is unused since the fake confirms every object it holds, and a
 * path NOT in the fake is the "storage cannot confirm" case.
 */
function install(tables, storage = {}) {
  const objects = {};
  for (const [folder, names] of storage.objects ?? new Map()) {
    objects[folder] = names.map((name) => ({ name }));
  }
  const bucket = new FakeStorage(objects);
  const client = Object.assign(fakeClient(tables), { storage: bucket });
  globalThis.__fakeServiceClientForTests = () => client;
  return { client, removed: bucket.removed, bucket };
}

function tablesFor(w, extra = {}) {
  return {
    interview_sessions: new FakeTable(w.sessions),
    interview_answers: new FakeTable(w.answers),
    interview_turns: new FakeTable([]),
    live_video_pieces: new FakeTable([]),
    live_interview_scores: new FakeTable([]),
    interview_answer_scores: new FakeTable([]),
    interview_session_scores: new FakeTable([]),
    background_jobs: new FakeTable([]),
    ...extra,
  };
}

function captureLog() {
  const log = [];
  const warns = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (...args) => {
    log.push(args.map(String).join(" "));
  };
  console.warn = (...args) => {
    warns.push(args.map(String).join(" "));
  };
  return { log, warns, restore: () => Object.assign(console, original) };
}

async function run(job, opts) {
  const { log, warns, restore } = captureLog();
  try {
    const result = await runInterviewPurge({ id: job, payload: {} }, opts);
    return { result, log, warns };
  } finally {
    restore();
  }
}

const ids = (rows) => new Set(rows.map((r) => String(r.id)));
/** Phase 1's page reads select delete_after; nothing else on the table does. */
const isSessionPage = (returned) => returned.length > 0 && "delete_after" in returned[0];

/* ── the marker ───────────────────────────────────────────── */

test("#59: a finished session is stamped purged_at, and its words are gone", async () => {
  const w = world(10);
  const t = tablesFor(w);
  install(t);
  const { result, log } = await run("p1");

  assert.deepEqual(
    ids(t.interview_sessions.rows.filter((s) => s.purged_at !== null)),
    ids(w.sessions),
    "every due session carries the marker",
  );
  assert.deepEqual(
    t.interview_answers.rows.filter((a) => a.transcript !== null).map((a) => a.id),
    [],
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    {
      examined: result.sessionsExamined,
      marked: result.sessionsMarked,
      retrying: result.sessionsRetrying,
      answers: result.answersCleared,
    },
    { examined: 10, marked: 10, retrying: 0, answers: 10 },
  );
  assert.match(log[0], /COMPLETE in \d+ ms: sessions examined=10 marked=10 retrying=0/);
});

test("#59: a session whose object storage cannot confirm gone is NOT stamped, and is counted as retrying", async () => {
  const w = world(10);
  const stuck = w.sessions[3].id;
  w.answers[3].video_path = `${stuck}/answer.webm`;
  const t = tablesFor(w);
  const { bucket } = install(t, { objects: new Map([[stuck, ["answer.webm"]]]) });
  // Storage lists the object but will not confirm its removal.
  const from = bucket.from.bind(bucket);
  bucket.from = (b) => {
    const real = from(b);
    return { ...real, remove: async () => ({ data: [], error: null }) };
  };
  const { result } = await run("p2");

  const marked = ids(t.interview_sessions.rows.filter((s) => s.purged_at !== null));
  assert.equal(marked.has(stuck), false, "the stuck session keeps purged_at null");
  assert.deepEqual(marked, ids(w.sessions.filter((s) => s.id !== stuck)));
  assert.equal(
    t.interview_answers.rows[3].video_path,
    `${stuck}/answer.webm`,
    "its path is kept for the retry",
  );
  assert.equal(t.interview_answers.rows[3].transcript, null, "its transcript still went");
  assert.deepEqual(
    { marked: result.sessionsMarked, retrying: result.sessionsRetrying },
    { marked: 9, retrying: 1 },
  );
});

test("#59: a stamped session is absent from the next run's read", async () => {
  const w = world(10);
  const t = tablesFor(w);
  install(t);
  await run("p3-first");

  let pageReads = 0;
  let rowsRead = 0;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) {
      pageReads += 1;
      rowsRead += returned.length;
    }
  };
  const { result } = await run("p3-second");
  assert.equal(rowsRead, 0, "no stamped session comes back to Phase 1");
  assert.equal(pageReads, 0);
  assert.equal(result.complete, true);
  assert.equal(result.sessionsExamined, 0);
});

/* ── multi-page, for the first time ───────────────────────── */

test("#59: page 2 is reached, and every session is stamped exactly once with a writer moving unread rows under the loop", async () => {
  const w = world(1200);
  const t = tablesFor(w);
  install(t);
  const read = new Set();
  const timesRead = new Map();
  let pages = 0;
  let k = 0;
  t.interview_sessions.between = (_n, returned) => {
    if (!isSessionPage(returned)) return;
    pages += 1;
    for (const r of returned) {
      read.add(r.id);
      timesRead.set(r.id, (timesRead.get(r.id) ?? 0) + 1);
    }
    // The second writer: move 40 sessions the loop has NOT read yet.
    const unread = w.sessions.map((s) => s.id).filter((id) => !read.has(id));
    const start = (k * 40) % Math.max(unread.length, 1);
    for (const id of unread.slice(start, start + 40)) t.interview_sessions.touch(id);
    k += 1;
  };
  const { result } = await run("p4");

  assert.ok(pages >= 3, `three pages of 500 were needed; ${pages} were read`);
  assert.deepEqual(
    ids(t.interview_sessions.rows.filter((s) => s.purged_at !== null)),
    ids(w.sessions),
  );
  assert.deepEqual(
    [...timesRead.entries()].filter(([, n]) => n > 1),
    [],
    "no session was read twice",
  );
  assert.equal(timesRead.size, 1200, "no session was missed");
  assert.deepEqual(
    { examined: result.sessionsExamined, marked: result.sessionsMarked },
    { examined: 1200, marked: 1200 },
  );
});

/* ── the backstop the marker must not remove ──────────────── */

test("#59: words a scorer writes after the purge are still cleared on the next run, without re-reading the session", async () => {
  const w = world(5);
  const t = tablesFor(w, {
    interview_answer_scores: new FakeTable([
      {
        answer_id: "a-2",
        session_id: w.sessions[2].id,
        reasoning: null,
        evidence: [],
        strengths: [],
        concerns: [],
        missing: [],
      },
    ]),
  });
  install(t);
  await run("p5-first");
  assert.equal(t.interview_sessions.rows[2].purged_at !== null, true);

  // The racing scorer lands after the stamp.
  t.interview_answer_scores.rows[0].reasoning = "written late";
  t.interview_answer_scores.rows[0].evidence = ["a quote"];
  let rowsRead = 0;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) rowsRead += returned.length;
  };
  const { result } = await run("p5-second");
  assert.equal(t.interview_answer_scores.rows[0].reasoning, null, "the late words are cleared");
  assert.deepEqual(t.interview_answer_scores.rows[0].evidence, []);
  assert.equal(rowsRead, 0, "Phase 1 did not re-read the stamped session");
  assert.equal(result.asyncScoresCleared, 1);
});

test("#59b: Phase 1b runs FIRST, so late words are cleared even when Phase 1 has far more work than the budget allows", async () => {
  const w = world(1200);
  // One session stamped three hours ago (inside the 24-hour window) whose
  // scorer wrote words after the stamp.
  const stampedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  w.sessions[7].purged_at = stampedAt;
  w.answers[7].transcript = null;
  const t = tablesFor(w, {
    interview_answer_scores: new FakeTable([
      {
        answer_id: "a-7",
        session_id: w.sessions[7].id,
        reasoning: "written after the stamp",
        evidence: ["a quote"],
        strengths: [],
        concerns: [],
        missing: [],
      },
    ]),
  });
  install(t);
  // The budget is gone the moment Phase 1 reads its first page: a backlog far
  // larger than one run, which is production today.
  let nowMs = 1_000_000;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) nowMs += 50_000;
  };
  const { result } = await run("p8", { budgetMs: 18_000, clock: () => nowMs });

  assert.equal(
    t.interview_answer_scores.rows[0].reasoning,
    null,
    "the late words were cleared before Phase 1 spent the budget",
  );
  assert.deepEqual(t.interview_answer_scores.rows[0].evidence, []);
  assert.equal(result.complete, false);
  assert.equal(result.stoppedDuring, "sessions", "Phase 1 is what ran out, not Phase 1b");
  assert.equal(result.asyncScoresClearedSoFar, 1);
});

/* ── #59c: the orphan sweep cannot be starved ─────────────── */

test("#59c: with Phase 1 over budget, the purge never reaches an orphan; the orphan-sweep job removes it anyway", async () => {
  const w = world(1200);
  // A session with a folder holding an upload no row names: the row write
  // failed after the upload, so nothing else will ever expire this recording.
  const orphanSession = "s-orphaned";
  const orphanPath = `${orphanSession}/answer.webm`;
  const t = tablesFor(w);
  const { removed } = install(t, { objects: new Map([[orphanSession, ["answer.webm"]]]) });
  let nowMs = 1_000_000;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) nowMs += 50_000;
  };
  const purge = await run("p9-purge", { budgetMs: 18_000, clock: () => nowMs });
  assert.equal(purge.result.complete, false);
  assert.deepEqual(removed, [], "the purge spent its budget on Phase 1 and never swept");

  const { log, restore } = captureLog();
  let result = null;
  try {
    result = await runInterviewOrphanSweep({ id: "p9-sweep", payload: {} });
  } finally {
    restore();
  }
  assert.deepEqual(removed, [orphanPath], "the separate job removed the orphan");
  assert.deepEqual(result, {
    complete: true,
    orphansRemoved: 1,
    foldersWalked: 1,
    elapsedMs: result.elapsedMs,
  });
  assert.match(log[0], /^\[orphan-sweep\] job p9-sweep: COMPLETE/);
});

test("#59c: the orphan sweep has its own recurring job, registered and scheduled", () => {
  const queue = readFileSync(new URL("./jobs-queue.ts", import.meta.url), "utf8");
  assert.match(queue, /INTERVIEW_ORPHAN_SWEEP: "interview_orphan_sweep",/);
  assert.match(
    queue,
    /registerHandler\(JOB_TYPES\.INTERVIEW_ORPHAN_SWEEP, handleInterviewOrphanSweep\);/,
  );
  assert.match(
    queue,
    /type: JOB_TYPES\.INTERVIEW_ORPHAN_SWEEP,\s*intervalMs: PURGE_INTERVAL_MS,\s*carry: \(last\) =>/,
    "scheduled daily, and the cursor is carried into the next job",
  );
});

/* ── #59b: the slice is a signal ──────────────────────────── */

/**
 * Phase 1b's cost, as staging measured it on 2026-10-30: every round trip
 * costs real time, and Phase 1b makes one per page of 500 stamped sessions
 * plus three score reads per chunk of 100. The earlier version of these tests
 * charged a fixed 7 s to the first read, which could not distinguish 20
 * stamped sessions from 800 and so could not catch the live failure. Here
 * every call on the tables Phase 1b touches costs `msPerCall` of the test's
 * clock, so the slice is exhausted exactly when the arithmetic says it is.
 */
const MS_PER_CALL = 230; // staging's median round trip inside Phase 1b
const anHourAgo = () => new Date(Date.now() - 3600 * 1000).toISOString();
// Pages: the loop reads until a page comes back short, so a count that fills
// its last page exactly costs one more, empty, read (500 stamped = 2 pages).
const expectedLateCalls = (stamped) => Math.floor(stamped / 500) + 1 + 3 * Math.ceil(stamped / 100);

function chargePerCall(t, msPerCall) {
  const clock = { nowMs: 1_000_000, lateCalls: 0, phase1Reads: 0 };
  let inPhase1 = false;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) {
      inPhase1 = true;
      clock.phase1Reads += 1;
    }
    clock.nowMs += msPerCall;
    if (!inPhase1) clock.lateCalls += 1;
  };
  for (const table of [
    "live_interview_scores",
    "interview_answer_scores",
    "interview_session_scores",
  ]) {
    t[table].between = () => {
      clock.nowMs += msPerCall;
      if (!inPhase1) clock.lateCalls += 1;
    };
  }
  return clock;
}

test("#59b: Phase 1b exhausting its slice is reported as an ALARM, and Phase 1 does not start", async () => {
  // 809 sessions stamped inside the window: the number at which staging's
  // alarm became deterministic. 2 pages + 3 x 9 chunks = 29 round trips at
  // 230 ms is 6.67 s, past the 6 s slice.
  const w = world(1200);
  for (let i = 0; i < 809; i += 1) w.sessions[i].purged_at = anHourAgo();
  const t = tablesFor(w);
  install(t);
  const clock = chargePerCall(t, MS_PER_CALL);
  const { result, log } = await run("p10", { budgetMs: 18_000, clock: () => clock.nowMs });
  assert.equal(result.complete, false);
  assert.equal(result.stoppedDuring, "late words");
  assert.equal(clock.phase1Reads, 0, "Phase 1 did not start");
  assert.equal(result.sessionsExaminedSoFar, 0);
  assert.equal(clock.lateCalls, expectedLateCalls(809), "pages + 3 x chunks round trips");
  assert.ok(result.elapsedMs > 6_000, `${result.elapsedMs} ms spent in Phase 1b`);
  assert.match(log[0], /ALARM, PHASE 1B DID NOT FINISH INSIDE ITS SLICE/);
  assert.match(log[0], /ALL PURGING HALTED THIS RUN/);
  assert.match(log[0], /Phase 1 DID NOT START/);
});

test("#59b: the slice holds for the sessions a day can stamp: 20 and 500 stamped sessions at the same round-trip cost fit, and Phase 1 runs", async () => {
  for (const stamped of [20, 500]) {
    const w = world(1200);
    for (let i = 0; i < stamped; i += 1) w.sessions[i].purged_at = anHourAgo();
    const t = tablesFor(w);
    install(t);
    const clock = chargePerCall(t, MS_PER_CALL);
    const { result } = await run(`p10-${stamped}`, { budgetMs: 18_000, clock: () => clock.nowMs });
    assert.notEqual(result.stoppedDuring, "late words", `${stamped} stamped: no alarm`);
    assert.equal(clock.lateCalls, expectedLateCalls(stamped), `${stamped} stamped: round trips`);
    assert.ok(clock.lateCalls * MS_PER_CALL < 6_000, `${stamped} stamped: inside the slice`);
    assert.ok(clock.phase1Reads > 0, `${stamped} stamped: Phase 1 started`);
    assert.ok(
      result.complete || result.sessionsExaminedSoFar > 0,
      `${stamped} stamped: Phase 1 did work`,
    );
  }
});

test("#59: above 500 sessions stamped in the window, Phase 1b logs ONE warning naming the ~800 ceiling and that the slice halts all purging; at 500 it logs none", async () => {
  const quiet = world(1200);
  for (let i = 0; i < 500; i += 1) quiet.sessions[i].purged_at = anHourAgo();
  install(tablesFor(quiet));
  const atLimit = await run("p-warn-500", { budgetMs: 18_000, clock: () => 1_000_000 });
  assert.deepEqual(atLimit.warns, [], "500 is the limit, not past it");

  const loud = world(1200);
  for (let i = 0; i < 600; i += 1) loud.sessions[i].purged_at = anHourAgo();
  const t = tablesFor(loud);
  install(t);
  const clock = chargePerCall(t, MS_PER_CALL);
  const { result, warns } = await run("p-warn-600", { budgetMs: 18_000, clock: () => clock.nowMs });
  assert.notEqual(result.stoppedDuring, "late words", "600 still fits the slice");
  assert.equal(warns.length, 1, "exactly one warning");
  assert.match(
    warns[0],
    /WARNING, Phase 1b read 600 sessions stamped in the last 24 hours, above 500/,
  );
  assert.match(warns[0], /about 800/);
  assert.match(warns[0], /halts ALL purging/);
});

/* ── #59b: the alarm fails the job ────────────────────────── */

test("#59b: on Phase 1b exhaustion the HANDLER throws a terminal configuration failure, so the job dies and the panel sees it", async () => {
  const w = world(1200);
  for (let i = 0; i < 809; i += 1) w.sessions[i].purged_at = anHourAgo();
  const t = tablesFor(w);
  install(t);
  const clock = chargePerCall(t, MS_PER_CALL);
  const { restore } = captureLog();
  try {
    await assert.rejects(
      handleInterviewPurge({ id: "p11", payload: {} }, undefined, {
        budgetMs: 18_000,
        clock: () => clock.nowMs,
      }),
      (err) => {
        assert.ok(
          err instanceof TerminalJobError,
          "a TerminalJobError, which planFailure buries on the spot",
        );
        assert.equal(err.failureClass, "configuration");
        assert.match(err.message, /ALARM, PHASE 1B DID NOT FINISH INSIDE ITS SLICE/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("#59b: a run that completes, or stops in Phase 1 for budget, does NOT fail the job", async () => {
  const w = world(1200);
  const t = tablesFor(w);
  install(t);
  let nowMs = 1_000_000;
  t.interview_sessions.between = (_n, returned) => {
    if (isSessionPage(returned)) nowMs += 50_000;
  };
  const { restore } = captureLog();
  try {
    await handleInterviewPurge({ id: "p12", payload: {} }, undefined, {
      budgetMs: 18_000,
      clock: () => nowMs,
    });
  } finally {
    restore();
  }
});

/* ── #59d: the orphan sweep pages the whole bucket ────────── */

const REFERENCED_FOLDERS = 120;
const ORPHAN_FOLDERS = 30;
const OBJECTS_PER_ORPHAN_FOLDER = 40;

/**
 * 120 session folders whose objects are referenced by answers, sorted BEFORE
 * 30 orphan folders with 40 unreferenced objects each: 1,200 orphan objects
 * behind more than one root page of folders that must be walked first.
 */
function orphanWorld() {
  const sessions = [];
  const answers = [];
  const objects = new Map();
  for (let i = 0; i < REFERENCED_FOLDERS; i += 1) {
    const id = `a-ref-${String(i).padStart(4, "0")}`;
    sessions.push({ id, delete_after: "2099-01-01T00:00:00+00:00", purged_at: null });
    answers.push({
      id: `ans-${id}`,
      session_id: id,
      video_path: `${id}/keep.webm`,
      transcript: null,
      transcript_segments: null,
    });
    objects.set(id, ["keep.webm"]);
  }
  for (let i = 0; i < ORPHAN_FOLDERS; i += 1) {
    const id = `z-orphan-${String(i).padStart(4, "0")}`;
    objects.set(
      id,
      Array.from(
        { length: OBJECTS_PER_ORPHAN_FOLDER },
        (_, k) => `piece-${String(k).padStart(3, "0")}.webm`,
      ),
    );
  }
  return { sessions, answers, objects };
}

test("#59d: every root folder and nested object is reached across root pages, and emptied folders shifting later pages lose nothing", async () => {
  const w = orphanWorld();
  const t = tablesFor(w);
  const { bucket } = install(t, { objects: w.objects });
  const { log, restore } = captureLog();
  let result = null;
  try {
    result = await runInterviewOrphanSweep({ id: "p13", payload: {} });
  } finally {
    restore();
  }
  const expected = ORPHAN_FOLDERS * OBJECTS_PER_ORPHAN_FOLDER;
  assert.equal(result.complete, true);
  assert.equal(result.orphansRemoved, expected, `all ${expected} orphan objects removed`);
  assert.equal(bucket.removed.length, expected);
  const kept = [...bucket.folders.entries()]
    .filter(([, objs]) => objs.size > 0)
    .map(([name]) => name);
  assert.equal(kept.length, REFERENCED_FOLDERS, "every referenced folder still holds its object");
  assert.ok(
    kept.every((name) => name.startsWith("a-ref-")),
    "nothing referenced was touched",
  );
  assert.match(log[0], /COMPLETE in \d+ ms: orphans=1200 folders=150/);
});

test("#59d: with its budget spent per run, the cursor the handler leaves in its job row lets each run resume: every orphan goes by the second run, and 'complete' means one full pass", async () => {
  const w = orphanWorld();
  const t = tablesFor(w);
  const { bucket } = install(t, { objects: w.objects });
  // Every storage call costs 150 ms of a clock the test owns: 120 calls per
  // 18 s budget, fewer than the 120 referenced folders plus the root pages,
  // so a run that always started at the top would never reach an orphan.
  let nowMs = 0;
  bucket.onCall = () => {
    nowMs += 150;
  };
  const perRun = [];
  let payload = {};
  const sweep = async (jobId, budgetMs) => {
    t.background_jobs.insert({
      id: jobId,
      type: "interview_orphan_sweep",
      payload,
      status: "running",
    });
    const before = bucket.removed.length;
    const r = await runInterviewOrphanSweep(
      { id: jobId, payload },
      { budgetMs, clock: () => nowMs },
    );
    // What the scheduler carries into tomorrow's job: the cursor this run wrote.
    const row = t.background_jobs.rows.find((j) => j.id === jobId);
    payload = typeof row.payload.cursor === "string" ? { cursor: row.payload.cursor } : {};
    perRun.push({
      jobId,
      removed: bucket.removed.length - before,
      walked: r.complete ? r.foldersWalked : r.foldersWalkedSoFar,
      complete: r.complete,
      cursor: row.payload.cursor,
    });
    return r;
  };
  const { restore } = captureLog();
  try {
    for (let run = 1; run <= 4; run += 1) await sweep(`p14-${run}`, 18_000);
  } finally {
    restore();
  }
  const total = perRun.reduce((n, r) => n + r.removed, 0);
  assert.equal(
    perRun[0].removed,
    0,
    "run 1 spent its budget on referenced folders and removed nothing",
  );
  assert.equal(typeof perRun[0].cursor, "string", "and left a cursor in its job row");
  assert.equal(
    perRun[1].removed,
    ORPHAN_FOLDERS * OBJECTS_PER_ORPHAN_FOLDER,
    `run 2 resumed past them and removed every orphan: ${JSON.stringify(perRun)}`,
  );
  assert.equal(total, ORPHAN_FOLDERS * OBJECTS_PER_ORPHAN_FOLDER);
  // The bucket is bigger than one budget's worth of folders, so no 18 s run
  // can make a full pass: `complete` stays false and the cursor keeps moving.
  // That is what the field means, and the log says where the next run starts.
  assert.ok(perRun.every((r) => r.complete === false));
  const cursors = perRun.map((r) => r.cursor);
  assert.equal(
    new Set(cursors).size,
    cursors.length,
    "each run stops somewhere new: round-robin, not a re-walk",
  );
  // With a budget that fits the whole bucket, one run makes the full pass and
  // clears the cursor.
  const { restore: restore2 } = captureLog();
  let full = null;
  try {
    full = await sweep("p14-full", 120_000);
  } finally {
    restore2();
  }
  assert.equal(full.complete, true);
  assert.equal(
    full.foldersWalked,
    REFERENCED_FOLDERS,
    "the orphan folders are empty and gone from the root; every referenced one was walked",
  );
  assert.equal(perRun[perRun.length - 1].cursor, null, "a completed run clears the cursor");
});

test("#59d: without the cursor, the same bucket and budget never reach an orphan: the control case, measured", async () => {
  const w = orphanWorld();
  const t = tablesFor(w);
  const { bucket } = install(t, { objects: w.objects });
  let nowMs = 0;
  bucket.onCall = () => {
    nowMs += 150;
  };
  const { restore } = captureLog();
  try {
    for (let run = 1; run <= 4; run += 1) {
      t.background_jobs.insert({
        id: `p15-${run}`,
        type: "interview_orphan_sweep",
        payload: {},
        status: "running",
      });
      await runInterviewOrphanSweep(
        { id: `p15-${run}`, payload: {} },
        { budgetMs: 18_000, clock: () => nowMs },
      );
    }
  } finally {
    restore();
  }
  assert.equal(bucket.removed.length, 0, "four runs from the top, zero orphans reached");
});

/* ── a folder that cannot be read is never passed ─────────── */

test("#59 item 2: a folder whose listing fails throws, leaves the cursor before it, and is the first folder the next run retries", async () => {
  const w = orphanWorld();
  const t = tablesFor(w);
  const { bucket } = install(t, { objects: w.objects });
  // Start past the referenced folders so the orphans are next; break the
  // listing of the third orphan folder.
  const broken = "z-orphan-0002";
  bucket.failList.add(broken);
  const payload = { cursor: "a-ref-0119" };
  t.background_jobs.insert({
    id: "p16",
    type: "interview_orphan_sweep",
    payload,
    status: "running",
  });
  const { restore } = captureLog();
  try {
    await assert.rejects(
      runInterviewOrphanSweep({ id: "p16", payload }),
      /list z-orphan-0002: storage unavailable/,
      "the run fails instead of passing the folder",
    );
  } finally {
    restore();
  }
  const row = t.background_jobs.rows.find((j) => j.id === "p16");
  assert.deepEqual(
    row.payload,
    { cursor: "a-ref-0119" },
    "a failed run writes no cursor: the previous one stands",
  );
  assert.equal(
    bucket.folders.get(broken).size,
    OBJECTS_PER_ORPHAN_FOLDER,
    "the broken folder's objects are untouched",
  );
  assert.equal(
    bucket.folders.get("z-orphan-0001").size,
    0,
    "the folders before it were swept before the failure",
  );

  // Storage recovers; the next job carries the same cursor and reaches the
  // broken folder again, this time emptying it.
  bucket.failList.delete(broken);
  t.background_jobs.insert({
    id: "p16-next",
    type: "interview_orphan_sweep",
    payload,
    status: "running",
  });
  const { restore: restore2 } = captureLog();
  let next = null;
  try {
    next = await runInterviewOrphanSweep({ id: "p16-next", payload });
  } finally {
    restore2();
  }
  assert.equal(next.complete, true);
  assert.equal(
    bucket.folders.get(broken).size,
    0,
    "the folder that failed last time is emptied this time",
  );
  assert.equal(
    [...bucket.folders.values()].filter((o) => o.size > 0).length,
    REFERENCED_FOLDERS,
    "every orphan folder is empty, every referenced one intact",
  );
});

/* ── 051 is run-once; the backfill lives elsewhere ────────── */

test("051 contains only statements meant to run once; the repeatable backfill is outside the migrations directory", () => {
  const migration = readFileSync(
    new URL("./supabase/migrations/051_interview_sessions_purged_at.sql", import.meta.url),
    "utf8",
  );
  const statements = migration
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  assert.doesNotMatch(statements, /limit\s+500/i, "no batched statement in a migration");
  assert.doesNotMatch(
    statements,
    /update\s+public\.interview_sessions/i,
    "no backfill UPDATE in a migration",
  );
  assert.doesNotMatch(statements, /select\s+count\(\*\)/i, "no dry-run count in a migration");
  assert.match(statements, /add column if not exists purged_at/);
  assert.match(statements, /create index if not exists interview_sessions_purge_due_idx/);
  assert.match(statements, /add constraint background_jobs_type_check/);
  assert.match(
    migration,
    /scripts\/backfills\/051-interview-sessions-purged-at\.sql/,
    "the migration names the backfill",
  );
  const backfill = readFileSync(
    new URL("../../scripts/backfills/051-interview-sessions-purged-at.sql", import.meta.url),
    "utf8",
  );
  assert.match(backfill, /limit 500/);
  assert.match(backfill, /update public\.interview_sessions s/);
  assert.match(
    backfill,
    /RUN AFTER src\/lib\/supabase\/migrations\/051_interview_sessions_purged_at\.sql/,
  );
});

/* ── the report ───────────────────────────────────────────── */

test("#59: a run that stops for budget says INCOMPLETE with 'so far' numbers, and stamps nothing it did not finish", async () => {
  const w = world(1200);
  const t = tablesFor(w);
  install(t);
  let nowMs = 1_000_000;
  t.interview_sessions.between = (_n, returned) => {
    // Past the budget as soon as the first page is read.
    if (isSessionPage(returned)) nowMs += 50_000;
  };
  const { result, log } = await run("p6", { budgetMs: 18_000, clock: () => nowMs });

  assert.equal(result.complete, false);
  assert.equal(result.stoppedDuring, "sessions");
  assert.equal(result.sessionsExaminedSoFar, 500, "one page was read before the budget ran out");
  assert.equal(
    result.sessionsMarkedSoFar,
    0,
    "no session in that page had its answers handled, so none is stamped",
  );
  assert.equal(t.interview_sessions.rows.filter((s) => s.purged_at !== null).length, 0);
  assert.ok(
    !("sessionsExamined" in result) && !("sessionsMarked" in result),
    "no field that reads as a total",
  );
  assert.match(log[0], /INCOMPLETE, budget of 18000 ms reached during sessions/);
  assert.match(log[0], /sessions examined so far=500/);
  assert.match(log[0], /NOT examined/);
  assert.doesNotMatch(log[0], /examined=/);
});

test("#59: describeInterviewPurge puts the stop reason first in both shapes", () => {
  const complete = describeInterviewPurge("x", {
    complete: true,
    sessionsExamined: 1,
    sessionsMarked: 1,
    sessionsRetrying: 0,
    answersCleared: 1,
    turnsPurged: 0,
    piecesPurged: 0,
    liveScoresCleared: 0,
    asyncScoresCleared: 0,
    objectsRemoved: 0,
    orphansRemoved: 0,
    elapsedMs: 5,
  });
  const incomplete = describeInterviewPurge("x", {
    complete: false,
    stoppedDuring: "orphans",
    budgetMs: 18_000,
    sessionsExaminedSoFar: 500,
    sessionsMarkedSoFar: 480,
    sessionsRetryingSoFar: 20,
    answersClearedSoFar: 900,
    turnsPurgedSoFar: 0,
    piecesPurgedSoFar: 0,
    liveScoresClearedSoFar: 0,
    asyncScoresClearedSoFar: 0,
    objectsRemovedSoFar: 0,
    orphansRemovedSoFar: 3,
    elapsedMs: 18_001,
  });
  assert.match(complete, /^\[purge\] job x: COMPLETE/);
  assert.match(
    incomplete,
    /^\[purge\] job x: INCOMPLETE, budget of 18000 ms reached during orphans/,
  );
});
