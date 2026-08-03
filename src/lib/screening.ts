/**
 * Screening-question semantics shared by three callers that cannot share a
 * module any other way:
 *
 *   /api/apply                     public route, scores answers at apply time
 *   ai-dashboard/jobs/actions.ts   "use server", sanitises and gates publish
 *   the jobs wizard                "use client", drives the editor UI
 *
 * It lives here rather than in lib/jobs.ts because that module imports
 * next/headers (via getInitialJobs → supabase/server), which a client component
 * may not pull in at any depth. The wizard previously imported ScreeningQuestion
 * with `import type`, which is erased at compile time and therefore harmless; a
 * VALUE import of the same module is not, and fails the Turbopack build while
 * passing tsc. lib/jobs.ts re-exports both symbols so server-side callers are
 * unaffected and there is exactly one implementation of the rule.
 *
 * ZERO runtime imports on purpose — anything added here must stay safe to load
 * in a browser bundle.
 */

/**
 * What a numeric question's `ideal` MEANS.
 *
 *   min   answer >= ideal   "years of experience"
 *   max   answer <= ideal   "current salary", "times terminated"
 *   none  collected, never tested — the number is shown to the recruiter and
 *         given to the AI as context, but there is no pass/fail
 *
 * Before this existed every numeric question was an implicit `min`, which is
 * the wrong operator for most of them: a ceiling question given a floor either
 * passes everyone or cannot be asked at all.
 */
export type NumericMode = "min" | "max" | "none";

/**
 * The mode of a numeric question, including every row written before the field
 * existed.
 *
 * The fallback is deliberately CONDITIONAL ON THE VALUE rather than a single
 * blanket default, because the stored data holds two genuinely different things
 * under one shape:
 *
 *   ideal "3"  → somebody typed a real floor. Keep scoring it as `min`;
 *                defaulting it to `none` would silently stop enforcing a
 *                threshold a company deliberately set.
 *   ideal "0"  → never a threshold at all. `answer >= 0` is a tautology on a
 *                field that cannot go below 0, so it passed every candidate —
 *                the exact bug that told a manager applicant answering 0 years,
 *                0 reports and 0 Agile that they met all three. Reading it as
 *                `none` is what it always actually meant.
 *
 * So a real number keeps its behaviour and a tautology becomes honest. No
 * migration, and no job changes its answer for a question that was genuinely
 * being tested.
 */
export function resolveNumericMode(q: {
  numeric_mode?: string | null;
  ideal?: string | null;
}): NumericMode {
  if (
    q.numeric_mode === "min" ||
    q.numeric_mode === "max" ||
    q.numeric_mode === "none"
  ) {
    return q.numeric_mode;
  }
  const n = Number.parseFloat(String(q.ideal ?? ""));
  return Number.isFinite(n) && n > 0 ? "min" : "none";
}
