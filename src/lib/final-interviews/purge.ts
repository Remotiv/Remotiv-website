import type { BackgroundJob, EnqueueInput, EnqueueResult } from "@/lib/jobs-queue";
import { TerminalJobError } from "@/lib/queue/failure-class";
import type { JobContext } from "@/lib/queue/job-context";
import { removeObjects } from "@/lib/storage-objects";
import { getRecordingStore, type RecordingStore } from "@/lib/storage-s3";
import { createServiceClient } from "@/lib/supabase/server";
import {
  FINAL_RECORDING_BUCKET,
  FINAL_RECORDING_PURGE_JOB,
  RECORDING_ORPHAN_GRACE_MS,
} from "./constants";

/**
 * Recording step 6a: deleting copied final-interview recordings.
 *
 * One daily job, three phases, in this order:
 *
 *   1. retention   ready rows whose delete_after has passed. The object is
 *                  deleted FIRST; only then is the row marked: status
 *                  'deleted', deleted_at now, deleted_by null (the purge, not
 *                  a person), storage_path null, and only while the row is
 *                  still ready with the same path. A failed delete leaves the
 *                  row as it was for the next run, and never stops the batch:
 *                  the batch pages on by id past it. A row is never marked
 *                  deleted while its file may still exist.
 *   2. objects     every object in the bucket, page by page in key order. An
 *                  object no pending or ready row points at, older than 24
 *                  hours, is deleted. That finds the files of deleted
 *                  applicants, interviews and companies, whose rows went with
 *                  them, without asking which companies exist.
 *   3. uploads     every unfinished multipart upload, the same way: aborted
 *                  when unreferenced and older than 24 hours.
 *
 * ── Never the files of a live import ─────────────────────────
 *
 * An import writes its pending row, with its storage_path, before it creates
 * an upload or an object (import.ts), so anything a live import is writing is
 * referenced, and kept. The 24 hours cover the moments around that write.
 * Failed rows protect nothing: their copy was given up on. A pending row whose
 * bot's import has been failed for over 7 days protects nothing either: the
 * failure cleanup deletes the file before marking the row failed, so a file
 * whose delete kept failing is left under a pending row nothing will revisit.
 * Ready rows are always protected, and a pending row under a live or
 * importing bot always is.
 *
 * ── Fail closed ──────────────────────────────────────────────
 *
 * The references for each page are read for exactly that page's keys, in
 * small chunks. If any chunk's read fails, nothing on that page is deleted and
 * the sweep stops; the job then fails so the queue records it.
 *
 * ── Dry run until switched on ────────────────────────────────
 *
 * Nothing is deleted unless RECORDING_PURGE_LIVE is exactly "true". Until then
 * every phase counts what it WOULD delete and the job logs the counts, so the
 * first live run is preceded by a read-only one.
 *
 * ── Bounded ──────────────────────────────────────────────────
 *
 * Pages, never the whole bucket in memory. When the worker's budget runs low
 * the job stops and queues a continuation carrying where the sweep had got to
 * (keys hold ids only); the retention phase needs no cursor because a purged
 * row leaves its own selector. Logs carry counts and recording ids, never
 * paths or URLs.
 */

type Service = ReturnType<typeof createServiceClient>;

const RECORDINGS = "final_interview_recordings";
/** Retention rows read per page. */
const RETENTION_BATCH = 25;
/** Objects or uploads listed per page. */
const SWEEP_PAGE = 50;
/** Keys per reference read: `.in()` with long paths overflows the URL past a few dozen. */
const REFERENCE_CHUNK = 25;
/** No new step is started with less worker budget than this. */
const STEP_BUDGET_MS = 8_000;
/**
 * A pending row stops protecting its file once its bot's import has been
 * failed for longer than this: its cleanup never got through, and nothing
 * will ever finish or retry it.
 */
const ABANDONED_PENDING_MS = 7 * 24 * 60 * 60_000;

export function isRecordingPurgeLive(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RECORDING_PURGE_LIVE === "true";
}

export type PurgeDeps = {
  service: Service;
  /** Null when SUPABASE_S3_* is not configured. */
  store: RecordingStore | null;
  now: () => number;
  /** Deletes only when true; otherwise counts. */
  live: boolean;
  enqueue: (input: EnqueueInput) => Promise<EnqueueResult>;
  ctx?: JobContext;
  /** Page sizes; tests make them small. */
  retentionBatch?: number;
  sweepPage?: number;
};

/** Where a continuation picks the sweep up. Never logged. */
type Resume =
  | { phase: "objects"; after?: string }
  | { phase: "uploads"; keyMarker?: string; uploadIdMarker?: string };

export type PurgeReport = {
  mode: "live" | "dry_run";
  storageConfigured: boolean;
  /** Ready rows past delete_after seen this run. */
  due: number;
  purged: number;
  /** Object delete or row update failed; left for the next run. */
  purgeFailed: number;
  /** The row changed between the read and the update; left untouched. */
  rowChanged: number;
  objectsScanned: number;
  orphanObjects: number;
  orphanObjectsDeleted: number;
  /** Unreferenced, but under 24 hours old. */
  youngObjectsKept: number;
  uploadsScanned: number;
  orphanUploads: number;
  orphanUploadsAborted: number;
  youngUploadsKept: number;
  /** A sweep delete or abort that failed; left for the next run. */
  sweepFailed: number;
  /** A reference read failed: the sweep stopped, nothing on that page was deleted. */
  referenceReadFailed: boolean;
  /** Out of budget: a continuation was queued (or tried). */
  continued: boolean;
};

function newReport(deps: PurgeDeps): PurgeReport {
  return {
    mode: deps.live ? "live" : "dry_run",
    storageConfigured: deps.store !== null,
    due: 0,
    purged: 0,
    purgeFailed: 0,
    rowChanged: 0,
    objectsScanned: 0,
    orphanObjects: 0,
    orphanObjectsDeleted: 0,
    youngObjectsKept: 0,
    uploadsScanned: 0,
    orphanUploads: 0,
    orphanUploadsAborted: 0,
    youngUploadsKept: 0,
    sweepFailed: 0,
    referenceReadFailed: false,
    continued: false,
  };
}

function dbError(what: string, error: { code?: string } | null | undefined): Error {
  return new Error(`${what} failed (${error?.code ?? "db"})`);
}

/** Room for one more step in this worker invocation. Always true outside the worker. */
function hasBudget(deps: PurgeDeps): boolean {
  return !deps.ctx || deps.ctx.remainingMs() >= STEP_BUDGET_MS;
}

/* ── 1. retention ───────────────────────────────────────────────── */

/** Ready rows past delete_after: file first, then the row. Returns false when out of budget. */
async function purgeDue(deps: PurgeDeps, report: PurgeReport): Promise<boolean> {
  const nowIso = new Date(deps.now()).toISOString();
  const batch = deps.retentionBatch ?? RETENTION_BATCH;
  let lastId: string | null = null;
  for (;;) {
    if (!hasBudget(deps)) return false;
    let query = deps.service
      .from(RECORDINGS)
      .select("id, company_id, storage_path")
      .eq("status", "ready")
      .lte("delete_after", nowIso)
      .not("storage_path", "is", null)
      .order("id", { ascending: true })
      .limit(batch);
    // By id, past the last row seen: a row whose delete keeps failing never
    // holds up the rows behind it.
    if (lastId) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw dbError("due recordings read", error);
    const rows = (data ?? []) as { id: string; company_id: string; storage_path: string }[];
    if (rows.length === 0) return true;

    for (const row of rows) {
      report.due += 1;
      if (!deps.live) continue;
      if (!deps.store) {
        throw new TerminalJobError(
          "configuration",
          "recordings are due for deletion but SUPABASE_S3_* is not configured",
        );
      }
      if (!hasBudget(deps)) return false;
      try {
        await deps.store.deleteObject(row.storage_path, deps.ctx?.signal);
      } catch {
        report.purgeFailed += 1;
        console.error(
          `[final-recording-purge] recording ${row.id}: delete failed; kept for the next run`,
        );
        continue;
      }
      const { data: updated, error: updErr } = await deps.service
        .from(RECORDINGS)
        .update({
          status: "deleted",
          deleted_at: nowIso,
          deleted_by: null,
          storage_path: null,
        })
        .eq("id", row.id)
        .eq("company_id", row.company_id)
        .eq("status", "ready")
        .eq("storage_path", row.storage_path)
        .select("id");
      if (updErr) {
        // The file is gone, the row still points at it: the next run deletes
        // nothing (already gone) and marks it then.
        report.purgeFailed += 1;
        console.error(
          `[final-recording-purge] recording ${row.id}: row update failed (${updErr.code ?? "db"})`,
        );
        continue;
      }
      if (((updated ?? []) as unknown[]).length > 0) report.purged += 1;
      else report.rowChanged += 1;
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < batch) return true;
  }
}

/* ── 2 and 3. the sweep ─────────────────────────────────────────── */

type ReferenceRow = {
  storage_path: string | null;
  status: string;
  company_id: string;
  vendor_recording_id: string | null;
};

/**
 * The pending rows (by company and Recall recording id) whose bot's import
 * has been failed for over ABANDONED_PENDING_MS, judged by the bot row's
 * updated_at, which the failure write stamps (a later write only moves it on,
 * which only delays this). Null if the read failed.
 */
async function abandonedPending(
  service: Service,
  rows: ReferenceRow[],
  nowMs: number,
): Promise<Set<string> | null> {
  const vendorIds = rows
    .filter((r) => r.status === "pending" && r.vendor_recording_id)
    .map((r) => r.vendor_recording_id as string);
  const abandoned = new Set<string>();
  if (vendorIds.length === 0) return abandoned;
  const { data, error } = await service
    .from("final_interview_bots")
    .select("company_id, provider_recording_id, import_status, updated_at")
    .in("provider_recording_id", vendorIds);
  if (error) return null;
  for (const b of (data ?? []) as {
    company_id: string;
    provider_recording_id: string | null;
    import_status: string;
    updated_at: string | null;
  }[]) {
    const failedAt = Date.parse(b.updated_at ?? "");
    if (
      b.import_status === "failed" &&
      Number.isFinite(failedAt) &&
      nowMs - failedAt > ABANDONED_PENDING_MS
    ) {
      abandoned.add(`${b.company_id}|${b.provider_recording_id}`);
    }
  }
  return abandoned;
}

/**
 * The keys among `keys` that a row still protects: a ready row, or a pending
 * row that is not abandoned. Null if any read failed (the caller then deletes
 * nothing).
 */
async function referencedKeys(
  service: Service,
  keys: string[],
  nowMs: number,
): Promise<Set<string> | null> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += REFERENCE_CHUNK) {
    const chunk = keys.slice(i, i + REFERENCE_CHUNK);
    const { data, error } = await service
      .from(RECORDINGS)
      .select("storage_path, status, company_id, vendor_recording_id")
      .in("storage_path", chunk)
      .in("status", ["pending", "ready"]);
    if (error) return null;
    const rows = (data ?? []) as ReferenceRow[];
    const abandoned = await abandonedPending(service, rows, nowMs);
    if (!abandoned) return null;
    for (const r of rows) {
      if (!r.storage_path) continue;
      if (r.status === "pending" && abandoned.has(`${r.company_id}|${r.vendor_recording_id}`)) {
        continue;
      }
      found.add(r.storage_path);
    }
  }
  return found;
}

function oldEnough(deps: PurgeDeps, at: number | null): boolean {
  // No timestamp is treated as new: kept.
  return at !== null && deps.now() - at >= RECORDING_ORPHAN_GRACE_MS;
}

/** Returns where to resume when out of budget, or null when the bucket was finished. */
async function sweepObjects(
  deps: PurgeDeps,
  store: RecordingStore,
  report: PurgeReport,
  startAfter: string | undefined,
): Promise<Resume | null | "stopped"> {
  let after = startAfter;
  for (;;) {
    if (!hasBudget(deps)) return { phase: "objects", after };
    const page = await store.listObjectsPage(
      { startAfter: after, maxKeys: deps.sweepPage ?? SWEEP_PAGE },
      deps.ctx?.signal,
    );
    report.objectsScanned += page.objects.length;
    const refs = await referencedKeys(
      deps.service,
      page.objects.map((o) => o.key),
      deps.now(),
    );
    if (!refs) {
      report.referenceReadFailed = true;
      return "stopped";
    }
    for (const o of page.objects) {
      if (!hasBudget(deps)) return { phase: "objects", after };
      if (!refs.has(o.key)) {
        if (!oldEnough(deps, o.lastModified)) report.youngObjectsKept += 1;
        else {
          report.orphanObjects += 1;
          if (deps.live) {
            try {
              await store.deleteObject(o.key, deps.ctx?.signal);
              report.orphanObjectsDeleted += 1;
            } catch {
              report.sweepFailed += 1;
            }
          }
        }
      }
      after = o.key;
    }
    if (!page.next) return null;
    after = page.next;
  }
}

async function sweepUploads(
  deps: PurgeDeps,
  store: RecordingStore,
  report: PurgeReport,
  from: { keyMarker?: string; uploadIdMarker?: string },
): Promise<Resume | null | "stopped"> {
  let keyMarker = from.keyMarker;
  let uploadIdMarker = from.uploadIdMarker;
  for (;;) {
    if (!hasBudget(deps)) return { phase: "uploads", keyMarker, uploadIdMarker };
    const page = await store.listUploadsPage(
      { keyMarker, uploadIdMarker, maxUploads: deps.sweepPage ?? SWEEP_PAGE },
      deps.ctx?.signal,
    );
    report.uploadsScanned += page.uploads.length;
    const refs = await referencedKeys(
      deps.service,
      [...new Set(page.uploads.map((u) => u.key))],
      deps.now(),
    );
    if (!refs) {
      report.referenceReadFailed = true;
      return "stopped";
    }
    for (const u of page.uploads) {
      if (!hasBudget(deps)) return { phase: "uploads", keyMarker, uploadIdMarker };
      if (!refs.has(u.key)) {
        if (!oldEnough(deps, u.initiated)) report.youngUploadsKept += 1;
        else {
          report.orphanUploads += 1;
          if (deps.live) {
            try {
              await store.abortUpload(u.key, u.uploadId, deps.ctx?.signal);
              report.orphanUploadsAborted += 1;
            } catch {
              report.sweepFailed += 1;
            }
          }
        }
      }
      keyMarker = u.key;
      uploadIdMarker = u.uploadId;
    }
    if (!page.next) return null;
    keyMarker = page.next.keyMarker;
    uploadIdMarker = page.next.uploadIdMarker;
  }
}

function readResume(payload: Record<string, unknown>): Resume | null {
  const r = payload.resume as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (r.phase === "objects") return { phase: "objects", after: str(r.after) };
  if (r.phase === "uploads") {
    return { phase: "uploads", keyMarker: str(r.keyMarker), uploadIdMarker: str(r.uploadIdMarker) };
  }
  return null;
}

/** One run. Exported with injectable deps for tests. */
export async function runRecordingPurge(
  deps: PurgeDeps,
  payload: Record<string, unknown> = {},
): Promise<PurgeReport> {
  const report = newReport(deps);
  const resume = readResume(payload);

  let next: Resume | null = null;
  if (!(await purgeDue(deps, report))) {
    // The retention phase needs no cursor; the sweep starts where it was.
    next = resume ?? { phase: "objects" };
  } else if (deps.store) {
    const store = deps.store;
    let outcome: Resume | null | "stopped" = null;
    if (resume?.phase !== "uploads") {
      outcome = await sweepObjects(
        deps,
        store,
        report,
        resume?.phase === "objects" ? resume.after : undefined,
      );
    }
    if (outcome === null) {
      outcome = await sweepUploads(deps, store, report, resume?.phase === "uploads" ? resume : {});
    }
    next = outcome === "stopped" ? null : outcome;
  }

  if (next) {
    report.continued = true;
    const queued = await deps
      .enqueue({ type: FINAL_RECORDING_PURGE_JOB, companyId: null, payload: { resume: next } })
      .catch(() => ({ ok: false as const, error: "threw" }));
    if (!queued.ok)
      console.error("[final-recording-purge] continuation not queued; tomorrow's run starts over");
  }
  return report;
}

/* ── applicant delete (step 6a) ─────────────────────────────────── */

/**
 * Remove the recording files of one application's final interviews, this
 * company's only, before the application is deleted (its rows cascade away
 * with it). Best-effort: the caller never blocks on it, and the daily sweep
 * removes anything left, including an upload a live import was still making.
 */
export async function removeApplicationRecordings(
  service: Service,
  companyId: string,
  applicationId: string,
): Promise<{ requested: number; removed: number; failed: boolean }> {
  const { data, error } = await service
    .from(RECORDINGS)
    .select("id, storage_path")
    .eq("application_id", applicationId)
    .eq("company_id", companyId)
    .not("storage_path", "is", null);
  if (error) return { requested: 0, removed: 0, failed: true };
  const paths = ((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  if (paths.length === 0) return { requested: 0, removed: 0, failed: false };
  const outcome = await removeObjects(service, FINAL_RECORDING_BUCKET, paths);
  return { requested: paths.length, removed: outcome.removed.size, failed: outcome.error !== null };
}

/* ── the job ────────────────────────────────────────────────────── */

/** jobs-queue imports this file, so the enqueue is reached lazily, as bots.ts does. */
async function lazyEnqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const { enqueue } = await import("@/lib/jobs-queue");
  return enqueue(input);
}

export async function handleFinalRecordingPurge(
  job: BackgroundJob,
  ctx?: JobContext,
): Promise<void> {
  const report = await runRecordingPurge(
    {
      service: createServiceClient(),
      store: getRecordingStore(FINAL_RECORDING_BUCKET),
      now: Date.now,
      live: isRecordingPurgeLive(),
      enqueue: lazyEnqueue,
      ctx,
    },
    (job.payload ?? {}) as Record<string, unknown>,
  );
  // Counts only: no keys, paths or URLs.
  console.log(`[final-recording-purge] ${JSON.stringify(report)}`);
  if (report.referenceReadFailed) {
    throw new Error(
      "recording references could not be read; the sweep deleted nothing on that page",
    );
  }
}
