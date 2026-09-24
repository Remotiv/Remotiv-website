import { createServiceClient } from "@/lib/supabase/server";
import type { TipKey } from "./tips";

/**
 * Per-member tip state.
 *
 * Keyed on company_members.id, not auth user id: someone who owns one
 * workspace and recruits in another gets tip state in each, and the
 * role-access tip means a different thing to them in each place.
 *
 * ── Tolerant on purpose ──────────────────────────────────────
 *
 * The table is created by hand in Supabase, so this runs against a database
 * that may not have it yet. Every failure answers "not dismissed", which SHOWS
 * the tip. The other direction would hide a feature notice for good because a
 * read timed out, and the card keeps its own dismissal for the session without
 * any table at all (see TipCard) — so showing it costs a card the reader can
 * close, while hiding it costs the entire point of the feature.
 *
 * It is a warn, not an error, and it is logged once per process: a missing
 * table would otherwise print on every Team render.
 */
export const TIP_TABLE = "company_member_tips";

let warned = false;

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[tips] ${TIP_TABLE} unreadable — tips will show until it exists. Dismissals hold for the session only.`,
    err,
  );
}

/** Has this member dismissed this tip? Unknown answers false. */
export async function isTipDismissed(memberId: string, key: TipKey): Promise<boolean> {
  const service = createServiceClient();
  const { data, error } = await service
    .from(TIP_TABLE)
    .select("dismissed_at")
    .eq("company_member_id", memberId)
    .eq("tip_key", key)
    .maybeSingle();

  if (error) {
    warnOnce(error);
    return false;
  }

  const row = data as { dismissed_at: string | null } | null;
  return Boolean(row?.dismissed_at);
}
