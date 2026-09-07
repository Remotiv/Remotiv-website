import "server-only";
import type { SourceTable } from "@/app/talent/lib/profile-owner";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Record that a person did something with their own profile.
 *
 * ── What counts, and what deliberately does not ──────────────
 *
 * Signing in, and changing anything on the profile. That is the whole list. A
 * profile being matched, searched or viewed is NOT activity: the retention
 * basis is consent, and if our own use of a profile extended the period we may
 * hold it, the consent would renew itself without the person doing anything.
 *
 * See lib/talent-retention.ts for the rule this feeds.
 *
 * ── Never throws, never blocks ───────────────────────────────
 *
 * This runs on the dashboard's render path and inside every save. A failure
 * here must not fail the thing the person was actually doing — the cost of a
 * missed touch is that the clock is a little behind, and any later visit or
 * save corrects it. So it swallows, logs, and returns.
 *
 * ── It also clears the warning ───────────────────────────────
 *
 * Coming back IS keeping the profile. Clearing retention_warned_at (and the
 * one-click token with it) makes the profile stop matching the purge selector
 * immediately, so someone who signs in after the warning email is safe without
 * having to find that email.
 */
export async function touchLastActive(
  profileId: string,
  sourceTable: SourceTable = "talent_profiles",
): Promise<void> {
  // hire_remote_profiles is a different pool with its own lifecycle; the
  // 24-month rule was decided for the talent pool only.
  if (sourceTable !== "talent_profiles") return;

  try {
    const { error } = await createServiceClient()
      .from("talent_profiles")
      .update({
        last_active_at: new Date().toISOString(),
        retention_warned_at: null,
        retention_keep_token_hash: null,
      })
      .eq("id", profileId);
    if (error) console.error("[talent-activity] touch failed:", error.message);
  } catch (err) {
    console.error("[talent-activity] touch threw:", err);
  }
}

/**
 * The same touch, matched by auth user rather than profile id.
 *
 * The dashboard layout has a session, not a profile — and matching on user_id
 * means this can only ever reach the caller's own row, which is the property
 * that makes it safe to call on a render path.
 */
export async function touchLastActiveForUser(userId: string): Promise<void> {
  try {
    const { error } = await createServiceClient()
      .from("talent_profiles")
      .update({
        last_active_at: new Date().toISOString(),
        retention_warned_at: null,
        retention_keep_token_hash: null,
      })
      .eq("user_id", userId);
    if (error) console.error("[talent-activity] touch-by-user failed:", error.message);
  } catch (err) {
    console.error("[talent-activity] touch-by-user threw:", err);
  }
}
