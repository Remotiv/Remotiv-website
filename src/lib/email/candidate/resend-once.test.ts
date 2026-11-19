/**
 * #59: a cancellation's candidate email reaches the candidate at most once,
 * whatever retries or races happen. deliverEmail and resendFailedEmail run as
 * shipped, with the real Resend SDK, over a fake `fetch` that keeps Resend's
 * idempotency rules (one key, one message: the same request again is answered
 * from the first, a different one is refused) and a fake database that
 * applies migration 067's claim. Nothing leaves the machine.
 *
 *   node --test src/lib/email/candidate/resend-once.test.ts
 *
 * The claim's row lock on a real Postgres: scripts/staging/checks-059-retry-claim.mjs.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "export {};",
  "@/lib/notifications/send-failure": [
    "export async function alertSendFailure() {}",
    "export function updatedOne(d) { return Array.isArray(d) && d.length === 1; }",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

process.env.RESEND_API_KEY = "re_test_key";
const { deliverEmail, resendFailedEmail, candidateEmailKey } = await import("./deliver.ts");
const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-000000000001";

/** Resend, as far as idempotency goes: what reached a candidate, by key. */
function fakeResend({ failFirst = 0, hang = false, dropAfterDelivery = false } = {}) {
  const byKey = new Map(); // key -> { body, id }
  const delivered = [];
  const requests = [];
  let failures = failFirst;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.resend.com/emails")) throw new Error(`unexpected fetch ${u}`);
    const key = new Headers(init.headers).get("Idempotency-Key");
    const body = String(init.body);
    requests.push({ key, body: JSON.parse(body) });
    if (hang) throw new TypeError("fetch failed");
    if (dropAfterDelivery && !byKey.has(key)) {
      // Delivered, then the connection dropped before the answer came back.
      byKey.set(key, { body, id: `re-${delivered.length + 1}` });
      delivered.push({ key, body: JSON.parse(body) });
      throw new TypeError("fetch failed");
    }
    const json = (status, obj) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (key && byKey.has(key)) {
      const first = byKey.get(key);
      if (first.body !== body) {
        return json(409, {
          name: "invalid_idempotent_request",
          message: "Same idempotency key used with a different request payload.",
          statusCode: 409,
        });
      }
      return json(200, { id: first.id }); // answered from the first: NOT delivered again
    }
    if (failures > 0) {
      failures -= 1;
      // Resend accepted and delivered it, but the answer was lost on the way back.
      const id = `re-${delivered.length + 1}`;
      delivered.push({ key, body: JSON.parse(body) });
      if (key) byKey.set(key, { body, id });
      return json(500, { name: "application_error", message: "upstream", statusCode: 500 });
    }
    const id = `re-${delivered.length + 1}`;
    delivered.push({ key, body: JSON.parse(body) });
    if (key) byKey.set(key, { body, id });
    return json(200, { id });
  };
  return { delivered, requests };
}

/** communication_logs with migration 067's claim, decided on one clock. */
function fakeDb() {
  const rows = [];
  let n = 0;
  const now = () => Date.now();
  const service = fakeService((table, calls) => {
    if (table === "rpc:claim_failed_email_log") {
      const a = calls[0][1];
      const row = rows.find((r) => r.id === a.p_id && r.company_id === a.p_company_id);
      if (row?.channel !== "email") return { data: [{ out_outcome: "missing" }], error: null };
      if (row.status !== "failed") return { data: [{ out_outcome: "wrong_status" }], error: null };
      if (!(Date.parse(row.created_at) > now() - 24 * 3600 * 1000)) {
        return { data: [{ out_outcome: "too_old" }], error: null };
      }
      row.status = "queued";
      row.attempt_started_at = new Date(now() + ++n).toISOString();
      row.error = null;
      return {
        data: [{ out_outcome: "claimed", out_attempt_started_at: row.attempt_started_at }],
        error: null,
      };
    }
    if (table !== "communication_logs") throw new Error(`unexpected table ${table}`);
    const op = calls[0][0];
    const eqs = Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
    if (op === "insert") {
      const row = {
        id: `log-${rows.length + 1}`,
        created_at: new Date(now()).toISOString(),
        attempt_started_at: null,
        ...calls[0][1],
      };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (op === "select") return { data: null, count: 0, error: null };
    if (op === "update") {
      const hit = rows.filter((r) => Object.entries(eqs).every(([k, v]) => r[k] === v));
      for (const r of hit) Object.assign(r, calls[0][1]);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { service, rows };
}

const message = (over = {}) => ({
  companyId: CO,
  applicationId: APP,
  event: "booking_cancelled",
  to: "sam@example.test",
  subject: "Interview cancelled - Engineer",
  html: "<p>Hi Sam, Hana cancelled your Engineer interview.</p>",
  companyName: "Acme",
  replyTo: null,
  sentByName: "Hana Host",
  ...over,
});
const retryOf = (logId, over = {}) => {
  const m = message(over);
  return {
    logId,
    companyId: m.companyId,
    to: m.to,
    subject: m.subject,
    html: m.html,
    companyName: m.companyName,
    replyTo: m.replyTo,
  };
};
const quiet = async (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
};

test("59-1. the first send carries the row's idempotency key, comm-log:{logId}", async () => {
  const r = fakeResend();
  const { service, rows } = fakeDb();
  const sent = await deliverEmail(service, message());
  assert.equal(sent.ok, true);
  assert.equal(r.requests[0].key, candidateEmailKey(rows[0].id));
  assert.equal(r.requests[0].key, `comm-log:${rows[0].id}`);
  assert.equal(rows[0].status, "sent");
});

test("59-2. TWO Retries at once of one failed email: one claims and sends, the other sends nothing", async () => {
  const r = fakeResend({ failFirst: 0 });
  const { service, rows } = fakeDb();
  // A first send Resend refused before delivering: a clean failed row.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ name: "validation_error", message: "no", statusCode: 422 }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  const first = await quiet(() => deliverEmail(service, message()));
  assert.equal(first.ok, false);
  assert.equal(rows[0].status, "failed");
  const resend = fakeResend();
  const [a, b] = await Promise.all([
    resendFailedEmail(service, retryOf(rows[0].id)),
    resendFailedEmail(service, retryOf(rows[0].id)),
  ]);
  assert.deepEqual([a.kind, b.kind].sort(), ["not_retried", "sent"], "exactly one Retry sent");
  assert.equal(resend.delivered.length, 1, "the candidate received one email");
  assert.equal(rows[0].status, "sent");
  assert.equal(r.delivered.length, 0);
});

test("59-3. a first send whose outcome is UNKNOWN (the function died mid-send, row left queued) is never resent", async () => {
  const { service, rows } = fakeDb();
  rows.push({
    id: "log-dead",
    company_id: CO,
    channel: "email",
    status: "queued",
    attempt_started_at: null,
    created_at: new Date().toISOString(),
  });
  const resend = fakeResend();
  const out = await resendFailedEmail(service, retryOf("log-dead"));
  assert.deepEqual(out, { kind: "not_retried", reason: "wrong_status" });
  assert.equal(resend.requests.length, 0, "nothing reached Resend");
  assert.equal(rows[0].status, "queued");
});

test("59-3b. delivered, then the connection dropped: the row reads failed, and the Retry delivers nothing more", async () => {
  const r = fakeResend({ dropAfterDelivery: true });
  const { service, rows } = fakeDb();
  const first = await quiet(() => deliverEmail(service, message()));
  assert.equal(first.ok, false, "the SDK reports the dropped connection as an error");
  assert.equal(rows[0].status, "failed");
  assert.equal(r.delivered.length, 1);
  assert.deepEqual(await resendFailedEmail(service, retryOf(rows[0].id)), { kind: "sent" });
  assert.equal(r.delivered.length, 1, "Resend answered the Retry from the first send");
});

test("59-4. a first send Resend DELIVERED but answered with an error: the Retry is answered from Resend's record, delivered once", async () => {
  const r = fakeResend({ failFirst: 1 });
  const { service, rows } = fakeDb();
  const first = await quiet(() => deliverEmail(service, message()));
  assert.equal(first.ok, false);
  assert.equal(rows[0].status, "failed");
  assert.equal(r.delivered.length, 1, "it did reach the candidate");
  const out = await resendFailedEmail(service, retryOf(rows[0].id));
  assert.deepEqual(out, { kind: "sent" });
  assert.equal(r.delivered.length, 1, "and the Retry did not deliver it again");
  assert.equal(r.requests[1].key, r.requests[0].key);
  assert.deepEqual(r.requests[1].body, r.requests[0].body, "the same request, byte for byte");
  assert.equal(rows[0].status, "sent");
});

test("59-5. the email changed since the first send: Resend refuses the key, nothing is delivered", async () => {
  const r = fakeResend({ failFirst: 1 });
  const { service, rows } = fakeDb();
  await quiet(() => deliverEmail(service, message()));
  const out = await resendFailedEmail(service, retryOf(rows[0].id, { companyName: "Acme Ltd" }));
  assert.deepEqual(out, { kind: "mismatch" });
  assert.equal(r.delivered.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error, /no longer matches the first one/);
});

test("59-6. a Retry after success, a Retry older than 24 hours, another company's: nothing sent", async () => {
  const r = fakeResend();
  const { service, rows } = fakeDb();
  await deliverEmail(service, message());
  assert.deepEqual(await resendFailedEmail(service, retryOf(rows[0].id)), {
    kind: "not_retried",
    reason: "wrong_status",
  });
  rows.push({
    id: "log-old",
    company_id: CO,
    channel: "email",
    status: "failed",
    created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  });
  assert.deepEqual(await resendFailedEmail(service, retryOf("log-old")), {
    kind: "not_retried",
    reason: "too_old",
  });
  assert.deepEqual(
    await resendFailedEmail(service, { ...retryOf(rows[0].id), companyId: "other" }),
    { kind: "not_retried", reason: "missing" },
  );
  assert.equal(r.delivered.length, 1);
});

test("59-7. a stale Retry cannot overwrite a newer outcome: its write is guarded on its own claim", async () => {
  fakeResend();
  const { service, rows } = fakeDb();
  rows.push({
    id: "log-x",
    company_id: CO,
    channel: "email",
    status: "failed",
    created_at: new Date().toISOString(),
  });
  // Claim, then something else re-stamps the row before this Retry's write.
  const realRpc = service.rpc;
  service.rpc = async (...args) => {
    const res = await realRpc(...args);
    rows[0].attempt_started_at = "a-newer-claim";
    return res;
  };
  await resendFailedEmail(service, retryOf("log-x"));
  assert.notEqual(rows[0].status, "sent", "the write did not land on someone else's claim");
});
