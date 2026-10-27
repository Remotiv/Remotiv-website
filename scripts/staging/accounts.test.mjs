/**
 * The account preflight, driven with a stub client and fabricated rows.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * The stub records the query it was given, so one test pins the read to the
 * exact shape company-access.ts uses (status active, created_at then id,
 * limit 1): a preflight that read a DIFFERENT first row than the dashboard
 * would pass accounts the dashboard refuses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNTS, assertAccountFree, assertAccountUsable } from "./accounts.mjs";

const FIXTURE = "00000000-0000-4000-8000-00000000c0ff";
const USER = "00000000-0000-4000-8000-0000000000aa";

/** A client that answers company_members and companies with what it is given. */
function stub({ members = [], memberCount = members.length, company = { status: "active" } } = {}) {
  const queries = [];
  const builder = (table) => {
    const q = { table, filters: [], orders: [], limit: null, head: false };
    queries.push(q);
    const api = {
      select: (cols, opts) => {
        q.cols = cols;
        q.head = Boolean(opts?.head);
        return api;
      },
      eq: (col, v) => {
        q.filters.push([col, v]);
        return api;
      },
      order: (col, opts) => {
        q.orders.push([col, opts?.ascending]);
        return api;
      },
      limit: async (n) => {
        q.limit = n;
        if (table === "company_members") return { data: members.slice(0, n), error: null };
        if (table === "companies") return { data: company ? [company] : [], error: null };
        return { data: null, error: { code: "42P01" } };
      },
      // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaitable; the stub must be too
      then: (resolve) => resolve({ count: memberCount, error: null }),
    };
    return api;
  };
  return { queries, from: builder };
}

test("ACCOUNTS names two variables each and the roles the plan assumes", () => {
  assert.equal(ACCOUNTS.length, 2);
  assert.deepEqual(
    ACCOUNTS.map((a) => a.role),
    ["owner", "recruiter"],
  );
  for (const a of ACCOUNTS) {
    assert.match(a.emailVar, /^STAGING_[A-Z_]+_EMAIL$/);
    assert.match(a.passwordVar, /^STAGING_[A-Z_]+_PASSWORD$/);
  }
});

test("assertAccountFree passes an account with no active membership", async () => {
  const c = stub({ memberCount: 0 });
  assert.equal(await assertAccountFree(c, { userId: USER, emailVar: "STAGING_TEST_EMAIL" }), 0);
});

test("assertAccountFree REFUSES an account that already belongs somewhere, naming the variable", async () => {
  const c = stub({ memberCount: 1 });
  await assert.rejects(
    assertAccountFree(c, { userId: USER, emailVar: "STAGING_TEST_EMAIL" }),
    (e) => {
      assert.match(e.message, /STAGING_TEST_EMAIL/);
      assert.match(e.message, /FIRST active row/);
      return true;
    },
  );
});

test("assertAccountFree refuses a null count and a missing user id", async () => {
  await assert.rejects(
    assertAccountFree(stub({ memberCount: null }), { userId: USER, emailVar: "X" }),
    /came back null/,
  );
  await assert.rejects(
    assertAccountFree(stub(), { userId: undefined, emailVar: "X" }),
    /no user id/,
  );
});

test("assertAccountUsable reads EXACTLY what company-access.ts reads", async () => {
  const c = stub({ members: [{ id: "m", company_id: FIXTURE, role: "owner" }] });
  await assertAccountUsable(c, {
    userId: USER,
    emailVar: "X",
    fixtureCompanyId: FIXTURE,
    role: "owner",
  });
  const q = c.queries.find((x) => x.table === "company_members");
  assert.deepEqual(q.filters, [
    ["user_id", USER],
    ["status", "active"],
  ]);
  assert.deepEqual(q.orders, [
    ["created_at", true],
    ["id", true],
  ]);
  assert.equal(q.limit, 1, "the dashboard takes the first row; so must this");
});

test("assertAccountUsable passes owner and recruiter in an active fixture company", async () => {
  for (const role of ["owner", "recruiter"]) {
    const c = stub({ members: [{ id: "m", company_id: FIXTURE, role }] });
    assert.deepEqual(
      await assertAccountUsable(c, {
        userId: USER,
        emailVar: "X",
        fixtureCompanyId: FIXTURE,
        role,
      }),
      { role },
    );
  }
});

test("assertAccountUsable REFUSES an account with no membership: the seed has not run", async () => {
  const c = stub({ members: [] });
  await assert.rejects(
    assertAccountUsable(c, {
      userId: USER,
      emailVar: "STAGING_TEST_EMAIL",
      fixtureCompanyId: FIXTURE,
      role: "owner",
    }),
    (e) => {
      assert.match(e.message, /STAGING_TEST_EMAIL/);
      assert.match(e.message, /no active company membership/);
      assert.match(e.message, /reason=unauthorized/);
      return true;
    },
  );
});

test("assertAccountUsable REFUSES a first membership outside the fixture", async () => {
  const c = stub({ members: [{ id: "m", company_id: "other", role: "owner" }] });
  await assert.rejects(
    assertAccountUsable(c, {
      userId: USER,
      emailVar: "X",
      fixtureCompanyId: FIXTURE,
      role: "owner",
    }),
    /NOT the fixture/,
  );
});

test("assertAccountUsable REFUSES the wrong role, and says why for the recruiter", async () => {
  const c = stub({ members: [{ id: "m", company_id: FIXTURE, role: "owner" }] });
  await assert.rejects(
    assertAccountUsable(c, {
      userId: USER,
      emailVar: "X",
      fixtureCompanyId: FIXTURE,
      role: "recruiter",
    }),
    /is a owner .* needs recruiter.*#25/,
  );
});

test("assertAccountUsable REFUSES a fixture company that still forces a password change", async () => {
  const company = { status: "active", must_change_password: true };
  const c = stub({ members: [{ id: "m", company_id: FIXTURE, role: "owner" }], company });
  await assert.rejects(
    assertAccountUsable(c, {
      userId: USER,
      emailVar: "STAGING_TEST_EMAIL",
      fixtureCompanyId: FIXTURE,
      role: "owner",
    }),
    (e) => {
      assert.match(e.message, /must_change_password is true/);
      assert.match(e.message, /forced=true/);
      assert.match(e.message, /STAGING_TEST_EMAIL/);
      return true;
    },
  );
  // The read must carry the column, or the check above compares undefined.
  const q = c.queries.find((x) => x.table === "companies");
  assert.match(q.cols, /must_change_password/, "the companies read must select the flag");
});

test("assertAccountUsable passes a fixture company with the flag false or absent", async () => {
  for (const company of [{ status: "active", must_change_password: false }, { status: "active" }]) {
    const c = stub({ members: [{ id: "m", company_id: FIXTURE, role: "owner" }], company });
    assert.deepEqual(
      await assertAccountUsable(c, {
        userId: USER,
        emailVar: "X",
        fixtureCompanyId: FIXTURE,
        role: "owner",
      }),
      { role: "owner" },
    );
  }
});

test("assertAccountUsable REFUSES a non-active fixture company", async () => {
  for (const company of [{ status: "paused" }, null]) {
    const c = stub({ members: [{ id: "m", company_id: FIXTURE, role: "owner" }], company });
    await assert.rejects(
      assertAccountUsable(c, {
        userId: USER,
        emailVar: "X",
        fixtureCompanyId: FIXTURE,
        role: "owner",
      }),
      /not "active"/,
    );
  }
});
