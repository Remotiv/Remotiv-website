/**
 * The eligibility rule for /ai-dashboard.
 *
 * Run with Node's built-in runner — no test framework, no new dependency:
 *
 *   node --test src/app/ai-dashboard/lib/company-access.test.ts
 *
 * ── Why these exist ──────────────────────────────────────────
 *
 * Two gates guard one door, and they used to ask different questions. The login
 * page selected ONE company column; the gated layout selected THIRTEEN. When a
 * column only the layout needed failed, login said "go to the dashboard" and
 * the dashboard said "cannot tell, go to login" — a redirect chain with no exit,
 * on the only way into the product.
 *
 * So the test that matters is not "does this return the right enum". It is the
 * INVARIANT: for identical membership and company state, the answer the login
 * page acts on and the answer the dashboard acts on are the same answer. That
 * is `both gates agree` below, and it is the reason this module exists at all.
 *
 * The stub models the two queries the rule actually makes — the membership
 * lookup and the one-column company read — including the way PostgREST reports
 * failure (an `error` alongside a null `data`, never a throw).
 */

// @ts-nocheck — the `./company-access.ts` specifier Node requires is rejected by
// this repo's tsconfig, which does not set `allowImportingTsExtensions`. Turning
// that on is a repo-wide config change outside this task; suppressed HERE, in
// the one file that needs it. Nothing ships from this file, and `node --test`
// still type-strips and runs every assertion below.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loginRedirectFor, resolveCompanyAccess } from "./company-access.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const COMPANY = "22222222-2222-2222-2222-222222222222";

/**
 * A Supabase service client, as much of one as the rule touches.
 *
 * `members` and `company` each accept either rows or an error, because the
 * whole point of the rule is that a query which FAILED is a different fact from
 * one answered "no", and the stub has to be able to express both.
 */
function stubService({ members = [], membersError = null, company = null, companyError = null }) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: members, error: membersError }),
        maybeSingle: () => Promise.resolve({ data: company, error: companyError }),
      };
      // `companies` is read twice by the rule — once as the owner fallback
      // (.limit) and once for status (.maybeSingle) — so the table name alone
      // does not pick the answer; the terminal method does.
      void table;
      return chain;
    },
  };
}

const activeMember = [{ id: "m1", company_id: COMPANY, role: "recruiter", name: "Sam" }];

test("ALLOWS an active member of an active company, and reports the role", async () => {
  const access = await resolveCompanyAccess(
    stubService({ members: activeMember, company: { status: "active" } }),
    USER,
  );
  assert.equal(access.ok, true);
  assert.equal(access.companyId, COMPANY);
  assert.equal(access.role, "recruiter", "the role travels with the verdict — no second lookup");
  assert.equal(access.memberName, "Sam");
});

test("REFUSES a user with no membership and no owned company", async () => {
  const access = await resolveCompanyAccess(stubService({ members: [] }), USER);
  assert.equal(access.ok, false);
  assert.equal(access.reason, "not_company");
});

test("REFUSES a paused company, and says which status", async () => {
  const access = await resolveCompanyAccess(
    stubService({ members: activeMember, company: { status: "paused" } }),
    USER,
  );
  assert.equal(access.ok, false);
  assert.equal(access.reason, "inactive");
  assert.equal(access.status, "paused", "the status picks the message the login page shows");
});

test("REFUSES a membership pointing at a company that is not there", async () => {
  // Asked and answered, not a transient failure — so `not_company`, and the
  // caller is right to sign them out.
  const access = await resolveCompanyAccess(
    stubService({ members: activeMember, company: null }),
    USER,
  );
  assert.equal(access.ok, false);
  assert.equal(access.reason, "not_company");
});

test("a failed membership lookup is UNAVAILABLE, never a refusal", async () => {
  // The distinction the whole module is built around: callers sign the user out
  // on a refusal, so a question that could not be ASKED must not answer "no".
  const access = await resolveCompanyAccess(
    stubService({ membersError: { message: "connection reset" } }),
    USER,
  );
  assert.equal(access.ok, false);
  assert.equal(access.reason, "unavailable");
});

test("a failed company-status lookup is UNAVAILABLE, never a refusal", async () => {
  const access = await resolveCompanyAccess(
    stubService({ members: activeMember, companyError: { message: "statement timeout" } }),
    USER,
  );
  assert.equal(access.ok, false);
  assert.equal(access.reason, "unavailable");
});

test("every refusal has a login destination that agrees with it", async () => {
  const states = [
    { name: "no membership", stub: { members: [] } },
    { name: "paused company", stub: { members: activeMember, company: { status: "paused" } } },
    { name: "archived company", stub: { members: activeMember, company: { status: "archived" } } },
    { name: "missing company", stub: { members: activeMember, company: null } },
    { name: "members query failed", stub: { membersError: { message: "boom" } } },
    {
      name: "company query failed",
      stub: { members: activeMember, companyError: { message: "boom" } },
    },
  ];

  for (const { name, stub } of states) {
    const access = await resolveCompanyAccess(stubService(stub), USER);
    assert.equal(access.ok, false, `${name}: expected a refusal`);

    // A refusal must land somewhere that agrees with it. Every reason maps to a
    // login page that renders the form; none maps back to /ai-dashboard, which
    // is what a loop would require.
    const target = loginRedirectFor(access);
    assert.ok(
      target.startsWith("/ai-dashboard/login"),
      `${name}: refused users go to login, got ${target}`,
    );
    assert.ok(
      !target.includes("reason=undefined"),
      `${name}: every refusal names a reason the login page has copy for`,
    );
  }
});

test("INVARIANT: nothing re-decides access after the verdict", async () => {
  /*
   * Asserting that two calls to one function agree would prove nothing — they
   * agree by construction. What can actually drift is the STRUCTURE around the
   * call, and that is what broke before: the layout re-decided access on its
   * own thirteen-column select, and disagreed with the gate that had already
   * said yes.
   *
   * So this reads the four files that make the decision and pins the shape:
   * both gates admit on the same call, and neither turns a post-verdict failure
   * back into a redirect.
   */
  const { readFileSync } = await import("node:fs");
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  const loginPage = read("../login/page.tsx");
  const guards = read("./company-guards.ts");
  const layout = read("../(gated)/layout.tsx");
  const overview = read("../(gated)/page.tsx");

  assert.ok(
    /resolveCompanyAccess\(/.test(loginPage),
    "the login page admits on the canonical rule, not a private copy",
  );
  assert.ok(
    /resolveCompanyAccess\(/.test(guards),
    "getCompanyContext admits on the canonical rule, not a private copy",
  );
  assert.ok(
    !/\.select\(COMPANY_COLUMNS\)/.test(loginPage),
    "the login gate must never take a dependency on the wide company select",
  );

  // After the verdict, a failure is a profile failure — a 500 — and never an
  // access decision. If either of these flips back to CompanyAccessDenied, the
  // ping-pong is reachable again.
  assert.ok(
    /throw new CompanyProfileError\(/.test(guards),
    "a profile that will not load throws CompanyProfileError",
  );
  assert.ok(
    !/redirect\(.*reason=unauthorized/.test(guards),
    "getCompanyContext decides nothing about where refused users go",
  );

  for (const [name, src] of [
    ["layout", layout],
    ["overview page", overview],
  ] as const) {
    assert.ok(
      /err instanceof CompanyAccessDenied/.test(src),
      `${name}: only a decided refusal may redirect`,
    );
    assert.ok(
      /\n\s*throw err;/.test(src),
      `${name}: anything that is not a refusal is rethrown, not redirected`,
    );
    assert.ok(
      !/CompanyProfileError/.test(src),
      `${name}: a profile failure must reach the error boundary, never login`,
    );
  }
});

test("loginRedirectFor: a signed-out user gets no accusatory banner", () => {
  // "This login is for company accounts only" is a strange thing to tell
  // someone whose session merely expired.
  assert.equal(loginRedirectFor({ ok: false, reason: "unauthenticated" }), "/ai-dashboard/login");
  assert.equal(
    loginRedirectFor({ ok: false, reason: "not_company" }),
    "/ai-dashboard/login?reason=unauthorized",
  );
  assert.equal(
    loginRedirectFor({ ok: false, reason: "unavailable" }),
    "/ai-dashboard/login?reason=unavailable",
  );
  assert.equal(
    loginRedirectFor({ ok: false, reason: "inactive", status: "archived" }),
    "/ai-dashboard/login?reason=archived",
  );
  // A status added later must not render a blank banner.
  assert.equal(
    loginRedirectFor({ ok: false, reason: "inactive", status: null }),
    "/ai-dashboard/login?reason=inactive",
  );
});
