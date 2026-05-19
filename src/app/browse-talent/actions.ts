"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";

export type UnlockResult =
  | {
      success: true;
      alreadyUnlocked: boolean;
      creditsRemaining: number;
      unlockedAt: string;
      candidateId: string;
      // Contact data revealed on successful unlock — server is source of truth.
      email: string | null;
      phone: string | null;
      linkedinUrl: string | null;
      cvUrl: string | null;
    }
  | {
      success: false;
      error:
        | "not_authenticated"
        | "not_subscribed"
        | "no_credits"
        | "candidate_not_found"
        | "invalid_input"
        | "rate_limited"
        | "internal_error";
      message: string;
    };

/**
 * unlockCandidate(candidateId)
 *
 * Atomically spends 1 credit (via unlock_candidate RPC) and returns the
 * candidate's contact fields. If the user has already unlocked this
 * candidate, no credit is charged and the existing contact info is
 * returned.
 *
 * Subscribers only. Free tier or anonymous → error.
 */
export async function unlockCandidate(candidateId: string): Promise<UnlockResult> {
  // Basic input validation
  if (typeof candidateId !== "string" || candidateId.length === 0 || candidateId.length > 100) {
    return {
      success: false,
      error: "invalid_input",
      message: "Invalid candidate ID.",
    };
  }

  // Auth-aware client to confirm session + invoke RPC (RPC checks auth.uid internally)
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();

  if (!user) {
    return {
      success: false,
      error: "not_authenticated",
      message: "Please sign in to unlock contacts.",
    };
  }

  // K2: per-user rate limit. 30 unlocks/min cap to mitigate credit-drain via
  // session theft. NOTE: in-memory limiter — per-lambda counter, resets on
  // cold start, not shared across regions. Burst protection only; not a
  // hard global cap. Pair with a real WAF / Upstash Redis layer in front
  // for hard quotas.
  const unlockRate = rateLimitByKey(`unlock:${user.id}`, { max: 30, windowMs: 60_000 });
  if (!unlockRate.ok) {
    return {
      success: false,
      error: "rate_limited",
      message: "Too many unlock attempts. Please wait a moment and try again.",
    };
  }

  // Call the SECURITY DEFINER RPC — atomic decrement + insert
  const { data: rpcData, error: rpcError } = await auth.rpc("unlock_candidate", {
    p_candidate_id: candidateId,
  });

  if (rpcError) {
    // J3: Never leak raw Supabase/Postgres error messages to the client.
    // Log server-side; return a generic message.
    console.error("[unlockCandidate] RPC failed:", rpcError);
    return {
      success: false,
      error: "internal_error",
      message: "Unlock failed. Please try again.",
    };
  }

  // RPC returns JSON: { success, already_unlocked, credits_remaining, unlocked_at } | { success: false, error }
  const result = rpcData as
    | {
        success: true;
        already_unlocked: boolean;
        credits_remaining: number;
        unlocked_at: string;
      }
    | {
        success: false;
        error: "not_authenticated" | "not_subscribed" | "no_credits" | "candidate_not_found";
      };

  if (!result.success) {
    const errMessages: Record<string, string> = {
      not_authenticated: "Please sign in to unlock contacts.",
      not_subscribed: "Subscription required to unlock contacts.",
      no_credits: "You're out of credits this month.",
      candidate_not_found: "Candidate not found.",
    };
    return {
      success: false,
      error: result.error,
      message: errMessages[result.error] ?? "Unlock failed.",
    };
  }

  // Issue #16: defense in depth — verify unlock_event row exists for this
  // user+candidate before trusting the RPC return as authorization. Uses the
  // user's auth-aware client so RLS enforces "only your own unlock_events".
  const { data: unlockEvent, error: verifyError } = await auth
    .from("unlock_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (verifyError || !unlockEvent) {
    return {
      success: false,
      error: "internal_error",
      message: "Unlock verification failed. Please contact support.",
    };
  }

  // RPC succeeded and unlock_event verified — fetch contact fields via service role.
  const sc = createServiceClient();
  const { data: candidate, error: fetchError } = await sc
    .from("talent_profiles")
    .select("email, phone, linkedin_url, cv_url")
    .eq("id", candidateId)
    .maybeSingle();

  if (fetchError || !candidate) {
    // Unlock recorded but fetch failed — fail safely; user can refresh.
    return {
      success: false,
      error: "internal_error",
      message: "Unlock recorded but contact fetch failed. Refresh the page.",
    };
  }

  // K1 Phase 2: replace the raw public cv_url with a fresh 1-hour signed URL.
  // The unlock_events row was already verified above, so getCvSignedUrl finds it
  // and signs without charging a credit. Subsequent re-views call getCvSignedUrl
  // directly from the client without re-entering this RPC.
  const signedResult = await getCvSignedUrl(candidateId);

  return {
    success: true,
    alreadyUnlocked: result.already_unlocked,
    creditsRemaining: result.credits_remaining,
    unlockedAt: result.unlocked_at,
    candidateId,
    email: candidate.email,
    phone: candidate.phone,
    linkedinUrl: candidate.linkedin_url,
    cvUrl: signedResult.ok ? signedResult.url : null,
  };
}

export async function toggleSave(candidateId: string): Promise<{
  success: boolean;
  saved?: boolean;
  error?: string;
}> {
  if (typeof candidateId !== "string" || candidateId.length < 1 || candidateId.length > 100) {
    return { success: false, error: "Invalid candidate ID" };
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { success: false, error: "Not authenticated" };
  }

  // K3: per-user rate limit. 60 saves/min cap. NOTE: in-memory limiter,
  // per-lambda. See K2 comment in unlockCandidate for caveats.
  const saveRate = rateLimitByKey(`save:${user.id}`, { max: 60, windowMs: 60_000 });
  if (!saveRate.ok) {
    return {
      success: false,
      error: "Too many save toggles. Please wait a moment.",
    };
  }

  // Public browse-talent is subscription-only — admin status on /browse-talent
  // is no longer a special-case. Admins who want to save profiles must subscribe.
  // (Admin privileges remain inside /admin/talent via getCvSignedUrl's admin branch.)
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("tier")
    .eq("user_id", user.id)
    .maybeSingle();
  const isSubscriber = sub?.tier === "starter" || sub?.tier === "pro";

  if (!isSubscriber) {
    return { success: false, error: "Subscription required" };
  }

  const { data: existing, error: existingError } = await supabase
    .from("saved_profiles")
    .select("id")
    .eq("user_id", user.id)
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (existingError) {
    return { success: false, error: "Could not check saved status" };
  }

  if (existing) {
    const { error: deleteError } = await supabase
      .from("saved_profiles")
      .delete()
      .eq("id", existing.id);
    if (deleteError) {
      return { success: false, error: "Could not unsave" };
    }
    return { success: true, saved: false };
  }

  const { error: insertError } = await supabase
    .from("saved_profiles")
    .insert({ user_id: user.id, candidate_id: candidateId });
  if (insertError) {
    return { success: false, error: "Could not save" };
  }
  return { success: true, saved: true };
}

// ────────────────────────────────────────────────────────────────────────────
// K1 Phase 2: getCvSignedUrl
// Returns a fresh 1-hour signed URL for a candidate's CV.
//   - Admins: bypass unlock_events check, signed via service-role.
//   - Subscribers with an unlock_events row: signed via service-role (no credit).
//   - Anyone else: { ok: false, error: "not_unlocked" }
// Logs every successful grant to signed_url_logs.
// ────────────────────────────────────────────────────────────────────────────

type CvSignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_authenticated" | "not_unlocked" | "cv_missing" | "internal_error" };

const CV_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

export async function getCvSignedUrl(candidateId: string): Promise<CvSignedUrlResult> {
  // Input validation (same shape as unlockCandidate)
  if (typeof candidateId !== "string" || candidateId.length < 1 || candidateId.length > 100) {
    return { ok: false, error: "internal_error" };
  }

  const auth = await createClient();
  const { data: authData } = await auth.auth.getUser();
  const user = authData.user;
  if (!user) {
    return { ok: false, error: "not_authenticated" };
  }

  const service = createServiceClient();

  // Determine admin status (super-admin email shortcut OR admin_users.role)
  let isAdmin = false;
  if (user.email && user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
    isAdmin = true;
  } else {
    const { data: roleRow } = await service
      .from("admin_users")
      .select("role, status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (
      roleRow?.status === "active" &&
      (roleRow.role === "admin" || roleRow.role === "super_admin")
    ) {
      isAdmin = true;
    }
  }

  // If not admin, require an unlock_events row (auth-aware so RLS enforces ownership)
  if (!isAdmin) {
    const { data: unlockRow, error: unlockErr } = await auth
      .from("unlock_events")
      .select("id")
      .eq("user_id", user.id)
      .eq("candidate_id", candidateId)
      .maybeSingle();
    if (unlockErr || !unlockRow) {
      return { ok: false, error: "not_unlocked" };
    }
  }

  // Fetch cv_path from talent_profiles (service-role bypasses RLS)
  const { data: candidateRow, error: candidateErr } = await service
    .from("talent_profiles")
    .select("cv_path, cv_url")
    .eq("id", candidateId)
    .maybeSingle();
  if (candidateErr || !candidateRow) {
    return { ok: false, error: "cv_missing" };
  }

  // Resolve cv_path: prefer cv_path; if null, derive from cv_url for transition safety
  let cvPath = candidateRow.cv_path as string | null;
  if (!cvPath && candidateRow.cv_url) {
    const match = String(candidateRow.cv_url).match(
      /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
    );
    cvPath = match ? match[1] : null;
  }
  if (!cvPath) {
    return { ok: false, error: "cv_missing" };
  }

  // Generate signed URL via service-role
  const { data: signed, error: signErr } = await service.storage
    .from("cvs")
    .createSignedUrl(cvPath, CV_SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: "internal_error" };
  }

  // Audit log (best-effort; failure does NOT block the grant)
  try {
    await service.from("signed_url_logs").insert({
      user_id: user.id,
      candidate_id: candidateId,
      source_table: "talent_profiles",
      was_admin: isAdmin,
    });
  } catch {
    // Swallow logging failures silently — do not let logging break a successful unlock.
  }

  return { ok: true, url: signed.signedUrl };
}
