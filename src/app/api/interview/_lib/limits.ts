import { type RateLimitResult, rateLimitByKey } from "@/app/api/_lib/rate-limit";

/**
 * Every candidate interview token route's limit, in one place (#57).
 *
 * Keyed on the token (its first 64 characters), never the IP: a candidate on a
 * flaky mobile network changes address mid-interview, and the token is a
 * high-entropy secret, so these limits control cost and abuse, not guessing.
 *
 * Sized to the fastest interview a real candidate can produce, because the
 * async flow has no finite maximum: Done works from the first second, prep is
 * skippable from 8 seconds, re-records are unlimited when the job allows them,
 * and each upload is tried 3 times and then on every Retry press. About 40
 * recordings a minute is the fastest loop by hand, with up to 3 tries each, so
 * upload-url and confirm allow 120 a minute. Windows are one minute so a
 * refused candidate waits under a minute; the page holds the recording and
 * retries a 429, so a refusal costs a wait, never an answer.
 *
 * Live calls are finite: one conversation per link (live/start refuses a
 * second), at most 200 video pieces (PIECE_MAX_INDEX), retried at worst every
 * 2 seconds on a flapping network. 120 a minute covers that plus draining a
 * backlog. live/event is a record only, so it keeps 60 per 10 minutes.
 *
 * On a Redis error these FAIL OPEN: the decision comes from this instance's
 * memory, and each error is one `[rate-limit] redis-error ... group=interview
 * outcome=open` line. A candidate is never cut off because Redis is down.
 */
export const INTERVIEW_LIMITS = {
  "interview-submit": { max: 10, windowMs: 60_000 },
  "interview-upload-url": { max: 120, windowMs: 60_000 },
  "interview-confirm": { max: 120, windowMs: 60_000 },
  "interview-playback": { max: 60, windowMs: 60_000 },
  "interview-consent": { max: 10, windowMs: 60_000 },
  "live-start": { max: 10, windowMs: 60_000 },
  "live-consent": { max: 10, windowMs: 60_000 },
  "live-event": { max: 60, windowMs: 10 * 60_000 },
  "live-video-upload": { max: 120, windowMs: 60_000 },
  "live-video-confirm": { max: 120, windowMs: 60_000 },
} as const satisfies Record<string, { max: number; windowMs: number }>;

export type InterviewLimitRoute = keyof typeof INTERVIEW_LIMITS;

/** The route's limit for this interview token. */
export function limitInterview(route: InterviewLimitRoute, token: string): RateLimitResult {
  return rateLimitByKey(`${route}:${token.slice(0, 64)}`, {
    ...INTERVIEW_LIMITS[route],
    group: "interview",
  });
}
