/**
 * The scorecard request: which interleavings queue, and that at most one job
 * results however the askers overlap.
 *
 *   node --test src/lib/interviews/scorecard.test.ts
 *
 * The service is an in-memory stand-in for the four queries the request
 * makes; `enqueue` is a stand-in for the queue, with a switch that models the
 * partial unique index from migration 027. Every test states its interleaving
 * in the order the real writes would commit.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestScorecard, SCORECARD_JOB_TYPE, scorecardRecoveryEligibility } from "./scorecard.ts";

const SESSION = "sess-1";

/** A tiny Postgres: three tables, the filters the request uses, thenable builders. */
function world(init: {
  session?: { status: string };
  answers?: { transcript_status: string }[];
  jobs?: { status: string; sessionId: string }[];
}) {
  const state = {
    session: init.session ? { id: SESSION, ...init.session } : null,
    answers: (init.answers ?? []).map((a, i) => ({ id: `a${i}`, session_id: SESSION, ...a })),
    jobs: (init.jobs ?? []).map((j, i) => ({
      id: `j${i}`,
      type: SCORECARD_JOB_TYPE,
      status: j.status,
      payload: { sessionId: j.sessionId },
    })),
  };

  function rows(table: string) {
    if (table === "interview_sessions") return state.session ? [state.session] : [];
    if (table === "interview_answers") return state.answers;
    if (table === "background_jobs") return state.jobs;
    throw new Error(`unexpected table ${table}`);
  }

  function builder(table: string) {
    let out = rows(table);
    let head = false;
    const b = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        head = Boolean(opts?.head);
        return b;
      },
      eq(col: string, val: unknown) {
        out = out.filter((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        out = out.filter((r) => vals.includes(r[col]));
        return b;
      },
      contains(col: string, obj: Record<string, unknown>) {
        out = out.filter((r) => Object.entries(obj).every(([k, v]) => r[col]?.[k] === v));
        return b;
      },
      limit(n: number) {
        out = out.slice(0, n);
        return b;
      },
      maybeSingle() {
        return Promise.resolve({ data: out[0] ?? null, error: null });
      },
      // biome-ignore lint/suspicious/noThenProperty: models PostgREST's thenable query builder, which the code under test awaits directly
      then(resolve: (v: unknown) => void) {
        resolve(head ? { count: out.length, data: null, error: null } : { data: out, error: null });
      },
    };
    return b;
  }

  const service = { from: builder } as never;

  /**
   * The queue. `index: true` models 027 - the insert is refused with 23505
   * when a live job for the same session exists. The `delay` is what opens
   * the read-then-write window: an asker that has passed its pre-check is
   * held here while another asker runs its own.
   */
  function enqueue(opts: { index: boolean; delay?: number }) {
    return async (input: { type: string; payload?: Record<string, unknown> }) => {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      const sessionId = input.payload?.sessionId;
      if (opts.index) {
        const live = state.jobs.some(
          (j) =>
            j.type === input.type &&
            ["queued", "running"].includes(j.status) &&
            j.payload.sessionId === sessionId,
        );
        if (live) {
          return {
            ok: false,
            error:
              'duplicate key value violates unique constraint "background_jobs_ai_scorecard_live_uniq"',
            code: "23505",
          };
        }
      }
      const id = `j${state.jobs.length}`;
      state.jobs.push({ id, type: input.type, status: "queued", payload: { sessionId } });
      return { ok: true, id };
    };
  }

  return {
    state,
    service,
    enqueue,
    // The two real writes, as the routes/handler perform them.
    submit() {
      state.session = { id: SESSION, status: "submitted" };
    },
    transcriptDone(i = 0) {
      state.answers[i].transcript_status = "done";
    },
    liveJobs: () => state.jobs.filter((j) => ["queued", "running"].includes(j.status)).length,
  };
}

// ── The two orderings ────────────────────────────────────────

test("1. transcript finishes before submit: transcription asks and is refused, submit asks and queues", async () => {
  const w = world({ session: { status: "started" }, answers: [{ transcript_status: "pending" }] });
  const enqueue = w.enqueue({ index: true });

  // T1 T2: the last transcript lands while the candidate is still reviewing.
  w.transcriptDone();
  const fromTranscribe = await requestScorecard(w.service, SESSION, { enqueue });
  assert.deepEqual(fromTranscribe, { ok: false, reason: "not_submitted" });
  assert.equal(w.liveJobs(), 0, "nothing queued against an open session");

  // S1 S2: the candidate submits. This is the ordering that used to strand.
  w.submit();
  const fromSubmit = await requestScorecard(w.service, SESSION, { enqueue });
  assert.deepEqual(fromSubmit, { ok: true, outcome: "queued" });
  assert.equal(w.liveJobs(), 1);
});

test("2. submit happens before the transcript: submit is refused, transcription later queues", async () => {
  const w = world({ session: { status: "started" }, answers: [{ transcript_status: "pending" }] });
  const enqueue = w.enqueue({ index: true });

  // S1 S2: submitted with a transcript still pending.
  w.submit();
  const fromSubmit = await requestScorecard(w.service, SESSION, { enqueue });
  assert.deepEqual(fromSubmit, { ok: false, reason: "transcripts_pending" });
  assert.equal(w.liveJobs(), 0, "an empty transcript must never be scored");

  // T1 T2: the transcript lands.
  w.transcriptDone();
  const fromTranscribe = await requestScorecard(w.service, SESSION, { enqueue });
  assert.deepEqual(fromTranscribe, { ok: true, outcome: "queued" });
  assert.equal(w.liveJobs(), 1);
});

// ── Both at once ─────────────────────────────────────────────

test("3. both askers pass the pre-check together: with 027's index exactly one job results", async () => {
  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  // The delay holds each asker between its pre-check and its insert, so both
  // see zero live jobs - the real window.
  const enqueue = w.enqueue({ index: true, delay: 5 });

  const [a, b] = await Promise.all([
    requestScorecard(w.service, SESSION, { enqueue }),
    requestScorecard(w.service, SESSION, { enqueue }),
  ]);

  assert.equal(w.liveJobs(), 1, "one paid run, not two");
  const outcomes = [a, b].map((r) => (r.ok ? r.outcome : r.reason)).sort();
  assert.deepEqual(outcomes, ["already_queued", "queued"]);
  assert.ok(a.ok && b.ok, "the loser is told it succeeded, because it did");
});

test("3b. the same overlap WITHOUT the index queues twice - which is why 027 must run first", async () => {
  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  const enqueue = w.enqueue({ index: false, delay: 5 });

  await Promise.all([
    requestScorecard(w.service, SESSION, { enqueue }),
    requestScorecard(w.service, SESSION, { enqueue }),
  ]);

  assert.equal(w.liveJobs(), 2, "the pre-check alone leaves the window open");
});

test("3c. a second ask after the first has landed is caught by the pre-check, no insert attempted", async () => {
  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  let inserts = 0;
  const base = w.enqueue({ index: true });
  const enqueue = async (input) => {
    inserts += 1;
    return base(input);
  };

  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: true,
    outcome: "queued",
  });
  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: true,
    outcome: "already_queued",
  });
  assert.equal(inserts, 1);
  assert.equal(w.liveJobs(), 1);
});

// ── The recruiter's button ───────────────────────────────────

const eligible = {
  kind: "async",
  status: "submitted",
  scoringEnabled: true,
  hasScoreRow: false,
  pendingTranscripts: 0,
  liveJob: false,
};

test("4. recovery: an eligible session is offered the button and one click queues once", async () => {
  assert.deepEqual(scorecardRecoveryEligibility(eligible), { ok: true });

  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  const enqueue = w.enqueue({ index: true });
  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: true,
    outcome: "queued",
  });
  assert.equal(w.liveJobs(), 1);
});

test("5. recovery: a repeated click is not offered, and if forced does not duplicate", async () => {
  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  const enqueue = w.enqueue({ index: true, delay: 5 });

  await requestScorecard(w.service, SESSION, { enqueue });

  // The page re-derives: a live job hides the button.
  assert.deepEqual(scorecardRecoveryEligibility({ ...eligible, liveJob: true }), {
    ok: false,
    block: "already_queued",
  });
  // A stale page that still shows it: the second request is absorbed.
  const again = await requestScorecard(w.service, SESSION, { enqueue });
  assert.deepEqual(again, { ok: true, outcome: "already_queued" });
  assert.equal(w.liveJobs(), 1);

  // Two recruiters at the same instant, after the first job has been queued.
  await Promise.all([
    requestScorecard(w.service, SESSION, { enqueue }),
    requestScorecard(w.service, SESSION, { enqueue }),
  ]);
  assert.equal(w.liveJobs(), 1);
});

test("6. scoring disabled: the button is not offered; the automatic path still asks so the handler can record why", async () => {
  assert.deepEqual(scorecardRecoveryEligibility({ ...eligible, scoringEnabled: false }), {
    ok: false,
    block: "scoring_disabled",
  });

  // requestScorecard has no view of the flag by design - see its comment. The
  // handler writes a 'skipped' row naming the flag, which the review page shows.
  const w = world({ session: { status: "submitted" }, answers: [{ transcript_status: "done" }] });
  const res = await requestScorecard(w.service, SESSION, { enqueue: w.enqueue({ index: true }) });
  assert.deepEqual(res, { ok: true, outcome: "queued" });
});

test("6b. a scorecard row of any status hides the button - skipped and failed are decisions already recorded", () => {
  assert.deepEqual(scorecardRecoveryEligibility({ ...eligible, hasScoreRow: true }), {
    ok: false,
    block: "already_decided",
  });
  for (const [k, v, block] of [
    ["kind", "live", "not_async"],
    ["status", "started", "not_submitted"],
    ["status", "expired", "not_submitted"],
    ["pendingTranscripts", 1, "transcripts_pending"],
  ]) {
    assert.deepEqual(scorecardRecoveryEligibility({ ...eligible, [k]: v }), { ok: false, block });
  }
});

// ── Incomplete transcripts ───────────────────────────────────

test("7. a pending transcript blocks scoring from either asker; the last one to settle queues", async () => {
  const w = world({
    session: { status: "submitted" },
    answers: [
      { transcript_status: "done" },
      { transcript_status: "pending" },
      { transcript_status: "pending" },
    ],
  });
  const enqueue = w.enqueue({ index: true });

  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: false,
    reason: "transcripts_pending",
  });
  w.transcriptDone(1);
  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: false,
    reason: "transcripts_pending",
  });
  assert.equal(w.liveJobs(), 0, "two of three transcripts is premature");

  w.transcriptDone(2);
  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: true,
    outcome: "queued",
  });
  assert.equal(w.liveJobs(), 1);
});

test("7b. a FAILED transcript is settled, not pending: the session is scoreable on the answers that have words", async () => {
  const w = world({
    session: { status: "submitted" },
    answers: [
      { transcript_status: "done" },
      { transcript_status: "failed" },
      { transcript_status: "done" },
    ],
  });
  const enqueue = w.enqueue({ index: true });
  assert.deepEqual(await requestScorecard(w.service, SESSION, { enqueue }), {
    ok: true,
    outcome: "queued",
  });
  assert.deepEqual(scorecardRecoveryEligibility({ ...eligible, pendingTranscripts: 0 }), {
    ok: true,
  });
});

test("a session that no longer exists is reported, not queued", async () => {
  const w = world({});
  assert.deepEqual(
    await requestScorecard(w.service, SESSION, { enqueue: w.enqueue({ index: true }) }),
    {
      ok: false,
      reason: "no_session",
    },
  );
});
