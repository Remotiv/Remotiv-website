import "server-only";
import { MAX_SESSION_SECONDS } from "@/lib/interviews/types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Whether a live interview's link opens the live candidate screen (AVI
 * commit 10), and which conversation provider it may use.
 *
 * ── Off unless deliberately turned on ────────────────────────
 *
 * On only when LIVE_INTERVIEW_SCREEN_ENABLED is exactly "1", like
 * ADMIN_LIVE_REVIEW_ENABLED. Missing, empty, "true", "0", " 1" and anything
 * else are off, and a live link resolves to "This interview isn't open yet"
 * as before. Read on the server at call time; never NEXT_PUBLIC_.
 *
 * On is still not enough for a real interview: the consent route and the
 * start route refuse while the live consent text has a placeholder in it
 * (live-consent.ts), so no candidate can get past consent until the wording
 * is final (decision, 26 Oct 2026).
 *
 * ── Mock only, never in production ───────────────────────────
 *
 * The only provider today is MockVoxAgent, a scripted stand-in that runs in
 * the browser. It is refused in a production build, so a production start
 * answers "Please try again shortly" until the real VoxAgent adapter exists.
 */
export function liveScreenEnabled(): boolean {
  return process.env.LIVE_INTERVIEW_SCREEN_ENABLED === "1";
}

export type LiveProviderMode = "mock";

/** The provider a start may use, or null: none in production yet. */
export function liveProviderMode(): LiveProviderMode | null {
  return process.env.NODE_ENV === "production" ? null : "mock";
}

/**
 * The live welcome screen's interviewer name and time limit, as frozen on the
 * session at invite (live_settings). Only those two fields are selected, as
 * JSON paths: the follow-up rules in the same column (mark-scheme adjacent,
 * live-settings.ts) are never read here, let alone sent to the page.
 */
export async function liveWelcomeFacts(
  sessionId: string,
  service: ReturnType<typeof createServiceClient> = createServiceClient(),
): Promise<{ interviewerName: string; minutes: number }> {
  const { data } = await service
    .from("interview_sessions")
    .select(
      "interviewer_name:live_settings->>interviewer_name, max_session_seconds:live_settings->max_session_seconds",
    )
    .eq("id", sessionId)
    .eq("kind", "live")
    .maybeSingle();
  const row = data as { interviewer_name: unknown; max_session_seconds: unknown } | null;
  const name = typeof row?.interviewer_name === "string" ? row.interviewer_name.trim() : "";
  const seconds =
    typeof row?.max_session_seconds === "number" && row.max_session_seconds > 0
      ? Math.min(row.max_session_seconds, MAX_SESSION_SECONDS)
      : MAX_SESSION_SECONDS;
  return {
    interviewerName: name.slice(0, 60) || "Your interviewer",
    minutes: Math.max(1, Math.round(seconds / 60)),
  };
}
