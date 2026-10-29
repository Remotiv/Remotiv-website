import "server-only";
import { FINAL_RECORDING_BUCKET } from "@/lib/final-interviews/constants";
import { findSharedPaths } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * An application's own stored files, removed before its row is deleted (B7):
 * its final-interview recordings and its CV. Called by both applicant
 * deletions, after its AI interviews (application-deletion.ts).
 *
 * ── Why the row waits for its files ──────────────────────────
 *
 * Nothing finds these files once the row is gone. The CV purge is driven by
 * job_applications rows and never lists the bucket, and the recording sweep
 * deletes nothing unless RECORDING_PURGE_LIVE is "true". So a file that does
 * not go now would stay for good: this returns not-ok, the caller stops before
 * deleting the row, and a retry, which finds the same paths on the same rows,
 * finishes the job.
 *
 * ── Gone means confirmed gone ────────────────────────────────
 *
 * Storage's remove() reports only what it deleted. A file it did not report is
 * looked up: if storage no longer has it, it is gone (a retry after a partial
 * success, or a file that was never there); if it is still there, or the look
 * fails, it is not.
 *
 * ── Never someone else's file ────────────────────────────────
 *
 * Recordings are selected by application id AND company id. A CV key can be
 * copied, never re-uploaded, into a talent profile or a client batch: if any
 * other row still holds it (findSharedPaths), the file stays for that row and
 * this application only lets go of it.
 */

type Service = ReturnType<typeof createServiceClient>;

const CV_BUCKET = "cvs";
const FILES_LEFT = "Some files could not be deleted yet - try again.";

/** Whether `path` is confirmed absent from `bucket`: listed, and not there. */
async function confirmedMissing(service: Service, bucket: string, path: string): Promise<boolean> {
  const cut = path.lastIndexOf("/");
  const dir = cut === -1 ? "" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  try {
    const { data, error } = await service.storage
      .from(bucket)
      .list(dir, { search: name, limit: 100 });
    if (error) return false;
    return !((data ?? []) as { name: string }[]).some((o) => o.name === name);
  } catch {
    return false;
  }
}

/** Remove `paths`; true only when every one is confirmed gone. */
export async function removeConfirmed(
  service: Service,
  bucket: string,
  paths: string[],
): Promise<boolean> {
  if (paths.length === 0) return true;
  let removed: Set<string>;
  try {
    removed = (await removeObjects(service, bucket, paths)).removed;
  } catch {
    removed = new Set();
  }
  for (const path of paths) {
    if (!removed.has(path) && !(await confirmedMissing(service, bucket, path))) return false;
  }
  return true;
}

export type ApplicationFilesResult = { ok: true } | { ok: false; error: string };

/**
 * Remove one application's recordings and CV. `companyIdSnapshot` is the
 * application's own company (null for Remotiv's own applications, which have
 * no final interviews); `cvPath` is the row's cv_path.
 */
export async function removeApplicationFiles(
  service: Service,
  companyIdSnapshot: string | null,
  applicationId: string,
  cvPath: string | null,
): Promise<ApplicationFilesResult> {
  if (companyIdSnapshot) {
    const { data, error } = await service
      .from("final_interview_recordings")
      .select("storage_path")
      .eq("application_id", applicationId)
      .eq("company_id", companyIdSnapshot)
      .not("storage_path", "is", null);
    if (error) return { ok: false, error: FILES_LEFT };
    const paths = [
      ...new Set(((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path)),
    ];
    if (!(await removeConfirmed(service, FINAL_RECORDING_BUCKET, paths))) {
      console.error(`[application-files] application ${applicationId}: recording file(s) left`);
      return { ok: false, error: FILES_LEFT };
    }
  }

  if (cvPath) {
    let shared: Set<string>;
    try {
      shared = await findSharedPaths(service, "cv_path", [cvPath], {
        table: "job_applications",
        ids: new Set([applicationId]),
      });
    } catch {
      return { ok: false, error: FILES_LEFT };
    }
    if (!shared.has(cvPath) && !(await removeConfirmed(service, CV_BUCKET, [cvPath]))) {
      console.error(`[application-files] application ${applicationId}: CV file left`);
      return { ok: false, error: FILES_LEFT };
    }
  }
  return { ok: true };
}
