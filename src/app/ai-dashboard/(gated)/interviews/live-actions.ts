"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  runLiveRecovery,
  signLiveTurnAudio,
  signLiveVideoPiece,
} from "@/lib/interviews/live-review";
import type {
  LiveActionResult,
  LiveAudioResult,
  LiveRecoveryRequest,
} from "@/lib/interviews/live-review-types";

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

/** Retry a transcription, or resolve a timing, repeat or style check or a failed transcription. */
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
