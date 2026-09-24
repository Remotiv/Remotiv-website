"use server";

import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { TIP_TABLE } from "@/app/ai-dashboard/lib/tip-state";
import { isTipKey } from "@/app/ai-dashboard/lib/tips";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Record that this member has dismissed a tip.
 *
 * ── Never throws ─────────────────────────────────────────────
 *
 * `recorded: false` is a normal answer, not an error path. The table is created
 * by hand in Supabase, so until it exists every call takes this branch — and a
 * rejected action would surface in the client as an unhandled promise on a
 * button whose only job is to close a card. The caller hides the tip first and
 * treats this as best-effort; see TipCard.
 *
 * The member id is resolved here from the session, never accepted from the
 * client: a member id off the wire is not evidence of anything, the same reason
 * canAccessJob re-reads the assignment server-side.
 */
export async function dismissTip(key: string): Promise<{ recorded: boolean }> {
  // Narrowed before it reaches a query, so an arbitrary string cannot become a
  // row nothing will ever read.
  if (!isTipKey(key)) return { recorded: false };

  try {
    const ctx = await getCompanyContext();
    const service = createServiceClient();

    const { error } = await service.from(TIP_TABLE).upsert(
      {
        company_member_id: ctx.memberId,
        tip_key: key,
        dismissed_at: new Date().toISOString(),
      },
      { onConflict: "company_member_id,tip_key" },
    );

    if (error) {
      console.warn(`[tips] could not record dismissal of ${key}:`, error.message);
      return { recorded: false };
    }
    return { recorded: true };
  } catch (err) {
    // Includes CompanyAccessDenied — a signed-out caller cannot have reached
    // the card, and either way this is not the place to route them anywhere.
    console.warn(`[tips] dismissal of ${key} failed:`, err);
    return { recorded: false };
  }
}
