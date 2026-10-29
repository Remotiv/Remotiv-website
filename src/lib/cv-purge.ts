import "server-only";
import { findSharedPaths } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * CV retention purge.
 *
 * ── Why this is the biggest one ──────────────────────────────
 *
 * Interview recordings belong to the few candidates who reached that stage. A
 * CV belongs to EVERY applicant, and until this job existed every one of them
 * was held indefinitely — the largest store of personal data in the product,
 * growing with every submission and expiring never.
 *
 * ══ THE SCOPE GUARD — read before changing any selector ═══════
 *
 * `company_id_snapshot` is what separates two entirely different kinds of row
 * that share one table:
 *
 *   NOT NULL — someone applied to a COMPANY's job through the product. Their
 *              CV is that company's hiring record, held on that company's
 *              behalf, and it expires 24 months after they applied.
 *   NULL     — Remotiv's own: the talent pool, and applicants to Remotiv's own
 *              listings. These are KEPT until the person asks us to delete
 *              them. Nothing in this file may touch them.
 *
 * The selector enforces that TWICE, independently:
 *
 *   1. `.lte("cv_delete_after", now)` — a null never satisfies a comparison in
 *      SQL, so a null cv_delete_after means KEEP FOREVER and is unreachable
 *      here. The date is read from the column and never computed: nothing in
 *      this file knows what "24 months" is, so no edit to a constant can widen
 *      what gets deleted. Changing the retention period is a backfill, done
 *      deliberately, with the rows visible before anything is removed.
 *   2. `.not("company_id_snapshot", "is", null)` — redundant TODAY, because
 *      /api/apply writes a date only for company rows. It is here for the day
 *      someone backfills the column more broadly, or writes it in a new code
 *      path, and does not realise what else reads it. Either guard alone
 *      protects the Remotiv-owned rows; both must fail together to lose them.
 *
 * ── This job survived a decision that stopped the others ─────
 *
 * Both guards briefly came off, on the reasoning that applying to Remotiv is
 * not consent to be held indefinitely. That was reversed: Remotiv keeps its own
 * applicants' CVs and its talent-pool profiles until asked to delete them, and
 * the talent-retention jobs are built but NOT SCHEDULED (see jobs-queue.ts).
 *
 * THIS job still runs, and the difference is whose data it is. A client
 * company's applicants are not Remotiv's to keep: that CV was collected for
 * that company's vacancy, the 24 months was set at the moment of applying, the
 * date is already stored on ~every such row, and it is the one retention
 * promise this product has actually been making. Switching it off would keep
 * someone else's candidates' documents indefinitely on a decision they were
 * never party to.
 *
 * ── What is removed, and what is kept ────────────────────────
 *
 * REMOVED: the PDF in storage, and `cv_text` — the full contents of that CV,
 * extracted into the database. Deleting the file while keeping a searchable
 * copy of every word in it would be a rename, not a deletion.
 *
 * ALSO REMOVED: the hiring team's comments on the application
 * (application_team_comments). Those are written opinions about a named person,
 * disclosable to them on request, and they were written alongside the CV — so
 * they expire with it rather than outliving it indefinitely. Nothing deletes an
 * application on a schedule, so without this pass the cascade on that table
 * would never fire and the notes would be kept forever. See the second loop
 * below for why it cannot share the first one's selector.
 *
 * KEPT: the job_applications row. Name, email, stage, screening answers and
 * decision history all survive. The company still knows who applied, when, and
 * what was decided; they no longer hold the document. Deleting the row would
 * erase the hiring record rather than expire the CV — and would silently break
 * every stage history and interview session that references it.
 *
 * That combination is also how a purged application is TOLD APART from one
 * that never had a CV, with no new column: cv_path null with cv_delete_after
 * set and in the past means the document expired. See the drawer and
 * /api/cv/company-application.
 */

/** Matches the bucket /api/apply uploads to and the CV routes sign against. */
const CV_BUCKET = "cvs";

/** PostgREST caps a response at 1000 rows; page well inside that. */
const DB_PAGE = 500;

/** Storage remove() takes a batch; keep the request URL and body sane. */
const REMOVE_CHUNK = 100;

/**
 * Wall-clock budget, matching the interview purge.
 *
 * Stopping early is safe and costs nothing: the selector is derived from
 * current state, and the cursor below lives only inside one run, so the next
 * run starts from the current state again without tracking progress anywhere.
 * What stopping early is NOT is invisible: the result says so (CvPurgeResult).
 */
const BUDGET_MS = 18_000;

type DueRow = {
  id: string;
  cv_path: string | null;
  cv_text: string | null;
  cv_delete_after: string;
};

/** Where the last page ended: the last row READ, whatever happened to it. */
type Cursor = { deleteAfter: string; id: string };

/**
 * What one run did, and whether it finished.
 *
 * Two shapes on purpose (#55a). The run that left 237 of 1,200 due rows
 * unprocessed used to log `rows=481` as though it had finished, and nothing in
 * that line said otherwise. An incomplete run now carries different field
 * NAMES, so no number it reports can be read as a total: `examinedSoFar` is
 * not `examined`, and a reader who wants the total has to notice there is
 * none. `unconfirmed` is the rows whose storage object could not be confirmed
 * gone: text cleared, path kept, read again by the next run.
 */
export type CvPurgeResult =
  | {
      complete: true;
      examined: number;
      cleared: number;
      unconfirmed: number;
      objectsRemoved: number;
      objectsKept: number;
      commentsDeleted: number;
      elapsedMs: number;
    }
  | {
      complete: false;
      stoppedDuring: "applications" | "comments";
      budgetMs: number;
      examinedSoFar: number;
      clearedSoFar: number;
      unconfirmedSoFar: number;
      objectsRemoved: number;
      objectsKept: number;
      commentsDeletedSoFar: number;
      elapsedMs: number;
    };

/** The one log line, with the stop reason first so a scan of the logs sees it. */
export function describeCvPurge(jobId: string, r: CvPurgeResult): string {
  if (r.complete) {
    return (
      `[cv-purge] job ${jobId}: COMPLETE in ${r.elapsedMs} ms: examined=${r.examined} ` +
      `cleared=${r.cleared} unconfirmed=${r.unconfirmed} (text cleared, path kept, read again next run) ` +
      `objects=${r.objectsRemoved} kept=${r.objectsKept} comments=${r.commentsDeleted}`
    );
  }
  return (
    `[cv-purge] job ${jobId}: INCOMPLETE, budget of ${r.budgetMs} ms reached during ${r.stoppedDuring} ` +
    `after ${r.elapsedMs} ms: examined so far=${r.examinedSoFar} cleared so far=${r.clearedSoFar} ` +
    `unconfirmed so far=${r.unconfirmedSoFar} objects=${r.objectsRemoved} kept=${r.objectsKept} ` +
    `comments so far=${r.commentsDeletedSoFar}. The rest of the due set was NOT examined; ` +
    `the next run starts again from the current state.`
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The queue's handler: runs the purge and returns nothing, as every handler does. */
export async function handleCvPurge(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await runCvPurge(job);
}

/**
 * The purge itself, returning what it did. `opts` exists for the tests: a
 * budget they can exhaust and a clock they can move. The handler passes
 * neither.
 */
export async function runCvPurge(
  job: { id: string; payload: Record<string, unknown> },
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<CvPurgeResult> {
  const service = createServiceClient();
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const startedAt = clock();
  const overBudget = () => clock() - startedAt > budgetMs;
  const now = new Date().toISOString();

  let objectsRemoved = 0;
  let objectsKept = 0;
  let rowsCleared = 0;
  let textOnly = 0;
  let examined = 0;
  let stoppedDuring: "applications" | "comments" | null = null;

  /*
   * ── Paged by KEY, not by offset (#55a) ────────────────────────
   *
   * The previous loop ordered by cv_delete_after alone and advanced an offset
   * by the number of rows it could not finish. The arithmetic was right for
   * the filter and wrong for the heap: cv_delete_after is not a total order
   * (everyone who applied in the same second shares one), and a concurrent
   * UPDATE to an indexed column moves a tuple under the window. Reproduced on
   * staging: with a second writer flipping pipeline_stage on rows the loop had
   * not reached, one full run left 237, then 303, of 1,200 due rows untouched
   * and logged a count that looked complete.
   *
   * The order is now (cv_delete_after, id), which is total because id is
   * unique, and each page starts strictly after the last row the previous
   * page READ, whatever happened to that row. A row that moves cannot cross
   * that boundary: it keeps its key.
   *
   * What this does NOT change: a row whose storage object could not be
   * confirmed gone keeps its path, stays in the filter, and is NOT read again
   * in this run. It sits behind the cursor and the next run, a day later,
   * reads it afresh. The offset version did exactly the same: counting a
   * stuck row in the offset moved the window PAST it ("passed over once per
   * run and retried on the next"). The cursor makes that one-attempt-per-run
   * rule structural instead of arithmetical.
   */
  let cursor: Cursor | null = null;

  for (;;) {
    if (overBudget()) {
      stoppedDuring = "applications";
      break;
    }

    /*
     * Idempotency, with no new column: a row is "already purged" precisely
     * when it holds neither a path nor extracted text. Once both are null
     * this stops matching, so a second run over the same application does no
     * work and makes no storage calls — it never even reads the row.
     *
     * One `or` expression carries both that test and the cursor, as one
     * `and(...)`, so PostgREST sees a single logical filter.
     */
    const notYetPurged = "cv_path.not.is.null,cv_text.not.is.null";
    const afterCursor = cursor
      ? `and(or(${notYetPurged}),or(cv_delete_after.gt.${cursor.deleteAfter},` +
        `and(cv_delete_after.eq.${cursor.deleteAfter},id.gt.${cursor.id})))`
      : notYetPurged;

    const { data, error } = await service
      .from("job_applications")
      .select("id, cv_path, cv_text, cv_delete_after")
      // ── The scope guard, both halves. See the banner. ──
      .lte("cv_delete_after", now)
      .not("company_id_snapshot", "is", null)
      .or(afterCursor)
      .order("cv_delete_after", { ascending: true })
      .order("id", { ascending: true })
      .limit(DB_PAGE);

    if (error) {
      const at = cursor ? `after ${cursor.deleteAfter} / ${cursor.id}` : "at the start";
      throw new Error(`cv purge: ${at}: ${error.message}`);
    }
    const rows = (data ?? []) as DueRow[];
    if (rows.length === 0) break;
    examined += rows.length;
    const last = rows[rows.length - 1];
    cursor = { deleteAfter: last.cv_delete_after, id: last.id };

    /*
     * ── Why the row update is split ──
     *
     * Same reasoning as the interview purge, and the same hazard. cv_path IS
     * the only record of where the PDF lives: clearing it after a failed
     * delete strands the file permanently, with nothing left pointing at it
     * and no sweep that would ever find it.
     *
     * So cv_text is cleared for every due row unconditionally — it lives in
     * the database, its deletion cannot half-succeed — while cv_path is
     * cleared ONLY for objects storage confirmed gone. Anything else keeps its
     * path, still matches the `or(...)` selector above, and is retried on the
     * next run.
     */
    const withPath = rows.filter((r): r is DueRow & { cv_path: string } => Boolean(r.cv_path));
    const confirmed = new Set<string>();
    const shared = new Set<string>();
    const self = { table: "job_applications", ids: new Set(rows.map((r) => r.id)) };

    for (const batch of chunk(withPath, REMOVE_CHUNK)) {
      if (overBudget()) {
        stoppedDuring = "applications";
        break;
      }
      const paths = [...new Set(batch.map((r) => r.cv_path))];

      /*
       * WHO ELSE HOLDS THESE KEYS — asked before anything is deleted.
       *
       * A storage object is not owned by the row that names it: the same key is
       * COPIED, never re-uploaded, into talent_profiles and onward into
       * client_batch_candidates. Deleting one here because this row expired
       * would empty a CV that another record still advertises.
       *
       * Not strictly reachable while the scope guard above holds — a client
       * company's application is not a row anything copies from. It stays
       * because that is an argument, and this is a check: it costs one indexed
       * read per batch, and the guard has come off once already.
       *
       * A failure to answer skips the batch whole rather than guessing. Both
       * guesses lose data: "assume shared" clears rows and strands their files,
       * "assume unshared" deletes a CV another row still advertises. These rows
       * keep matching the selector and are retried next run.
       */
      let sharedHere: Set<string>;
      try {
        sharedHere = await findSharedPaths(service, "cv_path", paths, self);
      } catch (err) {
        console.error(
          `[cv-purge] shared-reference check failed, batch skipped: ${(err as Error).message}`,
        );
        continue;
      }
      for (const path of sharedHere) shared.add(path);
      objectsKept += sharedHere.size;

      const removable = paths.filter((p) => !sharedHere.has(p));
      if (removable.length === 0) continue;

      let outcome: Awaited<ReturnType<typeof removeObjects>>;
      try {
        outcome = await removeObjects(service, CV_BUCKET, removable);
      } catch (err) {
        // Storage unreachable. Leave every path intact so the next run retries
        // rather than clearing paths for objects that may still exist.
        console.error(`[cv-purge] remove threw: ${(err as Error).message}`);
        continue;
      }
      if (outcome.error) {
        console.error(`[cv-purge] remove: ${outcome.error}`);
      }
      for (const path of outcome.removed) confirmed.add(path);
      objectsRemoved += outcome.removed.size;
    }

    const cleared: string[] = [];
    const textCleared: string[] = [];
    for (const row of rows) {
      /*
       * Three ways a row is finished, and they are not the same thing:
       *
       *   no path        — nothing left in storage to lose. Absence is not
       *                    failure.
       *   confirmed gone — the object was deleted.
       *   shared         — the object was deliberately LEFT, because another
       *                    row still names it. The application still expires:
       *                    its cv_path and cv_text go, the company no longer
       *                    holds the document, and the file survives only for
       *                    the other row's own retention period.
       *
       * A failed delete is none of these and must hold the row back — clearing
       * cv_path then would strand the file with nothing naming it.
       */
      if (!row.cv_path || confirmed.has(row.cv_path) || shared.has(row.cv_path)) {
        cleared.push(row.id);
      } else {
        textCleared.push(row.id);
      }
    }

    if (cleared.length > 0) {
      const { error: clearErr } = await service
        .from("job_applications")
        .update({ cv_path: null, cv_text: null })
        .in("id", cleared);
      if (clearErr) throw new Error(`cv purge: clear rows: ${clearErr.message}`);
      rowsCleared += cleared.length;
    }
    if (textCleared.length > 0) {
      const { error: textErr } = await service
        .from("job_applications")
        .update({ cv_text: null })
        .in("id", textCleared);
      if (textErr) throw new Error(`cv purge: clear text: ${textErr.message}`);
      textOnly += textCleared.length;
    }

    if (stoppedDuring || rows.length < DB_PAGE) break;
  }

  /*
   * ── Second pass: the hiring team's comments ──────────────────
   *
   * A SEPARATE loop, and it must be. The loop above carries
   * `or(cv_path.not.is.null, cv_text.not.is.null)` as its idempotency test, so
   * an application stops matching the moment its CV is gone. Every application
   * purged before this pass was written is already invisible to that selector,
   * permanently — folding the comment delete in there would miss all of them,
   * silently, and the miss would never surface because the rows it skips are
   * exactly the rows it cannot see.
   *
   * This selector is idempotent on its own terms instead: a deleted comment
   * stops matching it, so a second run over the same application reads nothing
   * and deletes nothing. That also removes the need for the cursor above — no
   * row can fail and stay matching, because a failed delete throws.
   *
   * Both halves of the scope guard are restated against the parent, for the
   * reason the banner gives: Remotiv's own pool keeps its comments exactly as
   * it keeps its CVs.
   *
   * `!inner` is load-bearing. Without it PostgREST builds a LEFT join, the
   * parent predicate stops restricting the top-level rows, and this deletes the
   * comments on EVERY application in the table. Verified read-only against
   * production before shipping: with the hint an impossible parent predicate
   * matches 0 rows and the real selector agrees with a join-free count over the
   * due ids; without it the same predicate matches the whole table.
   */
  let commentsDeleted = 0;
  for (;;) {
    if (stoppedDuring) break;
    if (overBudget()) {
      stoppedDuring = "comments";
      break;
    }

    const { data, error } = await service
      .from("application_team_comments")
      .select("id, job_applications!inner(cv_delete_after, company_id_snapshot)")
      .lte("job_applications.cv_delete_after", now)
      .not("job_applications.company_id_snapshot", "is", null)
      .limit(DB_PAGE);

    if (error) throw new Error(`cv purge: due comments: ${error.message}`);
    const ids = ((data ?? []) as unknown as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) break;

    /*
     * Replies go with their root by the composite FK's ON DELETE CASCADE, so a
     * batch that names a root and its reply deletes the reply twice over — the
     * second is a no-op against a row already gone, not an error. The count is
     * therefore rows NAMED, which can exceed rows that existed by the time the
     * statement ran. It is a log line, not a receipt.
     */
    const { error: delErr } = await service
      .from("application_team_comments")
      .delete()
      .in("id", ids);
    if (delErr) throw new Error(`cv purge: delete comments: ${delErr.message}`);
    commentsDeleted += ids.length;

    if (ids.length < DB_PAGE) break;
  }

  const elapsedMs = clock() - startedAt;
  const result: CvPurgeResult = stoppedDuring
    ? {
        complete: false,
        stoppedDuring,
        budgetMs,
        examinedSoFar: examined,
        clearedSoFar: rowsCleared,
        unconfirmedSoFar: textOnly,
        objectsRemoved,
        objectsKept,
        commentsDeletedSoFar: commentsDeleted,
        elapsedMs,
      }
    : {
        complete: true,
        examined,
        cleared: rowsCleared,
        unconfirmed: textOnly,
        objectsRemoved,
        objectsKept,
        commentsDeleted,
        elapsedMs,
      };
  console.log(describeCvPurge(job.id, result));
  return result;
}
