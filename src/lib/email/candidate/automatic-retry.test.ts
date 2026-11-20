/**
 * #56 (QA #40 M-3): the queue's retry of an automatic email whose first
 * attempt failed now delivers it, and never twice.
 *
 *   node --test src/lib/email/candidate/automatic-retry.test.ts
 *
 * Before: the retry inserted into the same unique key, got `duplicate`, and
 * the job completed, so one transient Resend error meant the candidate never
 * got the message. Now the failed row is claimed through migration 067's
 * claim_failed_email_log and sent with the first attempt's idempotency key.
 *
 * deliverEmail runs as shipped with the real Resend SDK over a fake `fetch`
 * that keeps Resend's idempotency rules (one key, one message: the same
 * request again is answered from the first; a different one is refused). The
 * fake database applies the partial unique index (application, event, channel
 * where sent_by_name is null) and 067's claim (a 'failed' row from the last
 * 24 hours, one claimer). Nothing leaves the machine. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { deliverEmail, candidateEmailKey } = await import("./deliver.ts");
const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-000000000001";

/**
 * Resend, as far as delivery and idempotency go. `outcomes` is what each
 * NEW request (an unseen key) gets: "ok", "500" (refused, not delivered),
 * "lost" (delivered, the answer lost on the way back).
 */
function fakeResend(outcomes = []) {
  const byKey = new Map();
  const delivered = [];
  const requests = [];
  const queue = [...outcomes];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.resend.com/emails"))
      throw new Error(`unexpected ${url}`);
    const key = new Headers(init.headers).get("Idempotency-Key");
    const body = String(init.body);
    requests.push({ key, body: JSON.parse(body) });
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
      return json(200, { id: first.id });
    }
    const next = queue.shift() ?? "ok";
    if (next === "500") {
      return json(500, { name: "application_error", message: "upstream", statusCode: 500 });
    }
    const id = `re-${delivered.length + 1}`;
    delivered.push({ key, body: JSON.parse(body) });
    byKey.set(key, { body, id });
    if (next === "lost") {
      return json(500, { name: "application_error", message: "upstream", statusCode: 500 });
    }
    return json(200, { id });
  };
  return { delivered, requests };
}

/** communication_logs with the partial unique index and 067's claim. */
function fakeDb({ selectFails = false } = {}) {
  const rows = [];
  let n = 0;
  const service = fakeService((table, calls) => {
    if (table === "rpc:claim_failed_email_log") {
      const a = calls[0][1];
      const row = rows.find((r) => r.id === a.p_id && r.company_id === a.p_company_id);
      if (row?.channel !== "email") return { data: [{ out_outcome: "missing" }], error: null };
      if (row.status !== "failed") return { data: [{ out_outcome: "wrong_status" }], error: null };
      if (!(Date.parse(row.created_at) > Date.now() - 24 * 3600 * 1000)) {
        return { data: [{ out_outcome: "too_old" }], error: null };
      }
      row.status = "queued";
      row.attempt_started_at = new Date(Date.now() + ++n).toISOString();
      row.error = null;
      return {
        data: [{ out_outcome: "claimed", out_attempt_started_at: row.attempt_started_at }],
        error: null,
      };
    }
    if (table !== "communication_logs") throw new Error(`unexpected table ${table}`);
    const op = calls[0][0];
    const eqs = Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
    const isNull = calls.filter((c) => c[0] === "is" && c[2] === null).map((c) => c[1]);
    const match = (r) =>
      Object.entries(eqs).every(([k, v]) => r[k] === v) && isNull.every((k) => r[k] == null);
    if (op === "insert") {
      const v = calls[0][1];
      const clash =
        !v.sent_by_name &&
        rows.some(
          (r) =>
            !r.sent_by_name &&
            r.application_id === v.application_id &&
            r.event === v.event &&
            r.channel === v.channel,
        );
      if (clash) return { data: null, error: { code: "23505", message: "duplicate key" } };
      const row = {
        id: `log-${rows.length + 1}`,
        created_at: new Date().toISOString(),
        attempt_started_at: null,
        ...v,
      };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (op === "select") {
      if (calls.some((c) => c[0] === "maybeSingle")) {
        if (selectFails) return { data: null, error: { code: "57014" } };
        const hit = rows.filter(match).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        return { data: hit ? { id: hit.id } : null, error: null };
      }
      return { data: null, count: 0, error: null }; // the daily cap count
    }
    if (op === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, calls[0][1]);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    throw new Error(`unexpected ${op}`);
  });
  return { service, rows };
}

/** One automatic message, rebuilt the same way on every attempt (the job's payload). */
const message = (over = {}) => ({
  companyId: CO,
  applicationId: APP,
  event: "interview_reminder",
  to: "candidate@example.test",
  subject: "Reminder: your interview",
  html: "<html><body>Your interview closes Friday.</body></html>",
  companyName: "Acme",
  replyTo: null,
  ...over,
});
const quiet = async (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
};

test("R1. one transient Resend error, then the queue's retry: delivered exactly once, on the same row and key", async () => {
  const resend = fakeResend(["500"]);
  const { service, rows } = fakeDb();
  const first = await quiet(() => deliverEmail(service, message()));
  assert.equal(first.ok, false);
  assert.equal(first.kind, "provider", "the job throws, so the queue retries");
  assert.equal(rows[0].status, "failed");
  assert.equal(resend.delivered.length, 0);

  const retry = await deliverEmail(service, message());
  assert.deepEqual(retry, { ok: true, logId: rows[0].id, providerId: null });
  assert.equal(rows.length, 1, "no second row");
  assert.equal(rows[0].status, "sent");
  assert.equal(resend.delivered.length, 1);
  assert.deepEqual(
    resend.requests.map((r) => r.key),
    [candidateEmailKey(rows[0].id), candidateEmailKey(rows[0].id)],
    "the SAME idempotency key both times",
  );
  assert.deepEqual(resend.requests[1].body, resend.requests[0].body, "the identical email");
});

test("R2. the first attempt WAS delivered but its answer was lost: the retry is answered from Resend's record, not delivered again", async () => {
  const resend = fakeResend(["lost"]);
  const { service, rows } = fakeDb();
  await quiet(() => deliverEmail(service, message()));
  assert.equal(rows[0].status, "failed");
  assert.equal(resend.delivered.length, 1);
  const retry = await deliverEmail(service, message());
  assert.equal(retry.ok, true);
  assert.equal(resend.delivered.length, 1, "never twice");
  assert.equal(rows[0].status, "sent");
});

test("R3. a message that changed between attempts is refused by Resend and NOT sent; the job does not retry it", async () => {
  const resend = fakeResend(["lost"]);
  const { service, rows } = fakeDb();
  await quiet(() => deliverEmail(service, message()));
  const retry = await deliverEmail(
    service,
    message({ html: "<html><body>Different</body></html>" }),
  );
  assert.equal(retry.ok, false);
  assert.equal(retry.kind, "duplicate", "a refusal the caller completes on, not a fault to retry");
  assert.equal(resend.delivered.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error, /no longer matches the first one/);
});

test("R4. a row already sent, or still queued (outcome unknown), is not retried: duplicate as before, nothing sent", async () => {
  for (const status of ["sent", "queued"]) {
    const resend = fakeResend();
    const { service, rows } = fakeDb();
    rows.push({
      id: "log-x",
      company_id: CO,
      application_id: APP,
      event: "interview_reminder",
      channel: "email",
      status,
      sent_by_name: null,
      created_at: new Date().toISOString(),
    });
    const out = await deliverEmail(service, message());
    assert.equal(out.ok, false, status);
    assert.equal(out.kind, "duplicate", status);
    assert.equal(resend.requests.length, 0, `${status}: nothing reached Resend`);
  }
});

test("R5. a failed row older than 24 hours is not retried (Resend's key window): duplicate, nothing sent", async () => {
  const resend = fakeResend();
  const { service, rows } = fakeDb();
  rows.push({
    id: "log-old",
    company_id: CO,
    application_id: APP,
    event: "interview_reminder",
    channel: "email",
    status: "failed",
    sent_by_name: null,
    created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  });
  const out = await deliverEmail(service, message());
  assert.equal(out.kind, "duplicate");
  assert.equal(resend.requests.length, 0);
});

test("R6. Resend fails again on the retry: the row reads failed again and the job may retry once more, still one key", async () => {
  const resend = fakeResend(["500", "500"]);
  const { service, rows } = fakeDb();
  await quiet(() => deliverEmail(service, message()));
  const second = await quiet(() => deliverEmail(service, message()));
  assert.equal(second.kind, "provider");
  assert.equal(rows[0].status, "failed");
  const third = await deliverEmail(service, message());
  assert.equal(third.ok, true);
  assert.equal(resend.delivered.length, 1);
  assert.equal(new Set(resend.requests.map((r) => r.key)).size, 1);
});

test("R7. another company's failed row is never claimed; a recruiter's own send never takes this path", async () => {
  const resend = fakeResend();
  const { service, rows } = fakeDb();
  rows.push({
    id: "log-other",
    company_id: "c-other",
    application_id: APP,
    event: "interview_reminder",
    channel: "email",
    status: "failed",
    sent_by_name: null,
    created_at: new Date().toISOString(),
  });
  const out = await deliverEmail(service, message());
  assert.equal(out.kind, "duplicate");
  assert.equal(resend.requests.length, 0);
  const src = readFileSync(new URL("./deliver.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /const retried = input\.sentByName \? null : await retryFailedAutomatic\(service, input\);/,
  );
});

test("R8. the lookup cannot be read: refused as a fault (the queue retries), nothing sent", async () => {
  const resend = fakeResend(["500"]);
  const { service } = fakeDb({ selectFails: true });
  await quiet(() => deliverEmail(service, message()));
  const out = await deliverEmail(service, message());
  assert.equal(out.ok, false);
  assert.equal(out.kind, "log");
  assert.equal(resend.delivered.length, 0);
});
