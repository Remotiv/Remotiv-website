/**
 * acceptInvite, run as shipped against a fake database and a fake auth (#100).
 *
 *   node --test src/app/ai-dashboard/accept/actions.test.ts
 *
 * ── What is tested ───────────────────────────────────────────
 *
 * Three things #100 changed, and the guards #101 required to stay:
 *
 *   1. a removed member's surviving company_members row is REACTIVATED by a
 *      fresh invitation, with the new invitation's role, instead of colliding
 *      on (company_id, user_id); an active member re-clicking writes nothing
 *   2. the invite is burned FIRST, by one conditional UPDATE ... RETURNING, so
 *      two acceptances of one token race on the burn and exactly one writes
 *   3. no library error message reaches the browser
 *
 * and, unchanged: an accepted, revoked, superseded or expired invitation is
 * refused before anything is written.
 *
 * The database is fake-postgrest.mjs with a responder that applies the real
 * predicates (token hash, status = 'pending' on the burn, the (company_id,
 * user_id) lookup) to in-memory rows, so the burn's mutual exclusion is
 * exercised, not assumed. Auth is a small fake with createUser, deleteUser and
 * signInWithPassword. The rate limiter is stubbed because its cleanup timer
 * keeps a bare Node process alive; notifications are recorded, not sent.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

// No test in this file may reach a real network (#48): blocked and recorded, checked last.
const guard = blockNetwork();

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/lib/supabase/server": [
    "export function createServiceClient() { return globalThis.__acceptService(); }",
    "export async function createClient() { return globalThis.__acceptAuthClient(); }",
  ].join("\\n"),
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/notifications/company": "export async function notifyCompany(input) { globalThis.__acceptNotified.push(input); }",
  "@/lib/company-identity": "export function isAlreadyRegistered(m) { return /already|exists|registered/i.test(m); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { acceptInvite } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const PASSWORD = "correct horse battery";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const eqMap = (calls) =>
  Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));

/** Names that must never reach the browser or the console. */
const LEAKS = [
  "company_members_company_id_user_id_key",
  "company_members",
  "user_id",
  "duplicate key",
];

/**
 * One fake world: invites, members and auth users as plain rows. The responder
 * applies the predicates the action actually sends. `events` records every
 * write attempt in order; `burnGate`, when set, holds every burn until the
 * expected number of requests have reached it (the race test).
 */
function world({
  invites = [],
  members = [],
  users = [],
  memberWriteFails = null,
  createUserFails = null,
  burnGate = null,
  flipOnRead = null,
  expireOnRead = false,
  inviters = DEFAULT_INVITERS,
} = {}) {
  const state = {
    invites: structuredClone(invites),
    members: structuredClone(members),
    users: structuredClone(users),
    // The members who SENT the invitations (#49), kept apart from `members` so
    // the counts the older cases assert are about the joiner only.
    inviters: structuredClone(inviters),
  };
  const events = [];
  const notified = [];
  const logged = [];
  const rpcCalls = [];
  let nextId = 1;

  const service = fakeService(async (table, calls) => {
    const eqs = eqMap(calls);
    const op = calls[0]?.[0];
    if (table === "rpc:accept_company_invite") {
      // Migration 062, step for step. One JS turn is one transaction here, so
      // this fake shows the DECISIONS; the locking itself is proven on a real
      // Postgres by scripts/staging/proofs-062.mjs.
      const a = calls[0][1];
      rpcCalls.push(a);
      if (burnGate) await burnGate.arrive();
      const inv = state.invites.find((i) => i.token_hash === a.p_token_hash);
      if (!inv) return { data: "invalid", error: null };
      if (inv.status !== "pending") {
        events.push("burn:lost");
        return { data: "not_pending", error: null };
      }
      if (!(inv.expires_at > new Date().toISOString())) {
        events.push("burn:lost");
        return { data: "expired", error: null };
      }
      const invited = inv.email.trim().toLowerCase();
      if ((a.p_email ?? "").trim().toLowerCase() !== invited)
        return { data: "email_mismatch", error: null };
      if (
        !state.users.some((u) => u.id === a.p_user_id && u.email.trim().toLowerCase() === invited)
      ) {
        return { data: "user_mismatch", error: null };
      }
      const inviterOk = (m) =>
        m.company_id === inv.company_id &&
        m.user_id === inv.invited_by &&
        m.status === "active" &&
        (m.role === "owner" || m.role === "admin");
      if (!inv.invited_by || ![...state.inviters, ...state.members].some(inviterOk)) {
        return { data: "inviter_invalid", error: null };
      }
      // A failed write raises inside the function: the WHOLE transaction rolls
      // back, the burn included, so nothing below is applied.
      if (memberWriteFails) return { data: null, error: memberWriteFails };
      inv.status = "accepted";
      inv.accepted_at = new Date().toISOString();
      events.push("burn:won");
      const m = state.members.find(
        (x) => x.company_id === inv.company_id && x.user_id === a.p_user_id,
      );
      if (!m) {
        events.push("member:insert");
        state.members.push({
          id: `m-${nextId++}`,
          company_id: inv.company_id,
          user_id: a.p_user_id,
          name: a.p_name,
          email: invited,
          role: inv.role,
          status: "active",
        });
        return { data: "joined", error: null };
      }
      if (m.status === "active") return { data: "already_member", error: null };
      if (m.status === "removed") {
        if (m.removed_at == null || !(m.removed_at < inv.created_at))
          return { data: "stale_removal", error: null };
      } else if (m.removed_at != null) {
        return { data: "status_changed", error: null };
      }
      events.push("member:update");
      Object.assign(m, {
        status: "active",
        role: inv.role,
        name: a.p_name,
        email: invited,
        removed_at: null,
      });
      return { data: "joined", error: null };
    }
    if (table === "company_members" && op === "select" && calls.some((c) => c[0] === "in")) {
      // The early, read-only inviter check (accept/actions.ts step 1b).
      const roles = calls.find((c) => c[0] === "in")[2];
      const row = [...state.inviters, ...state.members].find(
        (m) =>
          m.company_id === eqs.company_id &&
          m.user_id === eqs.user_id &&
          m.status === eqs.status &&
          roles.includes(m.role),
      );
      return { data: row ? { id: row.id ?? "m-inviter" } : null, error: null };
    }
    if (table === "company_invites" && op === "select") {
      const row = state.invites.find((i) => i.token_hash === eqs.token_hash) ?? null;
      const seen = row ? { ...row } : null;
      if (row && flipOnRead) row.status = flipOnRead; // withdrawn after the read, before the burn
      if (row && expireOnRead) row.expires_at = YESTERDAY; // expired after the read, before the burn
      return { data: seen, error: null };
    }
    if (table === "company_invites" && op === "update") {
      if (burnGate) await burnGate.arrive();
      const row = state.invites.find((i) => i.id === eqs.id);
      // The real predicate: status = 'pending' AND expires_at > now, both sent
      // by the action and both applied here. Exactly one of two racing
      // requests sees the row so.
      const gt = calls.find((c) => c[0] === "gt" && c[1] === "expires_at")?.[2];
      const unexpired = typeof gt === "string" && row && row.expires_at > gt;
      if (row && eqs.status === "pending" && row.status === "pending" && unexpired) {
        row.status = "accepted";
        row.accepted_at = calls[0][1].accepted_at;
        events.push("burn:won");
        return {
          data: {
            id: row.id,
            company_id: row.company_id,
            email: row.email,
            role: row.role,
            // The database's own timestamp, as RETURNING hands it back.
            created_at: row.created_at,
          },
          error: null,
        };
      }
      events.push("burn:lost");
      return { data: null, error: null };
    }
    if (table === "company_members" && op === "select") {
      const row =
        state.members.find((m) => m.company_id === eqs.company_id && m.user_id === eqs.user_id) ??
        null;
      return { data: row ? { id: row.id, status: row.status } : null, error: null };
    }
    if (table === "company_members" && op === "update") {
      events.push("member:update");
      if (memberWriteFails) return { data: null, error: memberWriteFails };
      // Every filter the action sends is applied, the way PostgREST would:
      // eq/neq on any column, lt on removed_at (NULL never satisfies lt), is
      // null. A row that fails any of them is not written and, with .select,
      // RETURNING hands back nothing.
      const neq = Object.fromEntries(calls.filter((c) => c[0] === "neq").map((c) => [c[1], c[2]]));
      const lt = calls.find((c) => c[0] === "lt")?.slice(1);
      const isNull = calls.find((c) => c[0] === "is" && c[2] === null)?.[1];
      const row = state.members.find(
        (m) =>
          Object.entries(eqs).every(([k, v]) => m[k] === v) &&
          Object.entries(neq).every(([k, v]) => m[k] !== v) &&
          (!lt || (m[lt[0]] !== null && m[lt[0]] !== undefined && m[lt[0]] < lt[1])) &&
          (!isNull || m[isNull] === null || m[isNull] === undefined),
      );
      const returning = calls.some((c) => c[0] === "select");
      if (!row) return { data: returning ? null : undefined, error: null };
      const before = row.status;
      Object.assign(row, calls[0][1]);
      // Migration 057's trigger: the database owns removed_at on both transitions.
      if (row.status === "removed" && before !== "removed") row.removed_at = tick();
      if (row.status !== "removed" && before === "removed") row.removed_at = null;
      // Migration 057's CHECK: (status = 'removed') = (removed_at is not null).
      if ((row.status === "removed") !== (row.removed_at != null)) {
        throw new Error("CHECK company_members_removed_at_matches_status violated by the fake");
      }
      return { data: returning ? { id: row.id } : undefined, error: null };
    }
    if (table === "company_members" && op === "insert") {
      events.push("member:insert");
      if (memberWriteFails) return { data: null, error: memberWriteFails };
      const row = calls[0][1];
      if (state.members.some((m) => m.company_id === row.company_id && m.user_id === row.user_id)) {
        // What the real database would do: the unique key refuses a second row.
        return {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "company_members_company_id_user_id_key"',
          },
        };
      }
      state.members.push({ id: `m-${nextId++}`, ...row });
      return { data: null, error: null };
    }
    throw new Error(`unexpected ${op} on ${table}`);
  });
  service.auth = {
    admin: {
      async createUser({ email, password }) {
        events.push("auth:create");
        if (createUserFails) return { data: { user: null }, error: createUserFails };
        if (state.users.some((u) => u.email === email)) {
          return {
            data: { user: null },
            error: {
              message: "A user with this email address has already been registered",
              code: "email_exists",
            },
          };
        }
        const user = { id: `u-${nextId++}`, email, password };
        state.users.push(user);
        return { data: { user: { id: user.id } }, error: null };
      },
      async deleteUser(id) {
        events.push("auth:delete");
        state.users = state.users.filter((u) => u.id !== id);
        return { data: null, error: null };
      },
    },
  };
  const authClient = {
    auth: {
      async signInWithPassword({ email, password }) {
        const user = state.users.find((u) => u.email === email && u.password === password);
        events.push(user ? "auth:signin" : "auth:signin-failed");
        return user
          ? { data: { user: { id: user.id } }, error: null }
          : { data: { user: null }, error: { message: "Invalid login credentials", status: 400 } };
      },
    },
  };

  globalThis.__acceptService = () => service;
  globalThis.__acceptAuthClient = () => authClient;
  globalThis.__acceptNotified = notified;

  const realError = console.error;
  const run = async (token, password = PASSWORD) => {
    console.error = (...args) => logged.push(args.map(String).join(" "));
    try {
      return await acceptInvite({ token, password });
    } finally {
      console.error = realError;
    }
  };
  return { state, events, notified, logged, rpcCalls, run };
}

function gate(expected) {
  let arrived = 0;
  let release = () => {};
  const open = new Promise((r) => {
    release = r;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= expected) release();
      await open;
    },
  };
}

/**
 * The fake database's clock for removed_at (migration 057's trigger stamps
 * now()): strictly increasing, so a stamp written later always sorts later.
 * Fixture timestamps sit before it.
 */
let clockMs = Date.parse("2026-11-10T12:00:00.000Z");
function tick() {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}
/** When the removed fixture was removed, and when the invitation was created: removal first. */
const REMOVED_AT = "2026-11-10T10:00:00.000Z";
const INVITED_AT = "2026-11-10T11:00:00.000Z";

/** Whoever sent the invitations: an active owner of both test companies (#49). */
const DEFAULT_INVITERS = [
  {
    id: "m-owner-1",
    company_id: "c0000000-0000-0000-0000-000000000001",
    user_id: "u-owner",
    role: "owner",
    status: "active",
  },
  {
    id: "m-owner-2",
    company_id: "c0000000-0000-0000-0000-000000000002",
    user_id: "u-owner",
    role: "owner",
    status: "active",
  },
];

const invite = (overrides = {}) => ({
  invited_by: "u-owner",
  id: "inv-1",
  company_id: CO,
  email: "rae@acme.test",
  name: "Rae Recruiter",
  role: "recruiter",
  status: "pending",
  expires_at: TOMORROW,
  created_at: INVITED_AT,
  token_hash: hash("tok-1"),
  ...overrides,
});

const removedRae = {
  id: "m-rae",
  company_id: CO,
  user_id: "u-rae",
  email: "rae@acme.test",
  name: "Rae (old name)",
  role: "hiring_manager",
  status: "removed",
  removed_at: REMOVED_AT, // before INVITED_AT: a fresh invitation, so it reactivates
};
const raeUser = { id: "u-rae", email: "rae@acme.test", password: PASSWORD };

test("1. a removed member accepting a FRESH invitation is reactivated: active, the new role, one row, no error", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: true });
  assert.equal(w.state.members.length, 1, "exactly one membership row");
  const row = w.state.members[0];
  assert.equal(row.status, "active");
  assert.equal(row.role, "recruiter", "the role comes from the NEW invitation, not the old row");
  assert.equal(row.name, "Rae Recruiter", "and so does the name");
  assert.equal(w.state.invites[0].status, "accepted", "the token is spent");
  assert.deepEqual(w.events, ["auth:create", "auth:signin", "burn:won", "member:update"]);
  assert.equal(w.notified.length, 1);
  assert.ok(!w.logged.some((l) => /23505|duplicate/.test(l)), "no duplicate-key error anywhere");
});

test("2a. the same person's OLD invitation, already accepted: refused, nothing written, membership unchanged", async () => {
  const w = world({
    invites: [invite({ status: "accepted" })],
    members: [removedRae],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: false, error: "This invitation is no longer active." });
  assert.deepEqual(w.events, [], "no account step, no burn, no write");
  assert.equal(w.state.members[0].status, "removed");
});

test("2b. a revoked invitation: refused, nothing written", async () => {
  const w = world({
    invites: [invite({ status: "revoked" })],
    members: [removedRae],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.equal(result.success, false);
  assert.deepEqual(w.events, []);
  assert.equal(w.state.members[0].status, "removed");
});

test("2c. a superseded invitation (status expired by a newer one): refused, nothing written", async () => {
  const w = world({
    invites: [invite({ status: "expired" })],
    members: [removedRae],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.equal(result.success, false);
  assert.deepEqual(w.events, []);
});

test("2d. withdrawn between the read and the burn: the burn's own predicate refuses, nothing written", async () => {
  const w = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    flipOnRead: "revoked",
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: false, error: "This invitation has already been used." });
  assert.deepEqual(w.events, ["auth:create", "auth:signin", "burn:lost"]);
  assert.equal(w.state.members[0].status, "removed", "membership untouched");
  assert.equal(w.state.invites[0].status, "revoked", "and the invite stays as withdrawn");
});

test("2e. expired between the read and the burn: the burn's own expires_at predicate refuses, nothing written", async () => {
  const w = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    expireOnRead: true,
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: false, error: "This invitation has already been used." });
  assert.deepEqual(w.events, ["auth:create", "auth:signin", "burn:lost"]);
  assert.equal(w.state.invites[0].status, "pending", "not consumed: the burn did not match");
  assert.equal(w.state.members[0].status, "removed", "membership untouched");
});

test("3. an expired invitation: refused, nothing written", async () => {
  const w = world({
    invites: [invite({ expires_at: YESTERDAY })],
    members: [removedRae],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: false, error: "This invitation has expired." });
  assert.deepEqual(w.events, []);
});

test("4. an active member re-clicking a valid link: short-circuits, writes nothing, spends the token, no error", async () => {
  const w = world({
    invites: [invite()],
    members: [{ ...removedRae, status: "active", role: "owner" }],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: true });
  assert.deepEqual(w.events, ["auth:create", "auth:signin", "burn:won"], "no membership write");
  assert.equal(w.state.members[0].role, "owner", "the existing role is not touched");
  assert.equal(w.state.invites[0].status, "accepted");
  assert.equal(w.notified.length, 0, "nobody joined, so no bell");
});

test("5. a brand new address: account created, membership inserted, one row, signed in", async () => {
  const w = world({ invites: [invite({ email: "new@acme.test", name: "New Person" })] });
  const result = await w.run("tok-1");
  assert.deepEqual(result, { success: true });
  assert.equal(w.state.users.length, 1);
  assert.equal(w.state.members.length, 1);
  assert.equal(w.state.members[0].user_id, w.state.users[0].id);
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.members[0].role, "recruiter");
  assert.deepEqual(w.events, ["auth:create", "burn:won", "member:insert", "auth:signin"]);
  assert.equal(w.notified.length, 1);
});

test("6. TWO CONCURRENT ACCEPTANCES of one token: exactly one succeeds, the other is told it was used, one row", async () => {
  const w = world({ invites: [invite({ email: "new@acme.test" })], burnGate: gate(2) });
  const [a, b] = await Promise.all([w.run("tok-1"), w.run("tok-1")]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.success).length, 1, "exactly one success");
  const loser = results.find((r) => !r.success);
  assert.equal(loser.error, "This invitation has already been used.");
  assert.equal(
    w.events.filter((e) => e.startsWith("burn:")).length,
    2,
    "both requests reached the burn",
  );
  assert.equal(w.events.filter((e) => e === "burn:won").length, 1, "only one burn returned a row");
  assert.equal(w.events.filter((e) => e.startsWith("member:")).length, 1, "only the winner wrote");
  assert.equal(w.state.members.length, 1, "exactly one membership row afterwards");
  assert.equal(w.state.users.length, 1, "one account, kept: the loser never deletes it");
  assert.ok(!w.events.includes("auth:delete"));
  assert.equal(w.state.invites[0].status, "accepted");
});

test("7. a failing membership write: a fixed string, and no constraint, table or column name anywhere", async () => {
  const w = world({
    invites: [invite({ email: "new@acme.test" })],
    memberWriteFails: {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "company_members_company_id_user_id_key" on user_id',
    },
  });
  const result = await w.run("tok-1");
  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "Couldn't finish joining the workspace. Please ask for a new invitation.",
  );
  const everything = [result.error, ...w.logged].join("\n");
  for (const needle of LEAKS) assert.ok(!everything.includes(needle), `leaked ${needle}`);
  assert.deepEqual(w.logged, ["[accept-invite] accept invite: 23505"], "the code only");
  assert.ok(w.events.includes("auth:delete"), "the account WE created is rolled back");
  assert.equal(w.state.users.length, 0);
  // Changed by #49 (migration 062): burn and grant are one transaction now, so
  // a failed grant rolls the burn back too and the SAME link can be retried.
  assert.equal(
    w.state.invites[0].status,
    "pending",
    "the token is NOT spent: the burn rolled back",
  );
});

test("8. a wrong password on an existing account does not spend the token (account before burn)", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  const result = await w.run("tok-1", "not the password");
  assert.equal(result.success, false);
  assert.equal(result.needsExistingPassword, true);
  assert.deepEqual(w.events, ["auth:create", "auth:signin-failed"]);
  assert.equal(w.state.invites[0].status, "pending", "still usable with the right password");
  assert.equal(w.state.members[0].status, "removed");
});

test("9. an account that cannot be created: a fixed string, the code logged, the token not spent", async () => {
  const w = world({
    invites: [invite({ email: "new@acme.test" })],
    createUserFails: {
      message: "Database error saving new user: relation auth.users",
      status: 500,
    },
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't create your account. Please try again.",
  });
  assert.deepEqual(w.logged, ["[accept-invite] create account: 500"]);
  assert.equal(w.state.invites[0].status, "pending");
  assert.deepEqual(w.events, ["auth:create"]);
});

/* ── 057: the reactivation predicate (#100) ─────────────────────────────── */

test("13. an invitation created at EXACTLY the removal's instant is refused: strict less-than, the safe direction, same string as any failed join", async () => {
  const w = world({
    invites: [invite({ created_at: REMOVED_AT })],
    members: [removedRae],
    users: [raeUser],
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't finish joining the workspace. Please ask for a new invitation.",
  });
  assert.equal(w.state.members[0].status, "removed", "not reactivated");
  assert.equal(
    w.state.invites[0].status,
    "accepted",
    "the token is spent: a fresh invitation is the way back",
  );
  assert.deepEqual(w.logged, ["[accept-invite] accept invite: stale_removal"]);
  assert.deepEqual(
    w.events,
    ["auth:create", "auth:signin", "burn:won"],
    "the function burns and decides; no membership write is attempted",
  );
});

test("14. an invitation created before the removal is refused; one created after it reactivates (the predicate, both sides)", async () => {
  const older = world({
    invites: [invite({ created_at: "2026-11-10T09:59:59.999Z" })],
    members: [removedRae],
    users: [raeUser],
  });
  assert.equal((await older.run("tok-1")).success, false);
  assert.equal(older.state.members[0].status, "removed");

  const newer = world({
    invites: [invite({ created_at: "2026-11-10T10:00:00.001Z" })],
    members: [removedRae],
    users: [raeUser],
  });
  assert.deepEqual(await newer.run("tok-1"), { success: true });
  assert.equal(newer.state.members[0].status, "active");
  assert.equal(
    newer.state.members[0].removed_at,
    null,
    "reactivation clears the stamp (057's trigger)",
  );
});

test("15. a row never removed (legacy 'invited', removed_at NULL) reactivates normally through the NULL path", async () => {
  const w = world({
    invites: [invite()],
    members: [{ ...removedRae, status: "invited", removed_at: null }],
    users: [raeUser],
  });
  assert.deepEqual(await w.run("tok-1"), { success: true });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.members[0].role, "recruiter");
  assert.equal(w.state.members[0].removed_at, null);
});

test("control: the fake refuses a duplicate (company_id, user_id) the way the database does", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  // Bypass the lookup by inserting directly: the fake must collide.
  const { error } = await globalThis.__acceptService().from("company_members").insert({
    company_id: CO,
    user_id: "u-rae",
    email: "rae@acme.test",
    name: "x",
    role: "recruiter",
    status: "active",
  });
  assert.equal(error?.code, "23505");
  assert.equal(w.state.members.length, 1);
});

/* ── #48: password attempts are limited per ACCOUNT, not per token ──────────
 * The limiter is the real lib/invite-password-limit.ts (the same module
 * instance the action imports), with a fresh memory store and a hand clock per
 * test. Sam has an existing login and no membership anywhere.
 */
const limit = await import("../../../lib/invite-password-limit.ts");
const CO2 = "c0000000-0000-0000-0000-000000000002";
const LOCKED = "Too many incorrect passwords for this account. Please try again in 15 minutes.";
const samUser = { id: "u-sam", email: "sam@acme.test", password: PASSWORD };
const samInvite = (n, overrides = {}) =>
  invite({
    id: `inv-sam-${n}`,
    email: "sam@acme.test",
    token_hash: hash(`sam-${n}`),
    ...overrides,
  });
function freshLimit() {
  let t = Date.parse("2026-11-17T12:00:00Z");
  limit.setInvitePasswordStoresForTests(limit.memoryAttemptStore(() => t));
  return { advance: (ms) => (t += ms) };
}
const signIns = (w) => w.events.filter((e) => e.startsWith("auth:signin")).length;

test("48-1. ten wrong passwords, then locked: the 11th never reaches the password check and spends nothing", async () => {
  freshLimit();
  const w = world({ invites: [samInvite(1)], users: [samUser] });
  for (let i = 0; i < 10; i++) {
    const r = await w.run("sam-1", `wrong password ${i}`);
    assert.equal(r.needsExistingPassword, true);
    assert.match(r.error, /doesn't match/);
  }
  const locked = await w.run("sam-1", PASSWORD);
  assert.deepEqual(locked, { success: false, error: LOCKED, needsExistingPassword: true });
  assert.equal(signIns(w), 10, "the 11th, even with the right password, is never checked");
  assert.equal(w.state.invites[0].status, "pending");
  assert.equal(w.state.members.length, 0);
});

test("48-2. a Resend (new token) and another company's invitation to the same account are still locked", async () => {
  freshLimit();
  const w = world({
    invites: [samInvite(1), samInvite(2), samInvite(3, { company_id: CO2 })],
    users: [samUser],
  });
  for (let i = 0; i < 10; i++) await w.run("sam-1", `wrong password ${i}`);
  assert.equal((await w.run("sam-2", "wrong password again")).error, LOCKED, "resent token");
  assert.equal((await w.run("sam-3", "wrong password again")).error, LOCKED, "second company");
  assert.equal((await w.run("sam-3", " ")).error, "Password must be at least 8 characters.");
  assert.equal(signIns(w), 10);
});

test("48-3. concurrent: 30 attempts across three tokens and two companies at once, at most 10 password checks", async () => {
  freshLimit();
  const w = world({
    invites: [samInvite(1), samInvite(2), samInvite(3, { company_id: CO2 })],
    users: [samUser],
  });
  const r = await Promise.all(
    Array.from({ length: 30 }, (_, i) => w.run(`sam-${(i % 3) + 1}`, `wrong password ${i}`)),
  );
  assert.equal(signIns(w), 10);
  assert.equal(r.filter((x) => x.error === LOCKED).length, 20);
});

test("48-4. after the lock window, the right password joins", async () => {
  const c = freshLimit();
  const w = world({ invites: [samInvite(1)], users: [samUser] });
  for (let i = 0; i < 11; i++) await w.run("sam-1", `wrong password ${i}`);
  c.advance(limit.INVITE_PASSWORD_LOCK_MS + 1000);
  const ok = await w.run("sam-1", PASSWORD);
  assert.equal(ok.success, true);
  assert.equal(w.state.invites[0].status, "accepted");
  assert.equal(
    w.state.members.filter((m) => m.user_id === "u-sam" && m.status === "active").length,
    1,
  );
});

test("48-5. the right password clears the count: the next invitation gets a full ten again", async () => {
  freshLimit();
  const w = world({ invites: [samInvite(1), samInvite(2, { company_id: CO2 })], users: [samUser] });
  for (let i = 0; i < 9; i++) await w.run("sam-1", `wrong password ${i}`);
  assert.equal((await w.run("sam-1", PASSWORD)).success, true);
  for (let i = 0; i < 10; i++) {
    assert.match((await w.run("sam-2", `wrong password ${i}`)).error, /doesn't match/);
  }
  assert.equal((await w.run("sam-2", "wrong password 11")).error, LOCKED);
});

test("48-6. a NEW address (no existing login) is not counted: account creation is not a password guess", async () => {
  freshLimit();
  const w = world({ invites: [invite({ email: "new@acme.test", token_hash: hash("new-1") })] });
  const r = await w.run("new-1", PASSWORD);
  assert.equal(r.success, true);
  assert.equal((await limit.reserveInvitePasswordAttempt("new@acme.test")).ok, true);
});

test("48-7. the attempt store unavailable: FAILS CLOSED - refused before the password check, token not spent", async () => {
  limit.setInvitePasswordStoresForTests({
    async increment() {
      throw new Error("ECONNREFUSED");
    },
    async clear() {},
  });
  const w = world({ invites: [samInvite(1)], users: [samUser] });
  const r = await w.run("sam-1", PASSWORD);
  assert.deepEqual(r, {
    success: false,
    error: "We couldn't check your password just now. Please try again in a moment.",
    needsExistingPassword: true,
  });
  assert.equal(signIns(w), 0, "not even the right password is checked");
  assert.equal(w.state.invites[0].status, "pending");
  assert.equal(w.state.members.length, 0);
  freshLimit();
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
