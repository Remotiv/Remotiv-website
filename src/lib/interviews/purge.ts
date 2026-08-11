import "server-only";
import { removeObjects } from "@/lib/storage-objects";
import { createServiceClient } from "@/lib/supabase/server";
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
 * REMOVED: the video object, and the transcript. The transcript is a verbatim
 * record of what the candidate said — deleting the video and keeping a
 * word-for-word copy of their speech would honour the letter of the promise
 * and break its plain meaning.
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
 * Wall-clock budget.
 *
 * The worker allows ~25s per tick and this job runs inside that. Stopping
 * early is safe and costs nothing: every selector below is derived from
 * current state, never from a cursor, so the next run resumes exactly where
 * this one stopped without tracking progress anywhere.
 */
const BUDGET_MS = 18_000;

type Service = ReturnType<typeof createServiceClient>;

type AnswerRow = {
  id: string;
  session_id: string;
  video_path: string | null;
  transcript: string | null;
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

export async function handleInterviewPurge(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const service = createServiceClient();
  const startedAt = Date.now();
  const now = new Date().toISOString();

  let sessionsPurged = 0;
  let objectsRemoved = 0;
  let rowsCleared = 0;
  let removalFailures = 0;
  let orphansRemoved = 0;
  let truncated = false;

  // ── Phase 1 — sessions past their retention date ──
  for (let page = 0; ; page += 1) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }

    const { data, error } = await service
      .from("interview_sessions")
      .select("id")
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
      .order("delete_after", { ascending: true })
      .range(page * DB_PAGE, page * DB_PAGE + DB_PAGE - 1);

    if (error) throw new Error(`purge: session page ${page}: ${error.message}`);
    const sessions = (data ?? []) as { id: string }[];
    if (sessions.length === 0) break;

    for (const ids of chunk(sessions.map((s) => s.id), ID_CHUNK)) {
      /*
       * The idempotency key, and there is no new column for it: a session is
       * "already purged" precisely when none of its answers still holds a
       * video_path or a transcript. Once cleared, this selector stops
       * matching, so a second run over the same session does no work and
       * makes no storage calls.
       */
      const { data: aData, error: aErr } = await service
        .from("interview_answers")
        .select("id, session_id, video_path, transcript")
        .in("session_id", ids)
        .or("video_path.not.is.null,transcript.not.is.null");

      if (aErr) throw new Error(`purge: answers: ${aErr.message}`);
      const answers = (aData ?? []) as AnswerRow[];
      if (answers.length === 0) continue;

      const bySession = new Map<string, AnswerRow[]>();
      for (const a of answers) {
        const list = bySession.get(a.session_id);
        if (list) list.push(a);
        else bySession.set(a.session_id, [a]);
      }

      for (const [sessionId, rows] of bySession) {
        if (Date.now() - startedAt > BUDGET_MS) {
          truncated = true;
          break;
        }

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
          removalFailures += rows.length;
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
         * So: the transcript is cleared for every due row unconditionally — it
         * lives in the database, its deletion cannot fail, and the promise
         * covers it. video_path is cleared ONLY for objects confirmed gone,
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
            .update({ video_path: null, transcript: null })
            .in("id", cleared);
          if (error) throw new Error(`purge: clear rows: ${error.message}`);
          rowsCleared += cleared.length;
        }
        if (transcriptOnly.length > 0) {
          const { error } = await service
            .from("interview_answers")
            .update({ transcript: null })
            .in("id", transcriptOnly);
          if (error) throw new Error(`purge: clear transcripts: ${error.message}`);
          removalFailures += transcriptOnly.length;
        }

        sessionsPurged += 1;
      }
      if (truncated) break;
    }

    if (truncated || sessions.length < DB_PAGE) break;
  }

  // ── Phase 2 — orphaned objects ──
  orphansRemoved = await sweepOrphans(service, startedAt);

  console.log(
    `[purge] job ${job.id}: sessions=${sessionsPurged} objects=${objectsRemoved} ` +
      `rows=${rowsCleared} retrying=${removalFailures} orphans=${orphansRemoved}` +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}

/**
 * Collect objects that no answer row points at.
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
async function sweepOrphans(service: Service, startedAt: number): Promise<number> {
  let removedCount = 0;
  const cutoff = Date.now() - ORPHAN_GRACE_MS;

  for (let offset = 0; ; offset += STORAGE_PAGE) {
    if (Date.now() - startedAt > BUDGET_MS) break;

    const { data, error } = await service.storage
      .from(INTERVIEW_BUCKET)
      .list("", { limit: STORAGE_PAGE, offset });
    if (error) {
      console.error(`[purge] orphan sweep: list root: ${error.message}`);
      return removedCount;
    }

    // Folders come back with a null id; files at the root are not something
    // this feature creates and are left alone rather than guessed at.
    const folders = ((data ?? []) as { name: string; id: string | null }[])
      .filter((e) => e.id === null)
      .map((e) => e.name);

    for (const sessionId of folders) {
      if (Date.now() - startedAt > BUDGET_MS) return removedCount;

      let objects: { name: string; createdAt: number }[];
      try {
        objects = await listSessionObjects(service, sessionId);
      } catch (err) {
        console.error(`[purge] orphan sweep: ${(err as Error).message}`);
        continue;
      }
      const stale = objects.filter((o) => o.createdAt > 0 && o.createdAt < cutoff);
      if (stale.length === 0) continue;

      // Referenced paths for THIS session. Read after listing, so an upload
      // confirmed in between is seen as referenced rather than swept.
      const { data: refData, error: refErr } = await service
        .from("interview_answers")
        .select("video_path")
        .eq("session_id", sessionId)
        .not("video_path", "is", null);

      if (refErr) {
        console.error(`[purge] orphan sweep: refs: ${refErr.message}`);
        continue;
      }
      const referenced = new Set(
        ((refData ?? []) as { video_path: string | null }[])
          .map((r) => r.video_path)
          .filter((p): p is string => Boolean(p)),
      );

      const orphans = stale
        .map((o) => `${sessionId}/${o.name}`)
        .filter((path) => !referenced.has(path));
      if (orphans.length === 0) continue;

      const { data: gone, error: rmErr } = await service.storage
        .from(INTERVIEW_BUCKET)
        .remove(orphans);
      if (rmErr) {
        console.error(`[purge] orphan sweep: remove: ${rmErr.message}`);
        continue;
      }
      removedCount += ((gone ?? []) as unknown[]).length;
    }

    if ((data ?? []).length < STORAGE_PAGE) break;
  }

  return removedCount;
}
