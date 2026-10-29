import type { BookingRow } from "@/lib/calendar/bookings";
import type { BackgroundJob, EnqueueInput, EnqueueResult } from "@/lib/jobs-queue";
import { JobYield, TerminalJobError, toJobError } from "@/lib/queue/failure-class";
import { assertProviderBudget, type JobContext } from "@/lib/queue/job-context";
import { deterministicUuid } from "@/lib/queue/job-id";
import {
  getRecallClient,
  isRecallId,
  RecallApiError,
  type RecallBot,
  type RecallClient,
} from "@/lib/recall/client";
import type { CreateBotRequest } from "@/lib/recall/types";
import { type HeaderReader, verifyRecallWebhook } from "@/lib/recall/verify";
import { createServiceClient } from "@/lib/supabase/server";
import {
  FINAL_BOT_ALERT_JOB,
  FINAL_RECORDING_IMPORT_JOB,
  type FinalBotStatus,
  RECORDING_ALERT_MAX_ATTEMPTS,
  RECORDING_BOT_EVERYONE_LEFT_TIMEOUT_S,
  RECORDING_BOT_INTEGRATION,
  RECORDING_BOT_JOIN_LEAD_MS,
  RECORDING_BOT_MIN_SCHEDULE_LEAD_MS,
  RECORDING_BOT_NAME,
  RECORDING_BOT_NOONE_JOINED_TIMEOUT_S,
  RECORDING_BOT_RECORDING_TIMEOUT_S,
  RECORDING_BOT_RETENTION_HOURS,
  RECORDING_BOT_WAITING_ROOM_TIMEOUT_S,
  RECORDING_FAILURE_ALERT_MAX_JOBS,
  RECORDING_IMPORT_ERRORS,
  RECORDING_IMPORT_MAX_ATTEMPTS,
  RECORDING_IMPORT_MAX_JOBS,
  RECORDING_IMPORT_RETRY_GAP_MS,
  RECORDING_IMPORT_SILENT_ERRORS,
  RECORDING_LOBBY_ALERT_DELAY_MS,
  RECORDING_WAITING_ROOM_FAILURE_SUB_CODES,
  type RecordingAlertKind,
} from "./constants";

/**
 * The Recall.ai recording bot for a Final Human Interview: scheduled when the
 * candidate books, replaced when they move it, removed when it is cancelled,
 * and cleaned up when its interview is deleted. Step 2 of the recording work.
 *
 * ── Who calls Recall ─────────────────────────────────────────
 *
 * Only the `final_bot_sync` job. The booking route and the recruiter's cancel
 * action call the three hooks at the bottom of this file, which write a row
 * and enqueue a job and never reach Recall, so a Recall outage cannot slow or
 * fail a booking.
 *
 * ── One job, state-based ─────────────────────────────────────
 *
 * A sync job does not carry an instruction. It reads the booking, its final
 * interview and every bot row for the booking, works out what should be true
 * now (planSync), makes it so, and reads again. An old queued job therefore
 * cannot recreate a bot for a booking that has since been cancelled: it sees
 * the cancellation first. Migration 040 allows one queued-or-running sync per
 * booking, so a change that lands while one is running is caught by the
 * re-read loop, and anything after the last re-read by the reconcile job
 * every two minutes.
 *
 * ── Media is never deleted here except on the privacy path ───
 *
 * Ordinary cancellation and rescheduling delete a bot only while it is still
 * scheduled (it has joined nothing, so it holds nothing). A bot that has
 * joined is asked to leave the call and its media is kept for the import.
 * Only the orphan `delete` action, queued by migration 040's trigger when an
 * applicant, interview, booking or company is deleted, deletes recordings
 * here. The import (import.ts, step 4) deletes Recall's copy too, but only
 * once Remotiv's copy is verified and marked ready.
 * No row is set to 'deleted' unless Recall has confirmed the bot is gone
 * before it joined anything.
 *
 * ── The feature flag ─────────────────────────────────────────
 *
 * RECALL_RECORDING_ENABLED gates NEW bots only, through isRecallRecordingEnabled.
 * With it off, nothing is written for a new booking, but bots that already
 * exist are still removed on cancel or reschedule, and the orphan delete runs.
 */

/* ── tuning ───────────────────────────────────────────────────── */

/** Must equal JOB_TYPES.FINAL_BOT_SYNC; a literal because jobs-queue imports this file. */
export const FINAL_BOT_SYNC_JOB = "final_bot_sync";
/** 30s, 1m, 2m, 4m, 8m between attempts: about a quarter of an hour of retries. */
export const SYNC_MAX_ATTEMPTS = 6;
/** How often the reconcile job may start. */
export const RECONCILE_INTERVAL_MS = 2 * 60_000;
/** Plan, act, re-read: at most this many times per job before handing back to the queue. */
const MAX_ROUNDS = 5;
/** A booking request waits at most this long for a hook. */
const HOOK_TIMEOUT_MS = 4_000;
/** A Recall call is not opened with less worker budget than this. */
const MIN_CALL_BUDGET_MS = 10_000;
const CALL_TIMEOUT_CAP_MS = 15_000;
/** Rows touched more recently than this are left to the job that touched them. */
const RECONCILE_SETTLE_MS = 2 * 60_000;
const RECONCILE_BATCH = 25;
const RECONCILE_LOOKBACK_MS = 24 * 60 * 60_000;
const RECONCILE_VENDOR_PAGES = 2;
const ORPHAN_LEAVE_POLLS = 4;
const ORPHAN_POLL_MS = 3_000;
/** How long after an import fails the reconcile still checks its host alert was queued. */
const IMPORT_ALERT_BACKSTOP_MS = 24 * 60 * 60_000;

/** last_event_code values Remotiv writes itself. Recall's own codes land there too. */
export const BOT_EVENT = {
  createRequested: "create_requested",
  createAmbiguous: "create_ambiguous",
  createRetry: "create_retry",
  createFailed: "create_failed",
  scheduled: "scheduled",
  adopted: "adopted",
  tooLate: "too_late_to_schedule",
  disabled: "recording_disabled",
  noMeetingUrl: "no_meeting_url",
  metadataMismatch: "vendor_metadata_mismatch",
  leaveRequested: "leave_requested",
  scheduledDeleted: "scheduled_bot_deleted",
  vendorNotFound: "vendor_not_found",
  supersededUnscheduled: "superseded_before_scheduling",
} as const;

/** A create was attempted, so a vendor bot may exist even though no id was saved. */
const CREATE_ATTEMPTED: ReadonlySet<string> = new Set([
  BOT_EVENT.createRequested,
  BOT_EVENT.createAmbiguous,
  BOT_EVENT.createRetry,
]);

/** Statuses whose vendor bot may still be scheduled or in a call. */
const VENDOR_ACTIVE: ReadonlySet<string> = new Set([
  "pending",
  "scheduled",
  "waiting_room",
  "in_call",
  "recording",
]);

/* ── the flag ─────────────────────────────────────────────────── */

/**
 * Whether NEW recording bots may be scheduled. Fails closed: only the exact
 * string "true" turns it on. Cleanup and the orphan delete never consult it.
 */
export function isRecallRecordingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RECALL_RECORDING_ENABLED === "true";
}

/* ── shapes ───────────────────────────────────────────────────── */

type Service = ReturnType<typeof createServiceClient>;

export type FinalBotRow = {
  id: string;
  final_interview_id: string;
  company_id: string;
  job_id: string;
  application_id: string;
  booking_id: string;
  provider: string;
  provider_bot_id: string | null;
  provider_recording_id: string | null;
  join_at: string;
  status: FinalBotStatus;
  last_event_code: string | null;
  last_event_sub_code: string | null;
  last_event_at: string | null;
  import_status: string;
  /** Not in BOT_COLUMNS: written by the import (step 4), read where it is needed. */
  import_error?: string | null;
  lobby_alert_sent_at: string | null;
  failure_alert_sent_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
};

const BOT_COLUMNS =
  "id, final_interview_id, company_id, job_id, application_id, booking_id, provider, provider_bot_id, provider_recording_id, join_at, status, last_event_code, last_event_sub_code, last_event_at, import_status, lobby_alert_sent_at, failure_alert_sent_at, superseded_at, created_at, updated_at";

export type BookingSnapshot = Pick<
  BookingRow,
  | "id"
  | "company_id"
  | "application_id"
  | "job_id"
  | "status"
  | "purpose"
  | "final_interview_id"
  | "scheduled_start"
  | "meeting_url"
>;

const BOOKING_COLUMNS =
  "id, company_id, application_id, job_id, status, purpose, final_interview_id, scheduled_start, meeting_url";

type FinalInterviewSnapshot = {
  id: string;
  company_id: string;
  job_id: string;
  application_id: string;
  status: string;
};

export type SyncState = {
  booking: BookingSnapshot | null;
  finalInterview: FinalInterviewSnapshot | null;
  rows: FinalBotRow[];
};

export type EnqueueFn = (input: EnqueueInput) => Promise<EnqueueResult>;

export type BotDeps = {
  service: Service;
  recall: RecallClient;
  enqueue: EnqueueFn;
  enabled: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ctx?: JobContext;
};

/** What the booking hooks need. No Recall client: hooks never call Recall. */
export type HookDeps = Pick<BotDeps, "service" | "enqueue" | "enabled" | "now">;

/** jobs-queue imports this file, so the enqueue is reached lazily, as expiry.ts does. */
async function lazyEnqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const { enqueue } = await import("@/lib/jobs-queue");
  return enqueue(input);
}

function workerDeps(ctx?: JobContext): BotDeps {
  return {
    service: createServiceClient(),
    recall: getRecallClient(),
    enqueue: lazyEnqueue,
    enabled: () => isRecallRecordingEnabled(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ctx,
  };
}

/* ── the bot request ──────────────────────────────────────────── */

export function desiredJoinAtMs(scheduledStart: string | null | undefined): number | null {
  const start = Date.parse(scheduledStart ?? "");
  return Number.isFinite(start) ? start - RECORDING_BOT_JOIN_LEAD_MS : null;
}

/** One key per bot row: Recall replays the first create for an hour on a repeat. */
export function idempotencyKeyFor(botRowId: string): string {
  return `remotiv-final-bot-${botRowId}`;
}

/** String values only, as Recall requires. The marker reconciliation trusts. */
export function botMetadata(
  row: Pick<FinalBotRow, "id" | "final_interview_id" | "company_id">,
): Record<string, string> {
  return {
    integration: RECORDING_BOT_INTEGRATION,
    botRowId: row.id,
    finalInterviewId: row.final_interview_id,
    companyId: row.company_id,
  };
}

export function buildCreateBotRequest(
  row: Pick<FinalBotRow, "id" | "final_interview_id" | "company_id" | "join_at">,
  meetingUrl: string,
): CreateBotRequest {
  return {
    meeting_url: meetingUrl,
    bot_name: RECORDING_BOT_NAME,
    join_at: new Date(Date.parse(row.join_at)).toISOString(),
    recording_config: {
      video_mixed_mp4: {},
      retention: { type: "timed", hours: RECORDING_BOT_RETENTION_HOURS },
    },
    automatic_leave: {
      waiting_room_timeout: RECORDING_BOT_WAITING_ROOM_TIMEOUT_S,
      noone_joined_timeout: RECORDING_BOT_NOONE_JOINED_TIMEOUT_S,
      everyone_left_timeout: { timeout: RECORDING_BOT_EVERYONE_LEFT_TIMEOUT_S },
      in_call_recording_timeout: RECORDING_BOT_RECORDING_TIMEOUT_S,
    },
    metadata: botMetadata(row),
  };
}

/* ── reading Recall's view of a bot ───────────────────────────── */

export type VendorPhase = "scheduled" | "in_progress" | "ended" | "unknown";

export type VendorView = {
  phase: VendorPhase;
  /** The row status this maps to; null when Recall said something unknown. */
  status: FinalBotStatus | null;
  code: string | null;
  subCode: string | null;
  at: string | null;
  /** Any status beyond being scheduled: the bot may hold media from here on. */
  dispatched: boolean;
  recordingIds: string[];
};

const IN_PROGRESS_CODES: ReadonlyMap<string, FinalBotStatus> = new Map([
  ["joining_call", "waiting_room"],
  ["in_waiting_room", "waiting_room"],
  ["in_call_not_recording", "in_call"],
  ["recording_permission_allowed", "in_call"],
  ["recording_permission_denied", "in_call"],
  ["in_call_recording", "recording"],
  ["breakout_room_entered", "in_call"],
  ["breakout_room_left", "in_call"],
  ["breakout_room_opened", "in_call"],
  ["breakout_room_closed", "in_call"],
]);

const ENDED_CODES: ReadonlyMap<string, FinalBotStatus> = new Map([
  ["call_ended", "call_ended"],
  ["recording_done", "done"],
  ["done", "done"],
  ["analysis_done", "done"],
  ["analysis_failed", "done"],
  ["media_expired", "done"],
  ["fatal", "fatal"],
]);

/** Status codes a bot carries before it is dispatched. */
const PRE_JOIN_CODES: ReadonlySet<string> = new Set(["ready"]);

export function vendorView(bot: RecallBot): VendorView {
  const changes = (bot.status_changes ?? []).filter((c) => typeof c?.code === "string");
  const last = changes.at(-1) ?? null;
  const dispatched = changes.some((c) => !PRE_JOIN_CODES.has(c.code));
  const lastEnded = [...changes].reverse().find((c) => ENDED_CODES.has(c.code)) ?? null;
  const recordingIds = (bot.recordings ?? []).map((r) => r?.id).filter(isRecallId);
  const base = {
    code: last?.code ?? null,
    subCode: last?.sub_code ?? null,
    at: last?.created_at ?? null,
    dispatched,
    recordingIds,
  };
  if (!dispatched) return { ...base, phase: "scheduled", status: "scheduled" };
  if (lastEnded) {
    return { ...base, phase: "ended", status: ENDED_CODES.get(lastEnded.code) ?? null };
  }
  const inProgress = last ? IN_PROGRESS_CODES.get(last.code) : undefined;
  if (inProgress) return { ...base, phase: "in_progress", status: inProgress };
  return { ...base, phase: "unknown", status: null };
}

/* ── the plan ─────────────────────────────────────────────────── */

export type SyncPlan = {
  /** Live rows that are no longer wanted: mark superseded. */
  retire: FinalBotRow[];
  /** A live row is wanted and none exists. */
  insertLive: boolean;
  /** The live row whose vendor bot should exist. */
  ensure: { row: FinalBotRow; createAllowed: boolean } | null;
  /** A patch to the live row that needs no vendor call. */
  markLive: { row: FinalBotRow; patch: Partial<FinalBotRow> } | null;
  /** Retired rows whose vendor bot may still be scheduled or in a call. */
  cleanup: FinalBotRow[];
  /** Retired rows that never reached Recall: close them. */
  closeRetired: FinalBotRow[];
};

export function isEligible(state: SyncState): boolean {
  const { booking, finalInterview } = state;
  return Boolean(
    booking &&
      booking.purpose === "final" &&
      booking.status === "booked" &&
      desiredJoinAtMs(booking.scheduled_start) !== null &&
      finalInterview?.status === "active",
  );
}

/**
 * What must change for the booking's bots to match the booking. Pure.
 *
 * One live row (superseded_at null) per booking, existing exactly when the
 * booking is an active final round that is booked; its join time is the
 * booking's start less the lead. Everything else is retired. A retired row
 * that may have a vendor bot is cleaned up; one that never did is closed.
 */
export function planSync(state: SyncState, enabled: boolean): SyncPlan {
  const plan: SyncPlan = {
    retire: [],
    insertLive: false,
    ensure: null,
    markLive: null,
    cleanup: [],
    closeRetired: [],
  };
  const { booking, rows } = state;
  if (!booking) return plan;

  const eligible = isEligible(state);
  const desired = desiredJoinAtMs(booking.scheduled_start);
  const live = rows.find((r) => r.superseded_at === null) ?? null;

  if (live) {
    if (!eligible) {
      plan.retire.push(live);
    } else if (Date.parse(live.join_at) !== desired) {
      plan.retire.push(live);
      plan.insertLive = enabled;
    } else if (live.status === "pending" && !live.provider_bot_id) {
      const attempted = CREATE_ATTEMPTED.has(live.last_event_code ?? "");
      if (!booking.meeting_url && !attempted) {
        if (live.last_event_code !== BOT_EVENT.noMeetingUrl) {
          plan.markLive = {
            row: live,
            patch: { status: "fatal", last_event_code: BOT_EVENT.noMeetingUrl },
          };
        }
      } else if (enabled || attempted) {
        plan.ensure = { row: live, createAllowed: enabled && Boolean(booking.meeting_url) };
      } else if (live.last_event_code !== BOT_EVENT.disabled) {
        plan.markLive = { row: live, patch: { last_event_code: BOT_EVENT.disabled } };
      }
    }
  } else if (eligible && enabled) {
    plan.insertLive = true;
  }

  for (const row of rows) {
    if (row.superseded_at === null) continue;
    if (row.provider_bot_id) {
      if (VENDOR_ACTIVE.has(row.status)) plan.cleanup.push(row);
    } else if (row.status === "pending") {
      if (CREATE_ATTEMPTED.has(row.last_event_code ?? "")) plan.cleanup.push(row);
      else plan.closeRetired.push(row);
    }
  }
  return plan;
}

function planIsEmpty(plan: SyncPlan): boolean {
  return (
    plan.retire.length === 0 &&
    !plan.insertLive &&
    !plan.ensure &&
    !plan.markLive &&
    plan.cleanup.length === 0 &&
    plan.closeRetired.length === 0
  );
}

/* ── database helpers ─────────────────────────────────────────── */

function dbError(what: string, error: { code?: string } | null | undefined): Error {
  // The code only: a PostgREST message can quote row values.
  return new Error(`${what} failed (${error?.code ?? "db"})`);
}

async function loadState(
  service: Service,
  bookingId: string,
  companyId: string | null,
): Promise<SyncState> {
  const { data: booking, error } = await service
    .from("interview_bookings")
    .select(BOOKING_COLUMNS)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw dbError("booking read", error);
  if (!booking) return { booking: null, finalInterview: null, rows: [] };
  const b = booking as BookingSnapshot;
  if (companyId && b.company_id !== companyId) {
    throw new TerminalJobError("deterministic", "the booking does not belong to the job's company");
  }

  const [fiRes, rowsRes] = await Promise.all([
    b.final_interview_id
      ? service
          .from("final_interviews")
          .select("id, company_id, job_id, application_id, status")
          .eq("id", b.final_interview_id)
          .eq("company_id", b.company_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service
      .from("final_interview_bots")
      .select(BOT_COLUMNS)
      .eq("booking_id", b.id)
      .eq("company_id", b.company_id)
      .order("created_at", { ascending: true }),
  ]);
  if (fiRes.error) throw dbError("final interview read", fiRes.error);
  if (rowsRes.error) throw dbError("bot rows read", rowsRes.error);
  return {
    booking: b,
    finalInterview: (fiRes.data as FinalInterviewSnapshot | null) ?? null,
    rows: (rowsRes.data ?? []) as FinalBotRow[],
  };
}

type UpdateQuery = ReturnType<ReturnType<Service["from"]>["update"]>;
type Guard = (query: UpdateQuery) => UpdateQuery;

/**
 * A conditional update of one bot row. The guard is the stale check: the row
 * is changed only if it still looks the way the caller last read it. True
 * when a row was changed.
 */
async function patchRow(
  deps: Pick<BotDeps, "service" | "now">,
  row: Pick<FinalBotRow, "id" | "company_id">,
  patch: Partial<FinalBotRow>,
  guard: Guard,
): Promise<boolean> {
  const query = deps.service
    .from("final_interview_bots")
    .update({ ...patch, updated_at: new Date(deps.now()).toISOString() })
    .eq("id", row.id)
    .eq("company_id", row.company_id);
  const { data, error } = await guard(query).select("id");
  if (error) throw dbError("bot row update", error);
  return ((data ?? []) as unknown[]).length > 0;
}

const pendingUnsaved: Guard = (q) =>
  q.eq("status", "pending").is("provider_bot_id", null).is("superseded_at", null);

async function insertLiveRow(
  deps: Pick<BotDeps, "service">,
  booking: Pick<BookingSnapshot, "id" | "company_id" | "scheduled_start">,
  finalInterview: FinalInterviewSnapshot,
): Promise<FinalBotRow | null> {
  const joinAt = desiredJoinAtMs(booking.scheduled_start);
  if (joinAt === null) return null;
  const { data, error } = await deps.service
    .from("final_interview_bots")
    .insert({
      final_interview_id: finalInterview.id,
      company_id: booking.company_id,
      job_id: finalInterview.job_id,
      application_id: finalInterview.application_id,
      booking_id: booking.id,
      provider: "recall",
      join_at: new Date(joinAt).toISOString(),
      status: "pending",
    })
    .select(BOT_COLUMNS)
    .single();
  if (error) {
    // One live row per booking (migration 040): somebody else wrote it first.
    if (error.code === "23505") return null;
    throw dbError("bot row insert", error);
  }
  return data as FinalBotRow;
}

/* ── talking to Recall ────────────────────────────────────────── */

function callOptions(deps: BotDeps, label: string): { signal?: AbortSignal; timeoutMs: number } {
  assertProviderBudget(deps.ctx, MIN_CALL_BUDGET_MS, label);
  if (!deps.ctx) return { timeoutMs: CALL_TIMEOUT_CAP_MS };
  return {
    signal: deps.ctx.signal,
    timeoutMs: Math.max(1_000, Math.min(CALL_TIMEOUT_CAP_MS, deps.ctx.remainingMs() - 3_000)),
  };
}

function recallStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === "number" ? s : null;
  }
  return null;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof RecallApiError) return err.retryable;
  // Not from Recall (a database read, say): let the queue retry it.
  return !(err instanceof TerminalJobError);
}

/**
 * What a handler rethrows. A Recall refusal raised before any request (no
 * key, no base URL, a malformed id) is terminal; everything else goes through
 * the shared classification.
 */
export function toBotJobError(err: unknown): unknown {
  if (err instanceof JobYield || err instanceof TerminalJobError) return err;
  if (err instanceof RecallApiError && err.status === null && !err.retryable) {
    const config = /not set|not configured/.test(err.message);
    return new TerminalJobError(config ? "configuration" : "deterministic", err.message, {
      cause: err,
    });
  }
  return toJobError(err);
}

/** Recall bots carrying this row's id in their metadata, ownership double-checked. */
async function findVendorBotsForRow(deps: BotDeps, row: FinalBotRow): Promise<RecallBot[]> {
  const { bots } = await deps.recall.listBots(
    { metadata: { integration: RECORDING_BOT_INTEGRATION, botRowId: row.id }, maxPages: 1 },
    callOptions(deps, "list bots"),
  );
  return bots.filter(
    (b) => b.metadata?.integration === RECORDING_BOT_INTEGRATION && b.metadata?.botRowId === row.id,
  );
}

function ownsRow(bot: RecallBot, row: FinalBotRow): boolean {
  return (
    bot.metadata?.companyId === row.company_id &&
    bot.metadata?.finalInterviewId === row.final_interview_id
  );
}

/** Write what Recall reports for this row's bot. Never writes 'deleted'. */
async function recordVendorState(
  deps: BotDeps,
  row: FinalBotRow,
  botId: string,
  view: VendorView,
  eventOverride?: string,
): Promise<void> {
  const patch: Partial<FinalBotRow> = {
    last_event_code: eventOverride ?? view.code ?? BOT_EVENT.scheduled,
    last_event_sub_code: view.subCode,
    last_event_at: view.at ?? new Date(deps.now()).toISOString(),
  };
  if (view.status) patch.status = view.status;
  await patchRow(deps, row, patch, (q) => q.eq("provider_bot_id", botId));
}

/** Recall confirmed the bot is gone and never joined: the one way to reach 'deleted'. */
async function markVendorGone(
  deps: BotDeps,
  row: FinalBotRow,
  botId: string,
  event: string,
): Promise<void> {
  await patchRow(
    deps,
    row,
    {
      status: "deleted",
      last_event_code: event,
      last_event_sub_code: null,
      last_event_at: new Date(deps.now()).toISOString(),
    },
    (q) => q.eq("provider_bot_id", botId),
  );
}

/**
 * Remove a bot Remotiv no longer wants, keeping anything it recorded.
 *
 *   scheduled, never joined  -> Delete Scheduled Bot; the row becomes 'deleted'
 *   405 on that delete       -> it was dispatched meanwhile: look again
 *   joining or in the call   -> Remove Bot From Call; media kept for the import
 *   ended, or unknown        -> nothing; media kept, Recall's state recorded
 *
 * Delete Bot Media and Delete Recording are never called here.
 */
async function retireVendorBot(
  deps: BotDeps,
  row: FinalBotRow,
  initial: RecallBot | null,
  botId: string,
  summary: SyncSummary,
): Promise<void> {
  if (!initial) {
    await markVendorGone(deps, row, botId, BOT_EVENT.vendorNotFound);
    summary.deleted += 1;
    return;
  }
  let view = vendorView(initial);

  if (view.phase === "scheduled") {
    const outcome = await deps.recall.deleteScheduledBot(botId, callOptions(deps, "delete bot"));
    if (outcome !== "not_allowed") {
      await markVendorGone(deps, row, botId, BOT_EVENT.scheduledDeleted);
      summary.deleted += 1;
      return;
    }
    const again = await deps.recall.retrieveBot(botId, callOptions(deps, "retrieve bot"));
    if (!again) {
      await markVendorGone(deps, row, botId, BOT_EVENT.vendorNotFound);
      summary.deleted += 1;
      return;
    }
    view = vendorView(again);
    if (view.phase === "scheduled") {
      await recordVendorState(deps, row, botId, view);
      // No status on purpose: the queue classifies a bare error as retryable,
      // where a 405 would be buried as deterministic.
      throw new Error("Recall refused to delete a bot it still reports as scheduled; retrying");
    }
  }

  if (view.phase === "in_progress") {
    const left = await deps.recall.leaveCall(botId, callOptions(deps, "leave call"));
    const after =
      left.outcome === "left"
        ? left.bot
        : await deps.recall.retrieveBot(botId, callOptions(deps, "retrieve bot"));
    const afterView = after ? vendorView(after) : view;
    await recordVendorState(
      deps,
      row,
      botId,
      afterView,
      afterView.phase === "in_progress" ? BOT_EVENT.leaveRequested : undefined,
    );
    summary.left += 1;
    return;
  }

  await recordVendorState(deps, row, botId, view);
  summary.preserved += 1;
}

/** A bot nothing points at any more, freshly created: remove it if it has not joined. */
async function removeIfStillScheduled(deps: BotDeps, bot: RecallBot): Promise<boolean> {
  if (vendorView(bot).phase !== "scheduled") return false;
  const outcome = await deps.recall.deleteScheduledBot(bot.id, callOptions(deps, "delete bot"));
  return outcome !== "not_allowed";
}

/* ── the sync ─────────────────────────────────────────────────── */

export type SyncSummary = {
  outcome: "in_sync" | "booking_missing";
  rounds: number;
  created: number;
  adopted: number;
  retired: number;
  deleted: number;
  left: number;
  preserved: number;
};

/** Persist a bot just created for this row, or compensate if the row moved on. */
async function persistCreated(
  deps: BotDeps,
  row: FinalBotRow,
  bot: RecallBot,
  summary: SyncSummary,
): Promise<void> {
  const view = vendorView(bot);
  // Guarded on the id still being unsaved only: a row superseded while the
  // call was out still records its bot, so the cleanup can find it.
  const applied = await patchRow(
    deps,
    row,
    {
      provider_bot_id: bot.id,
      status: view.status ?? "scheduled",
      last_event_code: BOT_EVENT.scheduled,
      last_event_sub_code: null,
      last_event_at: new Date(deps.now()).toISOString(),
    },
    (q) => q.is("provider_bot_id", null),
  );
  if (applied) {
    summary.created += 1;
    return;
  }
  const { data: current, error } = await deps.service
    .from("final_interview_bots")
    .select("id, provider_bot_id")
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .maybeSingle();
  if (error) throw dbError("bot row re-read", error);
  if ((current as { provider_bot_id: string | null } | null)?.provider_bot_id === bot.id) {
    summary.created += 1;
    return;
  }
  // The row is gone, or holds another bot. Nothing will ever point at this one.
  const removed = await removeIfStillScheduled(deps, bot);
  console.warn(
    `[final-bot] row ${row.id} moved on during create; new bot ${removed ? "removed" : "left for reconciliation"}`,
  );
}

/** Adopt a bot Recall already has for this row, and remove any scheduled duplicate. */
async function adoptVendorBots(
  deps: BotDeps,
  row: FinalBotRow,
  found: RecallBot[],
  summary: SyncSummary,
): Promise<void> {
  const owned = found.filter((b) => ownsRow(b, row));
  if (owned.length !== found.length) {
    // Metadata names this row but disagrees about whose it is. Touch nothing.
    const marked = await patchRow(
      deps,
      row,
      {
        status: "fatal",
        last_event_code: BOT_EVENT.metadataMismatch,
        last_event_at: new Date(deps.now()).toISOString(),
      },
      pendingUnsaved,
    );
    console.error(`[final-bot] row ${row.id}: Recall metadata disagrees with the row; not adopted`);
    if (marked) await queueFailureAlert(deps, row);
    return;
  }
  const canonical = owned.find((b) => vendorView(b).dispatched) ?? owned[0];
  if (!canonical) return;
  const view = vendorView(canonical);
  const applied = await patchRow(
    deps,
    row,
    {
      provider_bot_id: canonical.id,
      status: view.status ?? "scheduled",
      last_event_code: BOT_EVENT.adopted,
      last_event_sub_code: null,
      last_event_at: new Date(deps.now()).toISOString(),
    },
    (q) => q.is("provider_bot_id", null),
  );
  if (applied) summary.adopted += 1;
  for (const extra of owned) {
    if (extra.id === canonical.id) continue;
    // A duplicate that joined may hold media: left for the import and Recall's retention.
    const removed = await removeIfStillScheduled(deps, extra);
    console.warn(`[final-bot] row ${row.id}: duplicate bot ${removed ? "removed" : "kept"}`);
  }
}

/**
 * Make the live row's vendor bot exist. Looks Recall up by the row id before
 * creating, and creates with a per-row idempotency key, so neither a lost
 * response nor a failed save can produce a second bot.
 */
async function ensureLive(
  deps: BotDeps,
  row: FinalBotRow,
  meetingUrl: string | null,
  createAllowed: boolean,
  summary: SyncSummary,
): Promise<"done" | "stale"> {
  const nowIso = () => new Date(deps.now()).toISOString();
  const tooLate = Date.parse(row.join_at) - deps.now() < RECORDING_BOT_MIN_SCHEDULE_LEAD_MS;
  const attempted = CREATE_ATTEMPTED.has(row.last_event_code ?? "");
  const markTooLate = async () => {
    const marked = await patchRow(
      deps,
      row,
      { status: "fatal", last_event_code: BOT_EVENT.tooLate, last_event_at: nowIso() },
      pendingUnsaved,
    );
    if (marked) await queueFailureAlert(deps, row);
    return marked;
  };

  // Never attempted, so nothing can exist at Recall: no lookup needed.
  if (tooLate && !attempted) return (await markTooLate()) ? "done" : "stale";

  if (createAllowed) {
    const claimed = await patchRow(
      deps,
      row,
      { last_event_code: BOT_EVENT.createRequested, last_event_at: nowIso() },
      pendingUnsaved,
    );
    if (!claimed) return "stale";
  }

  const found = await findVendorBotsForRow(deps, row);
  if (found.length > 0) {
    await adoptVendorBots(deps, row, found, summary);
    return "done";
  }
  if (!createAllowed) {
    await patchRow(
      deps,
      row,
      { last_event_code: BOT_EVENT.disabled, last_event_at: nowIso() },
      pendingUnsaved,
    );
    return "done";
  }
  if (tooLate) return (await markTooLate()) ? "done" : "stale";
  // planSync allows a create only with a meeting URL; this is the type guard.
  if (!meetingUrl) return "done";

  let bot: RecallBot;
  try {
    bot = await deps.recall.createBot(buildCreateBotRequest(row, meetingUrl), {
      ...callOptions(deps, "create bot"),
      idempotencyKey: idempotencyKeyFor(row.id),
    });
  } catch (err) {
    if (err instanceof JobYield) throw err;
    const status = recallStatus(err);
    if (isRetryableError(err)) {
      // 429, 409 and 507 were refused outright; a timeout or a 5xx may have
      // created the bot. Either way the next attempt looks Recall up first.
      const refused = status === 429 || status === 409 || status === 507;
      await patchRow(
        deps,
        row,
        {
          last_event_code: refused ? BOT_EVENT.createRetry : BOT_EVENT.createAmbiguous,
          last_event_sub_code: status ? `http_${status}` : "network",
          last_event_at: nowIso(),
        },
        pendingUnsaved,
      ).catch(() => false);
      throw err;
    }
    const jobErr = toBotJobError(err);
    const failureClass = jobErr instanceof TerminalJobError ? jobErr.failureClass : "deterministic";
    const marked = await patchRow(
      deps,
      row,
      {
        status: "fatal",
        last_event_code: BOT_EVENT.createFailed,
        last_event_sub_code: status ? `${failureClass}_${status}` : failureClass,
        last_event_at: nowIso(),
      },
      pendingUnsaved,
    );
    console.error(`[final-bot] row ${row.id}: Recall refused the bot (${failureClass})`);
    // Before any rethrow: the host must hear about it whatever the class.
    if (marked) await queueFailureAlert(deps, row);
    // A bad key or an empty balance fails every booking: bury the job so it is seen.
    if (failureClass === "configuration" || failureClass === "billing") throw jobErr;
    return "done";
  }

  await persistCreated(deps, row, bot, summary);
  return "done";
}

/** A retired row: find its vendor bot (by saved id, or by metadata) and retire it. */
async function cleanupRetired(deps: BotDeps, row: FinalBotRow, summary: SyncSummary) {
  if (row.provider_bot_id) {
    const bot = await deps.recall.retrieveBot(
      row.provider_bot_id,
      callOptions(deps, "retrieve bot"),
    );
    await retireVendorBot(deps, row, bot, row.provider_bot_id, summary);
    return;
  }
  const found = (await findVendorBotsForRow(deps, row)).filter((b) => ownsRow(b, row));
  if (found.length === 0) {
    await closeNeverScheduled(deps, row);
    return;
  }
  const [first, ...rest] = found;
  if (!first) return;
  const view = vendorView(first);
  const saved = await patchRow(
    deps,
    row,
    {
      provider_bot_id: first.id,
      status: view.status ?? "scheduled",
      last_event_code: BOT_EVENT.adopted,
      last_event_at: new Date(deps.now()).toISOString(),
    },
    (q) => q.is("provider_bot_id", null),
  );
  if (saved) {
    summary.adopted += 1;
    await retireVendorBot(deps, { ...row, provider_bot_id: first.id }, first, first.id, summary);
  }
  for (const extra of rest) await removeIfStillScheduled(deps, extra);
}

async function closeNeverScheduled(deps: BotDeps, row: FinalBotRow): Promise<void> {
  await patchRow(
    deps,
    row,
    {
      status: "superseded",
      last_event_code: BOT_EVENT.supersededUnscheduled,
      last_event_at: new Date(deps.now()).toISOString(),
    },
    (q) => q.eq("status", "pending").is("provider_bot_id", null).not("superseded_at", "is", null),
  );
}

/**
 * Bring one booking's bots in line with the booking. Plan, act, re-read, up
 * to MAX_ROUNDS times; a booking still changing after that goes back on the
 * queue with backoff. Each retired row is cleaned at most once per run and
 * the live row ensured at most once, so a bot that is slow to leave a call
 * does not spin this loop.
 */
export async function syncBooking(
  deps: BotDeps,
  bookingId: string,
  companyId: string | null = null,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    outcome: "in_sync",
    rounds: 0,
    created: 0,
    adopted: 0,
    retired: 0,
    deleted: 0,
    left: 0,
    preserved: 0,
  };
  const cleaned = new Set<string>();
  const ensured = new Set<string>();

  const nextPlan = (state: SyncState): SyncPlan => {
    const plan = planSync(state, deps.enabled());
    plan.cleanup = plan.cleanup.filter((r) => !cleaned.has(r.id));
    if (plan.ensure && ensured.has(plan.ensure.row.id)) plan.ensure = null;
    return plan;
  };

  for (let round = 1; round <= MAX_ROUNDS + 1; round++) {
    const state = await loadState(deps.service, bookingId, companyId);
    if (!state.booking) {
      summary.outcome = "booking_missing";
      return summary;
    }
    const plan = nextPlan(state);
    if (planIsEmpty(plan)) return summary;
    if (round > MAX_ROUNDS) break;
    summary.rounds = round;

    const nowIso = new Date(deps.now()).toISOString();
    for (const row of plan.retire) {
      if (
        await patchRow(deps, row, { superseded_at: nowIso }, (q) => q.is("superseded_at", null))
      ) {
        summary.retired += 1;
      }
    }
    if (plan.markLive) {
      const marked = await patchRow(deps, plan.markLive.row, plan.markLive.patch, pendingUnsaved);
      // no_meeting_url is the only markLive that sets fatal.
      if (marked && plan.markLive.patch.status === "fatal") {
        await queueFailureAlert(deps, plan.markLive.row);
      }
    }
    for (const row of plan.cleanup) {
      cleaned.add(row.id);
      await cleanupRetired(deps, row, summary);
    }
    for (const row of plan.closeRetired) await closeNeverScheduled(deps, row);
    if (plan.insertLive && state.finalInterview && state.booking) {
      await insertLiveRow(deps, state.booking, state.finalInterview);
    }
    if (plan.ensure) {
      const result = await ensureLive(
        deps,
        plan.ensure.row,
        state.booking.meeting_url,
        plan.ensure.createAllowed,
        summary,
      );
      if (result === "done") ensured.add(plan.ensure.row.id);
    }
  }
  throw new Error("final_bot_sync: the booking kept changing during the run; retrying");
}

/* ── orphan delete: the privacy path ──────────────────────────── */

export type OrphanReport = {
  outcome: "gone" | "scheduled_deleted" | "media_deleted";
  recordings: number;
};

/**
 * Migration 040's trigger queues this when a bot row is deleted with its
 * applicant, interview, booking or company. Nothing in the database points
 * at the bot any more, so nothing it recorded can ever be imported: the bot
 * is removed and every recording Recall holds for it is deleted. Runs with
 * the flag off. A bot still in a call is asked to leave first; its media is
 * deleted once Recall reports it ended, on this run or a retry.
 */
export async function runOrphanDelete(
  deps: BotDeps,
  payload: Record<string, unknown>,
): Promise<OrphanReport> {
  const botId = payload.providerBotId;
  if (!isRecallId(botId)) {
    throw new TerminalJobError("deterministic", "orphan delete payload has no valid providerBotId");
  }
  const recordingId = isRecallId(payload.providerRecordingId) ? payload.providerRecordingId : null;
  const deleteMedia = async (ids: string[]) => {
    const unique = [...new Set(ids.filter(isRecallId))];
    for (const id of unique) {
      await deps.recall.deleteRecording(id, callOptions(deps, "delete recording"));
    }
    return unique.length;
  };

  let bot = await deps.recall.retrieveBot(botId, callOptions(deps, "retrieve bot"));
  if (!bot) {
    return { outcome: "gone", recordings: await deleteMedia(recordingId ? [recordingId] : []) };
  }
  let view = vendorView(bot);

  if (view.phase === "scheduled") {
    const outcome = await deps.recall.deleteScheduledBot(botId, callOptions(deps, "delete bot"));
    if (outcome !== "not_allowed") {
      return {
        outcome: "scheduled_deleted",
        recordings: await deleteMedia(recordingId ? [recordingId] : []),
      };
    }
    bot = await deps.recall.retrieveBot(botId, callOptions(deps, "retrieve bot"));
    if (!bot) {
      return { outcome: "gone", recordings: await deleteMedia(recordingId ? [recordingId] : []) };
    }
    view = vendorView(bot);
  }

  if (view.phase === "in_progress" || view.phase === "unknown") {
    await deps.recall.leaveCall(botId, callOptions(deps, "leave call"));
    for (let i = 0; i < ORPHAN_LEAVE_POLLS && view.phase !== "ended"; i++) {
      await deps.sleep(ORPHAN_POLL_MS);
      bot = await deps.recall.retrieveBot(botId, callOptions(deps, "retrieve bot"));
      if (!bot) {
        return { outcome: "gone", recordings: await deleteMedia(recordingId ? [recordingId] : []) };
      }
      view = vendorView(bot);
    }
  }
  if (view.phase !== "ended") {
    throw new Error("orphan delete: the bot has not left its call yet; media is deleted on retry");
  }
  const recordings = await deleteMedia([
    ...view.recordingIds,
    ...(recordingId ? [recordingId] : []),
  ]);
  return { outcome: "media_deleted", recordings };
}

/* ── reconcile: the backstop ──────────────────────────────────── */

export type ReconcileReport = {
  requeued: number;
  pendingRows: number;
  missingRows: number;
  staleLiveRows: number;
  retiredActive: number;
  vendorSeen: number;
  vendorAdopted: number;
  vendorRemovedScheduled: number;
  reportedUnidentified: number;
  reportedMismatch: number;
  reportedUnownedDispatched: number;
  reportedDuplicateDispatched: number;
  /** Lobby checks queued for bots whose webhook-time enqueue never happened. */
  lobbyChecksQueued: number;
  /** Failure alerts queued for fatal bots that have had none sent. */
  failureAlertsQueued: number;
  /** Fatal bots with no alert sent whose failure-alert jobs are used up. */
  failureAlertsCapped: number;
  /** Recording step 4: imports queued for recordings whose job never ran or ended unfinished. */
  importsQueued: number;
  /** Imports marked failed because every import job was used up. */
  importsFailed: number;
  /** Ready copies whose Recall delete is retried past the import cap. */
  importDeleteRetries: number;
  /** Import-failed alerts queued by the reconcile. */
  importAlertsQueued: number;
  vendorTruncated: boolean;
  vendorError: boolean;
};

async function enqueueSync(
  deps: Pick<HookDeps, "enqueue">,
  booking: { id: string; company_id: string },
  botRowId: string | null,
): Promise<"queued" | "already_queued" | "enqueue_failed"> {
  const result = await deps.enqueue({
    type: FINAL_BOT_SYNC_JOB,
    companyId: booking.company_id,
    payload: { action: "sync", bookingId: booking.id, ...(botRowId ? { botRowId } : {}) },
    maxAttempts: SYNC_MAX_ATTEMPTS,
  });
  if (result.ok) return "queued";
  // Migration 040 allows one queued-or-running sync per booking: one exists.
  if (result.code === "23505") return "already_queued";
  return "enqueue_failed";
}

/**
 * Find what the hooks and the sync jobs missed, and queue a sync for it. The
 * database pass needs no Recall call; the vendor pass reads Remotiv's own
 * bots (metadata.integration) and adopts or removes only those, and only
 * ever deletes a bot that is still scheduled.
 *
 * Runs every RECONCILE_INTERVAL_MS while the flag is on, and while it is off
 * for as long as any bot may still be scheduled or in a call, or any import
 * is unfinished.
 */
export async function reconcileFinalBots(deps: BotDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    requeued: 0,
    pendingRows: 0,
    missingRows: 0,
    staleLiveRows: 0,
    retiredActive: 0,
    vendorSeen: 0,
    vendorAdopted: 0,
    vendorRemovedScheduled: 0,
    reportedUnidentified: 0,
    reportedMismatch: 0,
    reportedUnownedDispatched: 0,
    reportedDuplicateDispatched: 0,
    lobbyChecksQueued: 0,
    failureAlertsQueued: 0,
    failureAlertsCapped: 0,
    importsQueued: 0,
    importsFailed: 0,
    importDeleteRetries: 0,
    importAlertsQueued: 0,
    vendorTruncated: false,
    vendorError: false,
  };
  const now = deps.now();
  const settleIso = new Date(now - RECONCILE_SETTLE_MS).toISOString();
  const lookbackIso = new Date(now - RECONCILE_LOOKBACK_MS).toISOString();
  const enabled = deps.enabled();
  const toSync = new Map<string, string>(); // booking id -> company id

  const read = async <T>(what: string, query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw dbError(what, error as { code?: string });
    return (data ?? []) as T[];
  };

  if (enabled) {
    // Pending live rows whose job never ran or died.
    const pending = await read<{ booking_id: string; company_id: string }>(
      "pending rows",
      deps.service
        .from("final_interview_bots")
        .select("booking_id, company_id")
        .eq("status", "pending")
        .is("superseded_at", null)
        .is("provider_bot_id", null)
        .gt("join_at", lookbackIso)
        .lt("updated_at", settleIso)
        .order("join_at", { ascending: true })
        .limit(RECONCILE_BATCH),
    );
    for (const r of pending) toSync.set(r.booking_id, r.company_id);
    report.pendingRows = pending.length;

    // Booked final rounds with no live row at all: the hook's insert failed.
    const minStart = new Date(
      now + RECORDING_BOT_JOIN_LEAD_MS + RECORDING_BOT_MIN_SCHEDULE_LEAD_MS,
    ).toISOString();
    const booked = await read<{ id: string; company_id: string }>(
      "booked final rounds",
      deps.service
        .from("interview_bookings")
        .select("id, company_id")
        .eq("purpose", "final")
        .eq("status", "booked")
        .gt("scheduled_start", minStart)
        .lt("booked_at", settleIso)
        .order("scheduled_start", { ascending: true })
        .limit(RECONCILE_BATCH),
    );
    if (booked.length > 0) {
      const live = await read<{ booking_id: string }>(
        "live rows",
        deps.service
          .from("final_interview_bots")
          .select("booking_id")
          .in(
            "booking_id",
            booked.map((b) => b.id),
          )
          .is("superseded_at", null),
      );
      const hasLive = new Set(live.map((l) => l.booking_id));
      for (const b of booked) {
        if (hasLive.has(b.id)) continue;
        toSync.set(b.id, b.company_id);
        report.missingRows += 1;
      }
    }
  }

  // Live rows whose booking was cancelled or moved while a job was running.
  const liveRows = await read<{
    booking_id: string;
    company_id: string;
    join_at: string;
  }>(
    "live rows",
    deps.service
      .from("final_interview_bots")
      .select("booking_id, company_id, join_at")
      .is("superseded_at", null)
      .in("status", [...VENDOR_ACTIVE])
      .gt("join_at", lookbackIso)
      .lt("updated_at", settleIso)
      .order("join_at", { ascending: true })
      .limit(RECONCILE_BATCH),
  );
  if (liveRows.length > 0) {
    const bookings = await read<{ id: string; status: string; scheduled_start: string | null }>(
      "bookings of live rows",
      deps.service
        .from("interview_bookings")
        .select("id, status, scheduled_start")
        .in(
          "id",
          liveRows.map((r) => r.booking_id),
        ),
    );
    const byId = new Map(bookings.map((b) => [b.id, b]));
    for (const r of liveRows) {
      const b = byId.get(r.booking_id);
      const stale =
        b?.status !== "booked" || Date.parse(r.join_at) !== desiredJoinAtMs(b.scheduled_start);
      if (!stale) continue;
      toSync.set(r.booking_id, r.company_id);
      report.staleLiveRows += 1;
    }
  }

  // Retired rows whose bot may still be scheduled or in a call.
  const retired = await read<{ booking_id: string; company_id: string }>(
    "retired active rows",
    deps.service
      .from("final_interview_bots")
      .select("booking_id, company_id")
      .not("superseded_at", "is", null)
      .not("provider_bot_id", "is", null)
      .in("status", ["scheduled", "waiting_room", "in_call", "recording"])
      .gt("join_at", lookbackIso)
      .lt("updated_at", settleIso)
      .limit(RECONCILE_BATCH),
  );
  const retiredUnsaved = await read<{ booking_id: string; company_id: string }>(
    "retired unsaved rows",
    deps.service
      .from("final_interview_bots")
      .select("booking_id, company_id")
      .not("superseded_at", "is", null)
      .is("provider_bot_id", null)
      .eq("status", "pending")
      .in("last_event_code", [...CREATE_ATTEMPTED])
      .gt("join_at", lookbackIso)
      .lt("updated_at", settleIso)
      .limit(RECONCILE_BATCH),
  );
  for (const r of [...retired, ...retiredUnsaved]) toSync.set(r.booking_id, r.company_id);
  report.retiredActive = retired.length + retiredUnsaved.length;

  for (const [bookingId, companyId] of toSync) {
    const outcome = await enqueueSync(deps, { id: bookingId, company_id: companyId }, null);
    if (outcome === "queued") report.requeued += 1;
  }

  // Bots waiting in the lobby for two minutes or more with no alert and no
  // check queued: the webhook's enqueue was lost, or the status came from an
  // adoption rather than a webhook. Runs with the flag off.
  const waiting = await read<{ id: string; company_id: string }>(
    "waiting bots",
    deps.service
      .from("final_interview_bots")
      .select("id, company_id")
      .eq("status", "waiting_room")
      .is("superseded_at", null)
      .is("lobby_alert_sent_at", null)
      .lt("last_event_at", new Date(now - RECORDING_LOBBY_ALERT_DELAY_MS).toISOString())
      .gt("join_at", lookbackIso)
      .limit(RECONCILE_BATCH),
  );
  for (const row of waiting) {
    if ((await ensureAlertJob(deps, row, "lobby", now)) === "queued") report.lobbyChecksQueued += 1;
  }

  // Live fatal bots whose host has not been told: a schedule-time or webhook
  // enqueue that was lost, or an alert that ended without delivering. Bounded
  // by the per-row cap in ensureAlertJob, so a host who can never be verified
  // costs at most three jobs, ever. Runs with the flag off.
  const fatal = await read<{ id: string; company_id: string }>(
    "fatal bots",
    deps.service
      .from("final_interview_bots")
      .select("id, company_id")
      .eq("status", "fatal")
      .is("superseded_at", null)
      .is("failure_alert_sent_at", null)
      .gt("join_at", lookbackIso)
      .limit(RECONCILE_BATCH),
  );
  for (const row of fatal) {
    const outcome = await ensureAlertJob(deps, row, "failure", now);
    if (outcome === "queued") report.failureAlertsQueued += 1;
    if (outcome === "capped") report.failureAlertsCapped += 1;
  }

  // Recording step 4. Recordings whose import was never queued, or whose job
  // ended before the copy was safe and Recall's deleted. Spaced and capped in
  // ensureImportJob. Runs with the flag off: an existing recording is
  // protected whatever the flag says.
  const imports = await read<{
    id: string;
    company_id: string;
    provider_recording_id: string;
    import_status: string;
  }>(
    "unfinished imports",
    deps.service
      .from("final_interview_bots")
      .select("id, company_id, provider_recording_id, import_status")
      .not("provider_recording_id", "is", null)
      .in("import_status", ["none", "queued", "importing"])
      .lt("updated_at", settleIso)
      .order("updated_at", { ascending: true })
      .limit(RECONCILE_BATCH),
  );
  for (const row of imports) {
    if (row.import_status === "none") {
      await patchRow(deps, row, { import_status: "queued" }, (q) => q.eq("import_status", "none"));
    }
    const outcome = await ensureImportJob(deps, row, { spaced: true });
    if (outcome === "queued") report.importsQueued += 1;
    if (outcome === "capped") await settleCappedImport(deps, row, report);
  }

  // Failed imports from the last day whose host alert was never queued. The
  // alert job's fixed id makes a repeat a no-op; the day bounds this far
  // inside the 30 days queue-sweep keeps that id taken.
  const failedImports = await read<{ id: string; company_id: string }>(
    "failed imports",
    deps.service
      .from("final_interview_bots")
      .select("id, company_id")
      .eq("import_status", "failed")
      .not("import_error", "in", `(${[...RECORDING_IMPORT_SILENT_ERRORS].join(",")})`)
      .gt("updated_at", new Date(now - IMPORT_ALERT_BACKSTOP_MS).toISOString())
      .limit(RECONCILE_BATCH),
  );
  for (const row of failedImports) {
    if ((await ensureImportFailedAlert(deps, row)) === "queued") report.importAlertsQueued += 1;
  }

  try {
    await reconcileVendor(deps, report, toSync);
  } catch (err) {
    if (!(err instanceof JobYield)) {
      report.vendorError = true;
      console.error(
        `[final-bot] reconcile vendor pass stopped: ${err instanceof Error ? err.message : "error"}`,
      );
    } else {
      report.vendorTruncated = true;
    }
  }
  return report;
}

async function reconcileVendor(
  deps: BotDeps,
  report: ReconcileReport,
  alreadyQueued: Map<string, string>,
): Promise<void> {
  const since = new Date(deps.now() - RECONCILE_LOOKBACK_MS).toISOString().slice(0, 10);
  const { bots, truncated } = await deps.recall.listBots(
    {
      metadata: { integration: RECORDING_BOT_INTEGRATION },
      joinAtAfter: since,
      maxPages: RECONCILE_VENDOR_PAGES,
    },
    callOptions(deps, "list bots"),
  );
  report.vendorTruncated = truncated;

  for (const bot of bots) {
    const meta = bot.metadata ?? {};
    // Recall filtered on this already; checked again because only this marker
    // makes a bot Remotiv's to touch.
    if (meta.integration !== RECORDING_BOT_INTEGRATION) continue;
    report.vendorSeen += 1;
    const rowId = meta.botRowId;
    if (!isRecallId(rowId) || !isRecallId(bot.id)) {
      report.reportedUnidentified += 1;
      continue;
    }
    const { data, error } = await deps.service
      .from("final_interview_bots")
      .select(BOT_COLUMNS)
      .eq("id", rowId)
      .maybeSingle();
    if (error) throw dbError("bot row read", error);
    const row = data as FinalBotRow | null;
    const view = vendorView(bot);

    if (!row) {
      // Nothing points at it. Scheduled is safe to remove; anything else may
      // hold media and is left to Recall's retention.
      if (view.phase === "scheduled") {
        if (await removeIfStillScheduled(deps, bot)) report.vendorRemovedScheduled += 1;
      } else {
        report.reportedUnownedDispatched += 1;
      }
      continue;
    }
    if (row.company_id !== meta.companyId || row.final_interview_id !== meta.finalInterviewId) {
      report.reportedMismatch += 1;
      continue;
    }
    if (!row.provider_bot_id) {
      const applied = await patchRow(
        deps,
        row,
        {
          provider_bot_id: bot.id,
          status: view.status ?? row.status,
          last_event_code: BOT_EVENT.adopted,
          last_event_at: new Date(deps.now()).toISOString(),
        },
        (q) => q.is("provider_bot_id", null),
      );
      if (applied) {
        report.vendorAdopted += 1;
        if (!alreadyQueued.has(row.booking_id)) {
          alreadyQueued.set(row.booking_id, row.company_id);
          if (
            (await enqueueSync(deps, { id: row.booking_id, company_id: row.company_id }, null)) ===
            "queued"
          ) {
            report.requeued += 1;
          }
        }
      }
      continue;
    }
    if (row.provider_bot_id !== bot.id) {
      if (view.phase === "scheduled") {
        if (await removeIfStillScheduled(deps, bot)) report.vendorRemovedScheduled += 1;
      } else {
        report.reportedDuplicateDispatched += 1;
      }
    }
  }
}

/**
 * Whether the reconcile job should be scheduled at all. With the flag on,
 * always. With it off, only while a bot from the last day may still be
 * scheduled or in a call, a recording is not yet copied (step 4), or an
 * import failed in the last day, so a deployment that never turned recording
 * on never queues one, and one that turned it off stops once the last import
 * is settled.
 */
export async function finalBotReconcileWanted(
  overrides: Partial<Pick<BotDeps, "service" | "enabled" | "now">> = {},
): Promise<boolean> {
  const enabled = overrides.enabled ?? (() => isRecallRecordingEnabled());
  if (enabled()) return true;
  const service = overrides.service ?? createServiceClient();
  const since = new Date((overrides.now ?? Date.now)() - RECONCILE_LOOKBACK_MS).toISOString();
  const [active, unsaved, imports, failedImports] = await Promise.all([
    service
      .from("final_interview_bots")
      .select("id")
      .in("status", ["scheduled", "waiting_room", "in_call", "recording"])
      .gt("join_at", since)
      .limit(1),
    service
      .from("final_interview_bots")
      .select("id")
      .eq("status", "pending")
      .in("last_event_code", [...CREATE_ATTEMPTED])
      .gt("join_at", since)
      .limit(1),
    // Recording step 4: a recording not yet copied, whatever its age.
    service
      .from("final_interview_bots")
      .select("id")
      .not("provider_recording_id", "is", null)
      .in("import_status", ["none", "queued", "importing"])
      .limit(1),
    service
      .from("final_interview_bots")
      .select("id")
      .eq("import_status", "failed")
      .gt(
        "updated_at",
        new Date((overrides.now ?? Date.now)() - IMPORT_ALERT_BACKSTOP_MS).toISOString(),
      )
      .limit(1),
  ]);
  const results = [active, unsaved, imports, failedImports];
  if (results.some((r) => r.error)) return false;
  return results.some((r) => ((r.data ?? []) as unknown[]).length > 0);
}

/* ── host alert jobs ──────────────────────────────────────────── */

// Migration 040 has no unique index for alert jobs: a derived primary key refuses the second.
export { deterministicUuid };

/** The fixed job ids a bot row's failure alerts may use: there are only RECORDING_FAILURE_ALERT_MAX_JOBS. */
export function failureAlertJobIds(botRowId: string): string[] {
  return Array.from({ length: RECORDING_FAILURE_ALERT_MAX_JOBS }, (_, i) =>
    deterministicUuid(`final-bot-alert:${botRowId}:failure:${i + 1}`),
  );
}

/**
 * Queue a host alert check unless one is already queued or running for this
 * bot and kind; the alert's own conditional claim makes any that slip through
 * harmless.
 *
 * Failure alerts are also capped at RECORDING_FAILURE_ALERT_MAX_JOBS jobs per
 * bot row, ever, counting every status. The cap is the primary key: each job
 * takes one of the row's fixed ids, so concurrent callers race on the insert
 * and the database refuses the loser. A caller counts what it saw, and every
 * refusal it meets, against the cap, so even a stale read cannot take an id
 * past it. Jobs queued before step 3b (random ids) count too. Succeeded jobs
 * are deleted after 30 days (queue-sweep) and failed or dead ones never are;
 * a row stops being eligible for alerts about a day after its join time, at
 * most 15 days out, so within its eligible life no id is ever freed.
 *
 * "failed" means nothing could be confirmed queued; "capped" means the cap
 * was already reached.
 */
async function ensureAlertJob(
  deps: Pick<BotDeps, "service" | "enqueue">,
  row: { id: string; company_id: string },
  kind: RecordingAlertKind,
  runAfterMs: number,
): Promise<"queued" | "exists" | "capped" | "failed"> {
  const { data, error } = await deps.service
    .from("background_jobs")
    .select("id")
    .eq("type", FINAL_BOT_ALERT_JOB)
    .in("status", ["queued", "running"])
    .eq("payload->>botRowId", row.id)
    .eq("payload->>kind", kind)
    .limit(1);
  if (error) return "failed";
  if (((data ?? []) as unknown[]).length > 0) return "exists";

  const job = {
    type: FINAL_BOT_ALERT_JOB,
    companyId: row.company_id,
    payload: { botRowId: row.id, kind },
    runAfter: new Date(runAfterMs),
    maxAttempts: RECORDING_ALERT_MAX_ATTEMPTS,
  };
  if (kind === "lobby") {
    // Bounded by the lobby itself: Meet closes its waiting room after 10 minutes.
    return (await deps.enqueue(job)).ok ? "queued" : "failed";
  }
  if (kind === "import_failed") {
    // One job per bot row, ever: an import fails once, so a refusal means it
    // was queued already. Its own id, so it never takes a failure alert's.
    const result = await deps.enqueue({ ...job, id: importFailedAlertJobId(row.id) });
    if (result.ok) return "queued";
    return result.code === "23505" ? "exists" : "failed";
  }

  const { data: prior, error: priorErr } = await deps.service
    .from("background_jobs")
    .select("id")
    .eq("type", FINAL_BOT_ALERT_JOB)
    .eq("payload->>botRowId", row.id)
    .eq("payload->>kind", "failure")
    .limit(100);
  if (priorErr) return "failed";
  const seen = new Set(((prior ?? []) as { id: string }[]).map((p) => p.id));
  let remaining = RECORDING_FAILURE_ALERT_MAX_JOBS - seen.size;
  for (const id of failureAlertJobIds(row.id)) {
    if (remaining <= 0) break;
    if (seen.has(id)) continue;
    const result = await deps.enqueue({ ...job, id });
    if (result.ok) return "queued";
    if (result.code !== "23505") return "failed";
    remaining -= 1; // taken by a concurrent caller
  }
  return "capped";
}

/**
 * The failure alert for a schedule-time failure, queued after the fatal write
 * landed. Never fails the sync: a missed enqueue is logged and the reconcile
 * backstop queues it within minutes.
 */
async function queueFailureAlert(
  deps: Pick<BotDeps, "service" | "enqueue" | "now">,
  row: { id: string; company_id: string },
): Promise<void> {
  const outcome = await ensureAlertJob(deps, row, "failure", deps.now()).catch(
    () => "failed" as const,
  );
  if (outcome === "failed") {
    console.warn(`[final-bot] row ${row.id}: failure alert not queued; the reconcile will retry`);
  }
}

/* ── recording import jobs (recording step 4) ─────────────────── */

/** The one job id a bot row's import-failed alert may use. */
export function importFailedAlertJobId(botRowId: string): string {
  return deterministicUuid(`final-bot-alert:${botRowId}:import_failed`);
}

/** The fixed job ids a bot row's imports may use: there are only RECORDING_IMPORT_MAX_JOBS. */
export function importJobIds(botRowId: string): string[] {
  return Array.from({ length: RECORDING_IMPORT_MAX_JOBS }, (_, i) =>
    deterministicUuid(`final-recording-import:${botRowId}:${i + 1}`),
  );
}

/**
 * Queue the host's import-failed alert. Its dedupe is the job's fixed id, the
 * email's idempotency key and the bell's id, all its own: it shares no claim
 * stamp, job id, key or bell with the step 3 and 3b alerts.
 */
export async function ensureImportFailedAlert(
  deps: Pick<BotDeps, "service" | "enqueue" | "now">,
  row: { id: string; company_id: string },
): Promise<"queued" | "exists" | "capped" | "failed"> {
  return ensureAlertJob(deps, row, "import_failed", deps.now());
}

/**
 * Queue an import for a bot row unless one is already queued or running
 * (migration 040 allows one per bot, by payload botId).
 *
 * Capped at RECORDING_IMPORT_MAX_JOBS jobs per bot row, ever, the way the
 * failure alerts are: each job takes one of the row's fixed ids, so the
 * database refuses one past the cap. `spaced` (the reconcile) starts the next
 * job no sooner than RECORDING_IMPORT_RETRY_GAP_MS after the last one ended,
 * so three jobs cover a day of outage rather than minutes. `afterCap` is for
 * work that may never be capped: finishing Recall's delete once Remotiv's
 * copy is safe, and cleaning up after a failure. It takes a random id.
 *
 * "capped" means every fixed id is taken and nothing was queued.
 */
export async function ensureImportJob(
  deps: Pick<BotDeps, "service" | "enqueue" | "now">,
  row: { id: string; company_id: string },
  options: { spaced?: boolean; afterCap?: boolean } = {},
): Promise<"queued" | "exists" | "capped" | "failed"> {
  const { data, error } = await deps.service
    .from("background_jobs")
    .select("id, status, updated_at")
    .eq("type", FINAL_RECORDING_IMPORT_JOB)
    .eq("payload->>botId", row.id)
    .limit(100);
  if (error) return "failed";
  const prior = (data ?? []) as { id: string; status: string; updated_at: string | null }[];
  if (prior.some((j) => j.status === "queued" || j.status === "running")) return "exists";

  const now = deps.now();
  const lastEnded = Math.max(0, ...prior.map((j) => Date.parse(j.updated_at ?? "") || 0));
  const runAfterMs =
    options.spaced && prior.length > 0
      ? Math.max(now, lastEnded + RECORDING_IMPORT_RETRY_GAP_MS)
      : now;
  const job = {
    type: FINAL_RECORDING_IMPORT_JOB,
    companyId: row.company_id,
    payload: { botId: row.id },
    runAfter: new Date(runAfterMs),
    maxAttempts: RECORDING_IMPORT_MAX_ATTEMPTS,
  };
  if (options.afterCap) {
    const result = await deps.enqueue(job);
    if (result.ok) return "queued";
    return result.code === "23505" ? "exists" : "failed";
  }

  const seen = new Set(prior.map((p) => p.id));
  let remaining = RECORDING_IMPORT_MAX_JOBS - seen.size;
  for (const id of importJobIds(row.id)) {
    if (remaining <= 0) break;
    if (seen.has(id)) continue;
    const result = await deps.enqueue({ ...job, id });
    if (result.ok) return "queued";
    if (result.code !== "23505") return "failed";
    remaining -= 1; // taken by a concurrent caller, or a live job appeared
  }
  return "capped";
}

/**
 * recording.done for a row: queued, then a job. Follows the event rather
 * than the write, so a redelivery after a failed enqueue still queues. Any
 * import already past 'queued' is left to its own job.
 */
async function startImport(
  deps: WebhookDeps,
  row: Pick<FinalBotRow, "id" | "company_id" | "import_status">,
): Promise<"queued" | "skipped" | "failed"> {
  if (row.import_status !== "none" && row.import_status !== "queued") return "skipped";
  if (row.import_status === "none") {
    const { error } = await deps.service
      .from("final_interview_bots")
      .update({ import_status: "queued", updated_at: new Date(deps.now()).toISOString() })
      .eq("id", row.id)
      .eq("company_id", row.company_id)
      .eq("import_status", "none")
      .not("provider_recording_id", "is", null);
    if (error) return "failed";
  }
  return (await ensureImportJob(deps, row)) === "failed" ? "failed" : "queued";
}

/**
 * Every import job for the row is used up. A copy that is already ready only
 * needs Recall's delete, which keeps being retried a gap apart until Recall
 * answers (its retention ends it within a week). Anything else is a failed
 * import: the host is told, and one more run cleans up what it left.
 */
async function settleCappedImport(
  deps: BotDeps,
  row: { id: string; company_id: string; provider_recording_id: string },
  report: ReconcileReport,
): Promise<void> {
  const { data, error } = await deps.service
    .from("final_interview_recordings")
    .select("id, status")
    .eq("vendor_recording_id", row.provider_recording_id)
    .eq("company_id", row.company_id)
    .maybeSingle();
  if (error) throw dbError("recording read", error);
  if ((data as { status: string } | null)?.status === "ready") {
    if ((await ensureImportJob(deps, row, { spaced: true, afterCap: true })) === "queued") {
      report.importDeleteRetries += 1;
    }
    return;
  }
  const failed = await patchRow(
    deps,
    row,
    { import_status: "failed", import_error: RECORDING_IMPORT_ERRORS.retriesExhausted },
    (q) => q.in("import_status", ["queued", "importing"]),
  );
  if (!failed) return;
  report.importsFailed += 1;
  console.error(`[final-bot] row ${row.id}: import failed after ${RECORDING_IMPORT_MAX_JOBS} jobs`);
  if ((await ensureImportFailedAlert(deps, row)) === "queued") report.importAlertsQueued += 1;
  await ensureImportJob(deps, row, { afterCap: true });
}

/* ── the Recall webhook ───────────────────────────────────────── */

export type WebhookDeps = Pick<BotDeps, "service" | "enqueue" | "now">;

/**
 * What the route answers. 2xx only when the event was applied, recognised as
 * a duplicate or stale, durably queued, or deliberately ignored; 503 when a
 * database read, write or enqueue it needed did not happen, so Recall retries.
 */
export type WebhookResult = { status: 200 | 401 | 503; outcome: string };

type RecallEvent = {
  name: string;
  botId: string | null;
  metadata: Record<string, string> | null;
  code: string | null;
  subCode: string | null;
  /** Recall's own timestamp for the change; the ordering key. */
  at: string | null;
  recordingId: string | null;
};

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const safeCode = (v: unknown): string | null =>
  typeof v === "string" && SAFE_CODE.test(v) ? v : null;

/** Recall's `event` + `data.{data,bot,recording}` shape, with anything unsafe dropped. */
function parseRecallEvent(raw: unknown): RecallEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw as { event?: unknown }).event;
  const data = (raw as { data?: unknown }).data;
  if (
    typeof name !== "string" ||
    !/^[a-z_]+\.[a-z_]+$/.test(name) ||
    !data ||
    typeof data !== "object"
  ) {
    return null;
  }
  const d = data as {
    data?: { code?: unknown; sub_code?: unknown; updated_at?: unknown };
    bot?: { id?: unknown; metadata?: unknown };
    recording?: { id?: unknown };
  };
  const at =
    typeof d.data?.updated_at === "string" && Number.isFinite(Date.parse(d.data.updated_at))
      ? d.data.updated_at
      : null;
  const meta = d.bot?.metadata;
  const metadata =
    meta && typeof meta === "object" && Object.values(meta).every((v) => typeof v === "string")
      ? (meta as Record<string, string>)
      : null;
  return {
    name,
    botId: isRecallId(d.bot?.id) ? d.bot.id : null,
    metadata,
    code: safeCode(d.data?.code),
    subCode: safeCode(d.data?.sub_code),
    at,
    recordingId: isRecallId(d.recording?.id) ? d.recording.id : null,
  };
}

/** Bot lifecycle events that move the row's status. Every other bot.* event records its code only. */
const LIFECYCLE_STATUS: ReadonlyMap<string, FinalBotStatus> = new Map([
  ["bot.in_waiting_room", "waiting_room"],
  ["bot.in_call_not_recording", "in_call"],
  ["bot.in_call_recording", "recording"],
  ["bot.call_ended", "call_ended"],
  ["bot.done", "done"],
  ["bot.fatal", "fatal"],
]);

export function isFailureEvent(name: string, subCode: string | null): boolean {
  return (
    name === "bot.fatal" ||
    name === "bot.recording_permission_denied" ||
    name === "recording.failed" ||
    (name === "bot.call_ended" &&
      subCode !== null &&
      RECORDING_WAITING_ROOM_FAILURE_SUB_CODES.has(subCode))
  );
}

/**
 * Verify, parse and apply one Recall webhook. Never calls Recall, never
 * consults the recording flag, never logs the body.
 */
export async function receiveRecallWebhook(
  input: { rawBody: string; header: HeaderReader; secret: string | undefined },
  overrides: Partial<WebhookDeps> = {},
): Promise<WebhookResult> {
  const now = overrides.now ?? Date.now;
  const verified = verifyRecallWebhook({
    secret: input.secret,
    header: input.header,
    rawBody: input.rawBody,
    nowMs: now(),
  });
  if (!verified.ok) {
    if (verified.reason === "no_secret" || verified.reason === "bad_secret") {
      console.error("[recall-webhook] RECALL_WEBHOOK_SECRET is missing or malformed; refusing");
      return { status: 503, outcome: "not_configured" };
    }
    console.warn(`[recall-webhook] rejected: ${verified.reason}`);
    return { status: 401, outcome: "unauthorized" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody);
  } catch {
    // Signed but not JSON: a retry would not change it.
    console.error(`[recall-webhook] ${verified.id}: signed payload was not JSON`);
    return { status: 200, outcome: "ignored_malformed" };
  }

  try {
    const deps: WebhookDeps = {
      service: overrides.service ?? createServiceClient(),
      enqueue: overrides.enqueue ?? lazyEnqueue,
      now,
    };
    const event = parseRecallEvent(raw);
    const result = event
      ? await processRecallEvent(deps, event)
      : ({ status: 200, outcome: "ignored_malformed" } as const);
    console.log(`[recall-webhook] ${verified.id} ${event?.name ?? "?"}: ${result.outcome}`);
    return result;
  } catch (err) {
    console.error(
      `[recall-webhook] ${verified.id}: processing failed (${err instanceof Error ? err.message : "error"})`,
    );
    return { status: 503, outcome: "error" };
  }
}

/** Apply one parsed event. Exported for tests. */
export async function processRecallEvent(
  deps: WebhookDeps,
  event: RecallEvent,
): Promise<WebhookResult> {
  const isBotEvent = event.name.startsWith("bot.");
  const isRecordingEvent = event.name === "recording.done" || event.name === "recording.failed";
  if (!isBotEvent && !isRecordingEvent) return { status: 200, outcome: "ignored_event" };
  if (!event.botId) return { status: 200, outcome: "ignored_no_bot" };

  const { data, error } = await deps.service
    .from("final_interview_bots")
    .select(BOT_COLUMNS)
    .eq("provider_bot_id", event.botId)
    .maybeSingle();
  // A failed read says nothing about whether the bot is known. Retry.
  if (error) return { status: 503, outcome: "db_unavailable" };
  const row = data as FinalBotRow | null;
  if (!row) return handleUnknownBot(deps, event);

  if (isRecordingEvent) return applyRecordingEvent(deps, row, event);
  return applyLifecycleEvent(deps, row, event);
}

/**
 * The bot lifecycle stream. One conditional UPDATE, so it is safe against
 * duplicate, delayed and concurrent deliveries without a read-then-write:
 *
 *   - Recall's own timestamp is the watermark: an event no newer than the
 *     row's last_event_at changes nothing, so a late in_waiting_room cannot
 *     pull a recording bot back to the lobby and a duplicate is a no-op.
 *   - 'deleted' and 'superseded' rows never move.
 *   - 'fatal' is final for this stream: a later bot.done does not hide it.
 *
 * Recording events never touch these columns, so the two streams cannot
 * block each other through the watermark.
 */
async function applyLifecycleEvent(
  deps: WebhookDeps,
  row: FinalBotRow,
  event: RecallEvent,
): Promise<WebhookResult> {
  let applied = false;
  if (event.at) {
    const status = LIFECYCLE_STATUS.get(event.name);
    const patch: Partial<FinalBotRow> = {
      last_event_code: event.code ?? event.name.slice("bot.".length),
      last_event_sub_code: event.subCode,
      last_event_at: event.at,
      updated_at: new Date(deps.now()).toISOString(),
      ...(status ? { status } : {}),
    };
    const { data, error } = await deps.service
      .from("final_interview_bots")
      .update(patch)
      .eq("id", row.id)
      .eq("company_id", row.company_id)
      .eq("provider_bot_id", event.botId as string)
      .not("status", "in", '("deleted","superseded","fatal")')
      .or(`last_event_at.is.null,last_event_at.lt."${event.at}"`)
      .select("id");
    if (error) return { status: 503, outcome: "db_unavailable" };
    applied = ((data ?? []) as unknown[]).length > 0;
  }

  const live =
    row.superseded_at === null && row.status !== "deleted" && row.status !== "superseded";

  // The lobby check follows the event, not the write: a redelivery after a
  // failed enqueue finds its own state already applied and must still queue.
  if (event.name === "bot.in_waiting_room" && event.at && live && !row.lobby_alert_sent_at) {
    const current =
      applied ||
      (row.last_event_code === event.code &&
        Date.parse(row.last_event_at ?? "") === Date.parse(event.at));
    if (current) {
      const queued = await ensureAlertJob(
        deps,
        row,
        "lobby",
        Math.max(deps.now(), Date.parse(event.at) + RECORDING_LOBBY_ALERT_DELAY_MS),
      );
      if (queued === "failed") return { status: 503, outcome: "enqueue_failed" };
    }
  }

  // A failure is a fact whatever order it arrives in.
  if (isFailureEvent(event.name, event.subCode) && live && !row.failure_alert_sent_at) {
    if ((await ensureAlertJob(deps, row, "failure", deps.now())) === "failed") {
      return { status: 503, outcome: "enqueue_failed" };
    }
  }

  if (!event.at) return { status: 200, outcome: "ignored_no_timestamp" };
  return { status: 200, outcome: applied ? "applied" : "stale_or_duplicate" };
}

/**
 * The recording artifact stream. recording.done stores the recording id, on
 * any row including a superseded or finished one, because that media is what
 * the import will copy; the first id is kept. It then queues the import
 * (recording step 4): import_status 'none' -> 'queued' and one
 * final_recording_import job. A second, different recording id is not
 * imported and is left to Recall's retention. Nothing here touches the
 * status or the media. recording.failed raises the failure alert; the schema
 * has no column for it beyond the alert stamp.
 */
async function applyRecordingEvent(
  deps: WebhookDeps,
  row: FinalBotRow,
  event: RecallEvent,
): Promise<WebhookResult> {
  if (event.name === "recording.failed") {
    const live =
      row.superseded_at === null && row.status !== "deleted" && row.status !== "superseded";
    if (live && !row.failure_alert_sent_at) {
      if ((await ensureAlertJob(deps, row, "failure", deps.now())) === "failed") {
        return { status: 503, outcome: "enqueue_failed" };
      }
    }
    return { status: 200, outcome: "recording_failed_noted" };
  }

  if (!event.recordingId) return { status: 200, outcome: "ignored_no_recording" };
  const { data, error } = await deps.service
    .from("final_interview_bots")
    .update({ provider_recording_id: event.recordingId })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq("provider_bot_id", event.botId as string)
    .is("provider_recording_id", null)
    .select("id");
  if (error) return { status: 503, outcome: "db_unavailable" };
  const stored = ((data ?? []) as unknown[]).length > 0;
  if (!stored && row.provider_recording_id !== event.recordingId) {
    console.warn(
      `[recall-webhook] row ${row.id}: a second recording id arrived; the first is kept`,
    );
    return { status: 200, outcome: "recording_kept_first" };
  }
  if ((await startImport(deps, row)) === "failed") {
    return { status: 503, outcome: "enqueue_failed" };
  }
  return { status: 200, outcome: stored ? "recording_stored" : "duplicate" };
}

/**
 * A signed event for a bot no row names. Deletion needs proof on every step:
 *
 *   not Remotiv's marker, or no valid botRowId/companyId/finalInterviewId
 *                                  -> ignored, never deleted
 *   its row exists (id not saved yet, or another bot saved)
 *                                  -> a sync is queued; Step 2 adopts or sorts it
 *   row exists but disagrees with the metadata
 *                                  -> ignored
 *   its row is genuinely gone      -> the orphan delete, deduplicated by
 *                                     migration 040's index
 *
 * A read or enqueue that fails is a 503, never a cleanup or an "unknown".
 * No row is ever created from a webhook.
 */
async function handleUnknownBot(deps: WebhookDeps, event: RecallEvent): Promise<WebhookResult> {
  const meta = event.metadata;
  if (meta?.integration !== RECORDING_BOT_INTEGRATION) {
    return { status: 200, outcome: "ignored_not_ours" };
  }
  if (
    !isRecallId(meta.botRowId) ||
    !isRecallId(meta.companyId) ||
    !isRecallId(meta.finalInterviewId)
  ) {
    return { status: 200, outcome: "ignored_unidentified" };
  }

  const { data, error } = await deps.service
    .from("final_interview_bots")
    .select("id, company_id, final_interview_id, booking_id, provider_bot_id")
    .eq("id", meta.botRowId)
    .maybeSingle();
  if (error) return { status: 503, outcome: "db_unavailable" };
  const row = data as Pick<
    FinalBotRow,
    "id" | "company_id" | "final_interview_id" | "booking_id" | "provider_bot_id"
  > | null;

  if (row) {
    if (row.company_id !== meta.companyId || row.final_interview_id !== meta.finalInterviewId) {
      return { status: 200, outcome: "ignored_metadata_mismatch" };
    }
    const queued = await enqueueSync(
      deps,
      { id: row.booking_id, company_id: row.company_id },
      null,
    );
    if (queued === "enqueue_failed") return { status: 503, outcome: "enqueue_failed" };
    return {
      status: 200,
      outcome: row.provider_bot_id ? "queued_sync_duplicate_bot" : "queued_sync_unsaved_bot",
    };
  }

  const result = await deps.enqueue({
    type: FINAL_BOT_SYNC_JOB,
    companyId: null,
    payload: {
      action: "delete",
      providerBotId: event.botId,
      providerRecordingId: event.recordingId,
    },
  });
  if (result.ok || result.code === "23505") return { status: 200, outcome: "queued_cleanup" };
  return { status: 503, outcome: "enqueue_failed" };
}

/* ── the job handler ──────────────────────────────────────────── */

/** Dispatch one final_bot_sync job. Exported with injectable deps for tests. */
export async function processFinalBotJob(
  deps: BotDeps,
  job: Pick<BackgroundJob, "id" | "company_id" | "payload">,
): Promise<SyncSummary | OrphanReport | ReconcileReport> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  try {
    if (payload.action === "delete") {
      const report = await runOrphanDelete(deps, payload);
      console.log(
        `[final-bot] orphan delete: ${report.outcome}, ${report.recordings} recording(s)`,
      );
      return report;
    }
    if (payload.action === "reconcile") {
      const report = await reconcileFinalBots(deps);
      console.log(`[final-bot] reconcile: ${JSON.stringify(report)}`);
      return report;
    }
    if (payload.action !== "sync" && payload.action !== undefined) {
      throw new TerminalJobError("deterministic", "unknown final_bot_sync action");
    }
    const bookingId = payload.bookingId;
    if (typeof bookingId !== "string" || !bookingId) {
      throw new TerminalJobError("deterministic", "final_bot_sync payload has no bookingId");
    }
    const summary = await syncBooking(deps, bookingId, job.company_id);
    console.log(
      `[final-bot] sync ${bookingId}: ${summary.outcome}, rounds ${summary.rounds}, created ${summary.created}, adopted ${summary.adopted}, deleted ${summary.deleted}, left ${summary.left}, kept ${summary.preserved}`,
    );
    return summary;
  } catch (err) {
    throw toBotJobError(err);
  }
}

export async function handleFinalBotSync(job: BackgroundJob, ctx?: JobContext): Promise<void> {
  await processFinalBotJob(workerDeps(ctx), job);
}

/* ── booking hooks: no Recall calls, never throw, bounded ─────── */

export type HookBooking = Pick<
  BookingRow,
  "id" | "company_id" | "purpose" | "final_interview_id" | "scheduled_start" | "status"
>;

export type HookOutcome =
  | "not_final"
  | "disabled"
  | "ineligible"
  | "no_bots"
  | "queued"
  | "already_queued"
  | "enqueue_failed"
  | "failed"
  | "timed_out";

export type HookOverrides = Partial<HookDeps> & { timeoutMs?: number };

function hookDeps(overrides: HookOverrides): HookDeps {
  return {
    service: overrides.service ?? createServiceClient(),
    enqueue: overrides.enqueue ?? lazyEnqueue,
    enabled: hookEnabled(overrides),
    now: overrides.now ?? Date.now,
  };
}

function hookEnabled(overrides: HookOverrides): () => boolean {
  return overrides.enabled ?? (() => isRecallRecordingEnabled());
}

/**
 * Run a hook's work without ever failing or holding up the booking response.
 * Anything short of queued is logged with the booking id only; the reconcile
 * job finds whatever was missed.
 */
async function runHook(
  name: string,
  bookingId: string,
  timeoutMs: number,
  work: () => Promise<HookOutcome>,
): Promise<HookOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HookOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      work().catch((err: unknown) => {
        console.error(
          `[final-bot] ${name} hook ${bookingId}: ${err instanceof Error ? err.message : "error"}`,
        );
        return "failed" as const;
      }),
      timeout,
    ]);
    if (outcome === "failed" || outcome === "timed_out" || outcome === "enqueue_failed") {
      console.warn(`[final-bot] ${name} hook ${bookingId}: ${outcome}; reconciliation will retry`);
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

async function readFinalInterview(
  service: Service,
  booking: HookBooking,
): Promise<FinalInterviewSnapshot | null> {
  if (!booking.final_interview_id) return null;
  const { data, error } = await service
    .from("final_interviews")
    .select("id, company_id, job_id, application_id, status")
    .eq("id", booking.final_interview_id)
    .eq("company_id", booking.company_id)
    .maybeSingle();
  if (error) throw dbError("final interview read", error);
  return (data as FinalInterviewSnapshot | null) ?? null;
}

/** POST /api/book/[token], after the calendar event exists. */
export async function onFinalBookingConfirmed(
  booking: HookBooking,
  overrides: HookOverrides = {},
): Promise<HookOutcome> {
  if (booking.purpose !== "final" || !booking.final_interview_id) return "not_final";
  // Off means nothing at all: no database client, no row, no job.
  if (!hookEnabled(overrides)()) return "disabled";
  return runHook("booked", booking.id, overrides.timeoutMs ?? HOOK_TIMEOUT_MS, async () => {
    const deps = hookDeps(overrides);
    const fi = await readFinalInterview(deps.service, booking);
    if (fi?.status !== "active" || desiredJoinAtMs(booking.scheduled_start) === null) {
      return "ineligible";
    }
    const row = await insertLiveRow(deps, booking, fi);
    return enqueueSync(deps, booking, row?.id ?? null);
  });
}

/** PATCH /api/book/[token], after the booking moved. Cleanup runs with the flag off. */
export async function onFinalBookingRescheduled(
  booking: HookBooking,
  overrides: HookOverrides = {},
): Promise<HookOutcome> {
  if (booking.purpose !== "final" || !booking.final_interview_id) return "not_final";
  return runHook("rescheduled", booking.id, overrides.timeoutMs ?? HOOK_TIMEOUT_MS, async () => {
    const deps = hookDeps(overrides);
    const nowIso = new Date(deps.now()).toISOString();
    const { data: retired, error } = await deps.service
      .from("final_interview_bots")
      .update({ superseded_at: nowIso, updated_at: nowIso })
      .eq("booking_id", booking.id)
      .eq("company_id", booking.company_id)
      .is("superseded_at", null)
      .select("id");
    if (error) throw dbError("bot row retire", error);

    let inserted: FinalBotRow | null = null;
    if (deps.enabled()) {
      const fi = await readFinalInterview(deps.service, booking);
      if (fi?.status === "active") inserted = await insertLiveRow(deps, booking, fi);
    }
    if (((retired ?? []) as unknown[]).length === 0 && !inserted) {
      return deps.enabled() ? "ineligible" : "no_bots";
    }
    return enqueueSync(deps, booking, inserted?.id ?? null);
  });
}

/** DELETE /api/book/[token] and cancelFinalInterview, after the booking is cancelled. */
export async function onFinalBookingCancelled(
  booking: HookBooking,
  overrides: HookOverrides = {},
): Promise<HookOutcome> {
  if (booking.purpose !== "final" || !booking.final_interview_id) return "not_final";
  return runHook("cancelled", booking.id, overrides.timeoutMs ?? HOOK_TIMEOUT_MS, async () => {
    const deps = hookDeps(overrides);
    const nowIso = new Date(deps.now()).toISOString();
    // Retired at once, so a create that has not started yet sees it is stale.
    const { error: retireErr } = await deps.service
      .from("final_interview_bots")
      .update({ superseded_at: nowIso, updated_at: nowIso })
      .eq("booking_id", booking.id)
      .eq("company_id", booking.company_id)
      .is("superseded_at", null)
      .select("id");
    if (retireErr) throw dbError("bot row retire", retireErr);
    const { data: existing, error } = await deps.service
      .from("final_interview_bots")
      .select("id")
      .eq("booking_id", booking.id)
      .eq("company_id", booking.company_id)
      .limit(1);
    if (error) throw dbError("bot rows read", error);
    if (((existing ?? []) as unknown[]).length === 0) return "no_bots";
    return enqueueSync(deps, booking, null);
  });
}
