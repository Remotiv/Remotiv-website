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
 * `.lte("cv_delete_after", now)`, and that is the whole of it. A null never
 * satisfies a comparison in SQL, so a null cv_delete_after means KEEP FOREVER
 * and is unreachable here. The date is read from the column and never computed:
 * nothing in this file knows what "24 months" is, so no edit to a constant can
 * widen what gets deleted. Changing the retention period is a backfill, done
 * deliberately, with the rows visible before anything is removed.
 *
 * ── The second guard, and why it is gone ─────────────────────
 *
 * This selector also carried `.not("company_id_snapshot", "is", null)`, on the
 * reasoning that a null snapshot marks a Remotiv-owned row — the talent pool,
 * or an applicant to Remotiv's own listing — whose CV "IS the marketplace" and
 * must never expire.
 *
 * That reasoning does not survive contact with the person it is about. It made
 * one promise to someone who applied to a client's job and a different, silent
 * one to someone who applied to ours, and the difference was invisible to both.
 * Applying to Remotiv is not consent to be held indefinitely. Every applicant
 * now gets the same 24 months from the day they applied, /api/apply writes the
 * date for every row it inserts, and the guard came off so those rows can
 * actually be reached.
 *
 * What that guard was protecting is protected properly instead: a talent-pool
 * profile is a separate row on its own rolling clock (lib/talent-retention.ts),
 * and where the two rows name the SAME storage object — the bridge copies the
 * path rather than re-uploading — findSharedPaths keeps the file alive for
 * whichever row has not expired yet. The marketplace inventory is the profile,
 * and nothing here deletes a profile.
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
  let objectsKept = 0;
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
    const shared = new Set<string>();
    const self = { table: "job_applications", ids: new Set(rows.map((r) => r.id)) };

    for (const batch of chunk(withPath, REMOVE_CHUNK)) {
      if (Date.now() - startedAt > BUDGET_MS) {
        truncated = true;
        break;
      }
      const paths = [...new Set(batch.map((r) => r.cv_path))];

      /*
       * WHO ELSE HOLDS THESE KEYS — asked before anything is deleted.
       *
       * A bridged applicant's CV is one object with two rows naming it, and
       * this job reaches it first for anyone who applied before joining the
       * talent pool. Deleting it here would empty the profile's CV while the
       * profile's own clock still has months to run.
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

    offset += textCleared.length;
    if (truncated || rows.length < DB_PAGE) break;
  }

  console.log(
    `[cv-purge] job ${job.id}: objects=${objectsRemoved} rows=${rowsCleared} ` +
      `retrying=${textOnly}` +
      (objectsKept > 0 ? ` kept=${objectsKept} (still referenced elsewhere)` : "") +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}
