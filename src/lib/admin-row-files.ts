import "server-only";
import { cvObjectState } from "@/lib/cv-object";
import { findSharedPaths, type PathColumn } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The files a super-admin delete must remove BEFORE it deletes the rows that
 * name them (#69 step 7).
 *
 * A path column is the only record of where a file lives: delete the row
 * first and the file is stranded, with nothing left pointing at it. So the
 * four admin deletes (talent, remote talent, client batch, client) call this
 * first and delete their rows only when it answers `ok`.
 *
 * The rule is the CV purge's (cv-purge.ts):
 *   - a key another row still names is KEPT (findSharedPaths): the same CV key
 *     is copied, never re-uploaded, into talent, batch and remote-talent rows,
 *     so deleting it because one copy went would empty a CV another record
 *     still shows. The rows being deleted are passed as `self`, so they do not
 *     count as each other's reference;
 *   - otherwise the file is removed, and a path storage did not confirm is
 *     checked: only storage's own "not found" counts as gone (cv-object.ts);
 *   - anything else (a failed shared check, a storage error, a file still
 *     there) answers `ok: false` with a reason code, and the caller keeps its
 *     rows and says so. Fail closed: a row kept is a delete to retry; a row
 *     deleted over a surviving file is a file nobody can find again.
 *
 * Never logs a path; the caller logs the reason code.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Which bucket each path column's keys live in (shared-storage-refs.ts). */
const BUCKET_OF: Record<PathColumn, string> = {
  cv_path: "cvs",
  photo_path: "talent_photos",
};

export type RowFilesOutcome =
  | { ok: true; removed: number; alreadyMissing: number; keptShared: number }
  | { ok: false; reason: "shared_check_failed" | "storage_error" | "still_present" };

/** One sentence for the admin when the files could not be cleared first. */
export const FILES_NOT_DELETED =
  "The files could not be deleted, so nothing was deleted. Please try again.";

export async function removeRowFiles(
  service: Service,
  files: { column: PathColumn; paths: (string | null | undefined)[] }[],
  self: { table: string; ids: Set<string> },
): Promise<RowFilesOutcome> {
  let removed = 0;
  let alreadyMissing = 0;
  let keptShared = 0;

  for (const { column, paths: raw } of files) {
    const paths = [...new Set(raw.filter((p): p is string => typeof p === "string" && p !== ""))];
    if (paths.length === 0) continue;

    let shared: Set<string>;
    try {
      shared = await findSharedPaths(service, column, paths, self);
    } catch {
      return { ok: false, reason: "shared_check_failed" };
    }
    keptShared += shared.size;

    const removable = paths.filter((p) => !shared.has(p));
    if (removable.length === 0) continue;

    let confirmed: Set<string>;
    try {
      confirmed = (await removeObjects(service, BUCKET_OF[column], removable)).removed;
    } catch {
      return { ok: false, reason: "storage_error" };
    }
    removed += confirmed.size;

    const bucket = service.storage.from(BUCKET_OF[column]);
    for (const p of removable) {
      if (confirmed.has(p)) continue;
      const state = await cvObjectState(bucket, p);
      if (state.state === "missing") {
        alreadyMissing += 1;
        continue;
      }
      return { ok: false, reason: state.state === "present" ? "still_present" : "storage_error" };
    }
  }

  return { ok: true, removed, alreadyMissing, keptShared };
}
