"use server";

import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { signPlatformTurnAudio, signPlatformVideoPiece } from "@/lib/interviews/live-review";
import type { LiveAudioResult } from "@/lib/interviews/live-review-types";

// The super admin's read-only live interview review (F4): its two recording
// links and nothing else. No recovery action lives here, and runLiveRecovery
// takes a company context only, so a super admin acts on nothing.
//
// Every call checks requireSuperAdmin again (a server action is a plain POST
// endpoint, whatever the page showed), then lib/interviews/live-review.ts
// checks the turn or piece belongs to that live session, writes the
// admin_access_logs row, and only then signs a 5-minute link.

const NOT_FOUND: LiveAudioResult = { ok: false, error: "That interview couldn't be found." };

async function superAdminId(): Promise<string | null> {
  try {
    return (await requireSuperAdmin()).user.id;
  } catch {
    return null;
  }
}

/** A signed URL for one turn's audio. */
export async function getAdminLiveTurnAudioUrl(
  sessionId: string,
  turnId: string,
): Promise<LiveAudioResult> {
  const adminUserId = await superAdminId();
  if (!adminUserId) return NOT_FOUND;
  return signPlatformTurnAudio(adminUserId, sessionId, turnId);
}

/** A signed URL for one confirmed piece of the candidate's camera video. */
export async function getAdminLiveVideoPieceUrl(
  sessionId: string,
  pieceIndex: number,
): Promise<LiveAudioResult> {
  const adminUserId = await superAdminId();
  if (!adminUserId) return NOT_FOUND;
  return signPlatformVideoPiece(adminUserId, sessionId, pieceIndex);
}
