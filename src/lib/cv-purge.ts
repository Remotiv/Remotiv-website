import "server-only";
import { cvObjectState } from "@/lib/cv-object";
import { describeCvOrphanSweep, runCvOrphanSweep } from "@/lib/cv-orphan-sweep";
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
 * the talent-pool retention jobs were removed on 11 Nov 2026 (#61).
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
 * ALSO REMOVED (#91): the AI's words about the CV, from application_scores.
 * The scorer copies verbatim CV spans into the card as evidence
 * (ai/cv-scoring.ts, the quote rules), so a card that outlives the CV keeps
 * pieces of it. Cleared: summary, verdict, evidence, strengths, concerns,
 * missing_requirements, each dimension's reasoning and quote, each must-have's
 * quote. KEPT: every number, the confidence, the status, each dimension and
 * its unstated flag, each must-have's item and status, and every human
 * adjustment with its note, as the interview purge keeps an interview's
 * (interviews/async-score-purge.ts). The verdict goes too: the prompt asks only
 * for "one line, max 12 words: the fit and the key caveat" and the parser only
 * caps its length (score-parsers.ts MAX_VERDICT_CHARS), so nothing stops it
 * naming an employer or a school. See the third loop below.
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
 * Stopping early is safe and costs nothing: every selector is derived from
 * current state, so the next run starts from the current state again without
 * tracking progress anywhere. What stopping early is NOT is invisible: the
 * result says so (CvPurgeResult).
 */
const BUDGET_MS = 18_000;

/**
 * How the budget is shared (#60). The text pass is database-only and cheap,
 * so it may use at most the first quarter. The storage pass then runs until
 * three quarters: a GUARANTEED half of the budget at least, never leftovers.
 * The comments and scores passes have the rest, and whatever the storage pass
 * did not need.
 */
const TEXT_SHARE = 0.25;
const STORAGE_UNTIL = 0.75;

/** Existence checks in flight at once, for paths remove() did not confirm. */
const CHECK_CONCURRENCY = 4;

type DueRow = {
  id: string;
  cv_path: string;
  cv_delete_after: string;
};

/** A query the due filter can be applied to (select, update or count). */
type DueFilterable<Q> = {
  lte(column: string, value: string): Q;
  not(column: string, operator: string, value: null): Q;
};

/** Where the storage pass's last page ended: the last row READ. */
type Cursor = { deleteAfter: string; id: string };

/**
 * What one run did, per pass, and whether ANY due work is left (#60).
 *
 * `complete` is true only when every pass reached its end, nothing was held
 * or left unattempted, and a final count finds no due row still holding a
 * path or text. A run that cleared everything it touched but stopped for
 * budget, or held a single file it could not confirm gone, is not complete.
 *
 *   text.cleared           due rows whose cv_text this run cleared
 *   storage.removed        objects storage confirmed it deleted
 *   storage.alreadyMissing paths storage reports do not exist: nothing left to
 *                          delete, so the path is cleared (not held for ever)
 *   storage.sharedKept     objects left because another row still names them
 *   storage.heldError      rows whose object could not be confirmed gone (a
 *                          storage error, an unknown answer, or an object still
 *                          present): path kept, tried again next run
 *   storage.notAttempted   rows read but not attempted, because the budget ran
 *                          out mid-page: not a failure, and not "unconfirmed"
 *   dueLeft                due rows still holding a path or text after the
 *                          run, or null when that count could not be read
 */
export type CvPurgeResult = {
  complete: boolean;
  budgetMs: number;
  elapsedMs: number;
  text: { cleared: number; finished: boolean };
  storage: {
    examined: number;
    rowsCleared: number;
    removed: number;
    alreadyMissing: number;
    sharedKept: number;
    heldError: number;
    notAttempted: number;
    finished: boolean;
  };
  comments: { deleted: number; finished: boolean };
  scores: { cleared: number; finished: boolean };
  dueLeft: number | null;
};

/** The one log line. COMPLETE only when nothing is left; otherwise what is, first. */
export function describeCvPurge(jobId: string, r: CvPurgeResult): string {
  const counts =
    `text cleared=${r.text.cleared}; storage examined=${r.storage.examined} ` +
    `rows cleared=${r.storage.rowsCleared} removed=${r.storage.removed} ` +
    `already missing=${r.storage.alreadyMissing} shared kept=${r.storage.sharedKept} ` +
    `held (error)=${r.storage.heldError} not attempted=${r.storage.notAttempted}; ` +
    `comments=${r.comments.deleted} scores=${r.scores.cleared}`;
  if (r.complete) {
    return `[cv-purge] job ${jobId}: COMPLETE in ${r.elapsedMs} ms, nothing due is left: ${counts}`;
  }
  const unfinished = (["text", "storage", "comments", "scores"] as const).filter(
    (k) => !r[k].finished,
  );
  const why = [
    unfinished.length > 0
      ? `budget of ${r.budgetMs} ms reached before the end of: ${unfinished.join(", ")}`
      : null,
    r.storage.heldError > 0 ? `${r.storage.heldError} held on a storage error` : null,
    r.storage.notAttempted > 0 ? `${r.storage.notAttempted} not attempted` : null,
    r.dueLeft === null ? "due rows left: unknown (count failed)" : `due rows left=${r.dueLeft}`,
  ].filter(Boolean);
  return (
    `[cv-purge] job ${jobId}: INCOMPLETE after ${r.elapsedMs} ms: ${why.join("; ")}. ${counts}. ` +
    `The next run starts again from the current state.`
  );
}

/**
 * The AI's words on a CV scorecard, as the scores pass leaves them. Every
 * jsonb column here is NOT NULL with a '[]' default, so empty is [], never
 * null; the two text columns are nullable.
 */
export const CV_SCORE_WORDS_CLEARED = {
  summary: null,
  verdict: null,
  evidence: [],
  strengths: [],
  concerns: [],
  missing_requirements: [],
} as const;

type ScoreWords = {
  application_id: string;
  summary: unknown;
  verdict: unknown;
  evidence: unknown;
  strengths: unknown;
  concerns: unknown;
  missing_requirements: unknown;
  dimension_scores: unknown;
  must_haves: unknown;
};

const filledText = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** An array with entries, or an object with keys (v4's evidence envelope). */
const filledJson = (v: unknown) =>
  Array.isArray(v)
    ? v.length > 0
    : v !== null && typeof v === "object" && Object.keys(v).length > 0;

/** The entries of a jsonb array, or of an object's values (a legacy keyed shape). */
const entriesOf = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v !== null && typeof v === "object" ? Object.values(v) : [];

/** Blank the named string fields of one entry; every other field is kept as it is. */
function blankFields(entry: unknown, fields: readonly string[]): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const f of fields) if (typeof out[f] === "string") out[f] = "";
  return out;
}

/** Same shape back, array or keyed object, with the named fields of each entry blanked. */
function blankEach(v: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(v)) return v.map((e) => blankFields(e, fields));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, e]) => [k, blankFields(e, fields)]),
    );
  }
  return v;
}

const DIMENSION_WORDS = ["reasoning", "quote"] as const;
const MUST_HAVE_WORDS = ["quote"] as const;

/** Each dimension kept with its dimension, score and unstated flag; reasoning and quote "". */
export function clearDimensionWords(v: unknown): unknown {
  return blankEach(v, DIMENSION_WORDS);
}

/** Each must-have kept with its item and status; quote "". */
export function clearMustHaveQuotes(v: unknown): unknown {
  return blankEach(v, MUST_HAVE_WORDS);
}

/** Whether a scorecard still holds any of the AI's words about the CV. */
export function scoreWordsLeft(r: Omit<ScoreWords, "application_id">): boolean {
  return (
    filledText(r.summary) ||
    filledText(r.verdict) ||
    filledJson(r.evidence) ||
    filledJson(r.strengths) ||
    filledJson(r.concerns) ||
    filledJson(r.missing_requirements) ||
    entriesOf(r.dimension_scores).some((e) =>
      DIMENSION_WORDS.some((f) => filledText((e as Record<string, unknown> | null)?.[f])),
    ) ||
    entriesOf(r.must_haves).some((e) =>
      MUST_HAVE_WORDS.some((f) => filledText((e as Record<string, unknown> | null)?.[f])),
    )
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
  try {
    await runCvPurge(job);
  } finally {
    // Last phase: CV files no row names any more (cv-orphan-sweep.ts). A dry
    // run unless CV_ORPHAN_SWEEP_LIVE is "true". It runs even when the purge
    // threw (#60), and never fails the job itself: the purge's own error, if
    // any, is still the one the queue sees.
    try {
      const sweep = await runCvOrphanSweep(createServiceClient());
      const line = describeCvOrphanSweep(job.id, sweep);
      if (sweep.stopped && sweep.stopped !== "cap" && sweep.stopped !== "budget") {
        console.error(line);
      } else console.log(line);
    } catch {
      console.error(`[cv-orphan-sweep] job ${job.id}: the sweep threw; nothing more was deleted`);
    }
  }
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
  const past = (share: number) => clock() - startedAt > budgetMs * share;
  const now = new Date().toISOString();

  /** The due set, both halves of the scope guard. See the banner. */
  const due = <Q extends DueFilterable<Q>>(q: Q): Q =>
    q.lte("cv_delete_after", now).not("company_id_snapshot", "is", null);

  /*
   * ── First pass: the extracted text (#60) ─────────────────────
   *
   * Every due row's cv_text, cleared before any storage call. It lives in the
   * database, its deletion cannot half-succeed, and nothing about the PDF
   * should hold it back: a storage outage used to leave text and file
   * together on the pages it stopped. A cleared row stops matching, so each
   * page reads the next rows still holding text; a row that comes back after
   * being cleared means the write did not land, and the pass stops rather
   * than spin.
   */
  let textCleared = 0;
  let textFinished = false;
  const textDone = new Set<string>();
  for (;;) {
    if (past(TEXT_SHARE)) break;
    const { data, error } = await due(
      service.from("job_applications").select("id, cv_delete_after"),
    )
      .not("cv_text", "is", null)
      .order("cv_delete_after", { ascending: true })
      .order("id", { ascending: true })
      .limit(DB_PAGE);
    if (error) throw new Error(`cv purge: text page: ${error.message}`);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) {
      textFinished = true;
      break;
    }
    if (ids.some((id) => textDone.has(id))) {
      console.error("[cv-purge] text pass: a cleared row came back; stopping the pass");
      break;
    }
    const { error: textErr } = await due(
      service.from("job_applications").update({ cv_text: null }),
    ).in("id", ids);
    if (textErr) throw new Error(`cv purge: clear text: ${textErr.message}`);
    for (const id of ids) textDone.add(id);
    textCleared += ids.length;
    if (ids.length < DB_PAGE) {
      textFinished = true;
      break;
    }
  }

  /*
   * ── Second pass: the files (#60) ─────────────────────────────
   *
   * NEWEST due first, by (cv_delete_after, id) descending, paged by key. A row
   * this pass cannot finish keeps its path and stays due; in the old oldest
   * first order those held rows were read FIRST on every run and a large
   * enough pile used the whole budget before any newer due row was reached.
   * A held row is by construction older than every row that became due after
   * it, so newest first reaches the new rows before the pile, and the pile is
   * retried with what is left of this pass's share.
   *
   * A path is cleared only when its object is known gone: storage confirmed
   * the delete, or an existence check says it does not exist, or another row
   * still names it (kept on purpose). Anything else (an error, an unknown
   * answer, an object still there) keeps the path: fail closed.
   */
  const storage = {
    examined: 0,
    rowsCleared: 0,
    removed: 0,
    alreadyMissing: 0,
    sharedKept: 0,
    heldError: 0,
    notAttempted: 0,
    finished: false,
  };
  const bucket = service.storage.from(CV_BUCKET);
  let cursor: Cursor | null = null;
  pages: for (;;) {
    if (past(STORAGE_UNTIL)) break;
    let page = due(service.from("job_applications").select("id, cv_path, cv_delete_after")).not(
      "cv_path",
      "is",
      null,
    );
    if (cursor) {
      page = page.or(
        `cv_delete_after.lt.${cursor.deleteAfter},` +
          `and(cv_delete_after.eq.${cursor.deleteAfter},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await page
      .order("cv_delete_after", { ascending: false })
      .order("id", { ascending: false })
      .limit(DB_PAGE);
    if (error) {
      const at = cursor ? `after ${cursor.deleteAfter} / ${cursor.id}` : "at the start";
      throw new Error(`cv purge: ${at}: ${error.message}`);
    }
    const rows = (data ?? []) as DueRow[];
    if (rows.length === 0) {
      storage.finished = true;
      break;
    }
    storage.examined += rows.length;
    const last = rows[rows.length - 1];
    cursor = { deleteAfter: last.cv_delete_after, id: last.id };
    const self = { table: "job_applications", ids: new Set(rows.map((r) => r.id)) };

    const batches = chunk(rows, REMOVE_CHUNK);
    for (let b = 0; b < batches.length; b++) {
      if (past(STORAGE_UNTIL)) {
        // Cut mid-page: the rest of this page was read but never tried.
        storage.notAttempted += batches.slice(b).reduce((n, x) => n + x.length, 0);
        break pages;
      }
      const batch = batches[b];
      const paths = [...new Set(batch.map((r) => r.cv_path))];
      const gone = new Set<string>();

      /*
       * WHO ELSE HOLDS THESE KEYS: asked before anything is deleted. The same
       * key is COPIED, never re-uploaded, into talent_profiles and onward, so
       * deleting it because this row expired would empty a CV another record
       * still advertises. A failure to answer holds the batch whole rather
       * than guess; both guesses lose data.
       */
      let sharedHere: Set<string>;
      try {
        sharedHere = await findSharedPaths(service, "cv_path", paths, self);
      } catch (err) {
        console.error(
          `[cv-purge] shared-reference check failed, batch held: ${(err as Error).message}`,
        );
        storage.heldError += batch.length;
        continue;
      }
      for (const p of sharedHere) gone.add(p);
      storage.sharedKept += sharedHere.size;

      const removable = paths.filter((p) => !sharedHere.has(p));
      let confirmed = new Set<string>();
      if (removable.length > 0) {
        try {
          const outcome = await removeObjects(service, CV_BUCKET, removable);
          if (outcome.error) console.error(`[cv-purge] remove: ${outcome.error}`);
          confirmed = outcome.removed;
        } catch (err) {
          console.error(`[cv-purge] remove threw: ${(err as Error).message}`);
        }
      }
      for (const p of confirmed) gone.add(p);
      storage.removed += confirmed.size;

      // Not confirmed: ask storage whether the object exists at all. Only its
      // own "not found" settles it (cv-object.ts); an error or an object that
      // is still there keeps the path.
      const unsettled = removable.filter((p) => !confirmed.has(p));
      let next = 0;
      const lane = async () => {
        while (next < unsettled.length) {
          const p = unsettled[next++];
          if ((await cvObjectState(bucket, p)).state === "missing") {
            gone.add(p);
            storage.alreadyMissing += 1;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CHECK_CONCURRENCY, unsettled.length) }, lane),
      );

      const cleared = batch.filter((r) => gone.has(r.cv_path)).map((r) => r.id);
      storage.heldError += batch.length - cleared.length;
      if (cleared.length > 0) {
        const { error: clearErr } = await service
          .from("job_applications")
          .update({ cv_path: null, cv_text: null })
          .in("id", cleared);
        if (clearErr) throw new Error(`cv purge: clear rows: ${clearErr.message}`);
        storage.rowsCleared += cleared.length;
      }
    }

    if (rows.length < DB_PAGE) {
      storage.finished = true;
      break;
    }
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
  let commentsFinished = false;
  for (;;) {
    if (overBudget()) break;

    const { data, error } = await service
      .from("application_team_comments")
      .select("id, job_applications!inner(cv_delete_after, company_id_snapshot)")
      .lte("job_applications.cv_delete_after", now)
      .not("job_applications.company_id_snapshot", "is", null)
      .limit(DB_PAGE);

    if (error) throw new Error(`cv purge: due comments: ${error.message}`);
    const ids = ((data ?? []) as unknown as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) {
      commentsFinished = true;
      break;
    }

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

    if (ids.length < DB_PAGE) {
      commentsFinished = true;
      break;
    }
  }

  /*
   * ── Third pass: the AI's words about the CV (#91) ────────────
   *
   * Same selector as the comments pass, and its own loop for the same reason:
   * the first loop cannot see an application whose CV is already gone. Unlike
   * a deleted comment, a cleared scorecard still matches the selector, so this
   * pass pages by application_id (unique on the table) and skips a clean card
   * in code, writing nothing to it. That is also what makes it run every day
   * over every expired card, as the interview purge does: a card written late
   * is cleaned on the next run.
   *
   * Each card is cleared by its own UPDATE, because dimension_scores and
   * must_haves are rewritten from the row's own entries: the numbers stay and
   * only the words go. No score column, no confidence, no status and no
   * human_* column is named, so effective_score, which Postgres derives from
   * them, cannot move.
   *
   * `!inner` is load-bearing here exactly as in the comments pass.
   */
  let scoresCleared = 0;
  let scoresFinished = false;
  let scoreCursor: string | null = null;
  for (;;) {
    if (overBudget()) break;

    let page = service
      .from("application_scores")
      .select(
        "application_id, summary, verdict, evidence, strengths, concerns, missing_requirements, " +
          "dimension_scores, must_haves, job_applications!inner(cv_delete_after, company_id_snapshot)",
      )
      .lte("job_applications.cv_delete_after", now)
      .not("job_applications.company_id_snapshot", "is", null);
    if (scoreCursor !== null) page = page.gt("application_id", scoreCursor);
    const { data, error } = await page.order("application_id", { ascending: true }).limit(DB_PAGE);

    if (error) throw new Error(`cv purge: due scores: ${error.message}`);
    const cards = (data ?? []) as unknown as ScoreWords[];
    if (cards.length === 0) {
      scoresFinished = true;
      break;
    }

    for (const card of cards) {
      if (!scoreWordsLeft(card)) continue;
      const { error: updErr } = await service
        .from("application_scores")
        .update({
          ...CV_SCORE_WORDS_CLEARED,
          dimension_scores: clearDimensionWords(card.dimension_scores),
          must_haves: clearMustHaveQuotes(card.must_haves),
        })
        .eq("application_id", card.application_id);
      if (updErr) throw new Error(`cv purge: clear score words: ${updErr.message}`);
      scoresCleared += 1;
    }

    scoreCursor = cards[cards.length - 1].application_id;
    if (cards.length < DB_PAGE) {
      scoresFinished = true;
      break;
    }
  }

  /*
   * ── What is left ─────────────────────────────────────────────
   *
   * One count over the due set, so COMPLETE is a statement about the table,
   * not about what this run happened to touch. A count that cannot be read is
   * unknown, and unknown is not complete.
   */
  const { count: left, error: leftErr } = await due(
    service.from("job_applications").select("id", { count: "exact", head: true }),
  ).or("cv_path.not.is.null,cv_text.not.is.null");
  const dueLeft = leftErr ? null : (left ?? 0);

  const elapsedMs = clock() - startedAt;
  const result: CvPurgeResult = {
    complete:
      textFinished &&
      storage.finished &&
      commentsFinished &&
      scoresFinished &&
      storage.heldError === 0 &&
      storage.notAttempted === 0 &&
      dueLeft === 0,
    budgetMs,
    elapsedMs,
    text: { cleared: textCleared, finished: textFinished },
    storage,
    comments: { deleted: commentsDeleted, finished: commentsFinished },
    scores: { cleared: scoresCleared, finished: scoresFinished },
    dueLeft,
  };
  console.log(describeCvPurge(job.id, result));
  return result;
}
