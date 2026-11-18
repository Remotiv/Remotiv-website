/**
 * #54: opening /login or an admin page as a company user never signs them
 * out, on any device. They are redirected to their dashboard, session intact.
 *
 *   node --test src/app/admin/admin-signout.test.ts
 *
 * AdminLayout and the /login page run as shipped. Supabase is a fake that
 * records every signOut call and its scope; redirect() throws the way
 * Next's does, carrying the target. The service client is fake-postgrest.mjs
 * answering admin_users and company_members from a seed. Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": [
    "export async function createClient() { return globalThis.__adminAuth; }",
    "export function createServiceClient() { return globalThis.__adminService; }",
  ].join("\\n"),
  "next/headers": "export async function headers() { return new Map([['x-pathname', '/admin']]); }",
  "next/navigation": "export function redirect(to) { const e = new Error('NEXT_REDIRECT'); e.to = to; throw e; }",
  "@/app/admin/_components/admin-flags": "export function AdminFlagsProvider({ children }) { return children; }",
  "@/app/admin/lib/feature-flags": "export function adminLiveReviewEnabled() { return false; }",
  "@/app/admin/lib/roles": "export function isSuperAdminEmail() { return false; }",
  "./login-client": "export function LoginClient() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { default: AdminLayout } = await import("./layout.tsx");
const { default: AdminLoginPage } = await import("../login/page.tsx");

const USER = { id: "u0000000-0000-4000-8000-000000000001", email: "member@example.invalid" };

/** `admin`: the admin_users row, or null. `member`: an active company membership. */
function world({ admin = null, member = false }) {
  const signOuts = [];
  globalThis.__adminAuth = {
    auth: {
      getUser: async () => ({ data: { user: USER } }),
      signOut: async (opts) => {
        signOuts.push(opts ?? "DEFAULT (global)");
        return { error: null };
      },
    },
  };
  globalThis.__adminService = fakeService((table, calls) => {
    const eq = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    if (table === "admin_users") return { data: admin, error: null };
    if (table === "company_members") {
      const hit = member && eq("user_id") === USER.id && eq("status") === "active";
      return { data: hit ? { id: "cm-1" } : null, error: null };
    }
    return { data: null, error: null };
  });
  return signOuts;
}

async function redirectOf(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.message === "NEXT_REDIRECT") return err.to;
    throw err;
  }
  return null;
}

const openAdmin = () => redirectOf(() => AdminLayout({ children: null }));
const openLogin = () => redirectOf(() => AdminLoginPage({ searchParams: Promise.resolve({}) }));

// Negative control: put back the bare `await supabase.auth.signOut()` with no membership check.
test("a company user opening /login: sent on to /admin, then to their dashboard, never signed out", async () => {
  const signOuts = world({ member: true });
  assert.equal(await openLogin(), "/admin");
  assert.equal(await openAdmin(), "/ai-dashboard");
  assert.deepEqual(signOuts, [], "session intact");
});

test("a company user opening an admin page directly: redirected to their dashboard, never signed out", async () => {
  const signOuts = world({ member: true });
  assert.equal(await openAdmin(), "/ai-dashboard");
  assert.deepEqual(signOuts, []);
});

// Negative control: drop `{ scope: "local" }` from either signOut and it is global again.
test("someone with no admin row and no company: signed out on this browser only", async () => {
  const signOuts = world({});
  assert.equal(await openAdmin(), "/login?reason=removed");
  assert.deepEqual(signOuts, [{ scope: "local" }]);
});

test("a paused admin: this browser only, with the reason on /login", async () => {
  const signOuts = world({ admin: { role: "admin", status: "paused" } });
  assert.equal(await openAdmin(), "/login?reason=paused");
  assert.deepEqual(signOuts, [{ scope: "local" }]);
});

test("an active admin passes, untouched", async () => {
  const signOuts = world({ admin: { role: "admin", status: "active" } });
  assert.equal(await openAdmin(), null);
  assert.deepEqual(signOuts, []);
});

test("no signOut anywhere under /admin or /login is left at the default (global) scope", async () => {
  const { readFileSync } = await import("node:fs");
  for (const rel of ["./layout.tsx", "../login/page.tsx", "../login/login-client.tsx"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\.signOut\(\s*\)/, `${rel} has a bare signOut()`);
  }
});
