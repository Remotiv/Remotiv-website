"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";

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

  // Call the SECURITY DEFINER RPC — atomic decrement + insert
  const { data: rpcData, error: rpcError } = await auth.rpc("unlock_candidate", {
    p_candidate_id: candidateId,
  });

  if (rpcError) {
    return {
      success: false,
      error: "internal_error",
      message: rpcError.message || "Unlock failed. Please try again.",
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

  // RPC succeeded — now fetch the candidate's contact fields via service role
  // (RLS doesn't block service role; this read is safe because we just verified
  // the unlock_event row exists for this user-candidate pair).
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

  return {
    success: true,
    alreadyUnlocked: result.already_unlocked,
    creditsRemaining: result.credits_remaining,
    unlockedAt: result.unlocked_at,
    candidateId,
    email: candidate.email,
    phone: candidate.phone,
    linkedinUrl: candidate.linkedin_url,
    cvUrl: candidate.cv_url,
  };
}
