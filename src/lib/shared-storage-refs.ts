import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Which storage objects are still pointed at by a row we are NOT deleting.
 *
 * ── The thing this exists to prevent ─────────────────────────
 *
 * A storage object is not owned by the row that names it. The same key reaches
 * a second table by being COPIED, never re-uploaded:
 *
 *   · api/talent/route.ts — the apply→talent bridge inherits the source
 *     `job_applications.cv_path` verbatim ("reference the existing object
 *     rather than uploading again").
 *   · admin/applications/actions.ts — "Move to Talent" copies `cv_path` into
 *     the profile patch, on both the insert and the archived-restore branch.
 *   · admin/client-batches/actions.ts — adding a candidate to a batch copies
 *     the source row's `cv_path` onward again.
 *
 * So "this row expired, delete its file" is wrong wherever a second row still
 * advertises that file. The column stays set, the object is gone, and every
 * signing route 404s on a CV the other record says exists.
 *
 * ── Why both purges need it, and why it is one function ──────
 *
 * cv-purge used to be safe by construction: it only touched company rows, and
 * nothing copies a company application's CV anywhere. That stopped being true
 * when its `company_id_snapshot` guard came off and Remotiv-owned applications
 * came into scope — those are precisely the rows the bridge copies from. The
 * two jobs now delete from opposite ends of the same shared object and each has
 * to ask the same question first.
 *
 * One list of tables, therefore, not one per caller. A fifth table gaining a
 * `cv_path` must not be a thing only one purge learns about.
 *
 * ── Why the column alone is the whole check ──────────────────
 *
 * Legacy rows stored a public URL in `cv_url` with `cv_path` null, but
 * migration 004 backfilled `cv_path` from it on all four tables. A row still
 * pointing into the `cvs` bucket points there through `cv_path`.
 */

type Service = ReturnType<typeof createServiceClient>;

export type PathColumn = "cv_path" | "photo_path";

/**
 * Every table holding a key for the corresponding bucket.
 *
 * `cv_path` — the four tables migration 004 added the column to, all keys in
 * the private `cvs` bucket.
 *
 * `photo_path` — both in `talent_photos`. Note that migration 011's column
 * comment says "inside the cvs bucket"; that comment is wrong. The write path
 * (api/hire-remote-profiles) uploads to `talent_photos` and the read path
 * (admin/remote-talent/actions) signs against it.
 */
const TABLES_BY_COLUMN: Record<PathColumn, readonly string[]> = {
  cv_path: [
    "job_applications",
    "talent_profiles",
    "client_batch_candidates",
    "hire_remote_profiles",
  ],
  photo_path: ["talent_profiles", "hire_remote_profiles"],
};

/**
 * The subset of `paths` that some other row still holds.
 *
 * `self` names the rows the caller is about to delete or clear itself — their
 * own reference is not someone else's. Pass the ids for the WHOLE PAGE being
 * processed, not the current remove-chunk: two expiring rows sharing one object
 * across chunk boundaries would otherwise each see the other as a live
 * reference, keep the file, clear both rows, and strand it — the exact outcome
 * this function exists to prevent, arrived at from the other side.
 *
 * THROWS on a query failure rather than returning a partial answer. An
 * incomplete result reads as "not shared" and deletes a live CV; the caller is
 * expected to skip the batch and retry on the next run.
 */
export async function findSharedPaths(
  service: Service,
  column: PathColumn,
  paths: string[],
  self: { table: string; ids: Set<string> },
): Promise<Set<string>> {
  const shared = new Set<string>();
  if (paths.length === 0) return shared;

  for (const table of TABLES_BY_COLUMN[column]) {
    const isSelf = table === self.table;
    const { data, error } = await service
      .from(table)
      .select(isSelf ? `id, ${column}` : column)
      .in(column, paths);

    if (error) {
      throw new Error(`shared-reference check ${table}.${column}: ${error.message}`);
    }

    /*
     * Through `unknown`: the column list is built at runtime, so PostgREST
     * cannot parse it and types the result as its own error shape. Rows are
     * `{ id?, <column> }` and are read defensively below rather than trusted.
     */
    for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
      if (isSelf && self.ids.has(String(row.id))) continue;
      const path = row[column];
      if (path) shared.add(path);
    }
  }

  return shared;
}
