"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";

// Hoisted from getCvSignedUrl so the shared signing helper (Phase 4 E2)
// can reference the same TTL.
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Phase 4 E2: shared signing helper. Takes a pre-resolved cv_path so the
// caller does NOT re-issue the unlock_events verify + talent_profiles lookup
// round-trips that it has already done. Used by:
//   - unlockCandidate (immediately after its Promise.all — verify+contact)
//   - getCvSignedUrl (after its admin / unlock_events / cv_path resolution)
// Audit log is fire-and-forget (Phase 4 E5): never blocks the response.
async function signCvUrlAndLog(params: {
  userId: string;
  candidateId: string;
  cvPath: string;
  wasAdmin: boolean;
  sourceTable: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: "internal_error" }> {
  const service = createServiceClient();
  const { data: signed, error: signErr } = await service.storage
    .from("cvs")
    .createSignedUrl(params.cvPath, CV_SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: "internal_error" };
  }
  // Phase 4 E5: fire-and-forget audit log. We deliberately do NOT await this:
  // a failed insert must never block a successful signed-URL grant. Errors
  // are surfaced via console.error so they show up in Vercel logs.
  service
    .from("signed_url_logs")
    .insert({
      user_id: params.userId,
      candidate_id: params.candidateId,
      source_table: params.sourceTable,
      was_admin: params.wasAdmin,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });
  return { ok: true, url: signed.signedUrl };
}

// Phase 4 E2: extracted from getCvSignedUrl's inline fallback. When cv_path
// is missing, derive it from a legacy public cv_url string.
function deriveCvPathFromUrl(cvUrl: string | null | undefined): string | null {
  if (!cvUrl) return null;
  const match = String(cvUrl).match(
    /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
  );
  return match ? match[1] : null;
}

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

  // Phase 4 E1: parallelize the two independent post-RPC reads. The unlock_events
  // re-verify (issue #16 defense-in-depth) and the contact-field fetch only need
  // (user_id, candidate_id) — they're independent. cv_path is folded into the
  // same SELECT so we can sign the URL inline below without a third round-trip
  // through getCvSignedUrl (Phase 4 E2).
  const sc = createServiceClient();
  const [verifyResult, candidateResult] = await Promise.all([
    auth
      .from("unlock_events")
      .select("id")
      .eq("user_id", user.id)
      .eq("candidate_id", candidateId)
      .maybeSingle(),
    sc
      .from("talent_profiles")
      .select("email, phone, linkedin_url, cv_url, cv_path")
      .eq("id", candidateId)
      .maybeSingle(),
  ]);

  if (verifyResult.error || !verifyResult.data) {
    return {
      success: false,
      error: "internal_error",
      message: "Unlock verification failed. Please contact support.",
    };
  }
  if (candidateResult.error || !candidateResult.data) {
    return {
      success: false,
      error: "internal_error",
      message: "Unlock recorded but contact fetch failed. Refresh the page.",
    };
  }
  const candidate = candidateResult.data;

  // Phase 4 E2: sign the CV URL inline using the cv_path we just fetched.
  // Skips the redundant admin + unlock_events + cv_path round-trips that
  // getCvSignedUrl(candidateId) would re-execute. unlockCandidate is the
  // subscriber path; wasAdmin is false (admin clicks go through /admin/talent
  // → getCvSignedUrl directly, which preserves the admin branch).
  let cvUrlForPayload: string | null = null;
  const cvPath = candidate.cv_path ?? deriveCvPathFromUrl(candidate.cv_url);
  if (cvPath) {
    const signed = await signCvUrlAndLog({
      userId: user.id,
      candidateId,
      cvPath,
      wasAdmin: false,
      sourceTable: "talent_profiles",
    });
    if (signed.ok) cvUrlForPayload = signed.url;
  }

  return {
    success: true,
    alreadyUnlocked: result.already_unlocked,
    creditsRemaining: result.credits_remaining,
    unlockedAt: result.unlocked_at,
    candidateId,
    email: candidate.email,
    phone: candidate.phone,
    linkedinUrl: candidate.linkedin_url,
    cvUrl: cvUrlForPayload,
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

  // Phase 4: collapse the read-then-write 2-step into a single round-trip
  // for the unsave path. `.delete().select("id")` returns the deleted rows so
  // we know whether anything was actually removed — no separate existence check.
  // If 0 rows were deleted (i.e. nothing was saved), fall through to INSERT.
  const { data: deletedRows, error: deleteError } = await supabase
    .from("saved_profiles")
    .delete()
    .eq("user_id", user.id)
    .eq("candidate_id", candidateId)
    .select("id");

  if (deleteError) {
    return { success: false, error: "Could not check saved status" };
  }

  if (deletedRows && deletedRows.length > 0) {
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

// CV_SIGNED_URL_TTL_SECONDS is declared at the top of this file so the
// shared signCvUrlAndLog helper (Phase 4 E2) can reference it.

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
  const cvPath =
    (candidateRow.cv_path as string | null) ??
    deriveCvPathFromUrl(candidateRow.cv_url as string | null);
  if (!cvPath) {
    return { ok: false, error: "cv_missing" };
  }

  // Phase 4 E2: storage sign + audit insert delegated to the shared helper.
  // Audit log is fire-and-forget inside signCvUrlAndLog (Phase 4 E5).
  return signCvUrlAndLog({
    userId: user.id,
    candidateId,
    cvPath,
    wasAdmin: isAdmin,
    sourceTable: "talent_profiles",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// B3/J2: refreshTier
// Lightweight server action to re-read the current user's subscription tier
// + credits_remaining. Called from the client on window focus events to detect
// mid-session subscription changes (e.g. user subscribed/cancelled in another
// tab). Mirrors the exact tier-detection logic used by page.tsx + toggleSave.
// ────────────────────────────────────────────────────────────────────────────

type RefreshTierResult =
  | { ok: true; tier: "free" | "subscriber"; creditsRemaining: number | null }
  | { ok: false; error: "not_authenticated" | "internal_error" };

export async function refreshTier(): Promise<RefreshTierResult> {
  const auth = await createClient();
  const { data: authData } = await auth.auth.getUser();
  const user = authData.user;
  if (!user) {
    return { ok: false, error: "not_authenticated" };
  }

  const service = createServiceClient();
  const { data: subRow, error: subErr } = await service
    .from("subscriptions")
    .select("tier, credits_remaining")
    .eq("user_id", user.id)
    .maybeSingle();

  if (subErr) {
    return { ok: false, error: "internal_error" };
  }

  let tier: "free" | "subscriber" = "free";
  let creditsRemaining: number | null = null;
  if (subRow && (subRow.tier === "starter" || subRow.tier === "pro")) {
    tier = "subscriber";
    creditsRemaining = subRow.credits_remaining ?? 0;
  }

  return { ok: true, tier, creditsRemaining };
}
