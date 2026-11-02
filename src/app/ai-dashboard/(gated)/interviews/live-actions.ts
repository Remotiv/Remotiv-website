"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { decideRestart, resendRestartLink } from "@/lib/interviews/live-restart-flow";
import {
  runLiveRecovery,
  signLiveTurnAudio,
  signLiveVideoPiece,
} from "@/lib/interviews/live-review";
import type {
  LiveActionResult,
  LiveAudioResult,
  LiveRecoveryRequest,
  LiveRestartDecideResult,
  LiveRestartResendResult,
} from "@/lib/interviews/live-review-types";
import { createServiceClient } from "@/lib/supabase/server";

// The AI Video Interview review's server actions. Thin: every rule (company,
// hiring team, role, latest attempt, the recovery itself) is in
// lib/interviews/live-review.ts, where it is tested.

async function viewer() {
  try {
    return await getCompanyContext();
  } catch {
    return null;
  }
}

/** A signed URL for one turn's audio. */
export async function getLiveTurnAudioUrl(
  sessionId: string,
  turnId: string,
): Promise<LiveAudioResult> {
  const ctx = await viewer();
  if (!ctx) return { ok: false, error: "Sign in to your workspace first." };
  return signLiveTurnAudio(ctx, sessionId, turnId);
}

/** Retry a transcription, or resolve a timing, repeat, wording or style check or a failed transcription. */
export async function runLiveReviewAction(request: LiveRecoveryRequest): Promise<LiveActionResult> {
  const ctx = await viewer();
  if (!ctx) return { ok: false, error: "Sign in to your workspace first." };
  const result = await runLiveRecovery(ctx, request);
  if (result.ok) revalidatePath(`/ai-dashboard/interviews/${request.sessionId}`);
  return result;
}

/** A signed URL for one confirmed piece of the candidate's camera video. */
export async function getLiveVideoPieceUrl(
  sessionId: string,
  pieceIndex: number,
): Promise<LiveAudioResult> {
  const ctx = await viewer();
  if (!ctx) return { ok: false, error: "Sign in to your workspace first." };
  return signLiveVideoPiece(ctx, sessionId, pieceIndex);
}

/**
 * Restart or no restart for a first attempt, with a note (F10 C5). Every rule
 * is in lib/interviews/live-restart-flow.ts.
 */
export async function decideRestartAction(
  sessionId: string,
  decision: "restart" | "no_restart",
  note: string,
): Promise<LiveRestartDecideResult> {
  const ctx = await viewer();
  if (!ctx) return { ok: false, code: "signed_out" };
  const result = await decideRestart(
    ctx,
    { sessionId, decision, note },
    { service: createServiceClient() },
  );
  if (result.ok) revalidatePath(`/ai-dashboard/interviews/${sessionId}`);
  return result;
}

/** Send the restart link again, for the same attempt 2. */
export async function resendRestartLinkAction(
  restartSessionId: string,
): Promise<LiveRestartResendResult> {
  const ctx = await viewer();
  if (!ctx) return { ok: false, code: "signed_out" };
  const result = await resendRestartLink(ctx, restartSessionId, { service: createServiceClient() });
  if (result.ok) revalidatePath(`/ai-dashboard/interviews/${restartSessionId}`);
  return result;
}
