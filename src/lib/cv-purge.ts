import "server-only";
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
 *              CV is that company's hiring record, and it expires.
 *   NULL     — Remotiv's own: the talent pool, and applicants to Remotiv's own
 *              listings. These CVs ARE the marketplace. Purging one destroys
 *              inventory the business is built on. They must never be touched
 *              by this job, under any future change to it.
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
 *      only company rows were backfilled with a date. It is here for the day
 *      someone backfills the column more broadly, or writes it in a new code
 *      path, and does not realise what else reads it. Either guard alone
 *      protects the talent pool; both must fail together to lose it.
 *
 * ── What is removed, and what is kept ────────────────────────
 *
 * REMOVED: the PDF in storage, and `cv_text` — the full contents of that CV,
 * extracted into the database. Deleting the file while keeping a searchable
 * copy of every word in it would be a rename, not a deletion.
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
 * current state, never from a cursor, so the next run resumes exactly where
 * this one stopped without tracking progress anywhere.
 */
const BUDGET_MS = 18_000;

type DueRow = {
  id: string;
  cv_path: string | null;
  cv_text: string | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function handleCvPurge(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const service = createServiceClient();
  const startedAt = Date.now();
  const now = new Date().toISOString();

  let objectsRemoved = 0;
  let rowsCleared = 0;
  let textOnly = 0;
  let truncated = false;

  /*
   * The window offset, advanced by the number of rows that could NOT be
   * finished — not by a fixed page size.
   *
   * The selector shrinks as it succeeds: a purged row stops matching, so the
   * rows behind it slide forward. Advancing by a full page would step over
   * exactly that many unpurged rows on every iteration. Advancing by the stuck
   * count instead lands the next window immediately after the rows still
   * matching, so nothing is skipped and a permanently failing row cannot spin
   * the loop forever — it is passed over once per run and retried on the next.
   */
  let offset = 0;

  for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }

    const { data, error } = await service
      .from("job_applications")
      .select("id, cv_path, cv_text")
      // ── The scope guard. See the banner. ──
      .lte("cv_delete_after", now)
      .not("company_id_snapshot", "is", null)
      /*
       * Idempotency, with no new column: a row is "already purged" precisely
       * when it holds neither a path nor extracted text. Once both are null
       * this stops matching, so a second run over the same application does no
       * work and makes no storage calls — it never even reads the row.
       */
      .or("cv_path.not.is.null,cv_text.not.is.null")
      .order("cv_delete_after", { ascending: true })
      .range(offset, offset + DB_PAGE - 1);

    if (error) throw new Error(`cv purge: offset ${offset}: ${error.message}`);
    const rows = (data ?? []) as DueRow[];
    if (rows.length === 0) break;

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
    const withPath = rows.filter((r): r is DueRow & { cv_path: string } =>
      Boolean(r.cv_path),
    );
    const confirmed = new Set<string>();

    for (const batch of chunk(withPath, REMOVE_CHUNK)) {
      if (Date.now() - startedAt > BUDGET_MS) {
        truncated = true;
        break;
      }
      let outcome: Awaited<ReturnType<typeof removeObjects>>;
      try {
        outcome = await removeObjects(
          service,
          CV_BUCKET,
          batch.map((r) => r.cv_path),
        );
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
      // No path at all means there is nothing left in storage to lose, so the
      // row is safe to finish. Absence is not failure.
      if (!row.cv_path || confirmed.has(row.cv_path)) cleared.push(row.id);
      else textCleared.push(row.id);
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

    offset += textCleared.length;
    if (truncated || rows.length < DB_PAGE) break;
  }

  console.log(
    `[cv-purge] job ${job.id}: objects=${objectsRemoved} rows=${rowsCleared} ` +
      `retrying=${textOnly}` +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}
