import "server-only";
import type { CalendarCleanupAlert } from "@/app/ai-dashboard/(gated)/notification-types";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import { createServiceClient } from "@/lib/supabase/server";
import { accountKeyFromEmail } from "./account-key";
import { getAccessToken } from "./connections";
import { getProvider } from "./provider";

/**
 * Calendar events a deleted applicant may have left behind (#56).
 *
 * An applicant delete goes ahead when the host's calendar is no longer
 * connected, because nothing can reach the event. The event may still be in
 * the host's Google Calendar, so a record of it is kept (migration 070,
 * calendar_cleanups) and the company's bell shows a lasting alert until it is
 * dealt with:
 *
 *   - PENDING while the delete is still running: written by the delete's
 *     booking step before anything is removed, so a delete that fails later
 *     leaves no active alert saying "deleted applicant" about someone who is
 *     still there. A retry writes nothing new (one row per event, unique on
 *     company, provider, account, calendar and event id).
 *   - OPEN once the delete has fully succeeded. The database says when: the
 *     pending row's pending_application_id references the applicant ON
 *     DELETE SET NULL (070), so it turns NULL in the same statement that
 *     deletes the applicant, and only then. activateCalendarCleanups (at the
 *     end of deleteApplication) and the worker sweep activate exactly the
 *     pending rows whose applicant is gone; a delete that failed keeps the id,
 *     so nothing about it can become an alert.
 *   - RESOLVED by "Mark as removed" (an owner, an admin or the host), or
 *     automatically when the host reconnects the SAME Google account and the
 *     silent delete is confirmed (#61's rule: 410, or 404 on a calendar we can
 *     read). A different account never resolves anything: it would answer 404
 *     on its own calendar. Resolved rows are deleted after 30 days.
 *
 * The record holds no candidate data: the company, the host (and a snapshot of
 * the host's display name, so the alert still says whose calendar after they
 * leave), Google's own event id, the calendar, the event's time and an HMAC of
 * the account (account-key.ts). While pending it also holds the application id,
 * which the applicant's deletion clears. Every read and write here is on one
 * company, except the sweep, which reads only this table.
 */

export const CLEANUP_SWEEP_LIMIT = 50;
/**
 * Time limits: the whole sweep (or a reconnect's retries) stops starting work
 * after CLEANUP_SWEEP_MAX_MS, and one Google call is abandoned after
 * CLEANUP_CALL_TIMEOUT_MS (reported "not confirmed", tried again later). A
 * row the sweep did not reach is left exactly as it was.
 */
export const CLEANUP_SWEEP_MAX_MS = 10_000;
export const CLEANUP_CALL_TIMEOUT_MS = 5_000;
export const RESOLVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const UNIQUE = "company_id,provider,account_key,calendar_id,provider_event_id";

type Service = ReturnType<typeof createServiceClient>;

/** What the delete knows about an event it could not reach. */
export type UnreachableEvent = {
  bookingId: string;
  hostMemberId: string;
  provider: string;
  eventId: string;
  eventStart: string | null;
};

/**
 * Record (pending) an event the delete could not reach. Returns false when it
 * could not be recorded: the caller stops the delete, so an event is never left
 * with nothing pointing at it.
 */
export async function recordPendingCleanup(
  service: Service,
  companyId: string,
  applicationId: string,
  event: UnreachableEvent,
): Promise<boolean> {
  const [{ data: booking, error: bookingErr }, { data: conn }, { data: member }] =
    await Promise.all([
      service
        .from("interview_bookings")
        .select("provider_account_key")
        .eq("id", event.bookingId)
        .eq("company_id", companyId)
        .maybeSingle(),
      // Any status: a revoked or failing connection still names the account
      // and the calendar the event was written to.
      service
        .from("calendar_connections")
        .select("provider, provider_account, provider_account_key, calendar_id")
        .eq("company_id", companyId)
        .eq("member_id", event.hostMemberId)
        .maybeSingle(),
      service
        .from("company_members")
        .select("name")
        .eq("id", event.hostMemberId)
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);
  if (bookingErr) {
    console.error(`[calendar-cleanup] booking read failed: ${bookingErr.code ?? "error"}`);
    return false;
  }
  const c = conn as {
    provider: string | null;
    provider_account: string | null;
    provider_account_key: string | null;
    calendar_id: string | null;
  } | null;
  const accountKey =
    (booking as { provider_account_key: string | null } | null)?.provider_account_key ||
    c?.provider_account_key ||
    accountKeyFromEmail(event.provider, c?.provider_account) ||
    "";
  const { error } = await service.from("calendar_cleanups").upsert(
    {
      company_id: companyId,
      host_member_id: event.hostMemberId,
      host_name_snapshot: ((member as { name: string | null } | null)?.name ?? "").trim() || null,
      provider: event.provider,
      account_key: accountKey,
      calendar_id: c?.calendar_id || "primary",
      provider_event_id: event.eventId,
      event_start: event.eventStart,
      status: "pending",
      pending_application_id: applicationId,
    },
    { onConflict: UNIQUE, ignoreDuplicates: true },
  );
  if (error) {
    console.error(`[calendar-cleanup] record failed: ${error.code ?? "error"}`);
    return false;
  }
  return true;
}

/**
 * The delete has fully succeeded: pending records whose applicant is gone (the
 * foreign key set the id to NULL when the row was deleted) become lasting
 * alerts. A pending record of an applicant still there is untouched.
 */
export async function activateCalendarCleanups(companyId: string): Promise<boolean> {
  const { error } = await createServiceClient()
    .from("calendar_cleanups")
    .update({ status: "open", activated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("status", "pending")
    .is("pending_application_id", null);
  if (error) {
    // The sweep activates it once it sees the applicant gone.
    console.error(`[calendar-cleanup] activate failed: ${error.code ?? "error"}`);
    return false;
  }
  return true;
}

/** Owners and admins see every open alert; any other member only their own. */
const seesAll = (ctx: CompanyContext) => ctx.role === "owner" || ctx.role === "admin";

export async function listOpenCleanups(ctx: CompanyContext): Promise<CalendarCleanupAlert[]> {
  if (!ctx.memberId) return [];
  let q = createServiceClient()
    .from("calendar_cleanups")
    .select("id, host_member_id, host_name_snapshot, event_start")
    .eq("company_id", ctx.companyId)
    .eq("status", "open")
    .order("event_start", { ascending: true })
    .limit(50);
  if (!seesAll(ctx)) q = q.eq("host_member_id", ctx.memberId);
  const { data, error } = await q;
  if (error) {
    console.error(`[calendar-cleanup] list failed: ${error.code ?? "error"}`);
    return [];
  }
  return (
    (data ?? []) as {
      id: string;
      host_member_id: string | null;
      host_name_snapshot: string | null;
      event_start: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    mine: r.host_member_id === ctx.memberId,
    hostName: r.host_name_snapshot,
    eventStart: r.event_start,
  }));
}

/** "Mark as removed": an owner, an admin or the host, on an open alert of their company. */
export async function markCleanupRemoved(ctx: CompanyContext, id: string): Promise<boolean> {
  if (!ctx.memberId || !id) return false;
  let q = createServiceClient()
    .from("calendar_cleanups")
    .update({
      status: "resolved",
      resolution: "marked_removed",
      resolved_at: new Date().toISOString(),
      resolved_by_member_id: ctx.memberId,
    })
    .eq("id", id)
    .eq("company_id", ctx.companyId)
    .eq("status", "open");
  if (!seesAll(ctx)) q = q.eq("host_member_id", ctx.memberId);
  const { data, error } = await q.select("id");
  if (error) {
    console.error(`[calendar-cleanup] resolve failed: ${error.code ?? "error"}`);
    return false;
  }
  return (data ?? []).length === 1;
}

type OpenRow = {
  id: string;
  company_id: string;
  host_member_id: string | null;
  provider: string;
  account_key: string;
  calendar_id: string;
  provider_event_id: string;
};

/** Try the silent delete for records of one host on this account; resolve the confirmed ones. */
async function deleteForHost(
  service: Service,
  memberId: string,
  provider: string,
  rows: OpenRow[],
  deadlineAt: number,
): Promise<{ resolved: number; tried: number }> {
  if (rows.length === 0 || Date.now() >= deadlineAt) return { resolved: 0, tried: 0 };
  const api = getProvider(provider);
  const token = api?.deleteEvent ? await getAccessToken(memberId, provider as "google") : null;
  let resolved = 0;
  let tried = 0;
  for (const r of rows) {
    const left = deadlineAt - Date.now();
    if (left <= 0) break;
    tried += 1;
    const gone =
      token && api?.deleteEvent
        ? await api.deleteEvent(token, {
            calendarId: r.calendar_id,
            eventId: r.provider_event_id,
            silent: true,
            signal: AbortSignal.timeout(Math.min(CLEANUP_CALL_TIMEOUT_MS, left)),
          })
        : false;
    const now = new Date().toISOString();
    const { error } = await service
      .from("calendar_cleanups")
      .update(
        gone
          ? { status: "resolved", resolution: "deleted_on_reconnect", resolved_at: now }
          : { last_attempt_at: now, last_error_code: token ? "not_confirmed" : "no_token" },
      )
      .eq("id", r.id)
      .eq("company_id", r.company_id)
      .eq("status", "open");
    if (!error && gone) resolved += 1;
  }
  return { resolved, tried };
}

/**
 * The host just connected Google: their open alerts for THIS account (by
 * key: by id or by address, account-key.ts accountKeysOf) are retried. Never
 * throws: a failed cleanup must not break the connection that triggered it.
 */
export async function resolveCleanupsOnReconnect(args: {
  companyId: string;
  memberId: string;
  provider: string;
  accountKeys: string[];
}): Promise<number> {
  try {
    const keys = args.accountKeys.filter(Boolean);
    if (keys.length === 0) return 0;
    const service = createServiceClient();
    const { data, error } = await service
      .from("calendar_cleanups")
      .select(
        "id, company_id, host_member_id, provider, account_key, calendar_id, provider_event_id",
      )
      .eq("company_id", args.companyId)
      .eq("host_member_id", args.memberId)
      .eq("provider", args.provider)
      .eq("status", "open")
      .in("account_key", keys)
      .limit(CLEANUP_SWEEP_LIMIT);
    if (error) return 0;
    const step = await deleteForHost(
      service,
      args.memberId,
      args.provider,
      (data ?? []) as OpenRow[],
      Date.now() + CLEANUP_SWEEP_MAX_MS,
    );
    return step.resolved;
  } catch (err) {
    console.error("[calendar-cleanup] reconnect cleanup failed:", (err as Error)?.name);
    return 0;
  }
}

/**
 * The worker's backstop (each tick, at most CLEANUP_SWEEP_LIMIT rows tried):
 *   1. pending rows whose applicant is gone (the foreign key cleared the id:
 *      the delete succeeded, its activation write did not) become open;
 *   2. open rows whose host has an ACTIVE connection on the SAME account are
 *      retried, as on reconnect;
 *   3. resolved rows older than 30 days are deleted.
 * One company at a time, every read and write on that company. The only step
 * that looks across companies is calendar_cleanup_companies (migration 070), a
 * database function that returns company ids that have work and nothing else.
 *
 * Bounded so it cannot hold up the worker: it starts nothing after
 * `deadlineAt` or CLEANUP_SWEEP_MAX_MS, whichever is first, each Google call
 * is cut off at CLEANUP_CALL_TIMEOUT_MS, and a company that fails is logged
 * and skipped without stopping the others. Never throws.
 */
export async function sweepCalendarCleanups(
  opts: { now?: number; deadlineAt?: number } = {},
): Promise<{
  activated: number;
  resolved: number;
  purged: number;
  failed: number;
}> {
  const now = opts.now ?? Date.now();
  const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, Date.now() + CLEANUP_SWEEP_MAX_MS);
  const out = { activated: 0, resolved: 0, purged: 0, failed: 0 };
  if (Date.now() >= deadlineAt) return out;
  try {
    const service = createServiceClient();
    const { data: companyRows, error } = await service.rpc("calendar_cleanup_companies", {
      p_limit: CLEANUP_SWEEP_LIMIT,
    });
    if (error) {
      console.error(`[calendar-cleanup] sweep: company list failed: ${error.code ?? "error"}`);
      return out;
    }
    const companies = ((companyRows ?? []) as unknown[])
      .map((r) =>
        typeof r === "string"
          ? r
          : (r as { calendar_cleanup_companies?: string })?.calendar_cleanup_companies,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    let budget = CLEANUP_SWEEP_LIMIT;
    for (const companyId of companies) {
      if (Date.now() >= deadlineAt) break;
      let step: Awaited<ReturnType<typeof sweepCompany>>;
      try {
        step = await sweepCompany(service, companyId, now, budget, deadlineAt);
      } catch (err) {
        out.failed += 1;
        console.error("[calendar-cleanup] sweep: one company failed:", (err as Error)?.name);
        continue;
      }
      out.activated += step.activated;
      out.resolved += step.resolved;
      out.purged += step.purged;
      budget -= step.tried;
      if (budget <= 0) break;
    }
  } catch (err) {
    console.error("[calendar-cleanup] sweep failed:", (err as Error)?.name);
  }
  return out;
}

/** The sweep for one company: every read and write on `companyId`. */
async function sweepCompany(
  service: Service,
  companyId: string,
  now: number,
  budget: number,
  deadlineAt: number,
): Promise<{ activated: number; resolved: number; purged: number; tried: number }> {
  // 1. Applicants deleted (the foreign key cleared the id) but not activated.
  const { data: activated } = await service
    .from("calendar_cleanups")
    .update({ status: "open", activated_at: new Date(now).toISOString() })
    .eq("company_id", companyId)
    .eq("status", "pending")
    .is("pending_application_id", null)
    .select("id");

  // 2. Open rows, retried only for a host connected on the same account.
  const { data: open } = await service
    .from("calendar_cleanups")
    .select("id, company_id, host_member_id, provider, account_key, calendar_id, provider_event_id")
    .eq("company_id", companyId)
    .eq("status", "open")
    .neq("account_key", "")
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(0, budget));
  const byHost = new Map<string, OpenRow[]>();
  for (const r of (open ?? []) as OpenRow[]) {
    if (!r.host_member_id) continue;
    const k = `${r.host_member_id}|${r.provider}`;
    byHost.set(k, [...(byHost.get(k) ?? []), r]);
  }
  let resolved = 0;
  let tried = 0;
  for (const rows of byHost.values()) {
    if (Date.now() >= deadlineAt) break;
    const { host_member_id, provider } = rows[0];
    const { data: conn } = await service
      .from("calendar_connections")
      .select("provider_account, provider_account_key")
      .eq("company_id", companyId)
      .eq("member_id", host_member_id as string)
      .eq("provider", provider)
      .eq("status", "active")
      .maybeSingle();
    const c = conn as {
      provider_account: string | null;
      provider_account_key: string | null;
    } | null;
    if (!c) continue;
    const keys = [c.provider_account_key, accountKeyFromEmail(provider, c.provider_account)].filter(
      Boolean,
    );
    const same = rows.filter((r) => keys.includes(r.account_key));
    const step = await deleteForHost(service, host_member_id as string, provider, same, deadlineAt);
    tried += step.tried;
    resolved += step.resolved;
  }

  // 3. Resolved more than 30 days ago.
  const { data: purged } = await service
    .from("calendar_cleanups")
    .delete()
    .eq("company_id", companyId)
    .eq("status", "resolved")
    .lt("resolved_at", new Date(now - RESOLVED_KEEP_MS).toISOString())
    .select("id");

  return {
    activated: (activated ?? []).length,
    resolved,
    purged: (purged ?? []).length,
    tried,
  };
}
