"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { DEFAULT_WORKING_RULES, parseRules, type WorkingRule } from "@/lib/calendar/availability";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * A member's default interview hours.
 *
 * Per MEMBER, like the calendar connection itself — these are the hours this
 * recruiter will take interviews in, not a company policy. Every function
 * re-derives the caller from their session and scopes to that member; none
 * takes a member id, which is the strongest form of that guarantee.
 *
 * Hours are stored as MINUTES FROM LOCAL MIDNIGHT against a weekday, never as
 * timestamps. They are a repeating intention — "Tuesdays, 9 til 5" — and the
 * instant that intention resolves to is different on a DST changeover day.
 * Storing instants would silently shift a recruiter's whole week twice a year.
 * The zone they are interpreted in is the calendar's own, from
 * calendar_connections.timezone.
 */

export type HoursResult = { ok: boolean; rules: WorkingRule[]; error?: string };

export async function fetchWorkingHours(): Promise<WorkingRule[]> {
  const ctx = await getCompanyContext();
  if (!ctx.memberId) return DEFAULT_WORKING_RULES;

  const service = createServiceClient();
  const { data, error } = await service
    .from("availability_rules")
    .select("weekday, start_minute, end_minute")
    .eq("member_id", ctx.memberId)
    .order("weekday", { ascending: true });

  if (error) {
    console.error("[availability] fetchWorkingHours failed:", error.message);
    return DEFAULT_WORKING_RULES;
  }

  const rows = (data ?? []) as { weekday: number; start_minute: number; end_minute: number }[];
  // No rows means "never set", which shows the default rather than an empty
  // week — an empty week would offer a candidate nothing and look broken.
  if (rows.length === 0) return DEFAULT_WORKING_RULES;

  return rows.map((r) => ({
    weekday: r.weekday,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
  }));
}

/**
 * Replace the member's rules wholesale.
 *
 * Delete-then-insert rather than a diff: the set is at most seven small rows,
 * a diff would need a stable identity per row that the UI does not have, and a
 * partially-applied week is a worse failure than a re-inserted one.
 *
 * Validated through the same `parseRules` availability uses, so a malformed
 * range cannot be stored here and then silently dropped at read time — the two
 * would disagree about what the recruiter had saved.
 */
export async function saveWorkingHours(raw: unknown): Promise<HoursResult> {
  const ctx = await getCompanyContext();
  if (!ctx.memberId) {
    return {
      ok: false,
      rules: DEFAULT_WORKING_RULES,
      error: "This account has no team member record.",
    };
  }

  const rules = parseRules(raw);
  if (rules.length === 0) {
    return {
      ok: false,
      rules: await fetchWorkingHours(),
      error: "Set at least one day, with a finish time after the start.",
    };
  }

  const service = createServiceClient();
  const { error: delErr } = await service
    .from("availability_rules")
    .delete()
    .eq("member_id", ctx.memberId);

  if (delErr) {
    console.error("[availability] clear failed:", delErr.message);
    return { ok: false, rules: await fetchWorkingHours(), error: "Could not save. Try again." };
  }

  const { error: insErr } = await service.from("availability_rules").insert(
    rules.map((r) => ({
      company_id: ctx.companyId,
      member_id: ctx.memberId,
      weekday: r.weekday,
      start_minute: r.startMinute,
      end_minute: r.endMinute,
    })),
  );

  if (insErr) {
    console.error("[availability] insert failed:", insErr.message);
    return { ok: false, rules: DEFAULT_WORKING_RULES, error: "Could not save. Try again." };
  }

  revalidatePath("/ai-dashboard/settings");
  return { ok: true, rules };
}
