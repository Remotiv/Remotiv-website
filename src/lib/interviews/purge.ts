import "server-only";
import { TerminalJobError } from "@/lib/queue/failure-class";
import { removeObjects } from "@/lib/storage-objects";
import { createServiceClient } from "@/lib/supabase/server";
import { purgeAsyncScoreWords } from "./async-score-purge";
import { purgeLiveScoreWords } from "./live-score-purge";
import { INTERVIEW_BUCKET } from "./session";

/**
 * Retention purge — the thing that makes the consent screen true.
 *
 * The candidate is told, in these words, before they record anything:
 *
 *   "Kept for 6 months, then deleted"
 *   "Recordings are stored securely by Remotiv and removed automatically
 *    after six months."
 *
 * `delete_after` has been written at invite time since the feature shipped and
 * was read by nothing, so that statement was false. This is what makes it
 * true.
 *
 * ── What is removed, and what is kept ────────────────────────
 *
 * REMOVED: the video object, the transcript, and the transcript's timed
 * segments. The transcript is a verbatim record of what the candidate said —
 * deleting the video and keeping a word-for-word copy of their speech would
 * honour the letter of the promise and break its plain meaning.
 *
 * transcript_segments is the SAME words again, split by timestamp. It was
 * missed when this purge was written: for every purged answer the transcript
 * was cleared and a complete, timed copy of it stayed in the row. Anything that
 * stores the candidate's words belongs in this list, and a new column holding
 * them must be added here in the same change that adds the column.
 *
 * KEPT: the interview_answers row itself, with question_text, position,
 * duration_seconds and recorded_at. The hiring record survives the media: a
 * reviewer can still see that this person was asked this question, answered
 * it, and how long they spoke for. Deleting the rows would rewrite history
 * rather than expire the recording.
 *
 * That combination is also what lets the drawer distinguish the two cases
 * without a new column: a question that was never answered has NO row, while a
 * purged answer has a row with recorded_at set and video_path null.
 *
 * ── AI Video Interview turns (migration 021) ─────────────────
 *
 * Same schedule: a session past delete_after. REMOVED from every turn: the
 * audio object, the interviewer's text, the candidate's transcript, its timed
 * segments and error, and the follow-up reason (it describes the answer).
 * KEPT, as the hiring record: speaker, kind, question position, follow-up
 * index, timings, interruption, and the audio's type, size and hash.
 * content_purged_at marks the turn purged; media_path is cleared only once its
 * object is confirmed gone, so a failed delete is retried on the next run.
 * The turn audio is in the session's folder, so the same folder sweep removes
 * it, and the orphan sweep counts it as referenced while a turn points at it.
 *
 * ── Live interview scores (migration 042) ────────────────────
 *
 * Same schedule. REMOVED from every question's score: the rationale and the
 * quotes (the candidate's words). KEPT: scores, statuses, counts and the
 * overall. See live-score-purge.ts.
 *
 * ── Async interview scorecards ───────────────────────────────
 *
 * Same schedule, every run, so a session purged before this step existed is
 * cleaned on the next run. REMOVED from interview_answer_scores: reasoning,
 * evidence, strengths, concerns and missing; from interview_session_scores:
 * the summary and each criterion's quote. KEPT: scores, confidence, statuses,
 * counts, the verdict, each criterion and its outcome, and every human
 * adjustment with its note. See async-score-purge.ts.
 *
 * ── Live interview camera video (migration 044) ──────────────
 *
 * Same schedule. Every piece's object is in the session's folder, so the same
 * folder sweep removes it; each piece row then has its media_path cleared and
 * content_purged_at stamped (044 allows exactly that, pending or confirmed),
 * only once its object is confirmed gone, so a failed delete is retried on
 * the next run. The orphan sweep counts a CONFIRMED piece's path as
 * referenced: a reserved piece never confirmed is not, and its upload is
 * swept after the 24-hour grace like any other orphan.
 */

/** How old an unreferenced object must be before the sweep will remove it. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** PostgREST caps a response at 1000 rows; page well inside that. */
const DB_PAGE = 500;

/** Storage list() is also paged, and its default limit is 100. */
const STORAGE_PAGE = 100;

/** `.in()` overflows the URL if handed thousands of ids at once. */
const ID_CHUNK = 100;

/**
 * How long after a session is stamped `purged_at` its score rows are still
 * checked for words (#59, Phase 1b).
 *
 * The race this guards is narrow. The scorer refuses to write words once
 * retention has passed (interview-scoring.ts, retentionPassed), so the only
 * words that can land AFTER a purge come from a scoring job that read
 * `delete_after` a moment before it passed and wrote a moment after the purge
 * cleared the session: a write in flight at the instant retention passes.
 * That is seconds, bounded by one scoring call. Twenty-four hours covers it
 * with a thousandfold margin. It was seven days until 2026-10-30; the cut
 * lost nothing and divides Phase 1b's work by seven, because its cost is
 * proportional to the sessions stamped inside this window (see
 * LATE_WORDS_BUDGET_MS).
 *
 * ── Where the checks are, traced 2026-10-30 ──────────────────
 *
 * Every writer of a field this purge clears re-reads `delete_after` when its
 * job actually RUNS, on every attempt, so a job that sat queued for months, or
 * was retried, or was re-queued from the admin panel, is gated at run time;
 * nothing accrues across the wait. `delete_after` itself only ever moves
 * EARLIER (application deletion sets it to now), never later, so a value read
 * at job start is never stale in the unsafe direction. The async scorer
 * (interview-scoring.ts) checks at job start, again immediately before each
 * score write (the words are stripped from the payload), and again right
 * after it (purgeAsyncScoreWords for the session), so the only interval it
 * leaves is one upsert's round trip, and that is closed by the post-write
 * check unless that cleanup call itself fails. The transcribers
 * (transcribe.ts, live-transcribe.ts) and the live ingest check once at job
 * start and then download, call the provider and write with no re-check:
 * their interval is the provider budget (about 55 s, AbortSignal) plus one
 * write that no timeout bounds. The live scorer (live-scoring.ts) has no
 * retentionPassed check in its handler at all: it stops on the turns'
 * content_purged_at marker, so once Phase 1 has purged a session it writes
 * nothing, and before that Phase 1 clears whatever it wrote. NO code enforces
 * a maximum between a transcriber's check and its write; the bound is the
 * worker's function lifetime, and Phase 1b does not re-check transcripts.
 *
 * ── What this window does and does not promise ───────────────
 *
 * Phase 1b runs inside the daily purge job, so it covers the race above only
 * when a purge run completes inside this window of the stamp: NORMAL
 * OPERATION, one successful run a day. The purge can fail, die on the slice
 * alarm below, or wait behind a delayed queue; a gap longer than this window
 * leaves any words that landed in the race in place, because the session is
 * stamped and Phase 1 never reads it again. The seven-day window needed a
 * week-long gap for that; this one needs a day. The async scorer's post-write
 * check makes that a double failure for score words (its cleanup call failed
 * AND the purge missed a day); transcripts have no such second line.
 */
const LATE_WORDS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Early warning (#59, 2026-10-30): Phase 1b's slice was measured to hold about
 * 800 sessions stamped in the window at 190-240 ms per round trip. Past this
 * count a run says so, once, while still well inside the slice, because
 * exhausting the slice halts ALL purging until someone acts. Production
 * stamps a few sessions a day; reaching this means the window has filled
 * artificially (see LATE_WORDS_BUDGET_MS) or traffic has grown past what the
 * slice was sized for, and the fix recorded there is due.
 */
const LATE_WORDS_WARN_AT = 500;

/**
 * Phase 1b's own slice of the budget, and why it runs FIRST (#59b).
 *
 * Phase 1 exhausts the whole budget on every run while a backlog exists.
 * Behind it, Phase 1b would never run at all, its window would close on the
 * sessions it exists for, and the late words would be kept forever: the same
 * starvation #59 fixes, with a deadline attached. So it runs before Phase 1,
 * inside this slice. Exhausting the slice is abnormal, and the run stops and
 * says so rather than quietly carrying on.
 *
 * ── What the slice is actually bounded by (corrected 2026-10-30) ──
 *
 * An earlier version of this comment said the window bounds Phase 1b "a week
 * of marked sessions, two indexed reads per hundred". That was wrong in a way
 * that matters. Phase 1b's cost is one read per page of 500 plus THREE score
 * reads per chunk of 100, over every session stamped inside
 * LATE_WORDS_WINDOW_MS, and each of those is a round trip. So the cost is
 * driven by how many sessions were STAMPED IN THE WINDOW, which in production
 * is the number of sessions EXPIRING PER DAY, not the backlog: a session is
 * stamped once, on the day it is purged, and leaves the window a day later.
 * Production had 28 sessions in total and 0 past retention on 2026-10-30; the
 * slice is thirty times the whole table away.
 *
 * Two things put the whole backlog inside the window at once, and both are
 * artificial: a backfill that stamps `purged_at = now()` (the backfill in
 * scripts/backfills therefore stamps `delete_after`, which is outside the
 * window by construction), and a test that compresses months of expiry into
 * minutes. The staging run of 2026-10-30 did the second: 1,200 sessions
 * seeded due at once were stamped within an hour, so after 809 of them Phase
 * 1b cost 29 round trips at 190-240 ms, 6.3-6.6 s, and the alarm fired on
 * every run until the marks were moved out of the window by hand. That
 * timeline cannot occur from real traffic. Anyone re-running that test should
 * know it alarms BY CONSTRUCTION, whatever the window: it is not evidence
 * about this constant.
 *
 * ── Measured ceiling, and the fix if it is ever approached ──
 *
 * Staging, 2026-10-30, this slice: about 800 sessions stamped in the window at
 * 190-240 ms per round trip, 8.1 ms per marked session (median; 6.8-11.6).
 * Round trips = pages + 3 x chunks, which matched 39 of 39 measured runs. At
 * 50 ms per round trip the slice carries about 3,700 sessions a day; at 25 ms,
 * about 7,500. If sessions expiring per day ever approach ~500, do not widen
 * the slice: make Phase 1b its own recurring job on the #59c pattern (the
 * orphan sweep), with the whole budget and a persisted cursor of its own.
 * That deletes this slice, the gate ahead of Phase 1 and the alarm in one
 * move, because nothing is then in front of Phase 1. Recorded, not built.
 */
const LATE_WORDS_BUDGET_MS = 6_000;

/*
 * ── For the record: three phases restart from the head (#59, #59b, #59c) ──
 *
 * cv-purge's held rows, Phase 1b here and the orphan sweep each start from the
 * top of their set on every run with no durable record of where the last run
 * got to; each was fixed by giving it a bounded window, a reserved slice or a
 * job of its own, which moves the starvation rather than removing it. A
 * persisted cursor IS the general answer: one row per sweep (a small
 * `purge_progress` table, or a column on background_jobs' payload) holding the
 * last key read, so a run resumes where the previous one stopped and no set
 * is ever walked from the head twice. It costs a migration, a write per page,
 * a reset rule for when the cursor's key no longer exists, and the reasoning
 * about what a stale cursor skips when rows change under it, which is the
 * #55a question again across runs instead of within one. Not built here;
 * worth building the next time a fourth phase needs the same reordering.
 */

/**
 * Wall-clock budget.
 *
 * The worker allows ~25s per tick and this job runs inside that. Stopping
 * early is safe and costs nothing: every selector below is derived from
 * current state, never from a cursor, so the next run resumes exactly where
 * this one stopped without tracking progress anywhere.
 */
const BUDGET_MS = 18_000;

type Service = ReturnType<typeof createServiceClient>;

type TurnRow = { id: string; session_id: string; media_path: string | null };

type AnswerRow = {
  id: string;
  session_id: string;
  video_path: string | null;
  transcript: string | null;
  transcript_segments: unknown;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every object key under one session's folder, paged to the end. */
async function listSessionObjects(
  service: Service,
  sessionId: string,
): Promise<{ name: string; createdAt: number }[]> {
  const found: { name: string; createdAt: number }[] = [];
  for (let offset = 0; ; offset += STORAGE_PAGE) {
    const { data, error } = await service.storage
      .from(INTERVIEW_BUCKET)
      .list(sessionId, { limit: STORAGE_PAGE, offset });
    if (error) throw new Error(`list ${sessionId}: ${error.message}`);
    const page = (data ?? []) as { name: string; created_at: string | null }[];
    for (const o of page) {
      found.push({
        name: o.name,
        createdAt: o.created_at ? new Date(o.created_at).getTime() : 0,
      });
    }
    if (page.length < STORAGE_PAGE) break;
  }
  return found;
}

/**
 * Remove EVERY object under one session's folder.
 *
 * Shared by the retention purge and by an operator deleting a session outright
 * — both need exactly this, and a second copy would be the place the two
 * quietly diverged on what "removed" means.
 *
 * Returns what was there and what is now gone. `complete` is the only thing a
 * caller should branch on before touching rows: video_path is the sole record
 * of where an object lives, so clearing rows while objects survive strands the
 * files with nothing pointing at them.
 *
 * An object that was never there counts as removed — there is nothing left to
 * delete, and treating absence as failure would make a retry loop forever.
 *
 * Throws only when the LISTING fails, which means storage is unreachable and
 * nothing is known about the folder.
 *
 * The deletion itself is `removeObjects` — shared with the CV purge, which
 * needs the identical "which of these are confirmed gone" answer for a
 * different bucket. What stays here is the part that IS interview-specific:
 * discovering the folder's contents so the sweep covers abandoned uploads too.
 */
export async function removeSessionObjects(
  service: Service,
  sessionId: string,
): Promise<{
  present: string[];
  removed: Set<string>;
  complete: boolean;
  error: string | null;
}> {
  const present = (await listSessionObjects(service, sessionId)).map(
    (o) => `${sessionId}/${o.name}`,
  );
  const outcome = await removeObjects(service, INTERVIEW_BUCKET, present);
  return {
    present,
    removed: outcome.removed,
    complete: outcome.complete,
    error: outcome.error,
  };
}

/** Where the last page ended: the last row READ, whatever happened to it. */
type Cursor = { deleteAfter: string; id: string };

/**
 * What one run did, and whether it finished (#59, same standard as cv-purge).
 *
 * Two shapes with different field NAMES, so no number an incomplete run
 * reports can be read as a total. `sessionsMarked` is the sessions this run
 * finished and stamped `purged_at`; `sessionsRetrying` is the sessions read
 * this run that still hold something storage could not confirm gone, left
 * unstamped for the next run.
 */
export type InterviewPurgeResult =
  | {
      complete: true;
      sessionsExamined: number;
      sessionsMarked: number;
      sessionsRetrying: number;
      answersCleared: number;
      turnsPurged: number;
      piecesPurged: number;
      liveScoresCleared: number;
      asyncScoresCleared: number;
      objectsRemoved: number;
      orphansRemoved: number;
      elapsedMs: number;
    }
  | {
      complete: false;
      stoppedDuring: "sessions" | "late words" | "orphans";
      budgetMs: number;
      sessionsExaminedSoFar: number;
      sessionsMarkedSoFar: number;
      sessionsRetryingSoFar: number;
      answersClearedSoFar: number;
      turnsPurgedSoFar: number;
      piecesPurgedSoFar: number;
      liveScoresClearedSoFar: number;
      asyncScoresClearedSoFar: number;
      objectsRemovedSoFar: number;
      orphansRemovedSoFar: number;
      elapsedMs: number;
    };

/** The one log line, with the stop reason first so a scan of the logs sees it. */
export function describeInterviewPurge(jobId: string, r: InterviewPurgeResult): string {
  if (!r.complete && r.stoppedDuring === "late words") {
    // Not routine, and not to be read as routine: see LATE_WORDS_BUDGET_MS.
    return (
      `[purge] job ${jobId}: ALARM, PHASE 1B DID NOT FINISH INSIDE ITS SLICE ` +
      `(${LATE_WORDS_BUDGET_MS} ms of the ${r.budgetMs} ms budget, after ${r.elapsedMs} ms). ` +
      `A sweep bounded to the sessions stamped in the last ${LATE_WORDS_WINDOW_MS / 3_600_000} hours ` +
      `should never need this long: something else is wrong (a missing index, a flood of late ` +
      `words, or a changed window). Phase 1 DID NOT START and the orphan sweep did not run: ` +
      `ALL PURGING HALTED THIS RUN, and will halt on every run until this is fixed. ` +
      `late words cleared so far: live=${r.liveScoresClearedSoFar} async=${r.asyncScoresClearedSoFar}.`
    );
  }
  if (r.complete) {
    return (
      `[purge] job ${jobId}: COMPLETE in ${r.elapsedMs} ms: sessions examined=${r.sessionsExamined} ` +
      `marked=${r.sessionsMarked} retrying=${r.sessionsRetrying} answers=${r.answersCleared} ` +
      `turns=${r.turnsPurged} video_pieces=${r.piecesPurged} live_scores=${r.liveScoresCleared} ` +
      `async_scores=${r.asyncScoresCleared} objects=${r.objectsRemoved} orphans=${r.orphansRemoved}`
    );
  }
  return (
    `[purge] job ${jobId}: INCOMPLETE, budget of ${r.budgetMs} ms reached during ${r.stoppedDuring} ` +
    `after ${r.elapsedMs} ms: sessions examined so far=${r.sessionsExaminedSoFar} ` +
    `marked so far=${r.sessionsMarkedSoFar} retrying so far=${r.sessionsRetryingSoFar} ` +
    `answers so far=${r.answersClearedSoFar} turns so far=${r.turnsPurgedSoFar} ` +
    `video_pieces so far=${r.piecesPurgedSoFar} live_scores so far=${r.liveScoresClearedSoFar} ` +
    `async_scores so far=${r.asyncScoresClearedSoFar} objects so far=${r.objectsRemovedSoFar} ` +
    `orphans so far=${r.orphansRemovedSoFar}. The rest of the due set was NOT examined; ` +
    `the next run starts again from the current state.`
  );
}

/**
 * The queue's handler: runs the purge and, on Phase 1b's alarm, FAILS THE JOB.
 *
 * A void wrapper that returned normally recorded the run as succeeded while
 * all purging had halted, and the queue panel showed a healthy maintenance
 * run: a log line nobody reads is not an alarm. The failure class is
 * `configuration`, a TerminalJobError, so planFailure buries the job on the
 * spot: one dead row per day (the scheduler paces by created_at), one
 * `job_dead` notification to every admin, and a dead count on the queue
 * panel and /api/health. Not `retryable`: a slice a bounded sweep could not
 * finish is a structural fault that three retries thirty seconds apart would
 * reproduce identically, each spending the slice again, before dying anyway.
 * `opts` is the tests' clock; the worker passes nothing.
 */
export async function handleInterviewPurge(
  job: { id: string; payload: Record<string, unknown> },
  _ctx?: unknown,
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<void> {
  const result = await runInterviewPurge(job, opts);
  if (!result.complete && result.stoppedDuring === "late words") {
    throw new TerminalJobError("configuration", describeInterviewPurge(job.id, result));
  }
}

/**
 * The purge itself, returning what it did. `opts` exists for the tests: a
 * budget they can exhaust and a clock they can move. The handler passes
 * neither.
 */
export async function runInterviewPurge(
  job: { id: string; payload: Record<string, unknown> },
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<InterviewPurgeResult> {
  const service = createServiceClient();
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const startedAt = clock();
  const overBudget = () => clock() - startedAt > budgetMs;
  const now = new Date().toISOString();

  let sessionsExamined = 0;
  let sessionsMarked = 0;
  let objectsRemoved = 0;
  let rowsCleared = 0;
  let orphansRemoved = 0;
  let turnsPurged = 0;
  let piecesPurged = 0;
  let scoresCleared = 0;
  let asyncScoresCleared = 0;
  const retrying = new Set<string>();
  let stoppedDuring: "sessions" | "late words" | "orphans" | null = null;

  const sweepLateWords = async () => {
    /*
     * ── Phase 1b — words written after a purge (the racing scorer) ──
     *
     * Sessions stamped within LATE_WORDS_WINDOW_MS get only the two score-word
     * sub-purges again: two indexed reads per hundred sessions, no storage.
     * Keyset on id alone, which is sound here because nothing in this phase
     * changes which sessions match. Runs BEFORE Phase 1, inside
     * LATE_WORDS_BUDGET_MS: see that constant for why the order is the fix.
     */
    let lateCursor: string | null = null;
    let lateSeen = 0;
    const since = new Date(Date.parse(now) - LATE_WORDS_WINDOW_MS).toISOString();
    const lateStartedAt = clock();
    const lateOver = () => overBudget() || clock() - lateStartedAt > LATE_WORDS_BUDGET_MS;
    while (!stoppedDuring) {
      if (lateOver()) {
        stoppedDuring = "late words";
        break;
      }
      let lateRead = service
        .from("interview_sessions")
        .select("id")
        .lte("delete_after", now)
        .not("purged_at", "is", null)
        .gte("purged_at", since);
      if (lateCursor) lateRead = lateRead.gt("id", lateCursor);
      const { data, error } = await lateRead.order("id", { ascending: true }).limit(DB_PAGE);
      if (error)
        throw new Error(`purge: late words after ${lateCursor ?? "(start)"}: ${error.message}`);
      const marked = (data ?? []) as { id: string }[];
      if (marked.length === 0) break;
      lateSeen += marked.length;
      lateCursor = marked[marked.length - 1].id;
      for (const ids of chunk(
        marked.map((m) => m.id),
        ID_CHUNK,
      )) {
        scoresCleared += await purgeLiveScoreWords(service, ids);
        const late = await purgeAsyncScoreWords(service, ids);
        asyncScoresCleared += late.answers + late.sessions;
      }
      // The slice is a hard bound, checked after the page's work as well as
      // before it: finishing late is the same signal as not finishing.
      if (lateOver()) {
        stoppedDuring = "late words";
        break;
      }
      if (marked.length < DB_PAGE) break;
    }
    if (lateSeen > LATE_WORDS_WARN_AT) {
      console.warn(
        `[purge] job ${job.id}: WARNING, Phase 1b read ${lateSeen} sessions stamped in the last ` +
          `${LATE_WORDS_WINDOW_MS / 3_600_000} hours, above ${LATE_WORDS_WARN_AT}. The ${LATE_WORDS_BUDGET_MS} ms ` +
          `slice was measured to hold about 800 at 190-240 ms per round trip; exhausting it halts ALL ` +
          `purging on every run (see LATE_WORDS_BUDGET_MS for the fix).`,
      );
    }
  };

  const sweepDueSessions = async () => {
    /*
     * ── Phase 1 — sessions past their retention date, paged by KEY (#59) ──
     *
     * Until #59 this loop paged by page NUMBER and never wrote the session
     * row, so a purged session matched `delete_after <= now` forever and every
     * run re-walked the whole purged history before reaching new work: 36 to 45
     * sessions per 18-second run on staging, declining as the history grew.
     *
     * Now a finished session is stamped `purged_at` (migration 051) and leaves
     * the filter. That is a filter mutation, the #55 class, so page-number
     * paging would step over exactly as many unpurged sessions as it stamped.
     * And `delete_after` alone is not a total order (every invite sent in the
     * same second shares one), so an offset would also lose rows to a writer
     * moving tuples under it, as #55a reproduced for cv-purge. The order is
     * therefore (delete_after, id), total because id is unique, and each page
     * starts strictly after the last row the previous page READ, whatever
     * happened to it. A session left unstamped because storage could not
     * confirm an object gone sits behind the cursor and is read again by the
     * next run, not this one: one attempt per run, the rule cv-purge has.
     */
    let cursor: Cursor | null = null;

    for (;;) {
      if (stoppedDuring) break;
      if (overBudget()) {
        stoppedDuring = "sessions";
        break;
      }

      let read = service
        .from("interview_sessions")
        .select("id, delete_after")
        /*
         * archived_at is deliberately NOT filtered here. Archiving is a list
         * affordance, not a retention decision — an archived interview still
         * expires six months after submission, exactly like any other. Adding
         * `.is("archived_at", null)` would let anyone opt a recording out of the
         * promise the candidate agreed to by tidying their list.
         */
        // A null delete_after would never match, so it is never purged. Nothing
        // writes null today (sendInterviewInvite always sets it) — but if that
        // ever changes, the row silently outlives its promise, so it is called
        // out here rather than left implicit.
        .lte("delete_after", now)
        // The marker: a session this purge has finished is never read again.
        .is("purged_at", null);
      /*
       * FOR WHOEVER EXTENDS THE TESTS: the four existing test files that drive
       * this handler (purge-turns, live-video, async-score-purge, copy-honesty)
       * go through test-support/fake-live-db.mjs, which ignores order, limit
       * and gte and parses or() only for `col.is.null` forms. Their fixtures
       * never fill a page of 500, so this cursor expression is never built
       * there, and they prove nothing about paging. The paging proof is
       * src/lib/interview-purge-decay.test.ts, through the evaluating fake in
       * lib/supabase/fake-table.ts, and its negative controls.
       */
      if (cursor) {
        read = read.or(
          `delete_after.gt.${cursor.deleteAfter},and(delete_after.eq.${cursor.deleteAfter},id.gt.${cursor.id})`,
        );
      }
      const { data, error } = await read
        .order("delete_after", { ascending: true })
        .order("id", { ascending: true })
        .limit(DB_PAGE);

      if (error) {
        const at = cursor ? `after ${cursor.deleteAfter} / ${cursor.id}` : "at the start";
        throw new Error(`purge: sessions ${at}: ${error.message}`);
      }
      const sessions = (data ?? []) as { id: string; delete_after: string }[];
      if (sessions.length === 0) break;
      sessionsExamined += sessions.length;
      const last = sessions[sessions.length - 1];
      cursor = { deleteAfter: last.delete_after, id: last.id };

      for (const ids of chunk(
        sessions.map((s) => s.id),
        ID_CHUNK,
      )) {
        /*
         * The idempotency key, and there is no new column for it: a session is
         * "already purged" precisely when none of its answers still holds a
         * video_path, a transcript or transcript segments. Once cleared, this
         * selector stops matching, so a second run over the same session does
         * no work and makes no storage calls.
         *
         * Segments are in the selector, not just the update, because of every
         * session purged before they were: those rows have no path and no
         * transcript, so without this term they would never match again and
         * their segments would be kept forever.
         */
        const { data: aData, error: aErr } = await service
          .from("interview_answers")
          .select("id, session_id, video_path, transcript, transcript_segments")
          .in("session_id", ids)
          .or("video_path.not.is.null,transcript.not.is.null,transcript_segments.not.is.null");

        if (aErr) throw new Error(`purge: answers: ${aErr.message}`);
        const answers = (aData ?? []) as AnswerRow[];

        // AI Video Interview turns of the same due sessions.
        // Which of this chunk's sessions still hold something after every
        // sub-purge has had its turn. Only a session in none of these sets is
        // stamped; the others are read again by the next run.
        const retryingHere = new Set<string>();
        const handled = new Set<string>();

        const turns = await purgeDueTurns(service, ids, now);
        turnsPurged += turns.purged;
        objectsRemoved += turns.objectsRemoved;
        for (const id of turns.retryingSessions) retryingHere.add(id);
        scoresCleared += await purgeLiveScoreWords(service, ids);
        const asyncScores = await purgeAsyncScoreWords(service, ids);
        asyncScoresCleared += asyncScores.answers + asyncScores.sessions;
        const video = await purgeDueVideoPieces(service, ids, now);
        piecesPurged += video.purged;
        objectsRemoved += video.objectsRemoved;
        for (const id of video.retryingSessions) retryingHere.add(id);

        const bySession = new Map<string, AnswerRow[]>();
        for (const a of answers) {
          const list = bySession.get(a.session_id);
          if (list) list.push(a);
          else bySession.set(a.session_id, [a]);
        }

        for (const [sessionId, rows] of bySession) {
          if (overBudget()) {
            stoppedDuring = "sessions";
            break;
          }
          handled.add(sessionId);

          /*
           * Removes EVERY object under the folder, not just the referenced ones:
           * a session past its retention date should keep nothing, including
           * whatever an abandoned upload left behind.
           */
          let sweep: Awaited<ReturnType<typeof removeSessionObjects>>;
          try {
            sweep = await removeSessionObjects(service, sessionId);
          } catch (err) {
            // Storage unreachable for this session. Leave every row intact so
            // the next run retries the whole thing rather than clearing paths
            // for objects that may still exist.
            console.error(`[purge] ${sessionId}: ${(err as Error).message}`);
            retryingHere.add(sessionId);
            continue;
          }
          if (sweep.error) {
            console.error(`[purge] ${sessionId}: remove: ${sweep.error}`);
          }
          const present = new Set(sweep.present);
          const removed = sweep.removed;
          objectsRemoved += removed.size;

          /*
           * ── Why the row update is split ──
           *
           * A storage delete that fails must not block the row update, and must
           * not lose track of what still needs removing. video_path IS the only
           * record of where the object lives, so clearing it on a failed delete
           * would strand the file forever with nothing pointing at it.
           *
           * So: the transcript and its segments are cleared for every due row
           * unconditionally — they live in the database, their deletion cannot
           * fail, and the promise covers them. video_path is cleared ONLY for objects confirmed gone,
           * which means either the remove() reported them or they were not in
           * storage to begin with. Anything else keeps its path and is picked up
           * on the next run, and the `or(...)` selector above still matches it
           * because video_path is still set.
           */
          const cleared: string[] = [];
          const transcriptOnly: string[] = [];
          for (const row of rows) {
            const path = row.video_path;
            const objectGone = !path || !present.has(path) || removed.has(path);
            if (objectGone) cleared.push(row.id);
            else transcriptOnly.push(row.id);
          }

          if (cleared.length > 0) {
            const { error } = await service
              .from("interview_answers")
              .update({ video_path: null, transcript: null, transcript_segments: null })
              .in("id", cleared);
            if (error) throw new Error(`purge: clear rows: ${error.message}`);
            rowsCleared += cleared.length;
          }
          if (transcriptOnly.length > 0) {
            const { error } = await service
              .from("interview_answers")
              .update({ transcript: null, transcript_segments: null })
              .in("id", transcriptOnly);
            if (error) throw new Error(`purge: clear transcripts: ${error.message}`);
            retryingHere.add(sessionId);
          }
        }

        /*
         * THE MARKER. A session is stamped only when every sub-purge ran for it
         * and none left anything to retry: the same predicate migration 051's
         * backfill evaluates from the rows. A session whose answers were still
         * waiting when the budget stopped the loop above is not stamped either.
         */
        const markable = ids.filter(
          (id) => !retryingHere.has(id) && (handled.has(id) || !bySession.has(id)),
        );
        for (const id of retryingHere) retrying.add(id);
        if (markable.length > 0) {
          const { error: markErr } = await service
            .from("interview_sessions")
            .update({ purged_at: now })
            .in("id", markable)
            .is("purged_at", null);
          if (markErr) throw new Error(`purge: mark sessions: ${markErr.message}`);
          sessionsMarked += markable.length;
        }
        if (stoppedDuring) break;
      }

      if (stoppedDuring || sessions.length < DB_PAGE) break;
    }
  };

  // Phase 1b FIRST, then Phase 1. The order is load-bearing: see LATE_WORDS_BUDGET_MS.
  await sweepLateWords();
  await sweepDueSessions();

  // ── Phase 2 — orphaned objects, only once Phases 1 and 1b finished ──
  // Best-effort here: with a backlog this never runs. The guarantee is the
  // separate interview_orphan_sweep job (runInterviewOrphanSweep below, #59c).
  // A folder that cannot be read or emptied THROWS (see sweepOrphans), which
  // fails this job as retryable; the stamps above are already persisted, so
  // the retry is cheap and the folder is not quietly passed.
  if (!stoppedDuring) {
    const orphans = await sweepOrphans(service, overBudget);
    orphansRemoved = orphans.removed;
    if (!orphans.complete) stoppedDuring = "orphans";
  }

  const elapsedMs = clock() - startedAt;
  const result: InterviewPurgeResult = stoppedDuring
    ? {
        complete: false,
        stoppedDuring,
        budgetMs,
        sessionsExaminedSoFar: sessionsExamined,
        sessionsMarkedSoFar: sessionsMarked,
        sessionsRetryingSoFar: retrying.size,
        answersClearedSoFar: rowsCleared,
        turnsPurgedSoFar: turnsPurged,
        piecesPurgedSoFar: piecesPurged,
        liveScoresClearedSoFar: scoresCleared,
        asyncScoresClearedSoFar: asyncScoresCleared,
        objectsRemovedSoFar: objectsRemoved,
        orphansRemovedSoFar: orphansRemoved,
        elapsedMs,
      }
    : {
        complete: true,
        sessionsExamined,
        sessionsMarked,
        sessionsRetrying: retrying.size,
        answersCleared: rowsCleared,
        turnsPurged,
        piecesPurged,
        liveScoresCleared: scoresCleared,
        asyncScoresCleared,
        objectsRemoved,
        orphansRemoved,
        elapsedMs,
      };
  console.log(describeInterviewPurge(job.id, result));
  return result;
}

/**
 * Clear the content of every not-yet-purged turn of these due sessions.
 *
 * Selects turns still holding content (content_purged_at null) or still
 * pointing at an object (media_path set), so a turn whose object delete failed
 * is picked up again, and a fully purged turn is never touched twice.
 */
/**
 * What one orphan-sweep run did, and whether it finished (#59c, #59d).
 *
 * An incomplete run carries `resumeAfter`: the last folder it finished, which
 * the handler writes into its own job's payload and the scheduler copies into
 * the next day's job, so the next run starts after it instead of re-walking
 * every referenced folder from the top. Without that, a bucket with more
 * referenced folders than one budget can list would never reach an orphan
 * behind them: the first persisted cursor in this file, and the reason the
 * sweep can promise progress.
 */
export type InterviewOrphanSweepResult =
  | { complete: true; orphansRemoved: number; foldersWalked: number; elapsedMs: number }
  | {
      complete: false;
      budgetMs: number;
      orphansRemovedSoFar: number;
      foldersWalkedSoFar: number;
      resumeAfter: string | null;
      elapsedMs: number;
    };

export function describeInterviewOrphanSweep(jobId: string, r: InterviewOrphanSweepResult): string {
  return r.complete
    ? `[orphan-sweep] job ${jobId}: COMPLETE in ${r.elapsedMs} ms: orphans=${r.orphansRemoved} ` +
        `folders=${r.foldersWalked}`
    : `[orphan-sweep] job ${jobId}: INCOMPLETE, budget of ${r.budgetMs} ms reached after ` +
        `${r.elapsedMs} ms: orphans so far=${r.orphansRemovedSoFar} folders so far=${r.foldersWalkedSoFar}. ` +
        `The rest of the bucket was NOT examined; the next run resumes after ` +
        `${r.resumeAfter ?? "(the start)"}.`;
}

/** The queue's handler for interview_orphan_sweep: the sweep with the whole budget to itself. */
export async function handleInterviewOrphanSweep(
  job: { id: string; payload: Record<string, unknown> },
  _ctx?: unknown,
  opts: { budgetMs?: number; clock?: () => number; graceMs?: number } = {},
): Promise<void> {
  await runInterviewOrphanSweep(job, opts);
}

/**
 * The orphan sweep as its own job (#59c). An orphan is an object under a
 * session folder that no answer, turn or video piece names, older than
 * ORPHAN_GRACE_MS: a candidate recording whose row write failed after the
 * upload, with no row and so no delete_after. Nothing else ever expires it.
 * Inside the purge it sits behind Phase 1, which a backlog starves; here it
 * cannot be starved by that backlog at all.
 *
 * ── The ceiling, measured on staging 2026-10-29 (#59, item 3) ───
 *
 * 260 one-object folders in interview-videos, real calls through the SDK:
 *
 *   root page, limit 100 ........ 327 ms median (339 ms p90): 3.3 ms per folder
 *   root page, limit 1000 ....... 341 ms for 260 entries, one page
 *   root page, NO limit ......... 100 entries: the API default, as suspected
 *   one folder's listing ........ 197 ms median (286 ms p90)
 *   one object's removal ........ 375 ms median (492 ms p90)
 *
 * With STORAGE_PAGE 100 and BUDGET_MS 18 000, the root listing ALONE spends
 * the budget at about 5,500 folders (18 000 / 327 × 100), and from there no
 * folder is ever walked. Long before that the walk rate binds: after the
 * root pages, each folder costs ~200 ms, so a run walks roughly
 * (18 000 − 3.3 × folders) / 200 folders. 1,000 folders: ~75 per run, a full
 * cycle every ~13 daily runs. 3,000 folders: ~40 per run, ~75 days a cycle.
 * The cursor keeps every cycle complete; it does not make it fast.
 *
 * If the bucket ever approaches those sizes, in order of cheapness: list the
 * root with limit 1000 (one page of 260 cost the same as one page of 100, so
 * the saturation point moves to ~55,000 folders); give the sweep more than
 * one run a day; then a per-prefix split of the walk across runs. Measure
 * again before choosing: these numbers are one staging project on one day.
 */
export async function runInterviewOrphanSweep(
  job: { id: string; payload: Record<string, unknown> },
  opts: { budgetMs?: number; clock?: () => number; graceMs?: number } = {},
): Promise<InterviewOrphanSweepResult> {
  const service = createServiceClient();
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const startedAt = clock();
  const overBudget = () => clock() - startedAt > budgetMs;
  const carried = (job.payload as { cursor?: unknown }).cursor;
  // `graceMs` is a test seam like the budget and the clock: a staging proof
  // uploads its objects minutes before the sweep, and the worker passes nothing.
  const sweep = await sweepOrphans(
    service,
    overBudget,
    typeof carried === "string" ? carried : null,
    opts.graceMs ?? ORPHAN_GRACE_MS,
  );
  const elapsedMs = clock() - startedAt;
  const result: InterviewOrphanSweepResult = sweep.complete
    ? { complete: true, orphansRemoved: sweep.removed, foldersWalked: sweep.walked, elapsedMs }
    : {
        complete: false,
        budgetMs,
        orphansRemovedSoFar: sweep.removed,
        foldersWalkedSoFar: sweep.walked,
        resumeAfter: sweep.lastFolder,
        elapsedMs,
      };
  /*
   * The cursor, persisted in this job's own row. ensureMaintenanceScheduled
   * copies `payload.cursor` from the latest job of this type into tomorrow's
   * (RecurringJob.carry), so a run that stopped for budget is continued, not
   * repeated. A completed run clears it, so the next one starts at the top.
   * Non-fatal: a failed write costs one re-walk, not the sweep.
   */
  const cursor = result.complete ? null : result.resumeAfter;
  const { error: cursorErr } = await service
    .from("background_jobs")
    .update({ payload: { ...job.payload, cursor } })
    .eq("id", job.id);
  if (cursorErr) console.error(`[orphan-sweep] cursor not saved: ${cursorErr.message}`);
  console.log(describeInterviewOrphanSweep(job.id, result));
  return result;
}

async function purgeDueTurns(
  service: Service,
  sessionIds: string[],
  now: string,
): Promise<{ purged: number; objectsRemoved: number; retryingSessions: Set<string> }> {
  const { data, error } = await service
    .from("interview_turns")
    .select("id, session_id, media_path")
    .in("session_id", sessionIds)
    .or("content_purged_at.is.null,media_path.not.is.null");
  if (error) throw new Error(`purge: turns: ${error.message}`);
  const turns = (data ?? []) as TurnRow[];
  const bySession = new Map<string, TurnRow[]>();
  for (const t of turns) {
    const list = bySession.get(t.session_id);
    if (list) list.push(t);
    else bySession.set(t.session_id, [t]);
  }

  let purged = 0;
  let objectsRemoved = 0;
  const retryingSessions = new Set<string>();
  const words = {
    text: null,
    transcript: null,
    transcript_segments: null,
    transcript_error: null,
    follow_up_reason: null,
    content_purged_at: now,
  };
  for (const [sessionId, rows] of bySession) {
    let sweep: Awaited<ReturnType<typeof removeSessionObjects>>;
    try {
      sweep = await removeSessionObjects(service, sessionId);
    } catch (err) {
      // Storage unreachable: leave the turns as they are for the next run.
      console.error(`[purge] turns ${sessionId}: ${(err as Error).message}`);
      retryingSessions.add(sessionId);
      continue;
    }
    objectsRemoved += sweep.removed.size;
    const present = new Set(sweep.present);
    const gone: string[] = [];
    const kept: string[] = [];
    for (const t of rows) {
      const objectGone =
        !t.media_path || !present.has(t.media_path) || sweep.removed.has(t.media_path);
      (objectGone ? gone : kept).push(t.id);
    }
    if (gone.length > 0) {
      const { error: e } = await service
        .from("interview_turns")
        .update({ ...words, media_path: null })
        .in("id", gone);
      if (e) throw new Error(`purge: clear turns: ${e.message}`);
      purged += gone.length;
    }
    if (kept.length > 0) {
      // The words go now; the path stays until its object is confirmed gone.
      const { error: e } = await service.from("interview_turns").update(words).in("id", kept);
      if (e) throw new Error(`purge: clear turn words: ${e.message}`);
      retryingSessions.add(sessionId);
    }
  }
  return { purged, objectsRemoved, retryingSessions };
}

/**
 * Clear every live video piece of these due sessions (migration 044). The
 * objects go with the session's folder; a row's media_path is cleared, and
 * content_purged_at stamped, only once its object is confirmed gone.
 */
async function purgeDueVideoPieces(
  service: Service,
  sessionIds: string[],
  now: string,
): Promise<{ purged: number; objectsRemoved: number; retryingSessions: Set<string> }> {
  const { data, error } = await service
    .from("live_video_pieces")
    .select("id, session_id, media_path")
    .in("session_id", sessionIds)
    .not("media_path", "is", null);
  if (error) throw new Error(`purge: video pieces: ${error.message}`);
  const bySession = new Map<string, { id: string; media_path: string }[]>();
  for (const p of (data ?? []) as { id: string; session_id: string; media_path: string }[]) {
    const list = bySession.get(p.session_id);
    if (list) list.push(p);
    else bySession.set(p.session_id, [p]);
  }
  let purged = 0;
  let objectsRemoved = 0;
  const retryingSessions = new Set<string>();
  for (const [sessionId, rows] of bySession) {
    let sweep: Awaited<ReturnType<typeof removeSessionObjects>>;
    try {
      sweep = await removeSessionObjects(service, sessionId);
    } catch (err) {
      console.error(`[purge] video ${sessionId}: ${(err as Error).message}`);
      retryingSessions.add(sessionId);
      continue;
    }
    objectsRemoved += sweep.removed.size;
    const present = new Set(sweep.present);
    const gone = rows
      .filter((p) => !present.has(p.media_path) || sweep.removed.has(p.media_path))
      .map((p) => p.id);
    if (gone.length < rows.length) retryingSessions.add(sessionId);
    if (gone.length > 0) {
      const { error: e } = await service
        .from("live_video_pieces")
        .update({ media_path: null, content_purged_at: now })
        .in("id", gone);
      if (e) throw new Error(`purge: clear video pieces: ${e.message}`);
      purged += gone.length;
    }
  }
  return { purged, objectsRemoved, retryingSessions };
}

/**
 * Collect objects that no answer row or turn points at.
 *
 * ── Where orphans come from ──────────────────────────────────
 *
 * The upload is a two-step: the browser PUTs to a signed URL, then calls
 * /api/interview/confirm, which is what writes the row. A PUT that succeeds
 * with no confirm — tab closed, connection dropped, confirm rejected the file
 * — leaves an object nothing references. Before this, nothing collected them.
 *
 * ── How an in-flight upload is protected ─────────────────────
 *
 * By AGE, not by guessing at intent. An object is only a candidate once it is
 * older than ORPHAN_GRACE_MS (24h), which is orders of magnitude longer than
 * the gap between a PUT completing and confirm running — that gap is one HTTP
 * round trip, bounded by the client's own upload timeout of ten minutes.
 *
 * Deleting a stale orphan is safe even if the candidate does return: paths are
 * deterministic (`{sessionId}/q{position}.{ext}`), so a retry re-uploads to the
 * same key and confirm re-verifies it from scratch.
 *
 * Folders whose session row no longer exists are swept whole, under the same
 * grace period.
 */
async function sweepOrphans(
  service: Service,
  overBudget: () => boolean,
  resumeAfter: string | null = null,
  graceMs: number = ORPHAN_GRACE_MS,
): Promise<{ removed: number; complete: boolean; walked: number; lastFolder: string | null }> {
  let removedCount = 0;
  let walked = 0;
  let lastFolder: string | null = null;
  const cutoff = Date.now() - graceMs;
  const stop = () => ({ removed: removedCount, complete: false, walked, lastFolder });

  /*
   * Every root folder is listed BEFORE anything is removed (#59d). Supabase's
   * list() is offset-paged and a folder is virtual: removing its last object
   * makes it vanish from the next root page and shifts every later folder by
   * one, so a sweep that deleted while still paging the root skipped a folder
   * per emptied folder. Listing to the end first, then sweeping, makes the
   * offsets stable for as long as they are used. `limit` is always passed:
   * the API's default is 100 and nothing above it would ever be seen.
   */
  const listed: string[] = [];
  for (let offset = 0; ; offset += STORAGE_PAGE) {
    if (overBudget()) return stop();
    const { data, error } = await service.storage
      .from(INTERVIEW_BUCKET)
      .list("", { limit: STORAGE_PAGE, offset });
    if (error) throw new Error(`orphan sweep: list root: ${error.message}`);
    // Folders come back with a null id; files at the root are not something
    // this feature creates and are left alone rather than guessed at.
    for (const e of (data ?? []) as { name: string; id: string | null }[]) {
      if (e.id === null) listed.push(e.name);
    }
    if ((data ?? []).length < STORAGE_PAGE) break;
  }
  /*
   * Resume after the cursor, then wrap: the folders after it first, the ones
   * up to and including it after, so one run with budget to spare still
   * covers the whole bucket, and the cursor it leaves is always the last
   * folder it finished.
   */
  listed.sort();
  const from = resumeAfter === null ? -1 : listed.findIndex((f) => f > resumeAfter);
  const folders =
    from <= 0 || from >= listed.length ? listed : [...listed.slice(from), ...listed.slice(0, from)];

  /*
   * A folder that cannot be read or emptied is never passed (#59, item 2).
   * Every failure below THROWS instead of `continue`: the job fails as
   * retryable (three attempts with backoff, then dead and notified), and the
   * cursor is written only by a run that finished, so the next run resumes
   * before the folder that failed and tries it again first. Skipping it
   * would have advanced the cursor past it, and a persistently failing
   * folder would have been invisible until the next full cycle, or forever.
   * The price is that a storage outage fails the sweep loudly, which is what
   * an outage of the only thing that deletes orphans should do.
   */
  for (const sessionId of folders) {
    if (overBudget()) return stop();
    walked += 1;
    lastFolder = sessionId;

    const objects = await listSessionObjects(service, sessionId);
    const stale = objects.filter((o) => o.createdAt > 0 && o.createdAt < cutoff);
    if (stale.length === 0) continue;

    // Referenced paths for THIS session. Read after listing, so an upload
    // confirmed in between is seen as referenced rather than swept.
    const { data: refData, error: refErr } = await service
      .from("interview_answers")
      .select("video_path")
      .eq("session_id", sessionId)
      .not("video_path", "is", null);

    if (refErr) throw new Error(`orphan sweep: refs ${sessionId}: ${refErr.message}`);
    // Turn audio (AI Video Interview) lives in the same folder.
    const { data: turnRefs, error: turnRefErr } = await service
      .from("interview_turns")
      .select("media_path")
      .eq("session_id", sessionId)
      .not("media_path", "is", null);
    if (turnRefErr) throw new Error(`orphan sweep: turn refs ${sessionId}: ${turnRefErr.message}`);
    // Live interview camera video: a CONFIRMED piece is referenced; a
    // reserved piece's upload that was never confirmed is not.
    const { data: pieceRefs, error: pieceRefErr } = await service
      .from("live_video_pieces")
      .select("media_path")
      .eq("session_id", sessionId)
      .eq("status", "confirmed")
      .not("media_path", "is", null);
    if (pieceRefErr)
      throw new Error(`orphan sweep: piece refs ${sessionId}: ${pieceRefErr.message}`);
    const referenced = new Set(
      [
        ...((refData ?? []) as { video_path: string | null }[]).map((r) => r.video_path),
        ...((turnRefs ?? []) as { media_path: string | null }[]).map((r) => r.media_path),
        ...((pieceRefs ?? []) as { media_path: string | null }[]).map((r) => r.media_path),
      ].filter((p): p is string => Boolean(p)),
    );

    const orphans = stale
      .map((o) => `${sessionId}/${o.name}`)
      .filter((path) => !referenced.has(path));
    if (orphans.length === 0) continue;

    const { data: gone, error: rmErr } = await service.storage
      .from(INTERVIEW_BUCKET)
      .remove(orphans);
    if (rmErr) throw new Error(`orphan sweep: remove ${sessionId}: ${rmErr.message}`);
    removedCount += ((gone ?? []) as unknown[]).length;
  }

  return { removed: removedCount, complete: true, walked, lastFolder };
}
