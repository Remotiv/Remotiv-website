/**
 * removeMember, run as shipped against a fake database (#100 extension):
 * removing a member revokes that company's pending invitations for them FIRST,
 * so acceptance (which now reactivates a removed row) cannot bring them back.
 *
 *   node --test "src/app/ai-dashboard/(gated)/team/actions.test.ts"
 *
 * ── What is tested ───────────────────────────────────────────
 *
 * The removal and the acceptance run together over ONE fake world, so the
 * two writes of the removal (revoke, then remove) and the burn of an
 * acceptance can be interleaved on purpose. The responder applies the real
 * predicates: the revoke's company + email + pending, the burn's id + pending
 * + unexpired, the (company_id, user_id) membership lookup. Hooks let a test
 * hold a write until another has landed, which is how both orderings of the
 * race are driven rather than hoped for.
 *
 * Everything the two actions import that would reach the network is stubbed:
 * Supabase (fake), the rate limiter (its cleanup timer keeps Node alive),
 * notifications, email and the invite template. Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": [
    "export function createServiceClient() { return globalThis.__teamService(); }",
    "export async function createClient() { return globalThis.__teamAuthClient(); }",
    "export function createStatelessClient() { return globalThis.__teamStateless(); }",
  ].join("\\n"),
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/notifications/company": "export async function notifyCompany(input) { globalThis.__teamNotified.push(input); }",
  "@/lib/email/send": "export async function sendEmail() { return { ok: true }; }",
  "@/lib/email/templates/company-invite": "export const companyInviteSubject = 'x'; export function renderCompanyInviteEmail() { return ''; }",
  "@/lib/validators": "export function isValidEmail(e) { return /@/.test(e); }",
  "@/lib/company-identity": "export function isAlreadyRegistered(m) { return /already|exists|registered/i.test(m); }",
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function requireCompanyRole() { return globalThis.__teamCtx; }",
    "export async function getCompanyContext() { return globalThis.__teamCtx; }",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { removeMember, updateMemberRole } = await import("./actions.ts");
const { acceptInvite, sendInviteCode } = await import("../../accept/actions.ts");
// The real limiter, on a fresh memory store per world: the email code (#51)
// has a per-address send budget that would otherwise carry across tests.
const limit = await import("../../../../lib/invite-password-limit.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const CODE = "424242";
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PASSWORD = "correct horse battery";
/**
 * The fake database's clock for removed_at (migration 057's trigger stamps
 * now()): strictly increasing, so a stamp written later always sorts later
 * than any fixture timestamp and than any invitation created before it.
 */
let clockMs = Date.parse("2026-11-10T12:00:00.000Z");
function tick() {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}
/** When fixture invitations were created: before the clock, so before any removal stamp. */
const INVITED_AT = "2026-11-10T11:00:00.000Z";
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const eqMap = (calls) =>
  Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));

const OWNER_CTX = {
  companyId: CO,
  role: "owner",
  memberId: "m-owner",
  memberName: "Olive Owner",
  user: { id: "u-owner", email: "olive@acme.test" },
  company: { name: "Acme" },
  mustChangePassword: false,
};

/** A step the test can hold: `wait()` blocks until `release()` is called. */
function latch() {
  let release = () => {};
  const open = new Promise((r) => {
    release = r;
  });
  return { wait: () => open, release };
}

/**
 * One fake world shared by removeMember and acceptInvite. `hooks` are awaited
 * at the named points so a test can order the writes of two concurrent calls.
 */
function world({
  invites = [],
  members = [],
  users = [],
  revokeFails = null,
  revokeSentFails = null,
  removeFails = null,
  hooks = {},
  inviters = [
    { id: "m-owner", company_id: CO, user_id: "u-owner", role: "owner", status: "active" },
  ],
} = {}) {
  const state = {
    invites: structuredClone(invites),
    members: structuredClone(members),
    users: structuredClone(users),
    // Who SENT the invitations (#49); apart from `members`, which is the joiner side.
    inviters: structuredClone(inviters),
  };
  const events = [];
  const logged = [];
  let nextId = 1;
  limit.setInvitePasswordStoresForTests(limit.memoryAttemptStore());

  const service = fakeService(async (table, calls) => {
    const eqs = eqMap(calls);
    const op = calls[0]?.[0];
    if (table === "rpc:accept_company_invite") {
      // Migration 062 as one atomic step: the burn hooks bracket the WHOLE
      // transaction, because nothing can land between its burn and its grant
      // (the locks; proven on real Postgres by scripts/staging/proofs-062.mjs).
      const a = calls[0][1];
      state.rpcCalls = (state.rpcCalls ?? 0) + 1;
      if (hooks.beforeBurn) await hooks.beforeBurn();
      const decide = () => {
        const inv = state.invites.find((i) => i.token_hash === a.p_token_hash);
        if (!inv) return "invalid";
        if (inv.status !== "pending" || !(inv.expires_at > new Date().toISOString())) {
          events.push("burn:lost");
          return "not_pending";
        }
        const invited = inv.email.trim().toLowerCase();
        if ((a.p_email ?? "").trim().toLowerCase() !== invited) return "email_mismatch";
        if (
          !state.users.some((u) => u.id === a.p_user_id && u.email.trim().toLowerCase() === invited)
        ) {
          return "user_mismatch";
        }
        const ok = (m) =>
          m.company_id === inv.company_id &&
          m.user_id === inv.invited_by &&
          m.status === "active" &&
          (m.role === "owner" || m.role === "admin");
        if (!inv.invited_by || ![...state.inviters, ...state.members].some(ok))
          return "inviter_invalid";
        inv.status = "accepted";
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
          return "joined";
        }
        if (m.status === "active") return "already_member";
        if (m.status === "removed") {
          if (m.removed_at == null || !(m.removed_at < inv.created_at)) return "stale_removal";
        } else if (m.removed_at != null) {
          return "status_changed";
        }
        events.push("member:update");
        Object.assign(m, {
          status: "active",
          role: inv.role,
          name: a.p_name,
          email: invited,
          removed_at: null,
        });
        return "joined";
      };
      const outcome = decide();
      if (hooks.afterBurn) hooks.afterBurn();
      return { data: outcome, error: null };
    }
    if (table === "company_members" && op === "select" && calls.some((c) => c[0] === "in")) {
      // acceptInvite's early, read-only inviter check (#49).
      const roles = calls.find((c) => c[0] === "in")[2];
      const row = [...state.inviters, ...state.members].find(
        (m) =>
          m.company_id === eqs.company_id &&
          m.user_id === eqs.user_id &&
          m.status === eqs.status &&
          roles.includes(m.role),
      );
      return { data: row ? { id: row.id } : null, error: null };
    }
    if (table === "company_invites" && op === "update" && "invited_by" in eqs) {
      // removeMember / updateMemberRole: revoke what the member SENT here (#49).
      events.push("invites:revoke-sent");
      if (revokeSentFails) return { data: null, error: revokeSentFails };
      for (const row of state.invites) {
        if (
          row.company_id === eqs.company_id &&
          row.invited_by === eqs.invited_by &&
          row.status === eqs.status
        ) {
          row.status = calls[0][1].status;
        }
      }
      return { data: null, error: null };
    }
    if (table === "company_members" && op === "select") {
      if ("id" in eqs) {
        const row = state.members.find((m) => m.id === eqs.id) ?? null;
        return { data: row ? { ...row } : null, error: null };
      }
      // acceptInvite's membership lookup, after its burn.
      if (hooks.beforeMemberLookup) await hooks.beforeMemberLookup();
      const row =
        state.members.find((m) => m.company_id === eqs.company_id && m.user_id === eqs.user_id) ??
        null;
      return { data: row ? { id: row.id, status: row.status } : null, error: null };
    }
    if (table === "company_members" && op === "update") {
      const patch = calls[0][1];
      if (patch.status === "removed") {
        if (hooks.beforeRemove) await hooks.beforeRemove();
        events.push("member:remove");
        if (removeFails) return { data: null, error: removeFails };
      } else {
        events.push("member:update");
      }
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
          (!lt || (m[lt[0]] != null && m[lt[0]] < lt[1])) &&
          (!isNull || m[isNull] == null),
      );
      const returning = calls.some((c) => c[0] === "select");
      if (!row) return { data: returning ? null : undefined, error: null };
      const before = row.status;
      Object.assign(row, patch);
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
      state.members.push({ id: `m-${nextId++}`, ...calls[0][1] });
      return { data: null, error: null };
    }
    if (table === "company_invites" && op === "select") {
      const row = state.invites.find((i) => i.token_hash === eqs.token_hash) ?? null;
      return { data: row ? { ...row } : null, error: null };
    }
    if (table === "company_invites" && op === "update" && "email" in eqs) {
      // removeMember's revoke: company + email + pending, every matching row.
      if (hooks.beforeRevoke) await hooks.beforeRevoke();
      events.push("invites:revoke");
      if (revokeFails) return { data: null, error: revokeFails };
      for (const row of state.invites) {
        if (
          row.company_id === eqs.company_id &&
          row.email === eqs.email &&
          row.status === eqs.status
        ) {
          row.status = calls[0][1].status;
        }
      }
      if (hooks.afterRevoke) hooks.afterRevoke();
      return { data: null, error: null };
    }
    if (table === "company_invites" && op === "update" && "id" in eqs) {
      // acceptInvite's burn: id + pending + unexpired, RETURNING one row.
      if (hooks.beforeBurn) await hooks.beforeBurn();
      const row = state.invites.find((i) => i.id === eqs.id);
      const gt = calls.find((c) => c[0] === "gt" && c[1] === "expires_at")?.[2];
      if (row && row.status === "pending" && eqs.status === "pending" && row.expires_at > gt) {
        row.status = "accepted";
        events.push("burn:won");
        if (hooks.afterBurn) hooks.afterBurn();
        return {
          data: {
            id: row.id,
            company_id: row.company_id,
            email: row.email,
            role: row.role,
            created_at: row.created_at, // the database's own timestamp, via RETURNING
          },
          error: null,
        };
      }
      events.push("burn:lost");
      if (hooks.afterBurn) hooks.afterBurn();
      return { data: null, error: null };
    }
    // The company's name, for the invitation code email (#51).
    if (table === "companies" && op === "select") return { data: { name: "Acme" }, error: null };
    throw new Error(`unexpected ${op} on ${table}`);
  });
  service.auth = {
    admin: {
      async createUser({ email, password, app_metadata }) {
        if (state.users.some((u) => u.email === email)) {
          return {
            data: { user: null },
            error: { message: "A user with this email address has already been registered" },
          };
        }
        const user = { id: `u-${nextId++}`, email, password: password ?? null, app: app_metadata };
        state.users.push(user);
        return { data: { user: { id: user.id } }, error: null };
      },
      async deleteUser(id) {
        state.users = state.users.filter((u) => u.id !== id);
        return { data: null, error: null };
      },
    },
  };
  const authClient = {
    auth: {
      async signInWithPassword({ email, password }) {
        const user = state.users.find((u) => u.email === email && u.password === password);
        return user
          ? { data: { user: { id: user.id } }, error: null }
          : { data: { user: null }, error: { message: "Invalid login credentials" } };
      },
    },
  };
  // The email code (#51) is not what these tests are about: every address's
  // code is CODE and always right. accept/actions.test.ts tests the code.
  service.auth.admin.generateLink = async ({ email }) => {
    if (!state.users.some((u) => u.email === email)) throw new Error("unmarked account");
    return { data: { properties: { email_otp: CODE } }, error: null };
  };
  service.auth.admin.updateUserById = async (id, attrs) => {
    const user = state.users.find((u) => u.id === id);
    user.password = attrs.password;
    user.app = { ...user.app, ...attrs.app_metadata };
    return { data: { user: { id } }, error: null };
  };
  const stateless = () => ({
    auth: {
      signInWithPassword: authClient.auth.signInWithPassword,
      async signInWithOtp() {
        throw new Error("no Supabase email for an invitation (#51)");
      },
      async verifyOtp({ email, token }) {
        const user = state.users.find((u) => u.email === email);
        return user && token === CODE
          ? { data: { user: { id: user.id, email, app_metadata: { ...user.app } } }, error: null }
          : { data: { user: null }, error: { code: "otp_expired" } };
      },
      async signOut() {
        return { error: null };
      },
    },
  });

  globalThis.__teamService = () => service;
  globalThis.__teamAuthClient = () => authClient;
  globalThis.__teamStateless = stateless;
  globalThis.__teamNotified = [];
  globalThis.__teamCtx = OWNER_CTX;

  const sendCode = (token) => {
    const hash = createHash("sha256").update(token).digest("hex");
    const email = state.invites.find((i) => i.token_hash === hash)?.email;
    const existingAccount = state.users.some((u) => u.email === email && u.password);
    return sendInviteCode({ token, password: PASSWORD, existingAccount });
  };
  const realError = console.error;
  const capture = async (fn) => {
    console.error = (...args) => logged.push(args.map(String).join(" "));
    try {
      return await fn();
    } finally {
      console.error = realError;
    }
  };
  return {
    state,
    events,
    logged,
    remove: (memberId) => capture(() => removeMember(memberId)),
    // Both steps of accepting (#51), as the page runs them.
    accept: (token) =>
      capture(async () => {
        const sent = await sendCode(token);
        if (!sent.success) return sent;
        return acceptInvite({ token, password: PASSWORD, code: CODE });
      }),
    // The steps apart, for a race against the FINAL step only.
    send: (token) => capture(() => sendCode(token)),
    finish: (token) => capture(() => acceptInvite({ token, password: PASSWORD, code: CODE })),
  };
}

const raeUser = { id: "u-rae", email: "rae@acme.test", password: PASSWORD };
const activeRae = {
  id: "m-rae",
  company_id: CO,
  user_id: "u-rae",
  email: "rae@acme.test",
  name: "Rae",
  role: "recruiter",
  status: "active",
};
const invite = (overrides = {}) => ({
  invited_by: "u-owner",
  id: "inv-1",
  company_id: CO,
  email: "rae@acme.test",
  name: "Rae",
  role: "recruiter",
  status: "pending",
  expires_at: TOMORROW,
  created_at: INVITED_AT,
  token_hash: hash("tok-1"),
  ...overrides,
});

test("1. removing a member revokes that company's pending invitation for them; accepting it afterwards is refused and writes nothing", async () => {
  const w = world({ invites: [invite()], members: [activeRae], users: [raeUser] });
  const removed = await w.remove("m-rae");
  assert.deepEqual(removed, { success: true, data: undefined });
  assert.equal(w.state.members[0].status, "removed");
  assert.equal(w.state.invites[0].status, "revoked", "no longer pending");
  assert.deepEqual(
    w.events,
    ["invites:revoke", "invites:revoke-sent", "member:remove"],
    "revoke FIRST, then remove",
  );

  const accepted = await w.accept("tok-1");
  assert.deepEqual(accepted, { success: false, error: "This invitation is no longer active." });
  assert.equal(w.state.members[0].status, "removed", "nothing reactivated");
  assert.deepEqual(
    w.events,
    ["invites:revoke", "invites:revoke-sent", "member:remove"],
    "and nothing written by the acceptance",
  );
});

test("2. a pending invitation for a DIFFERENT company survives untouched", async () => {
  const other = invite({ id: "inv-other", company_id: CO2, token_hash: hash("tok-other") });
  const w = world({ invites: [invite(), other], members: [activeRae], users: [raeUser] });
  await w.remove("m-rae");
  assert.equal(w.state.invites.find((i) => i.id === "inv-1").status, "revoked");
  assert.equal(
    w.state.invites.find((i) => i.id === "inv-other").status,
    "pending",
    "theirs to keep",
  );
});

test("3. an already-accepted or already-revoked invitation is not disturbed", async () => {
  const w = world({
    invites: [
      invite({ id: "inv-acc", status: "accepted", token_hash: hash("tok-acc") }),
      invite({ id: "inv-rev", status: "revoked", token_hash: hash("tok-rev") }),
      invite({ id: "inv-exp", status: "expired", token_hash: hash("tok-exp") }),
    ],
    members: [activeRae],
    users: [raeUser],
  });
  await w.remove("m-rae");
  assert.deepEqual(
    w.state.invites.map((i) => i.status),
    ["accepted", "revoked", "expired"],
    "only pending rows are touched",
  );
});

test("4. a fresh owner-issued invitation after the removal still works and reactivates them (#100's point)", async () => {
  const w = world({ invites: [invite()], members: [activeRae], users: [raeUser] });
  await w.remove("m-rae");
  assert.equal(w.state.members[0].status, "removed");
  // The owner invites again: a new pending row with a new token and a new role,
  // created AFTER the removal (the database writes created_at = now()).
  w.state.invites.push(
    invite({ id: "inv-2", role: "hiring_manager", token_hash: hash("tok-2"), created_at: tick() }),
  );
  const accepted = await w.accept("tok-2");
  assert.deepEqual(accepted, { success: true });
  assert.equal(w.state.members.length, 1, "the same row, reactivated");
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.members[0].role, "hiring_manager", "with the new invitation's role");
  assert.equal(w.state.invites.find((i) => i.id === "inv-2").status, "accepted");
});

test("5. the revoke write fails: the removal FAILS CLOSED, the member stays active, the code is logged, nothing leaks", async () => {
  const w = world({
    invites: [invite()],
    members: [activeRae],
    users: [raeUser],
    revokeFails: {
      code: "57014",
      message: 'canceling statement on "company_invites" (token_hash)',
    },
  });
  const result = await w.remove("m-rae");
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't remove this member. Please try again.",
  });
  assert.equal(
    w.state.members[0].status,
    "active",
    "not reported removed while an invitation could reactivate them",
  );
  assert.equal(w.state.invites[0].status, "pending");
  assert.deepEqual(w.events, ["invites:revoke"], "the membership write never ran");
  assert.deepEqual(w.logged, ["[team] remove member: revoking pending invitations failed: 57014"]);
  for (const needle of ["company_invites", "token_hash", "canceling"]) {
    assert.ok(
      !w.logged.join("\n").includes(needle) && !result.error.includes(needle),
      `leaked ${needle}`,
    );
  }
});

test("6. the removal write fails after the revoke: not reported as removed, the member is still active, the invitation is gone", async () => {
  const w = world({
    invites: [invite()],
    members: [activeRae],
    users: [raeUser],
    removeFails: { code: "57014", message: "boom" },
  });
  const result = await w.remove("m-rae");
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't remove this member. Please try again.",
  });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(
    w.state.invites[0].status,
    "revoked",
    "harmless: an active member lost an invitation they did not need",
  );
  assert.deepEqual(
    w.logged,
    ["[team] remove member: membership write failed: 57014"],
    "the code only",
  );
  assert.ok(
    !w.logged.join("\n").includes("boom") && !result.error.includes("boom"),
    "no raw message anywhere",
  );
});

/** A row removed BEFORE the fixture invitation was created: a fresh invitation would reactivate it. */
const REMOVED_EARLIER = "2026-11-10T10:00:00.000Z";

test("7a. race, revoke lands before the burn: the acceptance is refused and the removal completes", async () => {
  const revoked = latch();
  const burned = latch();
  const w = world({
    invites: [invite()],
    members: [{ ...activeRae, status: "removed", removed_at: REMOVED_EARLIER }],
    users: [raeUser],
    hooks: {
      afterRevoke: revoked.release, // the burn waits for the revoke to land
      beforeBurn: revoked.wait,
      afterBurn: burned.release, // the membership write waits for the burn to try
      beforeRemove: burned.wait,
    },
  });
  // The code was sent before (#51); then a removal of the (already removed)
  // row and the final step of the acceptance, in flight together.
  assert.deepEqual(await w.send("tok-1"), { success: true });
  const [removal, acceptance] = await Promise.all([w.remove("m-rae"), w.finish("tok-1")]);
  assert.deepEqual(removal, { success: true, data: undefined });
  assert.deepEqual(acceptance, { success: false, error: "This invitation has already been used." });
  assert.deepEqual(w.events, [
    "invites:revoke",
    "invites:revoke-sent",
    "burn:lost",
    "member:remove",
  ]);
  assert.equal(w.state.members[0].status, "removed", "final state: removed");
  assert.equal(
    w.state.invites[0].status,
    "revoked",
    "and nothing pending that could reactivate them",
  );
});

test("7b. race, the burn lands before the revoke: they are reactivated, then removed; nothing pending survives", async () => {
  const written = latch();
  const w = world({
    invites: [invite()],
    members: [{ ...activeRae, status: "removed", removed_at: REMOVED_EARLIER }],
    users: [raeUser],
    hooks: {
      beforeRevoke: written.wait, // the removal's first write waits for the whole acceptance
    },
  });
  const acceptance = w.accept("tok-1").then((r) => {
    written.release();
    return r;
  });
  const [removal, accepted] = await Promise.all([w.remove("m-rae"), acceptance]);
  assert.deepEqual(accepted, { success: true });
  assert.deepEqual(removal, { success: true, data: undefined });
  assert.deepEqual(w.events, [
    "burn:won",
    "member:update",
    "invites:revoke",
    "invites:revoke-sent",
    "member:remove",
  ]);
  assert.equal(w.state.members[0].status, "removed", "final state: removed");
  assert.equal(w.state.invites[0].status, "accepted", "the token is spent, not pending");
});

/*
 * ── The reachable starting state for 7c and 7d ──────────────
 *
 * An ACTIVE member who also holds a pending invitation that resolves to the
 * SAME auth user. inviteMember refuses to invite an active member by email
 * (team/actions.ts:369-379), so this needs the member row and the invitation
 * to carry different addresses for one account. That happens through
 * updateOwnAccount (settings/actions.ts:271-295): it changes the AUTH email
 * first, then updates company_members.email only for the company it was
 * called in (`.eq("company_id", ctx.companyId)`, 294), and never checks that
 * write's error. So a person in two companies who changes their address in
 * one leaves the other company's row on the OLD address with the auth user on
 * the NEW one; a failed row write does the same inside one company. An
 * invitation to the new address then passes the active-member check (it
 * looks for the new address, the row holds the old), and acceptance resolves
 * it to the same auth user (signInWithPassword on the invited address), so
 * the membership lookup by (company_id, user_id) finds the existing row. The
 * removal's revoke matches the row's OLD address and misses the invitation.
 *
 * If the invited address resolved to a DIFFERENT auth user, acceptance would
 * find no row and INSERT a new membership: a new person joining, not a
 * reactivation. These two tests are about the same-user case only.
 *
 * Fixture: member row email X (rae@acme.test), auth user U now on Y
 * (rae@newmail.test), invitation to Y.
 *
 * Both were KNOWN FAILING until migration 057: a removed_at on the membership
 * row, written by the database on the transition into 'removed' and cleared
 * on the way out, and a reactivation that is ONE conditional UPDATE refusing
 * when the invitation's server-written created_at is not later than it. They
 * pass by that comparison, which the fake applies as the database would; the
 * assertions are the same ones that failed before.
 */
const Y = "rae@newmail.test";
const raeMovedUser = { id: "u-rae", email: Y, password: PASSWORD };
const inviteToY = (overrides = {}) =>
  invite({ id: "inv-y", email: Y, token_hash: hash("tok-y"), ...overrides });

/*
 * 7c, rewritten for #49 (migration 062). Before 062 the acceptance was three
 * separate writes, and this test drove a removal BETWEEN its burn and its
 * membership write. accept_company_invite burns and grants in ONE transaction
 * holding the joiner's membership row FOR UPDATE, so that interleaving no
 * longer exists: a removal lands wholly before the function or wholly after
 * it. Both serial orders are below; that nothing can land between is proven on
 * a real Postgres by scripts/staging/proofs-062.mjs, not by this fake.
 */
test("7c-i. (#49) the removal lands BEFORE the atomic acceptance: refused by 057, the member stays removed, the stale token is spent", async () => {
  const removed = latch();
  const w = world({
    invites: [inviteToY()],
    members: [activeRae], // email X, active
    users: [raeMovedUser], // the same account, now on Y
    hooks: { beforeBurn: removed.wait },
  });
  const removal = w.remove("m-rae").then((r) => {
    removed.release();
    return r;
  });
  const [removalResult, acceptance] = await Promise.all([removal, w.accept("tok-y")]);
  assert.deepEqual(removalResult, { success: true, data: undefined });
  assert.deepEqual(w.events, [
    "invites:revoke",
    "invites:revoke-sent",
    "member:remove",
    "burn:won",
  ]);
  assert.equal(acceptance.success, false, "refused: the invitation predates the removal");
  assert.equal(
    acceptance.error,
    "Couldn't finish joining the workspace. Please ask for a new invitation.",
  );
  assert.equal(w.state.members[0].status, "removed", "final state: removed");
  assert.equal(w.state.invites[0].status, "accepted", "the stale token is consumed harmlessly");
});

test("7c-ii. (#49) the atomic acceptance lands BEFORE the removal: already a member, token spent, then removed", async () => {
  const accepted = latch();
  const w = world({
    invites: [inviteToY()],
    members: [activeRae], // email X, active
    users: [raeMovedUser], // the same account, now on Y
    hooks: { afterBurn: accepted.release, beforeRevoke: accepted.wait },
  });
  const [removalResult, acceptance] = await Promise.all([w.remove("m-rae"), w.accept("tok-y")]);
  assert.deepEqual(acceptance, { success: true }, "already an active member: nothing to grant");
  assert.deepEqual(removalResult, { success: true, data: undefined });
  assert.deepEqual(w.events, [
    "burn:won",
    "invites:revoke",
    "invites:revoke-sent",
    "member:remove",
  ]);
  assert.equal(w.state.members[0].status, "removed", "final state: removed");
  assert.equal(
    w.state.invites[0].status,
    "accepted",
    "the token is spent, nothing pending survives",
  );
});

test("7d. (#100, closed by 057) no race: row on X, invitation to Y, removal misses Y, the later acceptance does not reactivate", async () => {
  const w = world({ invites: [inviteToY()], members: [activeRae], users: [raeMovedUser] });
  const removal = await w.remove("m-rae");
  assert.deepEqual(removal, { success: true, data: undefined });
  assert.equal(w.state.members[0].status, "removed");
  assert.equal(w.state.invites[0].status, "pending", "the revoke matched X and missed Y");

  // Later, alone, the person opens the invitation that was sent to Y.
  const acceptance = await w.accept("tok-y");
  assert.equal(acceptance.success, false, "issued before the removal: refused by the predicate");
  assert.equal(
    acceptance.error,
    "Couldn't finish joining the workspace. Please ask for a new invitation.",
  );
  assert.equal(w.state.members[0].status, "removed", "final state: removed");
  assert.equal(w.state.invites[0].status, "accepted", "the stale token is consumed harmlessly");
});

/* ── 057's edges ───────────────────────────────────────────────────────── */

test("8. an invitation created at EXACTLY the removal's instant is refused: strict less-than, the safe direction", async () => {
  const w = world({ invites: [inviteToY()], members: [activeRae], users: [raeMovedUser] });
  await w.remove("m-rae");
  const stamp = w.state.members[0].removed_at;
  assert.ok(stamp, "the fake's trigger stamped the removal");
  // An invitation whose created_at equals removed_at to the microsecond.
  w.state.invites.push(
    inviteToY({ id: "inv-same", token_hash: hash("tok-same"), created_at: stamp }),
  );
  const acceptance = await w.accept("tok-same");
  assert.equal(acceptance.success, false);
  assert.equal(w.state.members[0].status, "removed");
});

test("9. a row never removed (legacy 'invited', removed_at NULL) still reactivates normally", async () => {
  const w = world({
    invites: [invite()],
    members: [{ ...activeRae, status: "invited", removed_at: null }],
    users: [raeUser],
  });
  const acceptance = await w.accept("tok-1");
  assert.deepEqual(acceptance, { success: true });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.members[0].removed_at, null, "never removed: stays NULL");
});

test("10. remove, rejoin, remove again: the stamp is cleared on the rejoin and re-set on the second removal, and an invitation issued between the two removals cannot reactivate after the second", async () => {
  const w = world({ invites: [], members: [activeRae], users: [raeUser] });
  // First removal.
  await w.remove("m-rae");
  const first = w.state.members[0].removed_at;
  assert.ok(first, "first removal stamped");
  // A fresh invitation, issued after the first removal: it reactivates.
  w.state.invites.push(invite({ id: "inv-a", token_hash: hash("tok-a"), created_at: tick() }));
  assert.deepEqual(await w.accept("tok-a"), { success: true });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(
    w.state.members[0].removed_at,
    null,
    "rejoin clears the stamp: no removal in effect",
  );
  // Another invitation issued while they are active (the email-mismatch route).
  w.state.invites.push(inviteToY({ id: "inv-b", token_hash: hash("tok-b"), created_at: tick() }));
  w.state.users = [raeMovedUser];
  // Second removal: the revoke matches X and misses Y; the stamp is re-set, later than inv-b.
  await w.remove("m-rae");
  const second = w.state.members[0].removed_at;
  assert.ok(second && second > first, "second removal stamped later than the first");
  assert.equal(
    w.state.invites.find((i) => i.id === "inv-b").status,
    "pending",
    "missed by the revoke",
  );
  // inv-b was created between the removals: it must not reactivate after the second.
  const stale = await w.accept("tok-b");
  assert.equal(stale.success, false);
  assert.equal(w.state.members[0].status, "removed", "a stale stamp would have let this through");
});

test("control: under 057 even the remove-first order cannot reactivate - the predicate, not the ordering, is the guard", async () => {
  // Drive the fake directly in the order that, before 057, left the member
  // ACTIVE: remove, then burn and reactivate, then revoke. The removal stamps
  // removed_at later than the invitation's created_at, so the reactivation's
  // conditional UPDATE matches nothing.
  const w = world({ invites: [invite()], members: [activeRae], users: [raeUser] });
  const svc = globalThis.__teamService();
  await svc
    .from("company_members")
    .update({ status: "removed" })
    .eq("id", "m-rae")
    .eq("company_id", CO);
  const accepted = await w.accept("tok-1");
  assert.equal(accepted.success, false, "before 057 this was { success: true }");
  await svc
    .from("company_invites")
    .update({ status: "revoked" })
    .eq("company_id", CO)
    .eq("email", "rae@acme.test")
    .eq("status", "pending");
  assert.equal(w.state.members[0].status, "removed", "before 057 this read 'active'");
});

/* ── #49: an invitation dies with its inviter's authority ─────────────────────
 * X is an admin of the company who sends an invitation to a new address. The
 * owner (the action's caller, OWNER_CTX) removes or demotes X. Synthetic data.
 */
const adminX = {
  id: "m-x",
  company_id: CO,
  user_id: "u-x",
  email: "x@acme.test",
  name: "X",
  role: "admin",
  status: "active",
};
const fromX = (overrides = {}) =>
  invite({
    id: "inv-x",
    email: "new@acme.test",
    token_hash: hash("tok-x"),
    invited_by: "u-x",
    ...overrides,
  });
const NO_LONGER_VALID = "This invitation is no longer valid. Ask your team to send a new one.";
const rpcCount = (w) => w.state.rpcCalls ?? 0;

test("49-1. inviter REMOVED before acceptance (legacy invite, never revoked): refused at the door, no account, no call, still pending", async () => {
  const w = world({
    invites: [fromX()],
    members: [{ ...adminX, status: "removed", removed_at: REMOVED_EARLIER }],
  });
  const r = await w.accept("tok-x");
  assert.deepEqual(r, { success: false, error: NO_LONGER_VALID });
  assert.equal(rpcCount(w), 0, "the early check stops it before the function");
  assert.equal(w.state.users.length, 0, "no account created");
  assert.equal(w.state.invites[0].status, "pending");
  assert.equal(w.state.members.length, 1);
});

test("49-2. inviter DEMOTED to recruiter before acceptance: refused the same way", async () => {
  const w = world({ invites: [fromX()], members: [{ ...adminX, role: "recruiter" }] });
  assert.deepEqual(await w.accept("tok-x"), { success: false, error: NO_LONGER_VALID });
  assert.equal(rpcCount(w), 0);
  assert.equal(w.state.users.length, 0);
});

test("49-3. invited_by NULL: refused, no account, nothing written", async () => {
  const w = world({ invites: [fromX({ invited_by: null })] });
  assert.deepEqual(await w.accept("tok-x"), { success: false, error: NO_LONGER_VALID });
  assert.equal(rpcCount(w), 0);
  assert.equal(w.state.users.length, 0);
});

test("49-4. inviter still an active ADMIN (not the owner): joins", async () => {
  const w = world({ invites: [fromX()], members: [adminX] });
  assert.deepEqual(await w.accept("tok-x"), { success: true });
  assert.ok(w.state.members.some((m) => m.email === "new@acme.test" && m.status === "active"));
  assert.equal(w.state.invites[0].status, "accepted");
});

test("49-5. removeMember(X) revokes the invitations X SENT, before the removal; another inviter's survive", async () => {
  const other = invite({ id: "inv-o", email: "o@acme.test", token_hash: hash("tok-o") });
  const w = world({ invites: [fromX(), other], members: [adminX] });
  assert.deepEqual(await w.remove("m-x"), { success: true, data: undefined });
  assert.deepEqual(w.events, ["invites:revoke", "invites:revoke-sent", "member:remove"]);
  assert.equal(w.state.invites.find((i) => i.id === "inv-x").status, "revoked");
  assert.equal(
    w.state.invites.find((i) => i.id === "inv-o").status,
    "pending",
    "the owner's invite is untouched",
  );
  assert.deepEqual(await w.accept("tok-x"), {
    success: false,
    error: "This invitation is no longer active.",
  });
});

test("49-6. updateMemberRole(X, recruiter) revokes X's invitations before the role write; to admin revokes nothing", async () => {
  const w = world({ invites: [fromX()], members: [adminX, { ...activeRae, role: "recruiter" }] });
  const demoted = await capturedCall(() => updateMemberRole("m-x", "recruiter"));
  assert.deepEqual(demoted, { success: true, data: undefined });
  assert.deepEqual(w.events, ["invites:revoke-sent", "member:update"]);
  assert.equal(w.state.invites[0].status, "revoked");
  w.events.length = 0;
  const promoted = await capturedCall(() => updateMemberRole("m-rae", "admin"));
  assert.deepEqual(promoted, { success: true, data: undefined });
  assert.deepEqual(w.events, ["member:update"], "a promotion revokes nothing");
});

test("49-7. the revoke of X's invitations fails: removal and demotion both FAIL CLOSED, X unchanged, the code logged", async () => {
  const fail = {
    code: "57014",
    message: "canceling statement due to statement timeout on company_invites",
  };
  const w = world({ invites: [fromX()], members: [adminX], revokeSentFails: fail });
  assert.deepEqual(await w.remove("m-x"), {
    success: false,
    error: "Couldn't remove this member. Please try again.",
  });
  const demoted = await capturedCall(() => updateMemberRole("m-x", "recruiter"));
  assert.deepEqual(demoted, {
    success: false,
    error: "Couldn't change this member's role. Please try again.",
  });
  assert.equal(w.state.members[0].status, "active");
  assert.equal(w.state.members[0].role, "admin");
  assert.ok(!w.events.includes("member:remove") && !w.events.includes("member:update"));
  assert.ok(
    w.logged.every((l) => !l.includes("company_invites")),
    "the code only",
  );
});

test("49-8. race: X is removed AFTER the early check but BEFORE the atomic grant: the function refuses, the new account is rolled back, nothing granted, still pending", async () => {
  const w = world({
    invites: [fromX()],
    members: [adminX],
    hooks: {
      // Inside the window the early check cannot see: the inviter's row changes.
      beforeBurn: async () => {
        w.state.members.find((m) => m.id === "m-x").status = "removed";
      },
    },
  });
  const r = await w.accept("tok-x");
  assert.deepEqual(r, { success: false, error: NO_LONGER_VALID });
  assert.equal(rpcCount(w), 1, "the function made the decision");
  assert.equal(w.state.users.length, 0, "the account created for the dead invitation is deleted");
  assert.equal(w.state.invites[0].status, "pending", "not burned");
  assert.ok(!w.state.members.some((m) => m.email === "new@acme.test"), "no membership");
});

/** updateMemberRole with console.error captured into the same world log. */
async function capturedCall(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
}
