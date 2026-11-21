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
    "export function createStatelessClient() { return globalThis.__acceptStateless(); }",
  ].join("\\n"),
  "@/app/api/_lib/rate-limit":
    "export async function rateLimitClosedByKey() { return { ok: true }; } export const TRY_AGAIN_SOON = 'Please try again in a minute.';",
  "@/lib/company-identity": "export function isAlreadyRegistered(m) { return /already|exists|registered/i.test(m); }",
  "@/lib/notifications/company": "export async function notifyCompany(input) { globalThis.__acceptNotified.push(input); }",
  "@/lib/email/send": "export async function sendEmail(payload) { return globalThis.__acceptEmail(payload); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { acceptInvite, sendInviteCode } = await import("./actions.ts");
// The real limiter module, the same instance the action imports: every world
// starts it on a fresh memory store, so one test's sends never lock another's.
const limit = await import("../../../lib/invite-password-limit.ts");

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
  setPasswordFails = null,
  createUserFails = null,
  burnGate = null,
  flipOnRead = null,
  expireOnRead = false,
  inviters = DEFAULT_INVITERS,
  sameCode = false,
  linkError = null,
  emailFails = false,
  companies = [
    { id: CO, name: "Acme & Sons" },
    { id: "c0000000-0000-0000-0000-000000000002", name: "Beta" },
  ],
  verifiedEmail = null,
  keepLimit = false,
} = {}) {
  if (!keepLimit) limit.setInvitePasswordStoresForTests(limit.memoryAttemptStore());
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
  const signOuts = [];
  // The code Supabase last emailed to each address. Each works once, and a
  // newer send replaces it: staging refused the older code once a newer one
  // was issued for an account that already existed, which every send here is
  // (scripts/staging/proofs-051.mjs, N). `expired` holds codes past their
  // lifetime. `sameCode` keeps one reusable code so two racing acceptances
  // both get past it to the burn (test 6).
  const codes = new Map(); // address -> the last code its INBOX received
  const issued = new Map();
  const minted = [];
  const emails = [];
  const expired = new Set();
  let nextCode = 100001;
  let inviteReads = 0;
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
      // The second read is acceptInvite's (the first is sendInviteCode's):
      // the change lands after it, before the burn.
      inviteReads += 1;
      if (row && flipOnRead && inviteReads === 2) row.status = flipOnRead;
      if (row && expireOnRead && inviteReads === 2) row.expires_at = YESTERDAY;
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
    if (table === "companies" && op === "select") {
      const row = companies.find((c) => c.id === eqs.id);
      return { data: row ? { name: row.name } : null, error: null };
    }
    throw new Error(`unexpected ${op} on ${table}`);
  });
  service.auth = {
    admin: {
      async updateUserById(id, attrs) {
        events.push("auth:set-password");
        if (setPasswordFails) return { data: { user: null }, error: setPasswordFails };
        const user = state.users.find((u) => u.id === id);
        user.password = attrs.password;
        user.meta = { ...(user.meta ?? {}), ...attrs.user_metadata };
        user.app = { ...(user.app ?? {}), ...attrs.app_metadata };
        return { data: { user: { id } }, error: null };
      },
      async createUser({ email, password, email_confirm, app_metadata }) {
        if (state.users.some((u) => u.email === email)) {
          return {
            data: { user: null },
            error: {
              message: "A user with this email address has already been registered",
              code: "email_exists",
              status: 422,
            },
          };
        }
        if (createUserFails) return { data: { user: null }, error: createUserFails };
        const user = {
          id: `u-${nextId++}`,
          email,
          password: password ?? null,
          confirmed: email_confirm === true,
          app: { ...app_metadata },
        };
        state.users.push(user);
        events.push("auth:create");
        return { data: { user: { id: user.id } }, error: null };
      },
      /** Mints a code and sends NOTHING, as Supabase's does. */
      async generateLink({ type, email }) {
        if (linkError) return { data: null, error: linkError };
        let user = state.users.find((u) => u.email === email);
        if (!user) {
          // Supabase would create an unmarked account here; the action never lets it.
          user = { id: `u-${nextId++}`, email, password: null };
          state.users.push(user);
          events.push("auth:link-create");
        }
        const fresh = sameCode ? "424242" : String(nextCode++);
        issued.set(email, [fresh]);
        minted.push(fresh);
        return {
          data: { user: { id: user.id }, properties: { email_otp: fresh, type } },
          error: null,
        };
      },
      async deleteUser(id) {
        events.push("auth:delete");
        state.users = state.users.filter((u) => u.id !== id);
        return { data: null, error: null };
      },
    },
  };
  /** Checks on a client with NO cookies: nothing here signs the browser in. */
  const stateless = () => ({
    auth: {
      async signInWithPassword({ email, password }) {
        const user = state.users.find(
          (u) => u.email === email && u.password != null && u.password === password,
        );
        events.push(user ? "auth:check" : "auth:check-failed");
        return user
          ? { data: { user: { id: user.id } }, error: null }
          : { data: { user: null }, error: { message: "Invalid login credentials", status: 400 } };
      },
      // Never called for an invitation (#51): this would be a Supabase email.
      async signInWithOtp() {
        events.push("auth:supabase-email");
        return { data: {}, error: null };
      },
      async verifyOtp({ email, token, type }) {
        const user = state.users.find((u) => u.email === email);
        const valid = issued.get(email) ?? [];
        if (type !== "email" || !user || !valid.includes(token) || expired.has(token)) {
          events.push("auth:code-wrong");
          return { data: { user: null }, error: { code: "otp_expired", status: 403 } };
        }
        if (!sameCode)
          issued.set(
            email,
            valid.filter((c) => c !== token),
          );
        events.push("auth:code-ok");
        return {
          data: {
            user: {
              id: user.id,
              email: verifiedEmail ?? user.email,
              user_metadata: { ...(user.meta ?? {}) },
              app_metadata: { provider: "email", ...(user.app ?? {}) },
            },
          },
          error: null,
        };
      },
      async signOut(opts) {
        signOuts.push(opts?.scope);
        return { error: null };
      },
    },
  });
  /** The cookie-bound client: signing in here signs the BROWSER in. */
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
  globalThis.__acceptStateless = stateless;
  /** Our Resend path: records every email, and the code the recipient can read. */
  globalThis.__acceptEmail = async (payload) => {
    emails.push(payload);
    if (emailFails) return { ok: false, error: "Resend error" };
    const code = /letter-spacing: 8px;">(\d+)</.exec(payload.html)?.[1];
    if (code) codes.set(payload.to, code);
    events.push("email:code");
    return { ok: true };
  };
  globalThis.__acceptNotified = notified;

  const realError = console.error;
  const quiet = async (fn) => {
    console.error = (...args) => logged.push(args.map(String).join(" "));
    try {
      return await fn();
    } finally {
      console.error = realError;
    }
  };
  const emailOf = (token) => state.invites.find((i) => i.token_hash === hash(token))?.email ?? "";
  /** What the page's form does: the existing-account hint, like hasExistingAccount. */
  const hint = (token) => state.users.some((u) => u.email === emailOf(token) && u.password != null);
  const send = (token, password = PASSWORD, existingAccount = hint(token)) =>
    quiet(() => sendInviteCode({ token, password, existingAccount }));
  const accept = (
    token,
    password = PASSWORD,
    code = codes.get(emailOf(token)) ?? "",
    resetPassword = undefined,
  ) => quiet(() => acceptInvite({ token, password, code, resetPassword }));
  /** "Forgot your password?" (#63): a code with no password check, then a new password. */
  const forgot = async (token, newPassword, code) => {
    const sent = await send(token, newPassword, false);
    if (!sent.success) return sent;
    return accept(token, newPassword, code ?? codes.get(emailOf(token)) ?? "", true);
  };
  /** Both steps, with the code the address received, as a person would. */
  const run = async (token, password = PASSWORD, { existingAccount, code } = {}) => {
    const sent = await send(token, password, existingAccount ?? hint(token));
    if (!sent.success) return sent;
    return accept(token, password, code ?? codes.get(emailOf(token)) ?? "");
  };
  return {
    state,
    events,
    notified,
    logged,
    rpcCalls,
    signOuts,
    codes,
    expired,
    minted,
    emails,
    send,
    accept,
    forgot,
    run,
  };
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
  assert.deepEqual(w.events, [
    "auth:check",
    "email:code",
    "auth:code-ok",
    "auth:check",
    "burn:won",
    "member:update",
    "auth:signin",
  ]);
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
  assert.deepEqual(w.events, [
    "auth:check",
    "email:code",
    "auth:code-ok",
    "auth:check",
    "burn:lost",
  ]);
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
  assert.deepEqual(w.events, [
    "auth:check",
    "email:code",
    "auth:code-ok",
    "auth:check",
    "burn:lost",
  ]);
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
  assert.deepEqual(
    w.events,
    ["auth:check", "email:code", "auth:code-ok", "auth:check", "burn:won", "auth:signin"],
    "no membership write",
  );
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
  assert.deepEqual(w.events, [
    "auth:create",
    "email:code",
    "auth:code-ok",
    "auth:set-password",
    "burn:won",
    "member:insert",
    "auth:signin",
  ]);
  assert.equal(w.notified.length, 1);
});

test("6. TWO CONCURRENT ACCEPTANCES of one token: exactly one succeeds, the other is told it was used, one row", async () => {
  const w = world({
    invites: [invite({ email: "new@acme.test" })],
    burnGate: gate(2),
    sameCode: true,
  });
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

test("8. a wrong password on an existing account does not spend the token, and sends no code", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  const result = await w.run("tok-1", "not the password");
  assert.equal(result.success, false);
  assert.equal(result.needsExistingPassword, true);
  assert.deepEqual(w.events, ["auth:check-failed"]);
  assert.equal(w.state.invites[0].status, "pending", "still usable with the right password");
  assert.equal(w.state.members[0].status, "removed");
});

test("9. a new account whose password cannot be set: a fixed string, the code logged, the token not spent", async () => {
  const w = world({
    invites: [invite({ email: "new@acme.test" })],
    setPasswordFails: {
      message: "Database error updating user: relation auth.users",
      status: 500,
    },
  });
  const result = await w.run("tok-1");
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't create your account. Please try again.",
  });
  assert.deepEqual(w.logged, ["[accept-invite] set password: 500"]);
  assert.equal(w.state.invites[0].status, "pending");
  assert.deepEqual(w.events, ["auth:create", "email:code", "auth:code-ok", "auth:set-password"]);
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
    ["auth:check", "email:code", "auth:code-ok", "auth:check", "burn:won"],
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
/** Password checks that reached Supabase, right or wrong. */
const signIns = (w) => w.events.filter((e) => e.startsWith("auth:check")).length;

test("48-1. ten wrong passwords, then locked: the 11th never reaches the password check and spends nothing", async () => {
  freshLimit();
  const w = world({ keepLimit: true, invites: [samInvite(1)], users: [samUser] });
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
    keepLimit: true,
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
    keepLimit: true,
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
  const w = world({ keepLimit: true, invites: [samInvite(1)], users: [samUser] });
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
  const w = world({
    keepLimit: true,
    invites: [samInvite(1), samInvite(2, { company_id: CO2 })],
    users: [samUser],
  });
  for (let i = 0; i < 9; i++) await w.run("sam-1", `wrong password ${i}`);
  assert.equal((await w.run("sam-1", PASSWORD)).success, true);
  for (let i = 0; i < 10; i++) {
    assert.match((await w.run("sam-2", `wrong password ${i}`)).error, /doesn't match/);
  }
  assert.equal((await w.run("sam-2", "wrong password 11")).error, LOCKED);
});

test("48-6. a NEW address (no existing login) is not counted: account creation is not a password guess", async () => {
  freshLimit();
  const w = world({
    keepLimit: true,
    invites: [invite({ email: "new@acme.test", token_hash: hash("new-1") })],
  });
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
  const w = world({ keepLimit: true, invites: [samInvite(1)], users: [samUser] });
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

/* ── #51: an emailed code for EVERY acceptance ────────────────────────────
 * The code goes to the INVITED address; the account it proves must be that
 * address; a wrong or expired code writes nothing; an existing account proves
 * its password as well; sending and checking are limited per address, on the
 * #48 store, failing closed.
 */
const CODE_WRONG = "That code is not right or has expired.";
const WRONG_PASSWORD =
  "That password doesn't match your existing Remotiv account. Enter your current password to join.";
const newInvite = (overrides = {}) =>
  invite({ email: "new@acme.test", name: "New Person", ...overrides });

test("51-1. a new address: the send creates the account with NO password and NO membership, and emails a code", async () => {
  const w = world({ invites: [newInvite()] });
  assert.deepEqual(await w.send("tok-1"), { success: true });
  assert.equal(w.state.users.length, 1);
  assert.equal(w.state.users[0].password, null, "no password until the code is proved");
  assert.equal(w.state.users[0].app.remotiv_invite_signup, true, "marked, in app_metadata");
  assert.equal(w.state.users[0].confirmed, false, "unconfirmed until the code is proved");
  assert.equal(w.state.users[0].meta, undefined, "nothing in user_metadata");
  assert.equal(w.state.members.length, 0);
  assert.equal(w.state.invites[0].status, "pending");
  assert.deepEqual(w.events, ["auth:create", "email:code"]);
});

test("51-2. a wrong code writes nothing: no password, no burn, no membership, nobody signed in", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  const r = await w.accept("tok-1", PASSWORD, "000000");
  assert.deepEqual(r, { success: false, error: CODE_WRONG });
  assert.deepEqual(w.events, ["auth:create", "email:code", "auth:code-wrong"]);
  assert.equal(w.state.users[0].password, null);
  assert.equal(w.state.invites[0].status, "pending");
  assert.equal(w.state.members.length, 0);
  assert.equal(w.rpcCalls.length, 0);
});

test("51-3. an expired code and a code replaced by a newer send write nothing; the newest code joins", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  const first = w.codes.get("new@acme.test");
  await w.send("tok-1");
  const second = w.codes.get("new@acme.test");
  assert.deepEqual(await w.accept("tok-1", PASSWORD, first), { success: false, error: CODE_WRONG });
  w.expired.add(second);
  assert.deepEqual(await w.accept("tok-1", PASSWORD, second), {
    success: false,
    error: CODE_WRONG,
  });
  assert.equal(w.state.members.length, 0);
  assert.equal(w.state.users[0].password, null);
  assert.equal(w.state.invites[0].status, "pending");
  w.expired.delete(second);
  assert.deepEqual(await w.accept("tok-1", PASSWORD, second), { success: true });
  assert.equal(w.state.members.length, 1);
});

test("51-4. a code works ONCE: replaying it after a join is refused", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  const code = w.codes.get("new@acme.test");
  assert.deepEqual(await w.accept("tok-1", PASSWORD, code), { success: true });
  const again = await w.accept("tok-1", PASSWORD, code);
  assert.equal(again.success, false);
});

test("51-5. a code that does not look like one never reaches Supabase and costs no check", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  for (const code of ["", "12345", "abcdef", "12345678901", " 1 2 3 4 5 6"]) {
    assert.deepEqual(await w.accept("tok-1", PASSWORD, code), {
      success: false,
      error: CODE_WRONG,
    });
  }
  assert.ok(!w.events.some((e) => e.startsWith("auth:code-wrong")), "verifyOtp never called");
  assert.equal(
    (await limit.reserveInviteCodeVerify("new@acme.test")).ok,
    true,
    "the check budget is untouched",
  );
});

test("51-6. an existing account needs its password AND the code: the right code with a wrong password writes nothing", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  assert.deepEqual(await w.send("tok-1"), { success: true });
  const r = await w.accept("tok-1", "not the password");
  assert.deepEqual(r, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  assert.equal(w.rpcCalls.length, 0, "never reaches the grant");
  assert.equal(w.state.members[0].status, "removed");
  assert.equal(w.state.invites[0].status, "pending");
  assert.equal(raeUser.password, PASSWORD);
  assert.equal(w.state.users[0].password, PASSWORD, "the existing password is not changed");
  assert.ok(!w.events.includes("auth:signin"), "the browser is not signed in");
});

test("51-7. an existing account with the right password but the wrong code writes nothing", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  await w.send("tok-1");
  const r = await w.accept("tok-1", PASSWORD, "999999");
  assert.deepEqual(r, { success: false, error: CODE_WRONG });
  assert.equal(w.rpcCalls.length, 0);
  assert.equal(w.state.members[0].status, "removed");
  assert.ok(!w.events.includes("auth:signin"));
});

test("51-8. an existing account sent down the NEW path (a wrong hint) still has to prove its password: nothing written, password unchanged", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  const sent = await w.send("tok-1", "a brand new password", false);
  assert.deepEqual(sent, { success: true }, "the code goes to the owner of the address");
  assert.ok(!w.events.includes("auth:create"), "no second account");
  assert.equal(w.state.users.length, 1);
  assert.equal(w.state.users[0].app, undefined, "an account that existed is never marked");
  const r = await w.accept("tok-1", "a brand new password");
  assert.deepEqual(r, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  assert.ok(!w.events.includes("auth:set-password"), "the code alone never sets a password");
  assert.equal(w.state.users[0].password, PASSWORD);
  assert.equal(w.rpcCalls.length, 0);
});

test("51-9. the account the code proves must BE the invited address: any other is refused, nothing written", async () => {
  const w = world({ invites: [newInvite()], verifiedEmail: "someone.else@acme.test" });
  await w.send("tok-1");
  const r = await w.accept("tok-1");
  assert.deepEqual(r, { success: false, error: CODE_WRONG });
  assert.ok(!w.events.includes("auth:set-password"));
  assert.equal(w.rpcCalls.length, 0);
  assert.equal(w.state.members.length, 0);
  assert.deepEqual(w.logged, ["[accept-invite] check code: email_mismatch"]);
});

test("51-10. the browser is signed in only after the grant; every session the checks opened is closed", async () => {
  const fresh = world({ invites: [newInvite()] });
  assert.deepEqual(await fresh.run("tok-1"), { success: true });
  assert.equal(fresh.events.at(-1), "auth:signin");
  assert.ok(fresh.events.indexOf("auth:signin") > fresh.events.indexOf("burn:won"));
  assert.deepEqual(fresh.signOuts, ["local"], "the code's session, locally only");

  const existing = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  assert.deepEqual(await existing.run("tok-1"), { success: true });
  assert.equal(existing.events.filter((e) => e === "auth:signin").length, 1);
  assert.ok(existing.events.indexOf("auth:signin") > existing.events.indexOf("burn:won"));
  assert.deepEqual(
    existing.signOuts,
    ["local", "local", "local"],
    "two password checks and the code",
  );

  const refused = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  await refused.send("tok-1");
  await refused.accept("tok-1", "not the password");
  assert.ok(!refused.events.includes("auth:signin"));
  assert.ok(
    refused.signOuts.every((x) => x === "local"),
    "never a global sign-out",
  );
});

test("51-11. a new account's password is set and its marker cleared: the next invitation asks for that password", async () => {
  const w = world({
    invites: [newInvite(), newInvite({ id: "inv-2", company_id: CO2, token_hash: hash("tok-2") })],
  });
  assert.deepEqual(await w.run("tok-1"), { success: true });
  assert.equal(w.state.users[0].password, PASSWORD);
  assert.equal(w.state.users[0].app.remotiv_invite_signup, null);
  const sent = await w.send("tok-2", "another password!", false);
  assert.equal(sent.success, true);
  const r = await w.accept("tok-2", "another password!");
  assert.deepEqual(r, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  assert.equal(w.state.users[0].password, PASSWORD, "not overwritten by the code");
  assert.deepEqual(await w.run("tok-2", PASSWORD), { success: true }, "the real password joins");
});

test("51-12. a refused grant deletes the account the code step made, never one that existed", async () => {
  const made = world({
    invites: [newInvite()],
    memberWriteFails: { code: "XX000", message: "boom" },
  });
  assert.equal((await made.run("tok-1")).success, false);
  assert.ok(made.events.includes("auth:delete"));
  assert.equal(made.state.users.length, 0, "the account this invitation made is rolled back");

  const existing = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    memberWriteFails: { code: "XX000", message: "boom" },
  });
  assert.equal((await existing.run("tok-1")).success, false);
  assert.ok(!existing.events.includes("auth:delete"));
  assert.equal(existing.state.users.length, 1, "an existing account is never deleted");

  // Refused by the early, read-only check (the inviter went between the two
  // steps): nothing is deleted, and the address keeps an account with no
  // password and no membership, as the send left it.
  const early = world({ invites: [newInvite()] });
  await early.send("tok-1");
  early.state.inviters.length = 0;
  assert.equal((await early.accept("tok-1")).success, false);
  assert.ok(!early.events.includes("auth:code-ok"), "the code is not even checked");
  assert.equal(early.state.users.length, 1);
  assert.equal(early.state.members.length, 0);
});

test("51-13. sending is limited per ADDRESS: 5, then refused, across a Resend and another company; nothing more is emailed", async () => {
  const w = world({
    invites: [newInvite(), newInvite({ id: "inv-2", company_id: CO2, token_hash: hash("tok-2") })],
  });
  for (let i = 0; i < 5; i++) assert.deepEqual(await w.send("tok-1"), { success: true });
  const locked = "Too many codes were sent to this email. Please try again in 15 minutes.";
  assert.deepEqual(await w.send("tok-1"), { success: false, error: locked });
  assert.deepEqual(await w.send("tok-2"), { success: false, error: locked });
  assert.equal(w.events.filter((e) => e === "email:code").length, 5);
});

test("51-14. checking is limited per ADDRESS: 10 wrong codes, then even the right code is refused before Supabase", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  for (let i = 0; i < 10; i++) {
    assert.equal((await w.accept("tok-1", PASSWORD, `00000${i}`)).error, CODE_WRONG);
  }
  const r = await w.accept("tok-1");
  assert.deepEqual(r, {
    success: false,
    error: "Too many incorrect codes for this email. Please try again in 15 minutes.",
  });
  assert.equal(
    w.events.filter((e) => e.startsWith("auth:code-")).length,
    10,
    "10 checked; the 11th never reached Supabase",
  );
  assert.equal(w.state.members.length, 0);
});

test("51-15. the limit store unavailable: FAILS CLOSED, no code emailed and no code checked", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  limit.setInvitePasswordStoresForTests({
    async increment() {
      throw new Error("ECONNREFUSED");
    },
    async clear() {},
  });
  assert.deepEqual(await w.send("tok-1"), {
    success: false,
    error: "We couldn't send a code just now. Please try again in a moment.",
  });
  assert.deepEqual(await w.accept("tok-1"), {
    success: false,
    error: "We couldn't check your code just now. Please try again in a moment.",
  });
  assert.deepEqual(w.events, ["auth:create", "email:code"], "nothing after the outage");
  assert.equal(w.state.members.length, 0);
});

test("51-16. our email fails: the fixed message, the account this send made is deleted, nothing else written, the code never logged", async () => {
  const fresh = world({ invites: [newInvite()], emailFails: true });
  assert.deepEqual(await fresh.send("tok-1"), {
    success: false,
    error: "We couldn't send a code just now. Please try again in a moment.",
  });
  assert.equal(fresh.emails.length, 1, "one attempt, to Resend");
  assert.equal(fresh.state.users.length, 0, "the account made for it is undone");
  assert.ok(fresh.events.includes("auth:delete"));
  assert.equal(fresh.state.members.length, 0);
  assert.equal(fresh.state.invites[0].status, "pending");
  assert.deepEqual(fresh.logged, ["[accept-invite] send code: email_failed"]);
  assert.ok(!fresh.logged.join("\n").includes(fresh.minted[0]), "the code is not in any log");
  assert.equal(fresh.codes.size, 0, "nobody received a code");

  const existing = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    emailFails: true,
  });
  assert.equal((await existing.send("tok-1")).success, false);
  assert.ok(!existing.events.includes("auth:delete"), "an existing account is never deleted");
  assert.equal(existing.state.users.length, 1);
  assert.equal(existing.state.users[0].password, PASSWORD);
  assert.equal(existing.state.members[0].status, "removed");
});

test("51-16b. the code cannot be made: the fixed message, the new account undone, nothing emailed", async () => {
  const w = world({
    invites: [newInvite()],
    linkError: { code: "unexpected_failure", status: 500 },
  });
  assert.deepEqual(await w.send("tok-1"), {
    success: false,
    error: "We couldn't send a code just now. Please try again in a moment.",
  });
  assert.equal(w.emails.length, 0);
  assert.equal(w.state.users.length, 0);
  assert.deepEqual(w.logged, ["[accept-invite] make code: unexpected_failure"]);
});

test("51-19. a marker in USER_METADATA (which any signed-in user can write) gives no password-free path", async () => {
  // The account's owner set the marker on their own account through updateUser.
  const forged = { ...raeUser, meta: { remotiv_invite_signup: true } };
  const w = world({ invites: [invite()], members: [removedRae], users: [forged] });
  assert.deepEqual(await w.send("tok-1", "a brand new password", false), { success: true });
  const r = await w.accept("tok-1", "a brand new password");
  assert.deepEqual(r, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  assert.ok(!w.events.includes("auth:set-password"), "no password is set from the code");
  assert.equal(w.state.users[0].password, PASSWORD, "the real password is unchanged");
  assert.equal(w.rpcCalls.length, 0, "never reaches the grant");
  assert.ok(!w.events.includes("auth:signin"));
});

test("51-20. the marker is written only by the service role, in the call that creates the account, once", async () => {
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  await w.send("tok-1");
  assert.equal(w.events.filter((e) => e === "auth:create").length, 1, "created once");
  assert.ok(!w.events.includes("auth:link-create"), "generateLink never makes an unmarked account");
  assert.equal(w.state.users[0].app.remotiv_invite_signup, true);
});

test("51-23. NO Supabase email for any invitation: signInWithOtp is never called, new, existing, resend or join", async () => {
  const fresh = world({ invites: [newInvite()] });
  await fresh.send("tok-1");
  assert.deepEqual(await fresh.run("tok-1"), { success: true });
  const existing = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  assert.deepEqual(await existing.run("tok-1"), { success: true });
  const wrongHint = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  await wrongHint.send("tok-1", "a brand new password", false);
  for (const w of [fresh, existing, wrongHint]) {
    assert.ok(!w.events.includes("auth:supabase-email"));
  }
  const src = (await import("node:fs")).readFileSync(
    new URL("./actions.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/signInWithOtp|\.resend\(|signUp\(/.test(src), "no Supabase email call in the action");
});

test("51-24. the code goes ONLY to the invited address, in our email, with the agreed words", async () => {
  const w = world({ invites: [newInvite({ email: "New@Acme.test" })] });
  await w.send("tok-1");
  await w.send("tok-1");
  assert.equal(w.emails.length, 2);
  for (const [i, e] of w.emails.entries()) {
    assert.equal(e.to, "new@acme.test", "the invited address, and only it");
    assert.equal(e.replyTo, undefined);
    assert.equal(e.subject, "Your code to join Acme & Sons on Remotiv");
    const text = e.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(
      text.includes(
        "Enter this code to accept your invitation to join Acme &amp; Sons on Remotiv.",
      ),
      "the company name is escaped in the body",
    );
    assert.ok(text.includes(w.minted[i]), "the code is in the body");
    assert.ok(
      text.includes(
        "This code expires in 1 hour. If you were not expecting this, you can ignore this email.",
      ),
    );
    assert.ok(!/[\u2013\u2014]/.test(e.subject + e.html), "no dashes");
  }
  assert.deepEqual([...w.codes.keys()], ["new@acme.test"], "nobody else received a code");
});

test("51-25. the code is never logged, on any path", async () => {
  // Each world installs the fakes globally, so each is made and run in turn.
  const options = [
    {},
    { emailFails: true },
    { memberWriteFails: { code: "XX000", message: "boom" } },
    { verifiedEmail: "other@acme.test" },
  ];
  const worlds = [];
  const real = { log: console.log, info: console.info, warn: console.warn };
  const all = [];
  console.log = console.info = console.warn = (...a) => all.push(a.map(String).join(" "));
  try {
    for (const o of options) {
      const w = world({ invites: [newInvite()], ...o });
      worlds.push(w);
      await w.run("tok-1");
    }
  } finally {
    Object.assign(console, real);
  }
  for (const w of worlds) {
    assert.ok(w.minted.length > 0);
    const lines = [...w.logged, ...all].join("\n");
    for (const c of w.minted) assert.ok(!lines.includes(c), "a minted code appears in a log");
  }
});

test("51-21. an account that cannot be created at the send: a fixed string, the code logged, no code emailed", async () => {
  const w = world({
    invites: [newInvite()],
    createUserFails: {
      message: "Database error saving new user: relation auth.users",
      status: 500,
    },
  });
  assert.deepEqual(await w.send("tok-1"), {
    success: false,
    error: "Couldn't create your account. Please try again.",
  });
  assert.deepEqual(w.logged, ["[accept-invite] create account: 500"]);
  assert.deepEqual(w.events, []);
});

test("51-22. the page's code field and copy follow INVITE_CODE_LENGTH; the server still takes 6 to 10 digits", async () => {
  const { INVITE_CODE_LENGTH } = await import("./code-length.ts");
  assert.equal(INVITE_CODE_LENGTH, 6, "both projects are set to 6");
  const ui = (await import("node:fs")).readFileSync(
    new URL("./[token]/code-step.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/\b6 digit\b|maxLength=\{\d|pattern="/.test(ui),
    "no hard-coded length left in the page",
  );
  const w = world({ invites: [newInvite()] });
  await w.send("tok-1");
  for (const code of ["1234567", "1234567890"]) {
    const before = w.events.length;
    assert.deepEqual(await w.accept("tok-1", PASSWORD, code), {
      success: false,
      error: CODE_WRONG,
    });
    assert.equal(w.events[before], "auth:code-wrong", `${code.length} digits reached Supabase`);
  }
});

test("51-17. a dead invitation sends no code and creates no account", async () => {
  for (const over of [{ status: "revoked" }, { expires_at: YESTERDAY }, { invited_by: null }]) {
    const w = world({ invites: [newInvite(over)] });
    assert.equal((await w.send("tok-1")).success, false);
    assert.deepEqual(w.events, []);
    assert.equal(w.state.users.length, 0);
  }
});

test("51-18. the new copy has no dashes", async () => {
  const src = await import("node:fs").then((fs) =>
    [
      fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./[token]/code-step.tsx", import.meta.url), "utf8"),
    ].join("\n"),
  );
  for (const copy of [
    "We sent a {INVITE_CODE_LENGTH} digit code to",
    "Enter it to confirm this is your email.",
    "That code is not right or has expired.",
    "Send a new code",
  ]) {
    // JSX text wraps across lines; the page renders it as one run of words.
    assert.ok(src.replace(/\s+/g, " ").includes(copy), copy);
  }
  const strings = src.match(/"[^"\n]*"|`[^`\n]*`|>[^<>{}\n]+</g) ?? [];
  assert.deepEqual(
    strings.filter((x) => /[–—]/.test(x)),
    [],
  );
});

/* ── #63: "Forgot your password?" on the existing-account step ──────────────
 * The emailed code alone proves the mailbox, as a password reset email does;
 * the new password replaces the old one; the limits are #51's.
 */
const NEW_PASSWORD = "a fresh new password";
/** A password check on a cookie-less client, as the action makes it. */
const passwordWorks = async (email, password) =>
  (await globalThis.__acceptStateless().auth.signInWithPassword({ email, password })).error ===
  null;

test("63-1. forgot path: code + new password joins, signed in, with no check of the old password", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  assert.deepEqual(await w.forgot("tok-1", NEW_PASSWORD), { success: true });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.invites[0].status, "accepted");
  assert.equal(w.state.users.length, 1, "the same account, no second one");
  assert.equal(w.state.users[0].password, NEW_PASSWORD);
  assert.deepEqual(w.events, [
    "email:code",
    "auth:code-ok",
    "auth:set-password",
    "burn:won",
    "member:update",
    "auth:signin",
  ]);
  assert.ok(!w.events.some((e) => e.startsWith("auth:check")), "the old password is never asked");
  assert.equal(w.rpcCalls[0].p_user_id, "u-rae");
});

test("63-2. forgot path, wrong code: nothing written, the old password still works", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  const r = await w.forgot("tok-1", NEW_PASSWORD, "000000");
  assert.deepEqual(r, { success: false, error: CODE_WRONG });
  assert.ok(!w.events.includes("auth:set-password"));
  assert.equal(w.state.users[0].password, PASSWORD);
  assert.equal(w.rpcCalls.length, 0);
  assert.equal(w.state.members[0].status, "removed");
  assert.equal(w.state.invites[0].status, "pending");
  assert.ok(!w.events.includes("auth:signin"));
});

test("63-3. afterwards the OLD password no longer works and the new one does", async () => {
  const w = world({
    invites: [invite(), invite({ id: "inv-2", company_id: CO2, token_hash: hash("tok-2") })],
    members: [removedRae],
    users: [raeUser],
  });
  assert.deepEqual(await w.forgot("tok-1", NEW_PASSWORD), { success: true });
  assert.equal(await passwordWorks("rae@acme.test", PASSWORD), false);
  assert.equal(await passwordWorks("rae@acme.test", NEW_PASSWORD), true);
  const old = await w.run("tok-2", PASSWORD);
  assert.deepEqual(old, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  assert.deepEqual(await w.run("tok-2", NEW_PASSWORD), { success: true });
});

test("63-4. an account with NO password (code sign-in only) joins through the forgot path", async () => {
  const w = world({
    invites: [invite()],
    users: [{ id: "u-rae", email: "rae@acme.test", password: null }],
  });
  assert.deepEqual(await w.forgot("tok-1", NEW_PASSWORD), { success: true });
  assert.equal(w.state.users[0].password, NEW_PASSWORD);
  assert.equal(w.state.members[0].user_id, "u-rae");
});

test("63-5. the limits apply: 5 sends per address shared with the normal path, then 10 checks", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  for (let i = 0; i < 3; i++) assert.equal((await w.send("tok-1")).success, true, "normal path");
  for (let i = 0; i < 2; i++) {
    assert.equal((await w.send("tok-1", NEW_PASSWORD, false)).success, true, "forgot path");
  }
  assert.deepEqual(await w.send("tok-1", NEW_PASSWORD, false), {
    success: false,
    error: "Too many codes were sent to this email. Please try again in 15 minutes.",
  });
  for (let i = 0; i < 10; i++) {
    assert.equal((await w.accept("tok-1", NEW_PASSWORD, `90000${i}`, true)).error, CODE_WRONG);
  }
  assert.deepEqual(await w.accept("tok-1", NEW_PASSWORD, undefined, true), {
    success: false,
    error: "Too many incorrect codes for this email. Please try again in 15 minutes.",
  });
  assert.equal(w.state.users[0].password, PASSWORD, "never reset");
  assert.equal(w.rpcCalls.length, 0);
});

test("63-6. the normal path is unchanged: without the forgot choice the code alone never sets a password", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  for (const reset of [undefined, false, "true", 1]) {
    // A code works once, so each try gets its own.
    await w.send("tok-1");
    const r = await w.accept("tok-1", NEW_PASSWORD, undefined, reset);
    assert.deepEqual(r, { success: false, error: WRONG_PASSWORD, needsExistingPassword: true });
  }
  assert.ok(!w.events.includes("auth:set-password"));
  assert.equal(w.state.users[0].password, PASSWORD);
});

test("63-7. a new password shorter than 8 is refused before anything is sent or set", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  assert.deepEqual(await w.forgot("tok-1", "short"), {
    success: false,
    error: "Password must be at least 8 characters.",
  });
  assert.deepEqual(w.events, []);
});

test("63-8. the grant refused after a reset: the password stays reset, no membership, the account is never deleted", async () => {
  const w = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    memberWriteFails: { code: "XX000", message: "boom" },
  });
  const r = await w.forgot("tok-1", NEW_PASSWORD);
  assert.equal(r.success, false);
  assert.equal(w.state.users.length, 1);
  assert.ok(!w.events.includes("auth:delete"));
  assert.equal(w.state.users[0].password, NEW_PASSWORD, "a proven reset is not undone");
  assert.equal(w.state.members[0].status, "removed");
  assert.equal(w.state.invites[0].status, "pending");
});

test("63-9. a reset that cannot be saved: a fixed string, the code logged, nothing granted", async () => {
  const w = world({
    invites: [invite()],
    members: [removedRae],
    users: [raeUser],
    setPasswordFails: { message: "Database error updating user", status: 500 },
  });
  assert.deepEqual(await w.forgot("tok-1", NEW_PASSWORD), {
    success: false,
    error: "Couldn't set your new password. Please try again.",
  });
  assert.deepEqual(w.logged, ["[accept-invite] reset password: 500"]);
  assert.equal(w.rpcCalls.length, 0);
  assert.ok(!w.events.includes("auth:signin"));
});

test("63-10. the forgot path clears the #48 lock: an account locked by wrong guesses can reset and join", async () => {
  const w = world({ invites: [invite()], members: [removedRae], users: [raeUser] });
  for (let i = 0; i < 11; i++) await w.send("tok-1", `wrong password ${i}`, true);
  assert.equal((await w.send("tok-1", PASSWORD, true)).error, LOCKED);
  assert.deepEqual(await w.forgot("tok-1", NEW_PASSWORD), { success: true });
  assert.equal((await limit.reserveInvitePasswordAttempt("rae@acme.test")).ok, true);
});

test("63-11. the page offers the forgot link only on the existing-account step, with no dashes", async () => {
  const fs = await import("node:fs");
  const ui = fs.readFileSync(new URL("./[token]/accept-client.tsx", import.meta.url), "utf8");
  const flat = ui.replace(/\s+/g, " ");
  assert.match(flat, /\{signInMode && \( <button type="button" onClick=\{startReset\}/);
  for (const copy of [
    "Forgot your password?",
    "Choose a new password. We will email you a code to confirm this is your email.",
    "Use my current password",
  ]) {
    assert.ok(flat.includes(copy), copy);
    assert.ok(!/[\u2013\u2014]/.test(copy));
  }
  const code = fs.readFileSync(new URL("./[token]/code-step.tsx", import.meta.url), "utf8");
  assert.match(code, /acceptInvite\(\{ token, password, code, resetPassword \}\)/);
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
