/**
 * #58: the company dashboard sign-in and the settings password re-check are
 * limited per account (ONE budget shared with the invitation page, #48) and
 * per IP, on the #48 store, before the password reaches Supabase.
 *
 *   node --test src/app/ai-dashboard/login/sign-in-limit.test.ts
 *
 * The two actions and the limiter are the real code, on a fresh memory store
 * per test. Supabase auth, the request headers and the company lookups are
 * fakes. Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/headers": "export async function headers() { return globalThis.__slHeaders; }",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": [
    "export async function createClient() { return globalThis.__slAuth; }",
    "export function createServiceClient() { return globalThis.__slService; }",
    "export function createStatelessClient() { return globalThis.__slAuth; }",
  ].join("\\n"),
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function resolveCompanyAccess() { return { ok: true }; }",
    "export async function getCompanyContext() { return globalThis.__slCtx; }",
    "export async function requireCompanyRole() { return globalThis.__slCtx; }",
  ].join("\\n"),
  "@/lib/company-identity": [
    "export function describeAuthEmailFailure() { return 'x'; }",
    "export async function findAuthUserIdByEmail() { return null; }",
    "export async function syncJobsCompanyName() {}",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const limit = await import("../../../lib/invite-password-limit.ts");
const { signInToCompany } = await import("./actions.ts");
const { updateOwnAccount } = await import("../(gated)/settings/actions.ts");
const { trustedClientIp } = await import("../../../lib/client-ip.ts");

const EMAIL = "rae@acme.test";
const PASSWORD = "correct horse battery";
const LOCKED = "Too many sign in attempts. Please try again in 15 minutes.";

/** One world: a Supabase that knows one password, and the request's headers. */
function world({ ip = "203.0.113.7", headers: extra = {}, vercel = "1", store } = {}) {
  limit.setInvitePasswordStoresForTests(store ?? limit.memoryAttemptStore());
  const checks = [];
  const map = new Map(Object.entries({ ...(ip ? { "x-real-ip": ip } : {}), ...extra }));
  globalThis.__slHeaders = { get: (k) => map.get(k.toLowerCase()) ?? null };
  process.env.VERCEL = vercel;
  globalThis.__slAuth = {
    auth: {
      async signInWithPassword({ email, password }) {
        checks.push(email);
        return password === PASSWORD
          ? { data: { user: { id: "u-rae" } }, error: null }
          : { data: { user: null }, error: { message: "Invalid login credentials", status: 400 } };
      },
      async signOut() {},
    },
  };
  globalThis.__slService = {
    from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
    auth: { admin: { updateUserById: async () => ({ error: null }) } },
  };
  globalThis.__slCtx = {
    companyId: "co-1",
    role: "recruiter",
    user: { id: "u-rae", email: EMAIL },
  };
  return { checks };
}

const form = (email, password) => {
  const f = new FormData();
  f.set("email", email);
  f.set("password", password);
  return f;
};
const signIn = (email, password) => signInToCompany(form(email, password));
const reauth = (current) =>
  updateOwnAccount({
    email: EMAIL,
    currentPassword: current,
    newPassword: "a brand new password",
    confirmPassword: "a brand new password",
  });

const quietly = async (fn) => {
  const real = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = real;
  }
};

test("58-1. sign-in: 10 wrong passwords per account, then locked across ANY IP; the 11th is never checked", async () => {
  const store = limit.memoryAttemptStore();
  const first = world({ store });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(await signIn(EMAIL, `wrong ${i}`), { ok: false, reason: "credentials" });
  }
  assert.deepEqual(await signIn(EMAIL, PASSWORD), { ok: false, reason: "locked" });
  assert.equal(first.checks.length, 10);
  const elsewhere = world({ ip: "198.51.100.9", store });
  assert.deepEqual(await signIn(EMAIL, PASSWORD), { ok: false, reason: "locked" });
  assert.equal(elsewhere.checks.length, 0, "another IP gets no fresh guesses at this account");
});

test("58-2. sign-in: 50 per IP across accounts, then refused before Supabase; another IP is unaffected", async () => {
  const store = limit.memoryAttemptStore();
  const w = world({ store });
  for (let i = 0; i < 50; i++) await signIn(`person${i}@acme.test`, "wrong password");
  assert.deepEqual(await signIn("fresh@acme.test", PASSWORD), { ok: false, reason: "locked" });
  assert.equal(w.checks.length, 50);
  const other = world({ ip: "198.51.100.9", store });
  assert.deepEqual(await signIn("fresh@acme.test", PASSWORD), { ok: true });
  assert.equal(other.checks.length, 1);
});

test("58-3. a right password clears the ACCOUNT's count, never the IP's", async () => {
  const store = limit.memoryAttemptStore();
  world({ store });
  for (let i = 0; i < 9; i++) await signIn(EMAIL, `wrong ${i}`);
  assert.deepEqual(await signIn(EMAIL, PASSWORD), { ok: true });
  for (let i = 0; i < 10; i++) {
    assert.equal((await signIn(EMAIL, `wrong again ${i}`)).reason, "credentials");
  }
  assert.equal((await signIn(EMAIL, PASSWORD)).reason, "locked");
  for (let i = 0; i < 29; i++) await signIn(`x${i}@acme.test`, "wrong password");
  assert.equal((await signIn("y@acme.test", PASSWORD)).reason, "locked", "the IP kept all 50");
});

test("58-4. ONE budget per account: invitation page, sign-in and settings share it", async () => {
  const store = limit.memoryAttemptStore();
  const w = world({ store });
  for (let i = 0; i < 4; i++) await limit.reserveInvitePasswordAttempt(EMAIL);
  for (let i = 0; i < 3; i++) await signIn(EMAIL, `wrong ${i}`);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await reauth(`wrong ${i}`), {
      success: false,
      error: "That current password isn't right.",
    });
  }
  assert.deepEqual(await signIn(EMAIL, PASSWORD), { ok: false, reason: "locked" });
  assert.deepEqual(await reauth(PASSWORD), {
    success: false,
    error: "Too many incorrect passwords. Please try again in 15 minutes.",
  });
  assert.equal((await limit.reserveInvitePasswordAttempt(EMAIL)).ok, false);
  assert.equal(w.checks.length, 6, "only the 6 inside the budget reached Supabase");
});

test("58-5. no trusted IP on Vercel: FAILS CLOSED with the couldn't check message, a safe reason code, no check", async () => {
  const w = world({ ip: null, headers: { "x-forwarded-for": "203.0.113.50" } });
  const { value, logged } = await quietly(() => signIn(EMAIL, PASSWORD));
  assert.deepEqual(value, { ok: false, reason: "check_unavailable" });
  const { value: settings } = await quietly(() => reauth(PASSWORD));
  assert.deepEqual(settings, {
    success: false,
    error: "We couldn't check your password just now. Please try again in a moment.",
  });
  assert.equal(w.checks.length, 0);
  assert.deepEqual(logged, ["[invite-password-limit] sign-in refused reason=NO_TRUSTED_IP"]);
});

test("58-6. the store unavailable: FAILS CLOSED before Supabase, logged by reason code with no address", async () => {
  const w = world({
    store: {
      async increment() {
        throw new Error("connect ECONNREFUSED 10.0.0.1");
      },
      async clear() {},
    },
  });
  const { value, logged } = await quietly(() => signIn(EMAIL, PASSWORD));
  assert.deepEqual(value, { ok: false, reason: "check_unavailable" });
  assert.equal(w.checks.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[invite-password-limit\] sign-in ip refused reason=[A-Z_]+$/);
  assert.ok(!logged[0].includes("rae") && !logged[0].includes("203.0.113"));
});

test("58-7. a spoofed x-forwarded-for never changes the bucket: the platform's address is the one counted", async () => {
  const store = limit.memoryAttemptStore();
  for (let i = 0; i < 50; i++) {
    world({ store, headers: { "x-forwarded-for": `10.9.${i}.1` } });
    await signIn(`p${i}@acme.test`, "wrong password");
  }
  const w = world({ store, headers: { "x-forwarded-for": "10.200.0.1" } });
  assert.deepEqual(await signIn("q@acme.test", PASSWORD), { ok: false, reason: "locked" });
  assert.equal(w.checks.length, 0);
});

test("58-8. trustedClientIp: Vercel headers first; off Vercel the forwarded or local address; on Vercel without them, null", () => {
  const h = (o) => ({ get: (k) => o[k] ?? null });
  assert.equal(
    trustedClientIp(h({ "x-vercel-forwarded-for": "1.1.1.1, 2.2.2.2" }), { VERCEL: "1" }),
    "1.1.1.1",
  );
  assert.equal(trustedClientIp(h({ "x-real-ip": "3.3.3.3" }), { VERCEL: "1" }), "3.3.3.3");
  assert.equal(trustedClientIp(h({ "x-forwarded-for": "4.4.4.4" }), { VERCEL: "1" }), null);
  assert.equal(trustedClientIp(h({}), { VERCEL: "1" }), null);
  assert.equal(trustedClientIp(h({ "x-forwarded-for": "5.5.5.5, 6.6.6.6" }), {}), "5.5.5.5");
  assert.equal(trustedClientIp(h({}), {}), "local");
});

test("58-9. settings re-check: 10 per account then locked before Supabase; a right password clears it", async () => {
  const w = world();
  for (let i = 0; i < 9; i++) await reauth(`wrong ${i}`);
  assert.deepEqual(await reauth(PASSWORD), { success: true, data: undefined });
  for (let i = 0; i < 10; i++) await reauth(`wrong again ${i}`);
  assert.deepEqual(await reauth(PASSWORD), {
    success: false,
    error: "Too many incorrect passwords. Please try again in 15 minutes.",
  });
  assert.equal(w.checks.length, 20);
});

test("58-10. the new copy has no dashes", async () => {
  const fs = await import("node:fs");
  const files = [
    new URL("./login-client.tsx", import.meta.url),
    new URL("../(gated)/settings/actions.ts", import.meta.url),
  ].map((u) => fs.readFileSync(u, "utf8"));
  for (const copy of [
    LOCKED,
    "We couldn't check your sign in just now. Please try again in a moment.",
    "Too many incorrect passwords. Please try again in 15 minutes.",
    "We couldn't check your password just now. Please try again in a moment.",
  ]) {
    assert.ok(
      files.some((f) => f.includes(copy)),
      copy,
    );
    assert.ok(!/[–—]/.test(copy));
  }
});

test("no test in this file tried the network", () => {
  delete process.env.VERCEL;
  guard.assertNoNetwork();
});
