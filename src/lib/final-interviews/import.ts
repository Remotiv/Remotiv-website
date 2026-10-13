import type { BackgroundJob, EnqueueInput, EnqueueResult } from "@/lib/jobs-queue";
import { JobYield, TerminalJobError } from "@/lib/queue/failure-class";
import { assertProviderBudget, type JobContext } from "@/lib/queue/job-context";
import {
  getRecallClient,
  isRecallId,
  type RecallClient,
  type RecallRecordingInfo,
} from "@/lib/recall/client";
import {
  getRecordingStore,
  type RecordingStore,
  RecordingStoreError,
  type StoredPart,
} from "@/lib/storage-s3";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyRecordingReady } from "./alerts";
import { deterministicUuid, type EnqueueFn, ensureImportFailedAlert, toBotJobError } from "./bots";
import {
  FINAL_RECORDING_BUCKET,
  RECORDING_BOT_JOIN_LEAD_MS,
  RECORDING_IMPORT_ERRORS,
  RECORDING_IMPORT_PART_BYTES,
  RECORDING_IMPORT_SILENT_ERRORS,
  RECORDING_IMPORT_UPLOADER,
  RECORDING_MAX_BYTES,
  RECORDING_RETENTION_MONTHS,
} from "./constants";

/**
 * Copy a finished Recall recording into Remotiv's private bucket, verify it,
 * mark it ready, delete Recall's copy, and only then mark the bot row ready.
 * Recording step 4. One `final_recording_import` job per bot row at a time
 * (migration 040), run by the ordinary worker.
 *
 * ── Resumable, inside the worker's 55 seconds ────────────────
 *
 * The file is copied in 8 MiB parts of one S3 multipart upload. Each run
 * asks storage which parts are already there (ListParts) and copies the
 * next ones while its budget lasts, then hands the job back (JobYield: back
 * on the queue at once, attempts untouched). A run killed mid-part loses
 * that part only. The upload is found again by its key, so nothing about it
 * is stored in the database. An upload that storage has aborted (Supabase
 * drops unfinished ones after a day) is simply started again.
 *
 * ── The order, and what each step guarantees ─────────────────
 *
 *   1. claim       import_status queued|importing -> importing, with a fresh
 *                  import_started_at as this run's token. Every later bot
 *                  row write is conditional on that token: a lost claim stops.
 *   2. recording   GET /recording/{id}/ for a fresh signed URL (never stored).
 *                  It must be this bot's, and done.
 *   3. size        a Range GET of byte 0 gives the total. Over 2 GiB fails.
 *   4. row         final_interview_recordings 'pending', its id derived from
 *                  Recall's recording id, so a retry finds the same row.
 *   5. copy        parts; each one must come back as exactly the range asked.
 *   6. verify      the stored parts add up to the total, the object's size
 *                  is the total, and bytes 4-7 are the MP4 'ftyp' box.
 *                  Anything else deletes the object and fails the import.
 *   7. ready       recording row 'ready', delete_after = booking start + 3
 *                  calendar months (step 6a). Never before step 6.
 *   8. delete      Recall's recording deleted (204, or 404 = already gone),
 *                  only after the object is checked again to be there at its
 *                  verified size, and Recall confirms the recording is this
 *                  bot's. A failed delete leaves the bot 'importing' and the
 *                  next run retries the delete only: nothing is uploaded again.
 *                  If our copy is confirmed missing or invalid AND Recall
 *                  answers 404, both copies are gone: the row is failed, the
 *                  bot failed 'copy_lost', the host alerted, no more retries.
 *   9. bot ready   import_status 'ready'. Never before step 8, because 040's
 *                  orphan guard reads 'ready' as "Recall's copy is gone".
 *  10. bell        the host's final_recording_ready bell, after step 9.
 *
 * ── Failures ─────────────────────────────────────────────────
 *
 * Network, 5xx, 429 and timeouts throw and the queue retries; the reconcile
 * queues a new job a few hours after one dies, up to three jobs per bot row
 * (bots.ts ensureImportJob). A terminal problem (too large, not an MP4, the
 * wrong size, Recall's recording failed or is not this bot's) fails the
 * import: the bot row gets import_status 'failed' and an import_error code,
 * the host is alerted, and the object and the pending row are cleaned up.
 * Recall's copy is never deleted on a failure and expires by its retention.
 *
 * A second recording for an interview that already has a ready one (say a
 * manual upload) is never written over: ours is failed 'duplicate_recording',
 * its object deleted, Recall's copy left to expire, and the host not alerted.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Keys, the signed download URL, the storage path (it carries ids), names
 * and emails. Logs carry the bot row id and a fixed outcome.
 */

type Service = ReturnType<typeof createServiceClient>;

export type ImportDeps = {
  service: Service;
  recall: RecallClient;
  /** Null when SUPABASE_S3_* is not configured: the import refuses. */
  store: RecordingStore | null;
  enqueue: EnqueueFn;
  now: () => number;
  ctx?: JobContext;
};

export type ImportOutcome =
  | "ready"
  | "already_ready"
  | "already_failed"
  | "failed"
  | "duplicate"
  | "bot_gone"
  | "interview_gone"
  | "not_queued"
  | "no_recording"
  | "claim_lost";

type ImportRow = {
  id: string;
  company_id: string;
  final_interview_id: string;
  job_id: string;
  application_id: string;
  booking_id: string;
  provider_bot_id: string | null;
  provider_recording_id: string | null;
  join_at: string;
  status: string;
  import_status: string;
  import_started_at: string | null;
  import_error: string | null;
};

const IMPORT_COLUMNS =
  "id, company_id, final_interview_id, job_id, application_id, booking_id, provider_bot_id, provider_recording_id, join_at, status, import_status, import_started_at, import_error";

type RecordingRow = {
  id: string;
  final_interview_id: string;
  status: string;
  storage_path: string | null;
  size_bytes: number;
};

const RECORDING_COLUMNS = "id, final_interview_id, status, storage_path, size_bytes";

/** A part is not started with less budget than this: 8 MiB down and up again. */
const PART_BUDGET_MS = 25_000;
/** Any other call is not started with less than this. */
const CALL_BUDGET_MS = 10_000;
const CALL_TIMEOUT_CAP_MS = 20_000;
const PART_TIMEOUT_CAP_MS = 30_000;
/** Bytes read back from the stored object for the MP4 check. */
const HEAD_BYTES = 16;

/** This run no longer holds the bot row: stop without writing anything else. */
class ClaimLost extends Error {
  constructor() {
    super("import claim lost");
    this.name = "ClaimLost";
  }
}

/** Ends the run as a failed import with this code. */
class ImportFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`import failed: ${code}`);
    this.name = "ImportFailure";
    this.code = code;
  }
}

function dbError(what: string, error: { code?: string } | null | undefined): Error {
  return new Error(`${what} failed (${error?.code ?? "db"})`);
}

/** The recording row's id: one per Recall recording, so every retry finds the same row. */
export function recordingRowId(vendorRecordingId: string): string {
  return deterministicUuid(`final-recording:${vendorRecordingId}`);
}

/** {company_id}/{final_interview_id}/{id}.mp4, as migration 038 lays it out. */
export function recordingStoragePath(
  row: Pick<ImportRow, "company_id" | "final_interview_id">,
  recordingId: string,
): string {
  return `${row.company_id}/${row.final_interview_id}/${recordingId}.mp4`;
}

/** An MP4 starts with its ftyp box: a 4-byte size, then "ftyp". */
export function looksLikeMp4(head: Uint8Array): boolean {
  return (
    head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  );
}

/**
 * The interview's scheduled start plus RECORDING_RETENTION_MONTHS calendar
 * months, in UTC, at the same time of day. A day the target month does not
 * have becomes its last day (31 August + 3 months = 30 November), so the
 * date never spills into the month after.
 */
export function deleteAfterFor(scheduledStart: string): string | null {
  const d = new Date(scheduledStart);
  if (!Number.isFinite(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + RECORDING_RETENTION_MONTHS);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

/** Part n (1-based) covers these bytes of a file of `total`. */
export function partRange(n: number, total: number): { start: number; end: number } {
  const start = (n - 1) * RECORDING_IMPORT_PART_BYTES;
  return { start, end: Math.min(start + RECORDING_IMPORT_PART_BYTES, total) - 1 };
}

/** One run's state: the row it claimed, its token, and where the copy lives. */
type Run = {
  deps: ImportDeps;
  store: RecordingStore;
  row: ImportRow & { provider_bot_id: string; provider_recording_id: string };
  token: string;
  /** The current recording, fetched once per run and again when its URL is refused. */
  info: RecallRecordingInfo | null;
};

function callOptions(run: Run, label: string, cap = CALL_TIMEOUT_CAP_MS) {
  assertProviderBudget(run.deps.ctx, CALL_BUDGET_MS, label);
  const ctx = run.deps.ctx;
  if (!ctx) return { timeoutMs: cap };
  return {
    signal: ctx.signal,
    timeoutMs: Math.max(1_000, Math.min(cap, ctx.remainingMs() - 3_000)),
  };
}

/** A storage call's signal: the worker's deadline and a cap of its own. */
function storeSignal(run: Run, label: string, cap = CALL_TIMEOUT_CAP_MS): AbortSignal {
  const { signal, timeoutMs } = callOptions(run, label, cap);
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

/* ── the bot row ──────────────────────────────────────────────── */

async function readBot(service: Service, botId: string): Promise<ImportRow | null> {
  const { data, error } = await service
    .from("final_interview_bots")
    .select(IMPORT_COLUMNS)
    .eq("id", botId)
    .maybeSingle();
  if (error) throw dbError("bot row read", error);
  return data as ImportRow | null;
}

/** Take the row for this run. The token is the new import_started_at; null when another run has it. */
async function claim(deps: ImportDeps, row: ImportRow): Promise<string | null> {
  let token = new Date(deps.now()).toISOString();
  if (token === row.import_started_at) token = new Date(deps.now() + 1).toISOString();
  const update = deps.service
    .from("final_interview_bots")
    .update({ import_status: "importing", import_started_at: token, updated_at: token })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .in("import_status", ["queued", "importing"]);
  const guarded =
    row.import_started_at === null
      ? update.is("import_started_at", null)
      : update.eq("import_started_at", row.import_started_at);
  const { data, error } = await guarded.select("id");
  if (error) throw dbError("import claim", error);
  return ((data ?? []) as unknown[]).length > 0 ? token : null;
}

/** Throws ClaimLost unless this run still holds the row. */
async function assertClaim(run: Run): Promise<void> {
  const { data, error } = await run.deps.service
    .from("final_interview_bots")
    .select("id")
    .eq("id", run.row.id)
    .eq("company_id", run.row.company_id)
    .eq("import_status", "importing")
    .eq("import_started_at", run.token)
    .maybeSingle();
  if (error) throw dbError("import claim check", error);
  if (!data) throw new ClaimLost();
}

/** A conditional write to the bot row this run holds. False when it no longer does. */
async function writeBot(run: Run, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await run.deps.service
    .from("final_interview_bots")
    .update({ ...patch, updated_at: new Date(run.deps.now()).toISOString() })
    .eq("id", run.row.id)
    .eq("company_id", run.row.company_id)
    .eq("import_status", "importing")
    .eq("import_started_at", run.token)
    .select("id");
  if (error) throw dbError("bot row update", error);
  return ((data ?? []) as unknown[]).length > 0;
}

/* ── the recording row ────────────────────────────────────────── */

async function readRecording(
  service: Service,
  row: Pick<ImportRow, "company_id" | "provider_recording_id">,
): Promise<RecordingRow | null> {
  const { data, error } = await service
    .from("final_interview_recordings")
    .select(RECORDING_COLUMNS)
    .eq("vendor_recording_id", row.provider_recording_id as string)
    .eq("company_id", row.company_id)
    .maybeSingle();
  if (error) throw dbError("recording read", error);
  return data as RecordingRow | null;
}

/** Whether the interview already has a ready recording other than `exceptId`. */
async function otherReady(run: Run, exceptId: string): Promise<boolean> {
  const { data, error } = await run.deps.service
    .from("final_interview_recordings")
    .select("id")
    .eq("final_interview_id", run.row.final_interview_id)
    .eq("company_id", run.row.company_id)
    .eq("status", "ready")
    .neq("id", exceptId)
    .limit(1);
  if (error) throw dbError("ready recording read", error);
  return ((data ?? []) as unknown[]).length > 0;
}

/** The pending row, written once; a retry or a racing run finds the same one. Null if the interview is gone. */
async function insertRecording(run: Run, total: number): Promise<RecordingRow | null> {
  const id = recordingRowId(run.row.provider_recording_id);
  const { error } = await run.deps.service.from("final_interview_recordings").insert({
    id,
    final_interview_id: run.row.final_interview_id,
    company_id: run.row.company_id,
    job_id: run.row.job_id,
    application_id: run.row.application_id,
    source: "recall_bot",
    vendor_recording_id: run.row.provider_recording_id,
    storage_path: recordingStoragePath(run.row, id),
    mime_type: "video/mp4",
    size_bytes: total,
    status: "pending",
    uploaded_by: null,
    uploaded_by_name: RECORDING_IMPORT_UPLOADER,
  });
  // 23503: the interview (or applicant) was deleted under us.
  if (error?.code === "23503") return null;
  if (error && error.code !== "23505") throw dbError("recording insert", error);
  return readRecording(run.deps.service, run.row);
}

/* ── Recall ───────────────────────────────────────────────────── */

/** The recording, which must be this bot's. Null when Recall no longer has it. */
async function fetchInfo(run: Run): Promise<RecallRecordingInfo | null> {
  const info = await run.deps.recall.retrieveRecording(
    run.row.provider_recording_id,
    callOptions(run, "retrieve recording"),
  );
  if (info && info.botId !== run.row.provider_bot_id) {
    throw new ImportFailure(RECORDING_IMPORT_ERRORS.ownerMismatch);
  }
  run.info = info;
  return info;
}

/** The recording, finished and downloadable. Anything still processing retries. */
async function requireDone(run: Run): Promise<RecallRecordingInfo & { downloadUrl: string }> {
  const info = run.info ?? (await fetchInfo(run));
  if (!info) throw new ImportFailure(RECORDING_IMPORT_ERRORS.gone);
  if (info.statusCode === "failed" || info.statusCode === "deleted") {
    throw new ImportFailure(RECORDING_IMPORT_ERRORS.recordingFailed);
  }
  if (info.videoStatusCode === "failed" || info.videoStatusCode === "deleted") {
    throw new ImportFailure(RECORDING_IMPORT_ERRORS.noVideo);
  }
  if (info.statusCode !== "done" || info.videoStatusCode !== "done" || !info.downloadUrl) {
    throw new Error("the recording is still processing at Recall; retrying");
  }
  return info as RecallRecordingInfo & { downloadUrl: string };
}

/** Bytes start..end. A refused URL (expired, about 6 hours) is fetched fresh once. */
async function fetchRange(run: Run, start: number, end: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await requireDone(run);
    const result = await run.deps.recall.downloadRange(
      info.downloadUrl,
      start,
      end,
      callOptions(run, "download part", PART_TIMEOUT_CAP_MS),
    );
    if (result.outcome === "ok") return result;
    run.info = null;
  }
  throw new Error("Recall's media host refused a fresh download URL; retrying");
}

/* ── storage ──────────────────────────────────────────────────── */

/**
 * The unfinished upload for this key, oldest first, extras aborted; a new one
 * if there is none. The claim is checked between listing and aborting: every
 * upload listed existed before that check, so if one belonged to a newer
 * worker, that worker had already taken the claim and this run stops here
 * without touching it.
 */
async function openUpload(run: Run, key: string): Promise<string> {
  const [first, ...extra] = await run.store.findUploads(key, storeSignal(run, "list uploads"));
  if (extra.length > 0) await assertClaim(run);
  for (const id of extra) await run.store.abortUpload(key, id, storeSignal(run, "abort upload"));
  return (
    first ?? (await run.store.createUpload(key, "video/mp4", storeSignal(run, "create upload")))
  );
}

/**
 * Stored parts that match the layout for `total`; "gone" when storage no
 * longer has the upload, "wrong" when it holds parts of another layout.
 */
async function usableParts(
  run: Run,
  key: string,
  uploadId: string,
  total: number,
): Promise<StoredPart[] | "gone" | "wrong"> {
  const parts = await run.store.listParts(key, uploadId, storeSignal(run, "list parts"));
  if (!parts) return "gone";
  const count = Math.ceil(total / RECORDING_IMPORT_PART_BYTES);
  for (const p of parts) {
    const { start, end } = partRange(p.partNumber, total);
    if (p.partNumber < 1 || p.partNumber > count || p.size !== end - start + 1) return "wrong";
  }
  return parts;
}

/**
 * Copy every missing part, then complete. Throws JobYield when the budget
 * runs out, with what was copied already safe in storage.
 */
async function copyParts(run: Run, rec: RecordingRow, key: string): Promise<void> {
  const total = rec.size_bytes;
  const count = Math.ceil(total / RECORDING_IMPORT_PART_BYTES);
  let uploadId = await openUpload(run, key);
  let parts = await usableParts(run, key, uploadId, total);
  if (!Array.isArray(parts)) {
    // Dropped by storage: nothing to abort. Of another layout: abort it, but
    // only while this run still holds the claim. Then start again cleanly.
    if (parts === "wrong") {
      await assertClaim(run);
      await run.store.abortUpload(key, uploadId, storeSignal(run, "abort upload"));
    }
    uploadId = await run.store.createUpload(key, "video/mp4", storeSignal(run, "create upload"));
    parts = [];
  }
  const have = new Map<number, StoredPart>(parts.map((p) => [p.partNumber, p]));

  let copied = 0;
  for (let n = 1; n <= count; n++) {
    if (have.has(n)) continue;
    if (run.deps.ctx && run.deps.ctx.remainingMs() < PART_BUDGET_MS) {
      throw new JobYield(`recording import: ${have.size} of ${count} parts stored`);
    }
    await assertClaim(run);
    const { start, end } = partRange(n, total);
    const got = await fetchRange(run, start, end);
    if (got.total !== total) throw new ImportFailure(RECORDING_IMPORT_ERRORS.sizeMismatch);
    const etag = await run.store.uploadPart(
      key,
      uploadId,
      n,
      got.bytes,
      storeSignal(run, "upload part", PART_TIMEOUT_CAP_MS),
    );
    have.set(n, { partNumber: n, size: got.bytes.byteLength, etag });
    copied += 1;
  }

  // Storage's own list is the authority on what will be assembled.
  const stored = await usableParts(run, key, uploadId, total);
  if (!Array.isArray(stored) || stored.length !== count) {
    throw new Error(
      `recording import: storage holds ${Array.isArray(stored) ? stored.length : 0} of ${count} parts; retrying`,
    );
  }
  const sum = stored.reduce((acc, p) => acc + p.size, 0);
  if (sum !== total) throw new ImportFailure(RECORDING_IMPORT_ERRORS.sizeMismatch);
  await assertClaim(run);
  // "missing" means it completed on an earlier run whose answer was lost, or
  // it was aborted; the object check that follows decides which.
  await run.store.completeUpload(key, uploadId, stored, storeSignal(run, "complete upload"));
  if (copied > 0) console.log(`[final-recording] bot ${run.row.id}: ${count} parts assembled`);
}

/** The object's size and its first bytes, or ImportFailure. */
async function verifyObject(run: Run, rec: RecordingRow, key: string): Promise<void> {
  const head = await run.store.headObject(key, storeSignal(run, "head object"));
  if (!head)
    throw new Error("recording import: the object is not there after completing; retrying");
  if (head.size !== rec.size_bytes) throw new ImportFailure(RECORDING_IMPORT_ERRORS.sizeMismatch);
  const first = await run.store.readHead(key, HEAD_BYTES, storeSignal(run, "read object"));
  if (!looksLikeMp4(first)) throw new ImportFailure(RECORDING_IMPORT_ERRORS.notMp4);
}

/* ── the steps after the copy ─────────────────────────────────── */

/** pending -> ready. "duplicate" when the interview has a ready recording already; "gone" when the row is. */
async function markReady(run: Run, rec: RecordingRow): Promise<"ready" | "duplicate" | "gone"> {
  const { data: booking, error: bookingErr } = await run.deps.service
    .from("interview_bookings")
    .select("scheduled_start")
    .eq("id", run.row.booking_id)
    .eq("company_id", run.row.company_id)
    .maybeSingle();
  if (bookingErr) throw dbError("booking read", bookingErr);
  const start =
    (booking as { scheduled_start: string | null } | null)?.scheduled_start ??
    new Date(Date.parse(run.row.join_at) + RECORDING_BOT_JOIN_LEAD_MS).toISOString();
  const deleteAfter = deleteAfterFor(start);
  if (!deleteAfter) throw new Error("recording import: no scheduled start to date the purge from");

  await assertClaim(run);
  const { data, error } = await run.deps.service
    .from("final_interview_recordings")
    .update({
      status: "ready",
      uploaded_at: new Date(run.deps.now()).toISOString(),
      delete_after: deleteAfter,
    })
    .eq("id", rec.id)
    .eq("company_id", run.row.company_id)
    .eq("status", "pending")
    .select("id");
  if (error?.code === "23505") return "duplicate";
  if (error) throw dbError("recording ready", error);
  if (((data ?? []) as unknown[]).length > 0) return "ready";
  const now = await readRecording(run.deps.service, run.row);
  if (now?.status === "ready") return "ready";
  if (!now) return "gone";
  throw new Error(`recording import: the recording row is ${now.status}, not pending`);
}

/**
 * Recall's copy, deleted only with Remotiv's copy in hand: the object is
 * looked at again first, and Recall must say the recording is this bot's.
 * Then import_status 'ready', then the bell.
 */
async function finishWithDelete(run: Run, rec: RecordingRow, key: string): Promise<ImportOutcome> {
  // Remotiv's copy is checked first, every time. Only a CONCLUSIVE answer
  // counts: storage said 404 (missing), or the object was read and is not the
  // recording (wrong size or no MP4 header: invalid). Any storage error throws
  // here and the run is retried, so an outage is never taken for a loss.
  const head = await run.store.headObject(key, storeSignal(run, "head object"));
  let local: "intact" | "missing" | "invalid" = "missing";
  if (head) {
    local =
      head.size === rec.size_bytes &&
      looksLikeMp4(await run.store.readHead(key, HEAD_BYTES, storeSignal(run, "read object")))
        ? "intact"
        : "invalid";
  }
  // Null only on Recall's own 404; any other answer throws and is retried.
  const info = await run.deps.recall.retrieveRecording(
    run.row.provider_recording_id,
    callOptions(run, "retrieve recording"),
  );
  if (info && info.botId !== run.row.provider_bot_id) {
    // Never deleted on doubt, and the saved copy is not failed for it.
    throw new TerminalJobError(
      "deterministic",
      "Recall's recording is not this bot's; not deleted",
    );
  }
  if (local !== "intact") {
    if (!info) {
      // Both copies are gone: nothing is left to save or to delete.
      await markCopyLost(run, rec);
      throw new ImportFailure(RECORDING_IMPORT_ERRORS.copyLost);
    }
    // Recall still has it. A ready row never returns to pending, so there is
    // no re-copy path; Recall's copy is kept and a later run looks again. Its
    // retention ends this within 7 days, and then both copies are gone.
    console.error(`[final-recording] bot ${run.row.id}: ready copy ${local}; Recall's copy kept`);
    throw new Error(
      "recording import: the ready copy is not where it should be; Recall's copy kept",
    );
  }
  await assertClaim(run);
  if (info) {
    await run.deps.recall.deleteRecording(
      run.row.provider_recording_id,
      callOptions(run, "delete recording"),
    );
  }
  if (!(await writeBot(run, { import_status: "ready", import_error: null }))) {
    return "claim_lost";
  }
  await sendReadyBell(run.deps, run.row.id);
  return "ready";
}

/**
 * Both copies are gone: the ready row that points at a missing or invalid
 * object becomes 'failed', guarded on still being ready at the same path, so
 * the card never offers a recording that is not there. The row goes first: a
 * failed bot over a ready row would keep offering it. failImport then fails
 * the bot (copy_lost), alerts the host once, and removes what is left.
 */
async function markCopyLost(run: Run, rec: RecordingRow): Promise<void> {
  await assertClaim(run);
  const { data, error } = await run.deps.service
    .from("final_interview_recordings")
    .update({ status: "failed" })
    .eq("id", rec.id)
    .eq("company_id", run.row.company_id)
    .eq("status", "ready")
    .eq("storage_path", rec.storage_path as string)
    .select("id");
  if (error) throw dbError("recording lost", error);
  if (((data ?? []) as unknown[]).length === 0) {
    throw new Error("recording import: the recording row changed before it could be marked lost");
  }
}

async function sendReadyBell(deps: ImportDeps, botId: string): Promise<void> {
  const bell = await notifyRecordingReady(deps, botId);
  if (bell === "failed") throw new Error("recording ready bell insert failed; retrying");
  if (bell === "unknown") console.error(`[final-recording] bot ${botId}: ready bell unconfirmed`);
}

/**
 * What a failed import leaves behind: an unfinished upload, an object, a
 * pending row. A ready row is never touched. Safe to run again.
 */
async function cleanUp(
  deps: ImportDeps,
  store: RecordingStore | null,
  row: ImportRow,
  signal?: AbortSignal,
): Promise<void> {
  if (!store || !row.provider_recording_id) return;
  const rec = await readRecording(deps.service, row);
  if (rec?.status === "ready" || rec?.status === "deleted") return;
  // The key is derived, so a copy is found even when its row was deleted with the interview.
  const key = recordingStoragePath(row, recordingRowId(row.provider_recording_id));
  for (const id of await store.findUploads(key, signal)) await store.abortUpload(key, id, signal);
  await store.deleteObject(key, signal);
  if (rec?.status === "pending") {
    const { error } = await deps.service
      .from("final_interview_recordings")
      .update({ status: "failed" })
      .eq("id", rec.id)
      .eq("company_id", row.company_id)
      .eq("status", "pending");
    if (error) throw dbError("recording failed", error);
  }
}

/** The bot row is failed (on this run's claim), the host told, the leftovers removed. */
async function failImport(run: Run, code: string): Promise<ImportOutcome> {
  if (!(await writeBot(run, { import_status: "failed", import_error: code }))) return "claim_lost";
  console.error(`[final-recording] bot ${run.row.id}: import failed (${code})`);
  if (!RECORDING_IMPORT_SILENT_ERRORS.has(code)) {
    if ((await ensureImportFailedAlert(run.deps, run.row)) === "failed") {
      throw new Error("import-failed alert not queued; retrying");
    }
  }
  await cleanUp(run.deps, run.store, run.row, storeSignal(run, "clean up"));
  return code === RECORDING_IMPORT_ERRORS.duplicate ? "duplicate" : "failed";
}

/* ── one run ──────────────────────────────────────────────────── */

async function copyAndFinish(run: Run): Promise<ImportOutcome> {
  let rec = await readRecording(run.deps.service, run.row);
  if (rec && rec.final_interview_id !== run.row.final_interview_id) {
    throw new TerminalJobError("deterministic", "the recording row belongs to another interview");
  }
  if (rec?.status === "ready")
    return finishWithDelete(run, rec, recordingStoragePath(run.row, rec.id));
  if (rec && rec.status !== "pending") {
    // The import fails the bot row before the recording row (copy_lost aside,
    // which a crash can stop between the two), so a closed row under an
    // importing bot is left alone: reconcile's cap fails the bot.
    throw new TerminalJobError("deterministic", `the recording row is ${rec.status}`);
  }

  if (!rec) {
    const info = await requireDone(run);
    const probe = await fetchRange(run, 0, 0);
    const total = probe.total;
    if (total > RECORDING_MAX_BYTES) throw new ImportFailure(RECORDING_IMPORT_ERRORS.tooLarge);
    if (total <= 0) throw new ImportFailure(RECORDING_IMPORT_ERRORS.empty);
    if (await otherReady(run, recordingRowId(info.id))) {
      throw new ImportFailure(RECORDING_IMPORT_ERRORS.duplicate);
    }
    await assertClaim(run);
    rec = await insertRecording(run, total);
    if (!rec) return "interview_gone";
    if (rec.status === "ready") {
      return finishWithDelete(run, rec, recordingStoragePath(run.row, rec.id));
    }
    if (rec.status !== "pending") throw new Error("recording import: the row is not pending");
  }

  const key = recordingStoragePath(run.row, rec.id);
  if (rec.storage_path !== key) {
    throw new TerminalJobError("deterministic", "recording row's storage path is not the import's");
  }
  if (!(await run.store.headObject(key, storeSignal(run, "head object")))) {
    await copyParts(run, rec, key);
  }
  await verifyObject(run, rec, key);

  const ready = await markReady(run, rec);
  if (ready === "duplicate") throw new ImportFailure(RECORDING_IMPORT_ERRORS.duplicate);
  if (ready === "gone") {
    // The recording row was deleted while copying. The copy goes with it only
    // if the bot row went too (the interview or applicant was deleted), so no
    // worker can be holding the key.
    await discardIfOrphaned(run.deps, run.row);
    return "interview_gone";
  }
  return finishWithDelete(run, rec, key);
}

/** One run of a final_recording_import job. Exported with injectable deps for tests. */
export async function runRecordingImport(
  deps: ImportDeps,
  payload: Record<string, unknown>,
  jobCompanyId: string | null = null,
): Promise<ImportOutcome> {
  const botId = payload.botId;
  if (!isRecallId(botId)) {
    throw new TerminalJobError(
      "deterministic",
      "final_recording_import payload has no valid botId",
    );
  }
  let claimed: ImportRow | null = null;
  try {
    const row = await readBot(deps.service, botId);
    if (!row) return "bot_gone";
    if (jobCompanyId && row.company_id !== jobCompanyId) {
      throw new TerminalJobError(
        "deterministic",
        "the bot row does not belong to the job's company",
      );
    }
    if (row.import_status === "ready") {
      await sendReadyBell(deps, row.id);
      return "already_ready";
    }
    if (row.import_status === "failed") {
      await cleanUp(deps, deps.store, row, deps.ctx?.signal);
      if (!RECORDING_IMPORT_SILENT_ERRORS.has(row.import_error ?? "")) {
        if ((await ensureImportFailedAlert(deps, row)) === "failed") {
          throw new Error("import-failed alert not queued; retrying");
        }
      }
      return "already_failed";
    }
    if (row.import_status === "none") return "not_queued";
    if (!isRecallId(row.provider_recording_id) || !isRecallId(row.provider_bot_id)) {
      return "no_recording";
    }
    if (!deps.store) {
      throw new TerminalJobError(
        "configuration",
        "recording storage is not configured: SUPABASE_S3_ENDPOINT, SUPABASE_S3_REGION, SUPABASE_S3_ACCESS_KEY_ID and SUPABASE_S3_SECRET_ACCESS_KEY are required",
      );
    }
    const token = await claim(deps, row);
    if (!token) return "claim_lost";
    claimed = row;
    const run: Run = {
      deps,
      store: deps.store,
      row: row as Run["row"],
      token,
      info: null,
    };
    try {
      return await copyAndFinish(run);
    } catch (err) {
      if (err instanceof ImportFailure) return await failImport(run, err.code);
      throw err;
    }
  } catch (err) {
    if (err instanceof ClaimLost) {
      if (claimed) await discardIfOrphaned(deps, claimed);
      return "claim_lost";
    }
    if (err instanceof RecordingStoreError && err.configuration) {
      throw new TerminalJobError("configuration", err.message, { cause: err });
    }
    throw toBotJobError(err);
  }
}

/**
 * The bot row vanished mid-run: its applicant, interview or booking was
 * deleted. An unfinished copy has nothing left to belong to, so it goes too.
 * A ready recording is kept (cleanUp never touches one): only a by-hand
 * booking delete leaves the interview, and its recording, in place.
 */
async function discardIfOrphaned(deps: ImportDeps, row: ImportRow): Promise<void> {
  if (await readBot(deps.service, row.id)) return;
  await cleanUp(deps, deps.store, row, deps.ctx?.signal);
  console.log(
    `[final-recording] bot ${row.id}: bot row deleted mid-import; unfinished copy removed`,
  );
}

/** jobs-queue imports this file, so the enqueue is reached lazily, as bots.ts does. */
async function lazyEnqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const { enqueue } = await import("@/lib/jobs-queue");
  return enqueue(input);
}

export async function handleFinalRecordingImport(
  job: BackgroundJob,
  ctx?: JobContext,
): Promise<void> {
  const deps: ImportDeps = {
    service: createServiceClient(),
    recall: getRecallClient(),
    store: getRecordingStore(FINAL_RECORDING_BUCKET),
    enqueue: lazyEnqueue,
    now: Date.now,
    ctx,
  };
  const outcome = await runRecordingImport(
    deps,
    (job.payload ?? {}) as Record<string, unknown>,
    job.company_id,
  );
  console.log(`[final-recording] job ${job.id}: ${outcome}`);
}
