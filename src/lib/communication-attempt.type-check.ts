/**
 * Compile-time guards for communication-attempt.ts (#85, 3a-2). Checked by
 * `tsc --noEmit` and never imported.
 *
 * Each line below MUST fail to type-check. If the types are ever loosened so
 * one of them compiles, its @ts-expect-error directive is unused and tsc fails.
 * The rule they hold: an owned attempt never carries a null stamp, so no
 * guarded write can ever be handed `.eq("attempt_started_at", null)`, which
 * matches nothing, silently, for ever.
 */
import type { AttemptStamp, OwnedAttempt } from "./communication-attempt";

declare const observed: AttemptStamp | null;

// @ts-expect-error an owned attempt can never hold a null stamp
export const ownedWithNullStamp: OwnedAttempt = { id: "x", stamp: null };

// @ts-expect-error an observed stamp, which may be null, is not an owned one
export const ownedFromObserved: OwnedAttempt = { id: "x", stamp: observed };

// @ts-expect-error a plain string is not a stamp: only the parsers make one
export const ownedFromString: OwnedAttempt = { id: "x", stamp: "2026-11-16T10:00:05.123456+00:00" };
