/**
 * Are the two staging test accounts USABLE, the way the dashboard decides it?
 *
 * Pure over an injected service client, so accounts.test.mjs can drive every
 * refusal with a stub and negative-controls.mjs can revert each one.
 *
 * ── What "usable" means, read from company-access.ts ─────────
 *
 * The dashboard resolves a signed-in user to a company through
 * company_members and nothing else: the FIRST active row for that user,
 * ordered by created_at then id (company-access.ts:99-105), then the company's
 * status must be "active". No membership means the login page with
 * reason=unauthorized, however valid the auth user is. So an account is
 * usable only when all of these hold:
 *
 *   1. it exists in the STAGING project's auth users (sign-in succeeded; the
 *      caller passes the userId that sign-in returned);
 *   2. its first active membership is in the fixture company, with the role
 *      the plan assumes (owner sees everything, recruiter is job-scoped);
 *   3. the fixture company is active;
 *   4. the fixture company does NOT force a password change. The gated layout
 *      (ai-dashboard/(gated)/layout.tsx:94) sends every member of a company
 *      whose row has must_change_password = true to
 *      /ai-dashboard/change-password?forced=true before any dashboard page
 *      renders. The column DEFAULTS TO TRUE (no migration defines it; the
 *      first 50-row run proved it on the fixture), so a seed that omits it
 *      writes a company nobody can reach through the browser. The seed sets
 *      it false explicitly; this check is the dashboard's own gate, repeated.
 *
 * Before the seed the account must instead be FREE: no active membership
 * anywhere, because the seed writes the one that counts and the dashboard
 * reads the first one. The auth user is created by hand (README-steps.md
 * step 7, blocker A); the company row and both membership rows are written by
 * the seed. Order: auth users first, then the seed.
 *
 * Nothing here prints an email or an id: variable names, roles and counts.
 */

/** The two accounts, by VARIABLE NAME, and the role the seed gives each. */
export const ACCOUNTS = [
  {
    label: "owner",
    emailVar: "STAGING_TEST_EMAIL",
    passwordVar: "STAGING_TEST_PASSWORD",
    role: "owner",
  },
  {
    label: "job-scoped recruiter",
    emailVar: "STAGING_SCOPED_EMAIL",
    passwordVar: "STAGING_SCOPED_PASSWORD",
    role: "recruiter",
  },
];

/** Exactly the read company-access.ts makes: first active row, created_at then id. */
async function firstActiveMembership(client, userId) {
  const { data, error } = await client
    .from("company_members")
    .select("id, company_id, role")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  if (error) throw new Error(`company_members could not be read (${error.code ?? "no code"})`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * Before the seed: the account has NO active membership anywhere.
 *
 * A membership elsewhere would be the one the dashboard resolves, since it
 * is older than the one the seed is about to write, and every harness number
 * would then describe a different company's data.
 */
export async function assertAccountFree(client, { userId, emailVar }) {
  if (!userId) throw new Error(`${emailVar}: no user id; sign-in did not return one`);
  const { count, error } = await client
    .from("company_members")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(`company_members could not be read (${error.code ?? "no code"})`);
  if (typeof count !== "number") throw new Error("company_members count came back null");
  if (count > 0) {
    throw new Error(
      `the account in ${emailVar} already has ${count} active company membership(s) in this ` +
        `project. The dashboard resolves the FIRST active row (company-access.ts), which would ` +
        `not be the one the seed writes. Use an account with no membership, or remove it.`,
    );
  }
  return 0;
}

/**
 * After the seed: the account resolves to the fixture company with the
 * expected role, and the company is active. The same read the dashboard
 * makes, so a pass here is the dashboard's own answer.
 */
export async function assertAccountUsable(client, { userId, emailVar, fixtureCompanyId, role }) {
  if (!userId) throw new Error(`${emailVar}: no user id; sign-in did not return one`);
  const m = await firstActiveMembership(client, userId);
  if (!m) {
    throw new Error(
      `the account in ${emailVar} has no active company membership: the dashboard would show ` +
        `it the login page (reason=unauthorized). The seed writes that row; either it has not ` +
        `run against this project, or it ran as a different user.`,
    );
  }
  if (m.company_id !== fixtureCompanyId) {
    throw new Error(
      `the account in ${emailVar} resolves to a company that is NOT the fixture: its first ` +
        `active membership is elsewhere, and every dashboard read would be of that company.`,
    );
  }
  if (m.role !== role) {
    throw new Error(
      `the account in ${emailVar} is a ${m.role} of the fixture company; the plan needs ${role}` +
        (role === "recruiter" ? " (owner/admin are unscoped, so #25 would measure nothing)" : ""),
    );
  }
  const { data, error } = await client
    .from("companies")
    .select("status, must_change_password")
    .eq("id", fixtureCompanyId)
    .limit(1);
  if (error) throw new Error(`companies could not be read (${error.code ?? "no code"})`);
  const status = data?.[0]?.status;
  if (status !== "active") {
    throw new Error(
      `the fixture company's status is ${JSON.stringify(status ?? null)}, not "active"; ` +
        `resolveCompanyAccess refuses every non-active company.`,
    );
  }
  const row = data?.[0];
  if (row.must_change_password === true) {
    throw new Error(
      `the fixture company's must_change_password is true: the gated layout sends every ` +
        `member to /ai-dashboard/change-password?forced=true before any dashboard page, so a ` +
        `browser login for ${emailVar} can never reach /ai-dashboard. The column defaults to ` +
        `true; the seed writes it false. Re-run the seed (teardown first).`,
    );
  }
  return { role: m.role };
}
