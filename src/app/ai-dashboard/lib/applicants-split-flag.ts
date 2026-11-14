/**
 * Whether a company sees the Applicants "Split" page (list left, details
 * panel right; docs/design/Applicants_Split_v9.md).
 *
 * ── On by default, with a kill switch (commit 10a) ───────────
 *
 * Split is the page for every company. APPLICANTS_SPLIT_DISABLED set to
 * exactly "1" turns the old page back on for EVERYONE: a kill switch, not a
 * per-company setting. Missing, empty, "true", "0", " 1" and anything else
 * leave Split on. Read on the server at call time; never NEXT_PUBLIC_.
 *
 * The old opt-in variables (APPLICANTS_SPLIT_ENABLED and the pilot list
 * APPLICANTS_SPLIT_COMPANIES) are no longer read: setting them does nothing.
 * Commit 10b removes the old page, this switch and its dead branches.
 *
 * `companyId` stays in the signature so the callers are unchanged until 10b.
 * `env` is a parameter so the rule is tested as a pure function; callers pass
 * nothing and get process.env.
 */
export function isApplicantsSplitOn(
  _companyId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.APPLICANTS_SPLIT_DISABLED !== "1";
}
