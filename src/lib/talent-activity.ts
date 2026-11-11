import "server-only";
import type { SourceTable } from "@/app/talent/lib/profile-owner";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Record that a person did something with their own profile.
 *
 * Writes `last_active_at` and nothing else. Signing in and changing anything
 * on the profile count; a profile being matched, searched or viewed does not.
 * Nothing reads the column for retention: talent-pool profiles are kept until
 * the person asks (privacy page, section 3), and the retention jobs that once
 * would have read it were removed on 11 Nov 2026 (#61).
 *
 * ── Do not re-add the retention columns ──────────────────────
 *
 * This update used to set `retention_warned_at` and `retention_keep_token_hash`
 * as well. retention_keep_token_hash does not exist in production, so every
 * one of these writes failed whole and last_active_at was never recorded.
 * Any column added back here needs its migration first.
 *
 * ── Never throws, never blocks ───────────────────────────────
 *
 * This runs on the dashboard's render path and inside every save. A failure
 * here must not fail the thing the person was actually doing - the cost of a
 * missed touch is that the clock is a little behind, and any later visit or
 * save corrects it. So it swallows, logs, and returns.
 */
export async function touchLastActive(
  profileId: string,
  sourceTable: SourceTable = "talent_profiles",
): Promise<void> {
  // hire_remote_profiles is a different pool with its own lifecycle and has
  // no last_active_at column.
  if (sourceTable !== "talent_profiles") return;

  try {
    const { error } = await createServiceClient()
      .from("talent_profiles")
      .update({
        last_active_at: new Date().toISOString(),
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
      })
      .eq("user_id", userId);
    if (error) console.error("[talent-activity] touch-by-user failed:", error.message);
  } catch (err) {
    console.error("[talent-activity] touch-by-user threw:", err);
  }
}
