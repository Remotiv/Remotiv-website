/**
 * F4: the /admin/interviews pages and actions, through the REAL
 * requireSuperAdmin (admin/lib/role-guards.ts) and the REAL switch
 * (admin/lib/feature-flags.ts). Supabase auth and the admin_users row are
 * faked and every call to them is counted.
 *
 *   ADMIN_LIVE_REVIEW_ENABLED not exactly "1"  nav item hidden, both pages 404,
 *                                              both media actions refused, and
 *                                              no auth or database call at all
 *   "1"                                        super admin only: a plain admin,
 *                                              a viewer, an inactive super admin
 *                                              and the signed-out get a 404
 *
 *   node --test "src/app/admin/interviews/admin-interviews-gate.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": [
    "export async function createClient() { globalThis.__gate.db += 1; return { auth: { getUser: async () => ({ data: { user: globalThis.__gate.user } }) } }; }",
    "export function createServiceClient() {",
    "  globalThis.__gate.db += 1;",
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
  "next/navigation": "export function notFound() { throw Object.assign(new Error('NEXT_NOT_FOUND'), { notFound: true }); } export function usePathname() { return '/admin'; }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
  "next/image": "export default function Image() { return null; }",
  "./notifications-bell": "export function NotificationsBell() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const { default: ListPage } = await import("./page.tsx");
const { default: ReviewPage } = await import("./[sessionId]/page.tsx");
const actions = await import("./actions.ts");
const { adminLiveReviewEnabled } = await import("../lib/feature-flags.ts");
const { TopNav } = await import("../_components/top-nav.tsx");
const { AdminFlagsProvider } = await import("../_components/admin-flags.tsx");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000e8";
const user = { id: "a0000000-0000-4000-8000-0000000000aa", email: "someone@remotiv.test" };
const SUPER = { role: "super_admin", status: "active", must_change_password: false };
const as = (row, signedIn = true) => {
  globalThis.__gate = { user: signedIn ? user : null, row, reached: [], db: 0 };
};
const isNotFound = (e) => e?.notFound === true;
const REFUSED = { ok: false, error: "That interview couldn't be found." };
const calls = () => [
  () => ListPage(),
  () => ReviewPage({ params: Promise.resolve({ sessionId: SESSION }) }),
];

/** Sets ADMIN_LIVE_REVIEW_ENABLED for one run (undefined: unset), then puts it back. */
async function withFlag(value, fn) {
  const before = process.env.ADMIN_LIVE_REVIEW_ENABLED;
  if (value === undefined) delete process.env.ADMIN_LIVE_REVIEW_ENABLED;
  else process.env.ADMIN_LIVE_REVIEW_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ADMIN_LIVE_REVIEW_ENABLED;
    else process.env.ADMIN_LIVE_REVIEW_ENABLED = before;
  }
}
const OFF_VALUES = [undefined, "", "0", "true", "TRUE", "yes", "on", " 1", "1 ", "01"];

/** The nav as the admin layout renders it: the switch handed down as a boolean. */
const nav = (role) =>
  renderToStaticMarkup(
    createElement(
      AdminFlagsProvider,
      { flags: { liveReview: adminLiveReviewEnabled() } },
      createElement(TopNav, { email: "someone@remotiv.test", userRole: role }),
    ),
  );
const hasInterviews = (html) => html.includes('href="/admin/interviews"');

/* ── off by default ───────────────────────────────────────────── */

test('the switch is on only for exactly "1"', async () => {
  for (const value of OFF_VALUES) {
    await withFlag(value, () =>
      assert.equal(adminLiveReviewEnabled(), false, JSON.stringify(value)),
    );
  }
  await withFlag("1", () => assert.equal(adminLiveReviewEnabled(), true));
});

test('off (missing, empty, "0", "true" ...): both pages 404 and both media actions refuse, before any auth or database call', async () => {
  for (const value of OFF_VALUES) {
    await withFlag(value, async () => {
      as(SUPER);
      for (const call of calls()) await assert.rejects(call(), isNotFound, JSON.stringify(value));
      assert.deepEqual(await actions.getAdminLiveTurnAudioUrl(SESSION, "t"), REFUSED);
      assert.deepEqual(await actions.getAdminLiveVideoPieceUrl(SESSION, 0), REFUSED);
      assert.equal(globalThis.__gate.db, 0, `${JSON.stringify(value)}: no auth or database call`);
      assert.deepEqual(globalThis.__gate.reached, [], "no review read, no log row, no link");
    });
  }
});

test("off: the Interviews item is hidden from the nav, even for a super admin", async () => {
  for (const value of OFF_VALUES) {
    await withFlag(value, () =>
      assert.equal(hasInterviews(nav("super_admin")), false, JSON.stringify(value)),
    );
  }
  // Nothing provided at all reads as off too.
  const bare = renderToStaticMarkup(
    createElement(TopNav, { email: "x@remotiv.test", userRole: "super_admin" }),
  );
  assert.equal(hasInterviews(bare), false);
  assert.match(
    bare,
    /href="\/admin\/companies"/,
    "control: the other super admin items still show",
  );
});

test("on: the Interviews item shows for a super admin only", async () => {
  await withFlag("1", () => {
    assert.equal(hasInterviews(nav("super_admin")), true);
    assert.equal(hasInterviews(nav("admin")), false);
    assert.equal(hasInterviews(nav("viewer")), false);
  });
});

test("the admin layout hands the server's switch to the nav; it is not set anywhere in the repo", () => {
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  assert.match(
    src("../layout.tsx"),
    /<AdminFlagsProvider flags=\{\{ liveReview: adminLiveReviewEnabled\(\) \}\}>/,
  );
  assert.match(src("../lib/feature-flags.ts"), /^import "server-only";/);
  for (const rel of ["../../../../.env.example"]) {
    assert.doesNotMatch(src(rel), /ADMIN_LIVE_REVIEW_ENABLED/, rel);
  }
});

/* ── on: exactly F4 ───────────────────────────────────────────── */

test("on: plain admins, viewers, an inactive super admin and the signed-out get a 404; nothing past the gate runs", async () => {
  await withFlag("1", async () => {
    for (const [label, row, signedIn] of [
      ["admin", { role: "admin", status: "active" }, true],
      ["viewer", { role: "viewer", status: "active" }, true],
      ["inactive super admin", { role: "super_admin", status: "disabled" }, true],
      ["no admin row", null, true],
      ["signed out", null, false],
    ]) {
      as(row, signedIn);
      for (const call of calls()) await assert.rejects(call(), isNotFound, label);
      assert.deepEqual(await actions.getAdminLiveTurnAudioUrl(SESSION, "t"), REFUSED, label);
      assert.deepEqual(await actions.getAdminLiveVideoPieceUrl(SESSION, 0), REFUSED);
      assert.deepEqual(globalThis.__gate.reached, [], `${label}: nothing past the gate`);
    }
  });
});

test("on: a super admin passes the gate: the list, the review and both media actions run", async () => {
  await withFlag("1", async () => {
    as(SUPER);
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
});
