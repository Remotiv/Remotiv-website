/**
 * F4: the /admin/interviews pages and actions are super admin only, through
 * the REAL requireSuperAdmin (admin/lib/role-guards.ts). Supabase auth and the
 * admin_users row are faked; a plain admin, a viewer, an inactive super admin
 * and a signed-out caller all get a 404, and nothing past the gate runs.
 *
 *   node --test "src/app/admin/interviews/admin-interviews-gate.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": [
    "export async function createClient() { return { auth: { getUser: async () => ({ data: { user: globalThis.__gate.user } }) } }; }",
    "export function createServiceClient() {",
    "  const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: globalThis.__gate.row, error: null }) };",
    "  return { from() { return q; } };",
    "}",
  ].join("\\n"),
  "@/lib/interviews/live-review": [
    "export async function listPlatformLiveSessions() { globalThis.__gate.reached.push('list'); return []; }",
    "export async function loadPlatformLiveReview() { globalThis.__gate.reached.push('review'); return { ok: false, reason: 'not_found', message: 'x' }; }",
    "export async function signPlatformTurnAudio() { globalThis.__gate.reached.push('audio'); return { ok: true, url: 'u' }; }",
    "export async function signPlatformVideoPiece() { globalThis.__gate.reached.push('video'); return { ok: true, url: 'u' }; }",
  ].join("\\n"),
  "@/app/admin/_components/top-nav": "export function TopNav() { return null; }",
  "@/app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client": "export function LiveReviewClient() { return null; }",
  "@/app/ai-dashboard/ai-dashboard.css": "",
  "next/navigation": "export function notFound() { throw Object.assign(new Error('NEXT_NOT_FOUND'), { notFound: true }); }",
  "next/link": "export default function Link() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { default: ListPage } = await import("./page.tsx");
const { default: ReviewPage } = await import("./[sessionId]/page.tsx");
const actions = await import("./actions.ts");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000e8";
const user = { id: "a0000000-0000-4000-8000-0000000000aa", email: "someone@remotiv.test" };
const as = (row, signedIn = true) => {
  globalThis.__gate = { user: signedIn ? user : null, row, reached: [] };
};
const isNotFound = (e) => e?.notFound === true;
const calls = () => [
  () => ListPage(),
  () => ReviewPage({ params: Promise.resolve({ sessionId: SESSION }) }),
];

test("plain admins, viewers, an inactive super admin and the signed-out get a 404; nothing past the gate runs", async () => {
  for (const [label, row, signedIn] of [
    ["admin", { role: "admin", status: "active" }, true],
    ["viewer", { role: "viewer", status: "active" }, true],
    ["inactive super admin", { role: "super_admin", status: "disabled" }, true],
    ["no admin row", null, true],
    ["signed out", null, false],
  ]) {
    as(row, signedIn);
    for (const call of calls()) await assert.rejects(call(), isNotFound, label);
    assert.deepEqual(
      await actions.getAdminLiveTurnAudioUrl(SESSION, "t"),
      { ok: false, error: "That interview couldn't be found." },
      label,
    );
    assert.deepEqual(await actions.getAdminLiveVideoPieceUrl(SESSION, 0), {
      ok: false,
      error: "That interview couldn't be found.",
    });
    assert.deepEqual(globalThis.__gate.reached, [], `${label}: nothing past the gate`);
  }
});

test("a super admin passes the gate: the list, the review and both media actions run", async () => {
  as({ role: "super_admin", status: "active", must_change_password: false });
  await ListPage();
  await assert.rejects(
    ReviewPage({ params: Promise.resolve({ sessionId: SESSION }) }),
    isNotFound,
    "an unknown session is a 404",
  );
  assert.equal((await actions.getAdminLiveTurnAudioUrl(SESSION, "t")).ok, true);
  assert.equal((await actions.getAdminLiveVideoPieceUrl(SESSION, 0)).ok, true);
  assert.deepEqual(globalThis.__gate.reached, ["list", "review", "audio", "video"]);
});
