import "server-only";
import { sendEmail } from "@/lib/email/send";
import { findSharedPaths } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildRetentionWarningEmail,
  expiryFor,
  keepProfileUrl,
  MIN_DAYS_SINCE_WARNING,
  mintKeepToken,
  PURGE_CEILING,
  purgeCutoff,
  RETENTION_MONTHS,
  warnCutoff,
  warnedBefore,
} from "@/lib/talent-retention";

/**
 * The two talent-retention jobs: warn, then purge.
 *
 * ══ NEITHER IS SCHEDULED ═════════════════════════════════════
 *
 * Both handlers are complete and registered, and nothing enqueues them. Remotiv
 * keeps talent-pool profiles and their CVs until the person asks. See the note
 * in jobs-queue.ts's RECURRING list — that list is the only enqueue path for
 * these two types, so its two missing lines are the whole of the decision, and
 * adding them back is the whole of reversing it.
 *
 * Kept whole rather than deleted because it is correct work and the columns it
 * needs are already live. Read the rest of this file as a description of what
 * it would do.
 *
 * Structure follows lib/cv-purge.ts — budget-bounded loop, offset advanced by
 * the stuck count rather than a page size, database clears separated from
 * storage removes. What it does NOT follow is that job's central safety
 * property: cv-purge reads a STORED expiry date and says so in its banner
 * ("nothing in this file knows what 24 months is"). A rolling window has to
 * compute its cutoff, so a different guard replaces it — see PURGE_CEILING and
 * the warned-first precondition below.
 *
 * ══ SCOPE ════════════════════════════════════════════════════
 *
 * `talent_profiles` and nothing else. A CLIENT COMPANY's applicant has a CV
 * that expires 24 months from the day they applied, on a stored date, handled
 * by cv-purge against job_applications — a different table on a different
 * basis, and the one retention job that does run. No future edit here may
 * widen to that table.
 *
 * The purge does READ the other cv_path tables, through findSharedPaths, to
 * learn which storage objects it must NOT delete. That is the opposite of
 * widening scope, and it runs before anything is removed. One object is
 * routinely named by both a profile and the application it was bridged from;
 * whichever expires first leaves the file for the other.
 */

const CV_BUCKET = "cvs";
const PHOTO_BUCKET = "talent_photos";
const DB_PAGE = 500;
const REMOVE_CHUNK = 100;
const BUDGET_MS = 18_000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

type WarnRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_active_at: string | null;
  created_at: string | null;
  claimed_at: string | null;
};

/**
 * Email everyone whose profile expires in about a month.
 *
 * ── Idempotency ──────────────────────────────────────────────
 *
 * `retention_warned_at IS NULL` is the selector's own guard: a warned profile
 * stops matching, so a second run in the same window emails nobody. Without it
 * this would mail every expiring person once a day for a month.
 *
 * The stamp and the token hash are written BEFORE the send. A crash between
 * them and Resend costs one person one warning email — recoverable, and they
 * still cannot be purged, because the purge requires a warning at least
 * MIN_DAYS_SINCE_WARNING old and will simply keep skipping them. The reverse
 * order risks mailing the same person daily, which is worse and not recoverable
 * from their side.
 */
export async function handleTalentRetentionWarn(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const service = createServiceClient();
  const startedAt = Date.now();
  const now = new Date();
  const cutoff = warnCutoff(now).toISOString();

  let warned = 0;
  let skipped = 0;
  let truncated = false;
  let offset = 0;

  console.log(
    `[talent-retention-warn] job ${job.id}: warning profiles last active on or before ${cutoff} ` +
      `(${RETENTION_MONTHS} months of inactivity, warning ${MIN_DAYS_SINCE_WARNING}+ days ahead)`,
  );

  for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }

    const { data, error } = await service
      .from("talent_profiles")
      .select("id, email, first_name, last_active_at, created_at, claimed_at")
      .lte("last_active_at", cutoff)
      .is("retention_warned_at", null)
      .order("last_active_at", { ascending: true })
      .range(offset, offset + DB_PAGE - 1);

    if (error) throw new Error(`talent retention warn: offset ${offset}: ${error.message}`);
    const rows = (data ?? []) as WarnRow[];
    if (rows.length === 0) break;

    let stuck = 0;
    for (const row of rows) {
      if (Date.now() - startedAt > BUDGET_MS) {
        truncated = true;
        break;
      }

      const to = (row.email ?? "").trim();
      if (!to) {
        /*
         * No address, so no warning is possible — and a profile that cannot be
         * warned must never be purged. Stamping it would make it purgeable in
         * 25 days with nobody having been told. Left unstamped: it keeps
         * matching, keeps being skipped, and stays visible in this count.
         */
        skipped += 1;
        stuck += 1;
        continue;
      }

      const lastActive = row.last_active_at ? new Date(row.last_active_at) : null;
      if (!lastActive || Number.isNaN(lastActive.getTime())) {
        skipped += 1;
        stuck += 1;
        continue;
      }

      const { rawToken, tokenHash } = mintKeepToken();
      const { error: stampErr } = await service
        .from("talent_profiles")
        .update({
          retention_warned_at: now.toISOString(),
          retention_keep_token_hash: tokenHash,
        })
        .eq("id", row.id)
        // Only stamp a row still unwarned — two overlapping runs cannot both
        // send, because the second update matches nothing.
        .is("retention_warned_at", null);

      if (stampErr) {
        console.error(`[talent-retention-warn] stamp failed for ${row.id}:`, stampErr.message);
        skipped += 1;
        stuck += 1;
        continue;
      }

      const joinedAt = row.claimed_at ?? row.created_at;
      const mail = buildRetentionWarningEmail({
        firstName: row.first_name,
        joinedAt: joinedAt ? new Date(joinedAt) : lastActive,
        expiresAt: expiryFor(lastActive),
        keepUrl: keepProfileUrl(rawToken),
      });

      const sent = await sendEmail({ to, subject: mail.subject, html: mail.html });
      if (!sent.ok) {
        // Stamped but unsent. See the note above: the cost is one missed
        // warning, and the purge still refuses this profile.
        console.error(`[talent-retention-warn] send failed for ${row.id}: ${sent.error}`);
        skipped += 1;
        continue;
      }
      warned += 1;
    }

    offset += stuck;
    if (stuck === rows.length) break;
  }

  console.log(
    `[talent-retention-warn] job ${job.id}: warned ${warned}, skipped ${skipped}` +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}

type PurgeRow = {
  id: string;
  cv_path: string | null;
  photo_path: string | null;
};

/**
 * Delete profiles that were warned and did not come back.
 *
 * ── Two preconditions, both structural ───────────────────────
 *
 * 1. WARNED FIRST. `retention_warned_at` must be non-null and at least
 *    MIN_DAYS_SINCE_WARNING old. A profile cannot be deleted unless a warning
 *    went out and had its month — the promise not to delete silently is
 *    enforced by the selector rather than by anyone remembering it.
 *
 * 2. THE CEILING. If more profiles are due than PURGE_CEILING, this refuses and
 *    logs loudly instead of deleting. That replaces the protection cv-purge
 *    gets from a stored date: a wrong RETENTION_MONTHS shows up as a refusal,
 *    not as an outage of the marketplace's inventory.
 *
 * A profile that comes back clears `retention_warned_at` (see the keep route
 * and touchLastActive), so it stops matching here immediately.
 */
export async function handleTalentRetentionPurge(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const service = createServiceClient();
  const startedAt = Date.now();
  const now = new Date();
  const inactiveBefore = purgeCutoff(now).toISOString();
  const warnedBeforeIso = warnedBefore(now).toISOString();

  /*
   * The due-set, written out at both call sites rather than shared through a
   * helper. The chain is three lines and it is the safety boundary of this
   * whole job — a reader checking "can this delete an unwarned profile?" should
   * see the answer inline, not have to follow a generic.
   */
  const { count, error: countErr } = await service
    .from("talent_profiles")
    .select("id", { count: "exact", head: true })
    .lte("last_active_at", inactiveBefore)
    .not("retention_warned_at", "is", null)
    .lte("retention_warned_at", warnedBeforeIso);

  if (countErr) throw new Error(`talent retention purge: count failed: ${countErr.message}`);

  const due = count ?? 0;
  if (due === 0) {
    console.log(`[talent-retention-purge] job ${job.id}: nothing due (cutoff ${inactiveBefore})`);
    return;
  }

  if (due > PURGE_CEILING) {
    /*
     * REFUSE, and say so where someone will find it.
     *
     * A run that refuses is only useful if the refusal is discoverable, so this
     * is console.error (not warn), carries the word REFUSING, states both
     * numbers and the computed cutoff, and names the constant to check. It is
     * deliberately NOT a thrown error: throwing would retry, fail again, and
     * bury the reason under attempt counts in last_error.
     */
    console.error(
      `[talent-retention-purge] REFUSING TO RUN — ${due} profiles are due for deletion, ` +
        `ceiling is ${PURGE_CEILING}. Nothing was deleted. ` +
        `Computed cutoff: last_active_at <= ${inactiveBefore} (RETENTION_MONTHS=${RETENTION_MONTHS}). ` +
        `Either the constant is wrong, or a backlog needs clearing deliberately — ` +
        `check lib/talent-retention.ts before raising PURGE_CEILING.`,
    );
    return;
  }

  console.log(
    `[talent-retention-purge] job ${job.id}: ${due} profile(s) due ` +
      `(inactive since ${inactiveBefore}, warned before ${warnedBeforeIso})`,
  );

  let objectsRemoved = 0;
  let objectsKept = 0;
  let rowsDeleted = 0;
  let truncated = false;
  let offset = 0;

  for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }

    const { data, error } = await service
      .from("talent_profiles")
      .select("id, cv_path, photo_path")
      .lte("last_active_at", inactiveBefore)
      .not("retention_warned_at", "is", null)
      .lte("retention_warned_at", warnedBeforeIso)
      .order("last_active_at", { ascending: true })
      .range(offset, offset + DB_PAGE - 1);

    if (error) throw new Error(`talent retention purge: offset ${offset}: ${error.message}`);
    const rows = (data ?? []) as PurgeRow[];
    if (rows.length === 0) break;

    /*
     * Files first, row second — the same ordering cv-purge uses and for the
     * same reason. `cv_path` is the only record of where the object lives, so
     * deleting the row first strands the file permanently, with nothing left
     * pointing at it and no sweep that would find it. A row whose files failed
     * to delete keeps matching and is retried next run.
     *
     * It is not, however, the only record ANYWHERE: the same key is copied into
     * other tables, and an object one of those still names must survive this
     * profile. See findSharedPaths — that check runs before any remove.
     */
    const confirmed = new Set<string>();
    const self = { table: "talent_profiles", ids: new Set(rows.map((r) => r.id)) };

    for (const batch of chunk(rows, REMOVE_CHUNK)) {
      if (Date.now() - startedAt > BUDGET_MS) {
        truncated = true;
        break;
      }
      const cvs = unique(batch.map((r) => r.cv_path));
      const photos = unique(batch.map((r) => r.photo_path));

      /*
       * WHO ELSE HOLDS THESE KEYS. Asked before anything is deleted, and a
       * failure to answer aborts the batch — see findSharedPaths. `self` covers
       * the whole page, not this chunk: a second expiring profile is not a
       * reason to keep the file, whichever chunk it landed in.
       */
      let sharedCvs: Set<string>;
      let sharedPhotos: Set<string>;
      try {
        sharedCvs = await findSharedPaths(service, "cv_path", cvs, self);
        sharedPhotos = await findSharedPaths(service, "photo_path", photos, self);
      } catch (err) {
        /*
         * Skip the batch whole. Neither guess is acceptable: "assume shared"
         * deletes rows and strands their files, "assume unshared" deletes a CV
         * another row still advertises. These profiles keep matching and are
         * retried next run.
         */
        console.error(
          `[talent-retention-purge] shared-reference check failed, batch skipped: ` +
            `${(err as Error).message}`,
        );
        continue;
      }

      objectsKept += sharedCvs.size + sharedPhotos.size;

      try {
        const removableCvs = cvs.filter((p) => !sharedCvs.has(p));
        const removablePhotos = photos.filter((p) => !sharedPhotos.has(p));
        const goneCvs =
          removableCvs.length > 0
            ? (await removeObjects(service, CV_BUCKET, removableCvs)).removed
            : new Set<string>();
        const gonePhotos =
          removablePhotos.length > 0
            ? (await removeObjects(service, PHOTO_BUCKET, removablePhotos)).removed
            : new Set<string>();
        objectsRemoved += goneCvs.size + gonePhotos.size;

        /*
         * A row is deletable once each of its files is accounted for: either
         * confirmed gone, or deliberately left behind because another row still
         * points at it.
         *
         * The distinction matters. An object we FAILED to delete must hold its
         * row back — clearing the row would strand the file, with nothing left
         * naming it and no sweep that would find it. A SHARED object is the
         * opposite case: it is not stranded, because the row that shares it is
         * still there, still pointing at it, and still carries its own retention
         * clock. Holding the profile back for it would mean never deleting the
         * profile at all.
         */
        for (const r of batch) {
          const cvOk = !r.cv_path || sharedCvs.has(r.cv_path) || goneCvs.has(r.cv_path);
          const photoOk =
            !r.photo_path || sharedPhotos.has(r.photo_path) || gonePhotos.has(r.photo_path);
          if (cvOk && photoOk) confirmed.add(r.id);
        }
      } catch (err) {
        console.error(`[talent-retention-purge] remove threw: ${(err as Error).message}`);
      }
    }

    const deletable = rows.filter((r) => confirmed.has(r.id)).map((r) => r.id);
    if (deletable.length > 0) {
      const { error: delErr } = await service.from("talent_profiles").delete().in("id", deletable);
      if (delErr) {
        console.error(`[talent-retention-purge] delete failed: ${delErr.message}`);
      } else {
        rowsDeleted += deletable.length;
      }
    }

    // Advance past only the rows this run could NOT finish; a deleted row stops
    // matching, so the window slides forward on its own.
    const stuck = rows.length - deletable.length;
    offset += stuck;
    if (stuck === rows.length) break;
  }

  console.log(
    `[talent-retention-purge] job ${job.id}: deleted ${rowsDeleted} profile(s), ` +
      `${objectsRemoved} object(s)` +
      (objectsKept > 0 ? `, kept ${objectsKept} still referenced elsewhere` : "") +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}
