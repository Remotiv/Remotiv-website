/**
 * A read that can say "I could not ask".
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * `Promise<T | null>` has two states where the domain has three: answered-and-
 * found, answered-and-not-found, and could-not-ask. The third has nowhere to
 * go, so it arrives as `null` — and every caller reads `null` as "not found"
 * and renders a 404. A live job page shows "this role no longer exists"; a
 * valid booking link shows "this link isn't valid". The reader has no reason to
 * retry, so they don't. They leave.
 *
 * The same collapse happens to `Promise<number>` (a failed count renders 0) and
 * `Promise<T[]>` (a failed list renders "nothing here"). This type is for all
 * of them: it WRAPS the value rather than replacing it, so `null` keeps meaning
 * "not found", `[]` keeps meaning "empty", `0` keeps meaning "none" — and
 * "could not ask" stops having to impersonate one of them.
 *
 * ── Not a new idea in this codebase ──────────────────────────
 *
 * CompanyAccess already distinguishes a refusal from a failed lookup, and the
 * whole login gate turns on it: `not_company` signs you out, `unavailable`
 * asks you to try again. Serving one as the other was the bug. This is that
 * distinction applied to reads instead of verdicts.
 *
 * ── Why this file ────────────────────────────────────────────
 *
 * IT MUST NEVER GAIN A "use server" DIRECTIVE — the same constraint as
 * paging.ts beside it. A `"use server"` module compiles every export into a
 * server action, and parts of `src/lib` do carry the directive, so "somewhere
 * in lib" is not sufficient. `src/lib/supabase/` is clean, and every caller of
 * this type is wrapping a Supabase read.
 */

/**
 * ── Writing the copy for the unknown state ───────────────────
 *
 * You are reaching for this type because a surface is about to tell someone
 * something it cannot support. Four rules, learned from the ones that got it
 * wrong:
 *
 * 1. A FAILURE makes a claim about US; an ABSENCE makes a claim about their
 *    workspace. "No applicants yet" is a fact about their company. "We couldn't
 *    load…" is a fact about our system. A failure must never borrow an
 *    absence's words.
 *
 * 2. SAY WHAT IS STILL TRUE. Each of these has a specific fear behind it — my
 *    messages were deleted, I was removed from the job, the interview fell
 *    through. Naming what survived is what stops the wrong conclusion.
 *
 * 3. ONE ACTION, AND MAKE IT CHEAP. Reload. Reopen. Never "contact support"
 *    for something a refresh fixes.
 *
 * 4. NEVER EXPLAIN HOW THE FEATURE WORKS IN A FAILURE STATE. It reads as a
 *    guarantee. "Every email sent to a candidate lands here" is the right thing
 *    to tell a genuinely empty inbox — it teaches a new user what to expect.
 *    Said over a read that failed, it is a promise the page is simultaneously
 *    breaking, and it is what made a recruiter conclude their messages were
 *    gone. Absence states TEACH; failure states APOLOGISE. Do not mix them.
 *
 * Sentence pattern: [what happened]. [what is still true] — [what to do].
 * Render it as title + body where there is room, and as one sentence inline
 * where a heading would read as a section title. Same voice either way: it is
 * the same reader, the same fear, and the same remedy.
 */

export type Read<T> =
  | { ok: true; value: T }
  /**
   * The question could not be asked. Deliberately carries no detail: callers
   * decide what to SAY, and the diagnostic belongs in the server log where the
   * failure happened, not in a string travelling to a browser.
   */
  | { ok: false };

/** The read succeeded. `value` may still be null, [] or 0 — those are answers. */
export function answered<T>(value: T): Read<T> {
  return { ok: true, value };
}

/** The read failed. Not "nothing" — unknown. */
export function unavailable<T>(): Read<T> {
  return { ok: false };
}

/**
 * The value, or a fallback if the read failed.
 *
 * For callers that genuinely cannot act on the difference — a background job
 * that will run again, a decorative panel. Every use is a place that has
 * decided the distinction does not matter, so it should be rare and obvious.
 */
export function orElse<T>(read: Read<T>, fallback: T): T {
  return read.ok ? read.value : fallback;
}
