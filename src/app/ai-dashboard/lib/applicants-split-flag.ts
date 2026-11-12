/**
 * Whether a company sees the Applicants "Split" page (list left, details
 * panel right; docs/design/Applicants_Split_v9.md).
 *
 * ── Off unless deliberately turned on ────────────────────────
 *
 * On only when APPLICANTS_SPLIT_ENABLED is exactly "1", like
 * LIVE_INTERVIEW_SCREEN_ENABLED and ADMIN_LIVE_REVIEW_ENABLED. Missing, empty,
 * "true", "0", " 1" and anything else are off, and the live Applicants page
 * renders as before. Read on the server at call time; never NEXT_PUBLIC_.
 *
 * APPLICANTS_SPLIT_COMPANIES, when it names at least one company id
 * (comma-separated, spaces around each id ignored), narrows "on" to those
 * companies: a pilot without a migration. Left unset or empty, "on" means
 * every company. It cannot turn Split on by itself.
 *
 * `env` is a parameter so the rule is tested as a pure function; callers pass
 * nothing and get process.env.
 */
export function isApplicantsSplitOn(
  companyId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.APPLICANTS_SPLIT_ENABLED !== "1") return false;
  const pilot = (env.APPLICANTS_SPLIT_COMPANIES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (pilot.length === 0) return true;
  return typeof companyId === "string" && pilot.includes(companyId);
}
