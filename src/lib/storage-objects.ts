import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Delete storage objects and report EXACTLY which ones are confirmed gone.
 *
 * ── Why this is shared ───────────────────────────────────────
 *
 * Every retention job has the same hazard: the database column holding the
 * object's path is the ONLY record of where that object lives. Clear the
 * column while the object survives and the file is stranded — nothing points
 * at it, no sweep will find it, and it outlives the promise made about it.
 *
 * So no caller may clear a path on hope. Each one needs the same answer to the
 * same question — "is this specific object actually gone?" — and each one had
 * to know the same non-obvious detail to get it: `remove()` echoes back full
 * keys on some versions of the storage client and bare filenames on others.
 * That detail is why this is one function rather than one per job.
 *
 * ── The contract ─────────────────────────────────────────────
 *
 * `removed` holds only paths storage confirmed. `complete` is true when every
 * requested path is in it. A caller clears a row's path when that path is in
 * `removed`, and leaves it alone otherwise so the next run retries.
 *
 * Absence is NOT failure elsewhere in the callers — a path that was never in
 * storage has nothing left to delete — but that judgement belongs to the
 * caller, which knows whether it listed the bucket first. This function
 * reports only what `remove()` told it.
 */

type Service = ReturnType<typeof createServiceClient>;

export type RemovalOutcome = {
  /** What was asked for, unchanged. */
  requested: string[];
  /** Full paths storage confirmed it deleted. */
  removed: Set<string>;
  /** Every requested path came back. */
  complete: boolean;
  /** The storage error, if the call reported one. Never thrown. */
  error: string | null;
};

export async function removeObjects(
  service: Service,
  bucket: string,
  paths: string[],
): Promise<RemovalOutcome> {
  if (paths.length === 0) {
    return { requested: paths, removed: new Set(), complete: true, error: null };
  }

  const { data: gone, error } = await service.storage
    .from(bucket)
    .remove(paths);

  /*
   * Map bare filenames back to the full path that was requested. A basename
   * shared by two requested paths is marked ambiguous and left UNRESOLVED:
   * that direction is safe (the path is kept and retried) where guessing is
   * not (the wrong row is cleared and a real object is stranded).
   */
  const requested = new Set(paths);
  const byBasename = new Map<string, string | null>();
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    byBasename.set(base, byBasename.has(base) ? null : p);
  }

  const removed = new Set<string>();
  for (const o of (gone ?? []) as { name: string }[]) {
    if (requested.has(o.name)) {
      removed.add(o.name);
      continue;
    }
    const full = byBasename.get(o.name);
    if (full) removed.add(full);
  }

  return {
    requested: paths,
    removed,
    complete: removed.size === paths.length,
    error: error?.message ?? null,
  };
}
