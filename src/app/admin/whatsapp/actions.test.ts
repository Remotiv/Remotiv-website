/**
 * The admin WhatsApp inbox read (#66): super admins only, unattached rows only.
 *
 *   node --test "src/app/admin/whatsapp/actions.test.ts"
 *
 * Drives the real fetchInboundMessages, with its real guard and the real
 * super-admin allowlist (roles.ts), against a fake service client and a fake
 * signed-in user. Nothing real is reached: the cookie-bound client and the
 * service client are both replaced below, and the service throws if a test
 * forgot to install one.
 *
 * What is proved: an admin and a viewer are refused with the same error
 * before whatsapp_inbound is queried; a super admin (by allowlist or by an
 * active admin_users row) is allowed; the query sent carries
 * application_id IS NULL; no applicant field, and no job_applications read,
 * reaches the result.
 *
 * WA_ACTIONS_UNDER_TEST points the suite at another copy of the action (the
 * negative control runs it against the pre-#66 file).
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { call, fakeService } from "../../../test-support/fake-postgrest.mjs";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

// Registered last, so it sees the bare specifier first. Both clients come
// from globals the tests install; neither can fall through to the real one.
const SERVER_STUB = [
  "export async function createClient() {",
  "  return { auth: { getUser: async () => ({ data: { user: globalThis.__waUserForTests ?? null } }) } };",
  "}",
  "export function createServiceClient() {",
  "  const make = globalThis.__fakeServiceClientForTests;",
  '  if (!make) throw new Error("test: no fake service installed");',
  "  return make();",
  "}",
].join("\n");
const HOOK = `
const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server": ${JSON.stringify(SERVER_STUB)},
};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`);

const OWNER = "owner@remotiv.test";
process.env.SUPER_ADMIN_EMAIL = OWNER;

const target = process.env.WA_ACTIONS_UNDER_TEST
  ? pathToFileURL(process.env.WA_ACTIONS_UNDER_TEST).href
  : "./actions.ts";
const { fetchInboundMessages } = await import(target);

const INBOUND = [
  {
    id: "msg-aaaaaa",
    from_phone: "923000000001",
    bsuid: null,
    profile_name: "Test Sender",
    body: "hello",
    message_type: "text",
    application_id: null,
    received_at: "2026-11-01T10:00:00.000Z",
  },
];

/** A world: the signed-in user, their admin_users row, and the inbox rows. */
function world({ email = "staff@remotiv.test", adminRow = null, adminError = null } = {}) {
  const service = fakeService((table) => {
    switch (table) {
      case "admin_users":
        return { data: adminRow, error: adminError };
      case "whatsapp_inbound":
        return { data: INBOUND, error: null };
      case "job_applications":
        return {
          data: [{ id: "app-1", first_name: "A", last_name: "B", job_title_snapshot: "C" }],
          error: null,
        };
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
  return { service, user: { id: "user-1", email } };
}

const logged = [];

async function run({ service, user }) {
  const saved = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__waUserForTests = user;
  try {
    return await fetchInboundMessages();
  } finally {
    console.error = saved;
    delete globalThis.__fakeServiceClientForTests;
    delete globalThis.__waUserForTests;
  }
}

const tables = (service) => service.queries.map((q) => q.table);
const inboxQuery = (service) => service.queries.find((q) => q.table === "whatsapp_inbound");

test("a: viewer is refused, and whatsapp_inbound is never queried", async () => {
  const w = world({ adminRow: { role: "viewer", status: "active" } });
  await assert.rejects(run(w), { message: "Forbidden" });
  assert.ok(!tables(w.service).includes("whatsapp_inbound"), tables(w.service).join(","));
});

test("b: an active admin is refused the same way, and whatsapp_inbound is never queried", async () => {
  const w = world({ adminRow: { role: "admin", status: "active" } });
  await assert.rejects(run(w), { message: "Forbidden" });
  assert.ok(!tables(w.service).includes("whatsapp_inbound"), tables(w.service).join(","));
});

test("refused too: signed out, no admin_users row, and a paused super_admin row", async () => {
  for (const w of [
    { ...world(), user: null },
    world({ adminRow: null }),
    world({ adminRow: { role: "super_admin", status: "paused" } }),
  ]) {
    await assert.rejects(run(w), { message: "Forbidden" });
    assert.ok(!tables(w.service).includes("whatsapp_inbound"));
  }
});

test("c: a super admin is allowed, by allowlist email or by an active admin_users row", async () => {
  for (const w of [
    world({ email: OWNER }),
    world({ email: "Owner@Remotiv.test" }),
    world({ adminRow: { role: "super_admin", status: "active" } }),
  ]) {
    const res = await run(w);
    assert.equal(res.ok, true);
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0].id, "msg-aaaaaa");
  }
});

test("d: the query sent carries application_id IS NULL", async () => {
  const w = world({ email: OWNER });
  await run(w);
  const q = inboxQuery(w.service);
  assert.ok(q, "whatsapp_inbound was not queried");
  assert.deepEqual(call(q.calls, "is"), ["is", "application_id", null]);
  // And no select asks for the column the filter removes from view.
  assert.ok(!String(call(q.calls, "select")?.[1]).includes("application_id"));
});

test("e: no applicant name or job title can reach the result", async () => {
  const w = world({ email: OWNER });
  const res = await run(w);
  assert.ok(!tables(w.service).includes("job_applications"), tables(w.service).join(","));
  for (const row of res.value) {
    for (const key of ["applicant", "applicationId", "name", "jobTitle"]) {
      assert.ok(!(key in row), `row carries ${key}`);
    }
  }
  assert.ok(!JSON.stringify(res.value).includes("job_title"));
});

/* ── follow-up: the allowlist does not outrank a paused row or a failed lookup ── */

const RAW = 'relation "admin_users" violates constraint admin_users_role_check';

test("allowlisted email with a paused row is refused, and whatsapp_inbound is never queried", async () => {
  const w = world({ email: OWNER, adminRow: { role: "super_admin", status: "paused" } });
  await assert.rejects(run(w), { message: "Forbidden" });
  assert.ok(!tables(w.service).includes("whatsapp_inbound"), tables(w.service).join(","));
});

test("allowlisted email with an archived row is refused, and whatsapp_inbound is never queried", async () => {
  const w = world({ email: OWNER, adminRow: { role: "admin", status: "archived" } });
  await assert.rejects(run(w), { message: "Forbidden" });
  assert.ok(!tables(w.service).includes("whatsapp_inbound"), tables(w.service).join(","));
});

test("allowlisted email with no row is still allowed (unchanged)", async () => {
  const w = world({ email: OWNER, adminRow: null });
  const res = await run(w);
  assert.equal(res.ok, true);
  assert.ok(tables(w.service).includes("whatsapp_inbound"));
});

test("a failed admin_users lookup refuses, allowlisted or not, and is never read as no row", async () => {
  logged.length = 0;
  const failure = { code: "57014", message: RAW };
  for (const w of [
    world({ email: OWNER, adminRow: null, adminError: failure }),
    // Adversarial: rows alongside an error must not be trusted either.
    world({ adminRow: { role: "super_admin", status: "active" }, adminError: failure }),
  ]) {
    await assert.rejects(run(w), { message: "Forbidden" });
    assert.ok(!tables(w.service).includes("whatsapp_inbound"), tables(w.service).join(","));
  }
  // Logged by code only: no library message, constraint or table name.
  const out = logged.join("\n");
  assert.ok(out.includes("57014"), out);
  assert.ok(!out.includes("violates") && !out.includes("admin_users_role_check"), out);
});
