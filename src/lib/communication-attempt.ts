import { DELETION_IN_PROGRESS } from "@/lib/applicant-deletion";
import { redactCandidateLinks } from "@/lib/candidate-links";
import { JobYield, TerminalJobError } from "@/lib/queue/failure-class";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Who owns an automatic message's log row, decided by the database (#85).
 *
 * The dispatchers call migration 059's three functions through this module:
 * the first-attempt insert, the claim, and the observed-state transitions.
 * Every time comparison happens inside those functions against the database
 * clock. Nothing here reads a clock, compares a time, or builds a Date: a
 * stamp the database returned is carried back to it as the exact string it
 * arrived as (AttemptStamp).
 *
 * Channel-agnostic: `channel` is a parameter, and nothing below names a
 * channel. What a channel sends, how it resolves a recipient and what its
 * provider's answers mean stay in its own dispatcher.
 *
 * No "server-only" import, so the decisions and the wrappers run under bare
 * node:test; every caller passes in a service-role client it built itself.
 */

type Service = ReturnType<typeof createServiceClient>;

/* ── the sentences ────────────────────────────────────────────── */

export const E1 = "Not re-sent: this message was first attempted more than 24 hours ago (#85).";
export const E2 = "Waiting: another attempt is sending this message (#85).";
export const E3 = "Could not claim the earlier log row for this message; will retry (#85).";
export const E4 =
  "The earlier log row for this message disappeared before it could be claimed; will retry (#85).";
export const E9 = "Not re-sent: scheduled messages are not retried automatically (#85).";
export const E10 = "Not re-sent: this send was interrupted before attempts were timed (#85).";
export const E11 = "Not sent: the application was deleted before this attempt could send (#85).";
export const E12 = "Not sent: the application is being deleted (#16).";
// E5 ("carried a one-time link that is not kept on file") is not implemented:
// no automatic template carries a one-time link, so it has no trigger.

/** The rules this module asks fail_observed_communication_log to apply. */
export type Rule = "E1" | "E9" | "E10";
const RULE_SENTENCE: Record<Rule, string> = { E1, E9, E10 };

/**
 * How long a send waits before asking the database again, after too_fresh or
 * not_due. Longer than the claim's 15-minute window, so the next ask can find
 * the row claimable; the minute over it absorbs the queue's one-minute tick
 * and modest clock skew. A fixed wait, not a time comparison: the claim still
 * decides. Must stay within the queue's MAX_YIELD_DELAY_MS, which a test holds.
 */
export const SEND_RETRY_DELAY_MS = 16 * 60_000;

/* ── stamps ───────────────────────────────────────────────────── */

/**
 * attempt_started_at as PostgREST returned it: a string with microseconds.
 * Opaque. Never through a Date, never formatted, never compared here: a Date
 * keeps milliseconds only, and a guard comparing a rounded stamp matches
 * nothing, silently (059, 3a REQUIREMENT 1). Made only by the parsers below.
 */
export type AttemptStamp = string & { readonly __brand: "AttemptStamp" };

/** A row this worker owns. Its stamp is never null: every guarded write compares it. */
export type OwnedAttempt = { readonly id: string; readonly stamp: AttemptStamp };

export type AttemptChannel = "email" | "whatsapp";
export type RowStatus = "queued" | "sent" | "failed" | "skipped" | "cancelled";
const ROW_STATUSES: readonly string[] = ["queued", "sent", "failed", "skipped", "cancelled"];

/**
 * Which rows may be claimed. 3a-2 claims from 'queued' only: a failed row is
 * terminal, because a timeout or a 200 without a message id is uncertain and
 * a resend could duplicate. 3a-3 widens this for email under its own rule.
 */
export type AttemptPolicy = { readonly claimFrom: "queued" };
export const QUEUED_ONLY: AttemptPolicy = { claimFrom: "queued" };

function contractBreak(what: string): TerminalJobError {
  return new TerminalJobError("deterministic", `communication attempt: ${what}`);
}

/** A stamp ownership depends on. Null or not a string breaks the contract. */
export function toOwnedStamp(value: unknown, where: string): AttemptStamp {
  if (typeof value !== "string" || value === "") {
    throw contractBreak(`${where} returned no stamp for a row it says is owned`);
  }
  return value as AttemptStamp;
}

/** A stamp observed on a row this worker does not own, which may be null. */
export function toObservedStamp(value: unknown, where: string): AttemptStamp | null {
  if (value === null) return null;
  if (typeof value !== "string" || value === "") {
    throw contractBreak(`${where} returned a stamp that is not a string`);
  }
  return value as AttemptStamp;
}

function rowId(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw contractBreak(`${where} returned no id`);
  return value;
}

/** Exactly one row, as every 059 function returns. */
function onlyRow(data: unknown, where: string): Record<string, unknown> {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") {
    throw contractBreak(`${where} did not return exactly one row`);
  }
  return data[0] as Record<string, unknown>;
}

/* ── database errors ──────────────────────────────────────────── */

export type DbError = { code?: string | null; message?: string | null } | null | undefined;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const TRANSIENT_STATUSES = new Set([0, 429, 502, 503, 504, 520, 522, 524]);
const TRANSIENT_CODES = new Set(["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03"]);

/**
 * Worth retrying, or not. Transient is a network failure (status 0), a
 * gateway or pool answer, a connection-class SQLSTATE, a serialization
 * failure, a deadlock, a lock or statement timeout, or a shutdown. Everything
 * else is permanent, including every code not listed: PGRST202 (059 is not
 * applied), 42501 (not the service-role client), a malformed argument. A loud
 * stop beats a retry that can never succeed.
 */
export function classifyDbError(error: DbError, status: number): "transient" | "permanent" {
  if (TRANSIENT_STATUSES.has(status)) return "transient";
  const code = error?.code ?? "";
  if (TRANSIENT_CODES.has(code) || code.startsWith("08") || code.startsWith("53")) {
    return "transient";
  }
  return "permanent";
}

/** The error to throw: counted E3 for transient, TerminalJobError otherwise. Code only, never the text. */
export function dbFailure(where: string, error: DbError, status: number): Error {
  const code = error?.code || "no code";
  console.error(`[communication-attempt] ${where} failed`, { code, status });
  if (classifyDbError(error, status) === "transient") {
    return new Error(`${E3} [${where}: ${code}, status ${status}]`);
  }
  return new TerminalJobError("deterministic", `${where} failed: ${code}, status ${status}`);
}

/** The constraint a 23503 names, for the LOG LINE only. Never a decision input. */
function constraintForLog(error: DbError): string {
  return /constraint "([^"]+)"/.exec(error?.message ?? "")?.[1] ?? "unnamed";
}

/**
 * Settle a foreign-key violation on an insert, after the caller has read the
 * application again by id. communication_logs has two foreign keys, so the
 * code alone does not say which one broke, and message text is not a
 * contract: the read decides. Gone means it was deleted under this attempt and
 * the caller skips the job; still there means something else is wrong,
 * permanently.
 */
export function settleForeignKeyViolation(error: DbError, applicationStillExists: boolean): "gone" {
  console.warn("[communication-attempt] foreign-key violation on insert", {
    constraint: constraintForLog(error),
  });
  if (applicationStillExists) {
    throw new TerminalJobError(
      "deterministic",
      "communication attempt: an insert broke a foreign key while its application still exists",
    );
  }
  return "gone";
}

/**
 * Read the application again by id and settle a 23503 with the answer. One
 * read, company-filtered like every read of this table on the tenant surface;
 * the company is the one the caller derived from that same application.
 */
export async function confirmApplicationGone(
  service: Service,
  key: { applicationId: string; companyId: string },
  error: DbError,
): Promise<"gone"> {
  const {
    data,
    error: readError,
    status,
  } = await service
    .from("job_applications")
    .select("id")
    .eq("id", key.applicationId)
    .eq("company_id_snapshot", key.companyId)
    .maybeSingle();
  if (readError) throw dbFailure("the application check after 23503", readError, status);
  return settleForeignKeyViolation(error, data !== null);
}

/* ── the three functions ──────────────────────────────────────── */

/**
 * What the claim answered. For a claim from 'queued', too_fresh and too_old
 * always carry the row's stamp (unclocked is tested before both), so a null
 * there breaks the contract too. A claim from 'failed' (3a-3) will widen this.
 */
export type ClaimResult =
  | { outcome: "claimed"; owned: OwnedAttempt }
  | { outcome: "too_fresh" | "too_old"; id: string; observed: AttemptStamp }
  | { outcome: "unclocked"; id: string; observed: null }
  | { outcome: "scheduled" | "wrong_status"; id: string; observed: AttemptStamp | null }
  | { outcome: "missing" }
  /** #16: 071's guard refused the claim; the applicant is being deleted. */
  | { outcome: "deleting" };

export function parseClaimRows(data: unknown): ClaimResult {
  const where = "claim_communication_log";
  const row = onlyRow(data, where);
  const outcome = row.out_outcome;
  switch (outcome) {
    case "claimed":
      return {
        outcome,
        owned: {
          id: rowId(row.out_id, where),
          stamp: toOwnedStamp(row.out_attempt_started_at, where),
        },
      };
    case "too_fresh":
    case "too_old":
      return {
        outcome,
        id: rowId(row.out_id, where),
        observed: toOwnedStamp(row.out_attempt_started_at, `${where} (${outcome})`),
      };
    case "unclocked":
      if (row.out_attempt_started_at !== null) {
        throw contractBreak(`${where} answered unclocked with a stamp`);
      }
      return { outcome, id: rowId(row.out_id, where), observed: null };
    case "scheduled":
    case "wrong_status":
      return {
        outcome,
        id: rowId(row.out_id, where),
        observed: toObservedStamp(row.out_attempt_started_at, where),
      };
    case "missing":
      if (row.out_id !== null || row.out_attempt_started_at !== null) {
        throw contractBreak(`${where} answered missing with a row`);
      }
      return { outcome };
    default:
      throw contractBreak(`${where} answered an unknown outcome`);
  }
}

export type TransitionOutcome = "failed" | "changed" | "not_due" | "bad_rule" | "missing";
const TRANSITION_OUTCOMES: readonly string[] = [
  "failed",
  "changed",
  "not_due",
  "bad_rule",
  "missing",
];

export function parseTransitionRows(data: unknown): { outcome: TransitionOutcome } {
  const row = onlyRow(data, "fail_observed_communication_log");
  if (typeof row.out_outcome !== "string" || !TRANSITION_OUTCOMES.includes(row.out_outcome)) {
    throw contractBreak("fail_observed_communication_log answered an unknown outcome");
  }
  return { outcome: row.out_outcome as TransitionOutcome };
}

type AttemptKey = { applicationId: string; event: string; channel: AttemptChannel };

export async function claimCommunicationLog(
  service: Service,
  key: AttemptKey,
  fromStatus: AttemptPolicy["claimFrom"],
): Promise<ClaimResult> {
  const { data, error, status } = await service.rpc("claim_communication_log", {
    p_application_id: key.applicationId,
    p_event: key.event,
    p_channel: key.channel,
    p_from_status: fromStatus,
  });
  if (error?.code === DELETION_IN_PROGRESS) return { outcome: "deleting" };
  if (error) throw dbFailure("claim_communication_log", error, status);
  return parseClaimRows(data);
}

export async function failObservedCommunicationLog(
  service: Service,
  input: { id: string; observed: AttemptStamp | null; rule: Rule },
): Promise<{ outcome: TransitionOutcome }> {
  const { data, error, status } = await service.rpc("fail_observed_communication_log", {
    p_id: input.id,
    p_observed_stamp: input.observed,
    p_rule: input.rule,
    p_error: RULE_SENTENCE[input.rule],
  });
  if (error) throw dbFailure("fail_observed_communication_log", error, status);
  return parseTransitionRows(data);
}

export type InsertResult =
  | { kind: "owned"; owned: OwnedAttempt }
  | { kind: "conflict" }
  /** 23503: the caller settles it with confirmApplicationGone. */
  | { kind: "foreign_key"; error: DbError }
  /** #16: 071's guard refused the row; the applicant is being deleted. */
  | { kind: "deleting" };

/**
 * The pre-send row of an automatic first attempt, stamped by the database.
 * The body is redacted here, so no caller can store a live link by passing
 * the rendered message straight in. 23505 is a conflict, not an error: a
 * concurrent attempt wrote the row first. 23503 goes back to the caller to
 * settle with one read.
 */
export async function insertFirstAttemptCommunicationLog(
  service: Service,
  input: AttemptKey & {
    companyId: string;
    toAddress: string;
    subject: string | null;
    body: string;
  },
): Promise<InsertResult> {
  const where = "insert_first_attempt_communication_log";
  const { data, error, status } = await service.rpc("insert_first_attempt_communication_log", {
    p_company_id: input.companyId,
    p_application_id: input.applicationId,
    p_event: input.event,
    p_channel: input.channel,
    p_to_address: input.toAddress,
    p_subject: input.subject,
    p_body: redactCandidateLinks(input.body),
  });
  if (error?.code === UNIQUE_VIOLATION) return { kind: "conflict" };
  if (error?.code === FOREIGN_KEY_VIOLATION) return { kind: "foreign_key", error };
  if (error?.code === DELETION_IN_PROGRESS) return { kind: "deleting" };
  if (error) throw dbFailure(where, error, status);
  const row = onlyRow(data, where);
  return {
    kind: "owned",
    owned: {
      id: rowId(row.out_id, where),
      stamp: toOwnedStamp(row.out_attempt_started_at, where),
    },
  };
}

/* ── writes on an owned row ───────────────────────────────────── */

/*
 * Each one is guarded on id, status 'queued' and this worker's stamp, so a row
 * someone else has since claimed, stopped or finished is never overwritten.
 * Each answers whether exactly one row matched. The success write is not here:
 * it stays by id in the dispatcher, because a send that happened is recorded
 * whatever the row became meanwhile.
 */

function matchedOne(data: unknown): boolean {
  return Array.isArray(data) && data.length === 1;
}

/**
 * Before the provider call: the body and address this attempt sends, and
 * proof the application still exists. 0 rows means the row was stopped,
 * re-claimed, or orphaned by a deleted application; nothing may be sent.
 */
export async function refreshOwnedBeforeSend(
  service: Service,
  owned: OwnedAttempt,
  input: { toAddress: string; body: string },
): Promise<boolean> {
  const { data, error, status } = await service
    .from("communication_logs")
    .update({ body: redactCandidateLinks(input.body), to_address: input.toAddress })
    .eq("id", owned.id)
    .eq("status", "queued")
    .eq("attempt_started_at", owned.stamp)
    .not("application_id", "is", null)
    .select("id");
  if (error) throw dbFailure("the pre-send refresh", error, status);
  return matchedOne(data);
}

/** A decision not to send (invalid number, opted out) recorded on the owned row. */
export async function markOwnedSkipped(
  service: Service,
  owned: OwnedAttempt,
  input: { error: string; toAddress: string },
): Promise<boolean> {
  const { data, error, status } = await service
    .from("communication_logs")
    .update({ status: "skipped", error: input.error, to_address: input.toAddress })
    .eq("id", owned.id)
    .eq("status", "queued")
    .eq("attempt_started_at", owned.stamp)
    .select("id");
  if (error) throw dbFailure("the skip write", error, status);
  return matchedOne(data);
}

/**
 * The provider refused, or its answer was uncertain. Never throws: it runs
 * after a send attempt, and a failed write here must not turn into a retry
 * that sends again. A write error is logged by code and reads as no match.
 */
export async function markOwnedFailed(
  service: Service,
  owned: OwnedAttempt,
  failure: string,
): Promise<boolean> {
  const { data, error } = await service
    .from("communication_logs")
    .update({ status: "failed", error: failure })
    .eq("id", owned.id)
    .eq("status", "queued")
    .eq("attempt_started_at", owned.stamp)
    .select("id");
  if (error) {
    console.error("[communication-attempt] the failure write failed", {
      code: error.code || "no code",
    });
    return false;
  }
  return matchedOne(data);
}

/**
 * The owned row's application was deleted before the send. Ends it as skipped
 * with E11. Sets status and error only: application_id stays NULL, the
 * address, subject and body are not touched (056's sweep clears them), and
 * no orphaned_at trigger fires, because this SET list never names
 * application_id. Matches only an orphaned row, so a stopped or re-claimed
 * one is left exactly as it is.
 */
export async function finaliseOrphanedAttempt(
  service: Service,
  owned: OwnedAttempt,
): Promise<boolean> {
  const { data, error, status } = await service
    .from("communication_logs")
    .update({ status: "skipped", error: E11 })
    .eq("id", owned.id)
    .eq("status", "queued")
    .eq("attempt_started_at", owned.stamp)
    .is("application_id", null)
    .select("id");
  if (error) throw dbFailure("the orphan finalise", error, status);
  return matchedOne(data);
}

/* ── the decision ─────────────────────────────────────────────── */

export type DecisionInput =
  | { from: "precheck"; row: { status: RowStatus } | null; afterConflict: boolean }
  | { from: "claim"; result: ClaimResult }
  | { from: "reread"; after: "wrong_status" | "changed"; row: { status: RowStatus } | null }
  | { from: "transition"; result: { outcome: TransitionOutcome } };

export type Step =
  | { kind: "first_attempt" }
  | { kind: "claim" }
  | { kind: "owned"; owned: OwnedAttempt }
  | { kind: "transition"; id: string; observed: AttemptStamp | null; rule: Rule }
  | { kind: "reread"; after: "wrong_status" | "changed" }
  /** Terminal: complete the job, write nothing. */
  | { kind: "done"; reason: string }
  /** Uncounted JobYield(E2, SEND_RETRY_DELAY_MS). Only too_fresh and not_due, which age out. */
  | { kind: "wait" }
  /** Counted: a plain Error, backed off, dead with an alert if it persists. */
  | { kind: "retry"; message: string }
  /** TerminalJobError, deterministic: a programming or contract error. */
  | { kind: "stop"; message: string };

const TERMINAL_STATUSES: readonly RowStatus[] = ["sent", "skipped", "cancelled"];

/**
 * The decision list, as a pure function: plain data in, plain data out. No
 * I/O, no client, no clock, no randomness, no Date, so every branch is a table
 * row in a test. `rereads` is how many re-reads this run has already done; a
 * second wrong_status or changed is a counted E3, never another re-read.
 */
export function decide(
  input: DecisionInput,
  state: { rereads: number },
  policy: AttemptPolicy,
): Step {
  switch (input.from) {
    case "precheck": {
      if (!input.row) {
        return input.afterConflict ? { kind: "retry", message: E4 } : { kind: "first_attempt" };
      }
      return fromRowStatus(input.row.status, policy);
    }
    case "reread": {
      if (!input.row) return { kind: "retry", message: E4 };
      // In 3a-2 the claim is always from 'queued', so wrong_status meant the
      // row was not queued. Finding it queued now means it changed back
      // underneath us: an unexplained race, not a wait anyone promised to end.
      if (input.row.status === "queued" && input.after === "wrong_status") {
        return { kind: "retry", message: E3 };
      }
      return fromRowStatus(input.row.status, policy);
    }
    case "claim": {
      const r = input.result;
      switch (r.outcome) {
        case "claimed":
          return { kind: "owned", owned: r.owned };
        case "too_fresh":
          return { kind: "wait" };
        case "too_old":
          return { kind: "transition", id: r.id, observed: r.observed, rule: "E1" };
        case "unclocked":
          /*
           * E10, honestly: a queued row with no stamp was written before
           * attempts were timed. Its send may have gone out, or its worker may
           * have died first, and nothing on the row tells the two apart. It is
           * ended as failed and is not sent, so a message that was genuinely
           * never sent stays unsent. That is a real cost, accepted deliberately:
           * a missed message is better than a duplicate.
           */
          return { kind: "transition", id: r.id, observed: null, rule: "E10" };
        case "scheduled":
          return { kind: "transition", id: r.id, observed: r.observed, rule: "E9" };
        case "wrong_status":
          return state.rereads >= 1
            ? { kind: "retry", message: E3 }
            : { kind: "reread", after: "wrong_status" };
        case "missing":
          return { kind: "retry", message: E4 };
        case "deleting":
          // #16: never sent, now or on any retry; the job completes.
          return { kind: "done", reason: E12 };
      }
      return { kind: "stop", message: "communication attempt: unhandled claim outcome" };
    }
    case "transition": {
      switch (input.result.outcome) {
        case "failed":
          return { kind: "done", reason: "ended by the database rule" };
        case "changed":
          return state.rereads >= 1
            ? { kind: "retry", message: E3 }
            : { kind: "reread", after: "changed" };
        case "not_due":
          return { kind: "wait" };
        case "bad_rule":
          return {
            kind: "stop",
            message: "communication attempt: fail_observed_communication_log refused the rule",
          };
        case "missing":
          return { kind: "retry", message: E4 };
      }
      return { kind: "stop", message: "communication attempt: unhandled transition outcome" };
    }
  }
}

/** What a row found by a read means: terminal, or a claim from the policy's status. */
function fromRowStatus(status: RowStatus, policy: AttemptPolicy): Step {
  if (TERMINAL_STATUSES.includes(status)) return { kind: "done", reason: `already ${status}` };
  if (status === "failed") {
    // policy.claimFrom is 'queued' in 3a-2: a failed row is terminal.
    return { kind: "done", reason: "a failed row is not claimed again" };
  }
  if (status === policy.claimFrom) return { kind: "claim" };
  return { kind: "retry", message: E3 };
}

/* ── the driver ───────────────────────────────────────────────── */

export type Resolution =
  | { kind: "first_attempt" }
  | { kind: "owned"; owned: OwnedAttempt }
  | { kind: "done"; reason: string };

/** The automatic row for this key, if any: status only, never the stamp. */
async function readAutomaticRow(
  service: Service,
  key: AttemptKey,
): Promise<{ status: RowStatus } | null> {
  const { data, error, status } = await service
    .from("communication_logs")
    .select("id, status")
    .eq("application_id", key.applicationId)
    .eq("event", key.event)
    .eq("channel", key.channel)
    .is("sent_by_name", null)
    .maybeSingle();
  if (error) throw dbFailure("the pre-check", error, status);
  if (!data) return null;
  const rowStatus = (data as { status?: unknown }).status;
  if (typeof rowStatus !== "string" || !ROW_STATUSES.includes(rowStatus)) {
    throw contractBreak("the pre-check read a status outside the CHECK");
  }
  return { status: rowStatus as RowStatus };
}

/**
 * Run the decision list for one automatic message until it settles: a first
 * attempt for the caller to insert, an owned row, or done. Waits and retries
 * leave by throwing: JobYield for a wait, a plain Error for a counted retry,
 * TerminalJobError for a stop. `afterConflict` is the second look after a
 * first-attempt insert hit 23505; an empty pre-check then is E4, never a
 * second insert.
 */
export async function resolveAutomaticAttempt(
  service: Service,
  key: AttemptKey,
  policy: AttemptPolicy,
  options: { afterConflict?: boolean } = {},
): Promise<Resolution> {
  const state = { rereads: 0 };
  let step = decide(
    {
      from: "precheck",
      row: await readAutomaticRow(service, key),
      afterConflict: options.afterConflict === true,
    },
    state,
    policy,
  );
  // At most: claim, transition, re-read, claim, transition. The bound is a
  // backstop; decide() settles well inside it.
  for (let turns = 0; turns < 8; turns++) {
    switch (step.kind) {
      case "first_attempt":
      case "owned":
      case "done":
        return step;
      case "claim":
        step = decide(
          { from: "claim", result: await claimCommunicationLog(service, key, policy.claimFrom) },
          state,
          policy,
        );
        break;
      case "transition":
        step = decide(
          {
            from: "transition",
            result: await failObservedCommunicationLog(service, step),
          },
          state,
          policy,
        );
        break;
      case "reread": {
        const after = step.after;
        state.rereads += 1;
        step = decide(
          { from: "reread", after, row: await readAutomaticRow(service, key) },
          state,
          policy,
        );
        break;
      }
      case "wait":
        throw new JobYield(E2, SEND_RETRY_DELAY_MS);
      case "retry":
        throw new Error(step.message);
      case "stop":
        throw new TerminalJobError("deterministic", step.message);
    }
  }
  throw contractBreak("the decision list did not settle");
}
