/**
 * #67: the admin drawer's "Message on WhatsApp" link exists only for a
 * candidate who ticked the WhatsApp box and has not replied STOP, is built on
 * the server, and is hidden when either check cannot be made.
 *
 *   node --test src/lib/whatsapp/chat-link.test.ts
 *
 * The real chat-link.ts and the real admin action, against fake-postgrest.mjs.
 * The admin guard and the admin scope are stubbed. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__chatService; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { if (!globalThis.__chatAdmin) throw new Error('not an admin'); return { user: { id: 'u1' } }; } export async function requireSuperAdmin() { throw new Error('no'); }",
  "@/lib/admin-scope": "export async function adminApplicationScope() { return 'company_id_snapshot.is.null'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { whatsAppChatLink } = await import("./chat-link.ts");
const { CHAT_LINK_UNAVAILABLE } = await import("./consent.ts");
const { getApplicationWhatsAppLink } = await import("../../app/admin/applications/actions.ts");

const DIGITS = "923001234567";
const TICKED = { whatsapp_opt_in: true, whatsapp_opt_in_at: "2026-11-25T09:00:00.000Z" };
const APP = {
  phone: "0300 1234567",
  first_name: "Syn",
  last_name: "Thetic",
  job_title_snapshot: "Engineer",
  jobs: { title: "Engineer" },
};

/** `optedOut` puts a STOP under the phone; `failing` errors one table's read. */
function world({ app = { ...APP, ...TICKED }, optedOut = false, failing = null } = {}) {
  const svc = fakeService((table) => {
    if (table === failing) return { data: null, error: { code: "57014", message: "timeout" } };
    if (table === "job_applications") return { data: app, error: null };
    if (table === "whatsapp_opt_outs") {
      return { data: optedOut ? [{ id: "o1" }] : [], error: null };
    }
    if (table === "whatsapp_inbound") return { data: [], error: null };
    throw new Error(`unexpected table ${table}`);
  });
  globalThis.__chatService = svc;
  return svc;
}

const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

const link = (svc, over) =>
  quiet(() => whatsAppChatLink(svc, { ...APP, ...TICKED, job_title: "Engineer", ...over }));

test("opted in, no STOP: the wa.me link, to the normalised number", async () => {
  const r = await link(world());
  assert.equal(r.ok, true);
  assert.ok(r.href.startsWith(`https://wa.me/${DIGITS}?text=`));
  assert.match(decodeURIComponent(r.href), /Hi Syn Thetic, this is Remotiv\..*Engineer position/);
});

test("no tick, an existing application, or a tick without its time: no link, and STOP is not even read", async () => {
  for (const over of [
    { whatsapp_opt_in: false, whatsapp_opt_in_at: null },
    { whatsapp_opt_in: null, whatsapp_opt_in_at: null },
    { whatsapp_opt_in: undefined, whatsapp_opt_in_at: undefined },
    { whatsapp_opt_in: true, whatsapp_opt_in_at: null },
  ]) {
    const svc = world();
    assert.deepEqual(await link(svc, over), { ok: false, reason: "no_opt_in" });
    assert.equal(svc.queries.length, 0);
  }
});

test("opted in but replied STOP: no link", async () => {
  assert.deepEqual(await link(world({ optedOut: true })), { ok: false, reason: "stopped" });
});

test("a STOP lookup that errors hides the link", async () => {
  for (const failing of ["whatsapp_opt_outs", "whatsapp_inbound"]) {
    assert.deepEqual(await link(world({ failing })), { ok: false, reason: "check_failed" });
  }
});

test("a number that cannot be addressed: no link", async () => {
  assert.deepEqual(await link(world(), { phone: "12345" }), { ok: false, reason: "no_number" });
});

// ── The admin action the drawer calls ───────────────────────

async function asAdmin(fn) {
  globalThis.__chatAdmin = true;
  try {
    return await quiet(fn);
  } finally {
    delete globalThis.__chatAdmin;
  }
}

test("the action answers the link for an opted-in candidate, and the label otherwise", async () => {
  world();
  const ok = await asAdmin(() => getApplicationWhatsAppLink("app-1"));
  assert.equal(ok.ok, true);
  assert.ok(ok.href.startsWith(`https://wa.me/${DIGITS}?text=`));

  world({ app: { ...APP, whatsapp_opt_in: false, whatsapp_opt_in_at: null } });
  assert.deepEqual(await asAdmin(() => getApplicationWhatsAppLink("app-1")), {
    ok: false,
    label: "WhatsApp unavailable: no opt-in",
  });

  world({ optedOut: true });
  assert.deepEqual(await asAdmin(() => getApplicationWhatsAppLink("app-1")), {
    ok: false,
    label: "WhatsApp unavailable: replied STOP",
  });
});

test("the action reads consent from the row, inside the admin scope", async () => {
  const svc = world();
  await asAdmin(() => getApplicationWhatsAppLink("app-1"));
  const read = svc.queries.find((q) => q.table === "job_applications");
  const select = read.calls.find((c) => c[0] === "select")[1];
  assert.match(select, /\bwhatsapp_opt_in\b/);
  assert.match(select, /\bwhatsapp_opt_in_at\b/);
  assert.ok(read.calls.some((c) => c[0] === "eq" && c[1] === "id" && c[2] === "app-1"));
  assert.ok(
    read.calls.some((c) => c[0] === "or"),
    "the admin scope is applied",
  );
});

test("fails closed: no admin, a failed read, or no row is no link and reads nothing more", async () => {
  const svc = world();
  const notAdmin = await quiet(() => getApplicationWhatsAppLink("app-1"));
  assert.deepEqual(notAdmin, { ok: false, label: CHAT_LINK_UNAVAILABLE.check_failed });
  assert.equal(svc.queries.length, 0, "nothing read for a non-admin");

  world({ failing: "job_applications" });
  assert.deepEqual(await asAdmin(() => getApplicationWhatsAppLink("app-1")), {
    ok: false,
    label: CHAT_LINK_UNAVAILABLE.check_failed,
  });

  world({ app: null });
  assert.deepEqual(await asAdmin(() => getApplicationWhatsAppLink("app-1")), {
    ok: false,
    label: CHAT_LINK_UNAVAILABLE.check_failed,
  });
});

test("the labels are the decided wording, with no dash", () => {
  assert.equal(CHAT_LINK_UNAVAILABLE.no_opt_in, "WhatsApp unavailable: no opt-in");
  assert.equal(CHAT_LINK_UNAVAILABLE.stopped, "WhatsApp unavailable: replied STOP");
  for (const label of Object.values(CHAT_LINK_UNAVAILABLE)) {
    assert.doesNotMatch(label, /[‒-―]/);
  }
});
