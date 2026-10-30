import "server-only";
import { allCvReferences, referencedCvPaths } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The CV bucket's orphan sweep: the last phase of the cv_purge job
 * (cv-purge.ts handleCvPurge). Deletes CV files that no row names any more,
 * left by deletes that never removed their file (the import's failed inserts,
 * super-admin applicant deletes before B7, talent and batch deletes).
 *
 * ── Dry run unless switched on ───────────────────────────────
 *
 * Nothing is deleted unless CV_ORPHAN_SWEEP_LIVE is exactly "true". Until then
 * the sweep counts what it WOULD delete and logs the counts, so the first live
 * run is preceded by read-only ones.
 *
 * ── What counts as an orphan ─────────────────────────────────
 *
 * A file older than CV_ORPHAN_GRACE_MS (7 days: an upload waits seconds for its
 * row, never days) whose key no row names: cv_path on any of the tables in
 * shared-storage-refs.ts, or a legacy public cv_url ending in it. The whole
 * bucket is listed and every key read before anything is judged.
 *
 * ── Never a file something still names ──────────────────────
 *
 *   - Each delete batch is checked again, fresh, immediately before it is
 *     deleted (referencedCvPaths); anything a row now names is kept.
 *   - Any failed read (a listing page, a reference read) stops the sweep and
 *     deletes nothing more: an incomplete answer would read as "unreferenced".
 *   - If more than CV_ORPHAN_MAX_SHARE of the bucket looks unreferenced,
 *     nothing is deleted at all: that is a broken reference read, not orphans.
 *   - At most CV_ORPHAN_MAX_DELETES files per run, inside a time budget.
 *
 * ── Logs ─────────────────────────────────────────────────────
 *
 * Counts only, by folder group and age band. Never a path.
 */

type Service = ReturnType<typeof createServiceClient>;

const CV_BUCKET = "cvs";
const DAY_MS = 86_400_000;
/** An upload waits seconds for its row; a week is far past any of them. */
export const CV_ORPHAN_GRACE_MS = 7 * DAY_MS;
/** Files deleted per run, at most. */
export const CV_ORPHAN_MAX_DELETES = 500;
/** Above this share of the bucket unreferenced, nothing is deleted: the reads are wrong. */
export const CV_ORPHAN_MAX_SHARE = 0.2;
/** Time the sweep may take, on top of the purge's own. */
const BUDGET_MS = 20_000;
const LIST_PAGE = 100;
const DELETE_BATCH = 100;

export type AgeBand = "7-30d" | "30-180d" | ">180d";

export type CvOrphanSweepResult = {
  live: boolean;
  /** Why nothing (more) was deleted, or null for a sweep that ran to the end. */
  stopped:
    | null
    | "listing_failed"
    | "reference_read_failed"
    | "delete_failed"
    | "too_many_unreferenced"
    | "budget"
    | "cap";
  files: number;
  /** Within the grace period: never judged. */
  young: number;
  unreferenced: number;
  /** Deleted (live), or that would be (dry run, up to the cap). */
  deleted: number;
  /** Unreferenced when listed, but named by a row at the fresh check: kept. */
  keptAtRecheck: number;
  byGroup: Record<string, number>;
  byAge: Record<string, number>;
};

/** The folder a key is in, without ids: the shapes the writers use. */
export function folderGroup(path: string): string {
  const first = path.split("/")[0];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first)) {
    return "job folder";
  }
  if (first === "manual") return "manual";
  if (first === "batch") return "batch";
  if (path.startsWith("talent/cvs/")) return "talent/cvs";
  if (path.startsWith("hire-remote/cvs/")) return "hire-remote/cvs";
  return "other";
}

function ageBand(ageMs: number): AgeBand {
  if (ageMs < 30 * DAY_MS) return "7-30d";
  if (ageMs < 180 * DAY_MS) return "30-180d";
  return ">180d";
}

type Listed = { path: string; createdAt: number | null };

/** Every file in the bucket, folders walked. Null if any page could not be read. */
async function listAll(
  service: Service,
  prefix = "",
  out: Listed[] = [],
): Promise<Listed[] | null> {
  for (let offset = 0; ; offset += LIST_PAGE) {
    let page: { name: string; id: string | null; created_at?: string | null }[];
    try {
      const { data, error } = await service.storage
        .from(CV_BUCKET)
        .list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) return null;
      page = (data ?? []) as typeof page;
    } catch {
      return null;
    }
    for (const e of page) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) {
        if (!(await listAll(service, path, out))) return null;
      } else {
        const at = Date.parse(e.created_at ?? "");
        out.push({ path, createdAt: Number.isFinite(at) ? at : null });
      }
    }
    if (page.length < LIST_PAGE) return out;
  }
}

export async function runCvOrphanSweep(
  service: Service,
  opts: { live?: boolean; now?: () => number; budgetMs?: number; maxDeletes?: number } = {},
): Promise<CvOrphanSweepResult> {
  const live = opts.live ?? process.env.CV_ORPHAN_SWEEP_LIVE === "true";
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const overBudget = () => now() - startedAt > (opts.budgetMs ?? BUDGET_MS);
  const maxDeletes = opts.maxDeletes ?? CV_ORPHAN_MAX_DELETES;
  const result: CvOrphanSweepResult = {
    live,
    stopped: null,
    files: 0,
    young: 0,
    unreferenced: 0,
    deleted: 0,
    keptAtRecheck: 0,
    byGroup: {},
    byAge: {},
  };

  const files = await listAll(service);
  if (!files) return { ...result, stopped: "listing_failed" };
  result.files = files.length;

  let named: Set<string>;
  try {
    named = await allCvReferences(service);
  } catch {
    return { ...result, stopped: "reference_read_failed" };
  }

  const candidates: Listed[] = [];
  for (const f of files) {
    // No timestamp reads as new: kept.
    if (f.createdAt === null || startedAt - f.createdAt < CV_ORPHAN_GRACE_MS) {
      result.young += 1;
      continue;
    }
    if (!named.has(f.path)) candidates.push(f);
  }
  result.unreferenced = candidates.length;
  for (const f of candidates) {
    const g = folderGroup(f.path);
    const a = ageBand(startedAt - (f.createdAt as number));
    result.byGroup[g] = (result.byGroup[g] ?? 0) + 1;
    result.byAge[a] = (result.byAge[a] ?? 0) + 1;
  }
  if (files.length > 0 && candidates.length / files.length > CV_ORPHAN_MAX_SHARE) {
    return { ...result, stopped: "too_many_unreferenced" };
  }

  for (let i = 0; i < candidates.length; ) {
    if (result.deleted >= maxDeletes) return { ...result, stopped: "cap" };
    if (overBudget()) return { ...result, stopped: "budget" };
    const room = maxDeletes - result.deleted;
    const batch = candidates.slice(i, i + Math.min(DELETE_BATCH, room)).map((f) => f.path);
    if (batch.length === 0) break;
    i += batch.length;
    let stillNamed: Set<string>;
    try {
      stillNamed = await referencedCvPaths(service, batch);
    } catch {
      return { ...result, stopped: "reference_read_failed" };
    }
    const doomed = batch.filter((p) => !stillNamed.has(p));
    result.keptAtRecheck += batch.length - doomed.length;
    if (!live) {
      result.deleted += doomed.length;
      continue;
    }
    if (doomed.length === 0) continue;
    try {
      const outcome = await removeObjects(service, CV_BUCKET, doomed);
      result.deleted += outcome.removed.size;
      if (outcome.error) return { ...result, stopped: "delete_failed" };
    } catch {
      return { ...result, stopped: "delete_failed" };
    }
  }
  return result;
}

/** The one log line: counts only. */
export function describeCvOrphanSweep(jobId: string, r: CvOrphanSweepResult): string {
  const mode = r.live ? "LIVE" : "DRY RUN";
  const verb = r.live ? "deleted" : "would delete";
  return (
    `[cv-orphan-sweep] job ${jobId}: ${mode}${r.stopped ? `, STOPPED (${r.stopped})` : ""}: ` +
    `files=${r.files} young=${r.young} unreferenced=${r.unreferenced} ${verb}=${r.deleted} ` +
    `kept_at_recheck=${r.keptAtRecheck} by_group=${JSON.stringify(r.byGroup)} ` +
    `by_age=${JSON.stringify(r.byAge)}`
  );
}
