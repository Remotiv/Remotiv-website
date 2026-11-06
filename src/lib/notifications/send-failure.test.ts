/**
 * #71A: every path that marks a communication_logs row failed tells the
 * company exactly once, and can never change what that path returns.
 *
 *   node --test src/lib/notifications/send-failure.test.ts
 *
 * Drives the four real writers end to end: deliverEmail (no key, and Resend
 * refusing), handleWhatsAppMessage (Meta refusing, terminal and transient) and
 * the signed WhatsApp webhook (a failure reported after acceptance), against a
 * fake database and a fake `fetch`. Nothing leaves the machine. The WhatsApp
 * terminal case has its own test because it returns normally: the job is
 * marked succeeded, the queue's dead-job alert never fires, and before this
 * change nobody heard about it.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { register } from "node:module";
import { mock, test } from "node:test";
import { call, fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-webhook-test-hook.mjs", import.meta.url));

const { alertSendFailure, sendFailureBellId, sendFailureText, SEND_FAILURE_ALERT_TIMEOUT_MS } =
  await import("./send-failure.ts");
const { deliverEmail } = await import("../email/candidate/deliver.ts");
const { handleWhatsAppMessage } = await import("../whatsapp/dispatch.ts");
const webhook = await import("../../app/api/webhooks/whatsapp/route.ts");

/* ── the world ───────────────────────────────────────────────── */

const COMPANY = "company-1";
const JOB = "job-1";
const APP_ID = "11111111-2222-4333-8444-555555abcdef";
/** Made-up candidate data that must never reach a bell. */
const CANDIDATE = {
  first: "Zubair",
  last: "Testerson",
  email: "zubair.testerson@example.test",
  phone: "0300 1234567",
  digits: "923001234567",
};
const MEMBERS = [
  { id: "m-owner", role: "owner" },
  { id: "m-admin", role: "admin" },
  { id: "m-rec", role: "recruiter" },
  { id: "m-other", role: "recruiter" },
];
/** Owner, admin, and the recruiter on this job's hiring team. Never m-other. */
const RECIPIENTS = ["m-admin", "m-owner", "m-rec"];

const ok = (data) => ({ data, error: null });

/** The AbortSignal a query carried, if the code passed one. */
const signalOf = (calls) => call(calls, "abortSignal")?.[1] ?? null;

/**
 * `bells` is how notifications_company answers: "ok" stores rows and refuses a
 * repeated id with 23505; "throw" rejects every call; "hang" never answers
 * until its abort signal fires, and then rejects the way an aborted fetch
 * does. `jobLookup: "throw"` rejects the helper's own job_applications read,
 * the one read it makes outside notifyCompanyOnce. `updateMatches` is how many
 * rows a failed-status update reports back (1, or 0 for a row that was not
 * there). `webhookRow` is what the status lookup finds by provider_message_id.
 * `seen.signal` is the signal the first hung bell write received.
 */
function world({ bells = "ok", jobLookup = "ok", updateMatches = 1, webhookRow = null } = {}) {
  const stored = [];
  const seen = { signal: null };
  let logs = 0;
  const service = fakeService((table, calls) => {
    switch (table) {
      case "communication_logs": {
        if (call(calls, "insert")) return ok({ id: `log-${++logs}` });
        if (call(calls, "update")) {
          // The updated row back, as `.select("id")` asks for it.
          const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
          return ok(call(calls, "select") && updateMatches === 1 ? [{ id }] : []);
        }
        if (call(calls, "select")?.[2]?.head) return { data: null, count: 0, error: null };
        if (calls.some((c) => c[0] === "eq" && c[1] === "provider_message_id")) {
          return ok(webhookRow);
        }
        return ok(null); // the dispatcher's idempotency read
      }
      case "job_applications": {
        if (jobLookup === "throw" && call(calls, "select")?.[1] === "job_id") {
          throw new Error("job lookup unavailable");
        }
        return ok({
          id: APP_ID,
          first_name: CANDIDATE.first,
          last_name: CANDIDATE.last,
          email: CANDIDATE.email,
          phone: CANDIDATE.phone,
          job_id: JOB,
          job_title_snapshot: "Engineer",
          company_id_snapshot: COMPANY,
          pipeline_stage: "interview",
        });
      }
      case "companies":
        return ok({ id: COMPANY, name: "Acme", candidate_reply_email: null });
      case "jobs":
        return ok({ title: "Engineer" });
      case "whatsapp_opt_outs":
        return call(calls, "maybeSingle") ? ok(null) : ok([]);
      case "whatsapp_inbound":
        return ok([]);
      case "company_members":
        return ok(MEMBERS);
      case "job_hiring_team":
        return ok([{ member_id: "m-rec" }]);
      case "notifications_company": {
        if (bells === "throw") throw new Error("notifications unavailable");
        if (bells === "hang") {
          const signal = signalOf(calls);
          seen.signal ??= signal;
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError")),
            );
          });
        }
        const row = call(calls, "insert")[1];
        if (stored.some((r) => r.id === row.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        stored.push(row);
        return ok(row);
      }
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
  return { service, stored, seen };
}

/** The bells stored for one failure record, by recipient, with their ids checked. */
function bellsFor(stored, logId) {
  const expected = new Map(RECIPIENTS.map((m) => [sendFailureBellId(logId, m), m]));
  for (const row of stored) {
    assert.ok(expected.has(row.id), `a bell with an id not derived from ${logId}: ${row.id}`);
    assert.equal(row.member_id, expected.get(row.id), "the id names its recipient");
    assert.equal(row.type, "message_failed");
    assert.equal(row.company_id, COMPANY);
    assert.equal(row.application_id, APP_ID);
    assert.equal(row.job_id, JOB);
  }
  return stored.map((r) => r.member_id).sort();
}

/** Exactly one alert for one record: one bell per recipient, nobody twice, nobody else. */
function assertOneAlert(stored, logId) {
  assert.deepEqual(bellsFor(stored, logId), RECIPIENTS);
}

/* ── driving the writers ─────────────────────────────────────── */

function quietly(run) {
  const saved = { error: console.error, log: console.log, warn: console.warn };
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  return Promise.resolve()
    .then(run)
    .finally(() => Object.assign(console, saved));
}

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function withFetch(fake, run) {
  const saved = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = saved;
    });
}

/** deliverEmail with no provider key (`configured: false`) or with Resend refusing. */
function runEmail(service, { configured, actorMemberId = null } = {}) {
  const resendRefuses = async () =>
    new Response(
      JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to`" }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
  return quietly(() =>
    withEnv({ RESEND_API_KEY: configured ? "re_test_key" : undefined }, () =>
      withFetch(resendRefuses, () =>
        deliverEmail(service, {
          companyId: COMPANY,
          applicationId: APP_ID,
          event: "interview",
          to: CANDIDATE.email,
          subject: "Your interview",
          html: "<p>hello</p>",
          companyName: "Acme",
          replyTo: null,
          actorMemberId,
        }),
      ),
    ),
  );
}

/** handleWhatsAppMessage against a Meta that refuses: terminal (132001) or transient (500). */
async function runWhatsApp(service, meta) {
  const metaRefuses = async () =>
    meta === "terminal"
      ? new Response(
          JSON.stringify({
            error: { message: "Template name does not exist in the translation", code: 132001 },
          }),
          { status: 400 },
        )
      : new Response("{}", { status: 500 });
  globalThis.__fakeServiceClientForTests = () => service;
  try {
    return await quietly(() =>
      withEnv({ WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "test-phone" }, () =>
        withFetch(metaRefuses, () =>
          handleWhatsAppMessage({
            id: "job-row-1",
            payload: { applicationId: APP_ID, event: "interview", channel: "whatsapp" },
          }).then(
            () => ({ outcome: "resolved" }),
            (err) => ({ outcome: "rejected", message: err.message }),
          ),
        ),
      ),
    );
  } finally {
    delete globalThis.__fakeServiceClientForTests;
  }
}

/** A signed Meta status webhook saying the message with this wamid failed. */
async function runWebhook(service, wamid) {
  const secret = "test-app-secret";
  const raw = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: wamid, status: "failed", errors: [{ code: 131026, title: "Undeliverable" }] },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  globalThis.__fakeServiceClientForTests = () => service;
  try {
    return await quietly(() =>
      withEnv({ WHATSAPP_APP_SECRET: secret }, () =>
        webhook.POST(
          new Request("http://localhost/api/webhooks/whatsapp", {
            method: "POST",
            body: raw,
            headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
          }),
        ),
      ),
    );
  } finally {
    delete globalThis.__fakeServiceClientForTests;
  }
}

const failedWrites = (service) =>
  service.queries
    .filter((q) => q.table === "communication_logs")
    .flatMap((q) => q.calls.filter((c) => c[0] === "update" && c[1]?.status === "failed"));

/* ── the four writers ────────────────────────────────────────── */

test("deliverEmail with no provider key marks the row failed and alerts once", async () => {
  const { service, stored } = world();
  const outcome = await runEmail(service, { configured: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not_configured");
  assert.equal(failedWrites(service).length, 1);
  assertOneAlert(stored, outcome.logId);
});

test("deliverEmail when Resend refuses marks the row failed and alerts once", async () => {
  const { service, stored } = world();
  const outcome = await runEmail(service, { configured: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "provider", "the fake Resend answer must read as a provider refusal");
  assert.equal(failedWrites(service).length, 1);
  assertOneAlert(stored, outcome.logId);
});

test("WhatsApp TERMINAL refusal returns normally, so the job succeeds silently, and still alerts once", async () => {
  const { service, stored } = world();
  const result = await runWhatsApp(service, "terminal");
  assert.equal(
    result.outcome,
    "resolved",
    "the terminal path does not throw: the queue hears nothing",
  );
  assert.equal(failedWrites(service).length, 1);
  assertOneAlert(stored, "log-1");
});

test("WhatsApp transient refusal throws for the queue and alerts once", async () => {
  const { service, stored } = world();
  const result = await runWhatsApp(service, "transient");
  assert.equal(result.outcome, "rejected");
  assert.match(result.message, /send_message\[whatsapp\]/);
  assert.equal(failedWrites(service).length, 1);
  assertOneAlert(stored, "log-1");
});

test("the webhook's late failure marks the row failed and alerts once", async () => {
  const row = {
    id: "log-wa",
    status: "sent",
    company_id: COMPANY,
    application_id: APP_ID,
    event: "interview_reminder",
  };
  const { service, stored } = world({ webhookRow: row });
  const response = await runWebhook(service, "wamid.test");
  assert.equal(response.status, 200);
  assert.equal(failedWrites(service).length, 1);
  assertOneAlert(stored, "log-wa");
  assert.ok(stored[0].body.includes("interview reminder"), "the bell names the message");
});

/* ── the rules ───────────────────────────────────────────────── */

test("an update that matched no row rings no bell, on every writer", async () => {
  const email = world({ updateMatches: 0 });
  const outcome = await runEmail(email.service, { configured: false });
  assert.equal(outcome.kind, "not_configured", "the send path's answer is unchanged");
  assert.equal(email.stored.length, 0);

  const wa = world({ updateMatches: 0 });
  assert.equal((await runWhatsApp(wa.service, "terminal")).outcome, "resolved");
  assert.equal(wa.stored.length, 0);

  const row = {
    id: "log-wa",
    status: "sent",
    company_id: COMPANY,
    application_id: APP_ID,
    event: "interview",
  };
  const hook = world({ updateMatches: 0, webhookRow: row });
  assert.equal((await runWebhook(hook.service, "wamid.gone")).status, 200);
  assert.equal(hook.stored.length, 0);
});

test("every notification request carries the helper's abort signal", async () => {
  const { service } = world();
  await quietly(() =>
    alertSendFailure(service, {
      logId: "log-9",
      companyId: COMPANY,
      applicationId: APP_ID,
      event: "interview",
      channel: "email",
    }),
  );
  const alertQueries = service.queries.filter((q) =>
    ["job_applications", "company_members", "job_hiring_team", "notifications_company"].includes(
      q.table,
    ),
  );
  assert.equal(alertQueries.length, 3 + RECIPIENTS.length);
  const signals = new Set(alertQueries.map((q) => signalOf(q.calls)));
  assert.equal(signals.size, 1, "one signal on every request");
  assert.ok(signals.values().next().value instanceof AbortSignal);
});

/**
 * The clock is injected, not shortened: node:test's mock timers replace
 * setTimeout, so the real three-second constant is what fires, and the fake
 * bell write never answers until the abort reaches it.
 */
async function runWithHungBells(drive) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const w = world({ bells: "hang" });
  const started = Date.now();
  try {
    const pending = drive(w.service);
    // Let the send path reach the hung write and register its timer.
    for (let i = 0; i < 50 && !w.seen.signal; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(w.seen.signal, "the bell write was reached and given a signal");
    assert.equal(w.seen.signal.aborted, false, "not aborted before the timeout");
    mock.timers.tick(SEND_FAILURE_ALERT_TIMEOUT_MS);
    const result = await pending;
    assert.equal(w.seen.signal.aborted, true, "the request was abandoned, not just raced past");
    assert.ok(Date.now() - started < 1000, "no real wait");
    assert.equal(w.stored.length, 0);
    return result;
  } finally {
    mock.timers.reset();
  }
}

test("a bell write that never answers: deliverEmail still returns, and the request is aborted", async () => {
  const outcome = await runWithHungBells((service) => runEmail(service, { configured: false }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not_configured");
});

test("a bell write that never answers: the WhatsApp terminal path still returns normally", async () => {
  const result = await runWithHungBells((service) => runWhatsApp(service, "terminal"));
  assert.equal(result.outcome, "resolved");
});

test("application_id NULL produces no alert and no lookup", async () => {
  const { service, stored } = world();
  await alertSendFailure(service, {
    logId: "log-orphan",
    companyId: COMPANY,
    applicationId: null,
    event: "interview",
    channel: "whatsapp",
  });
  assert.equal(stored.length, 0);
  assert.deepEqual(service.queries, [], "nothing is read for an erased applicant");
});

test("the webhook alerts nobody for a row whose applicant was deleted", async () => {
  const row = {
    id: "log-wa",
    status: "sent",
    company_id: COMPANY,
    application_id: null,
    event: "interview",
  };
  const { service, stored } = world({ webhookRow: row });
  const response = await runWebhook(service, "wamid.orphan");
  assert.equal(response.status, 200);
  assert.equal(failedWrites(service).length, 1, "the record is still marked failed");
  assert.equal(stored.length, 0);
});

test("the same failure record alerting twice produces one bell per recipient, not two", async () => {
  const { service, stored } = world();
  const input = {
    logId: "log-7",
    companyId: COMPANY,
    applicationId: APP_ID,
    event: "interview",
    channel: "email",
  };
  await quietly(() => alertSendFailure(service, input));
  await quietly(() => alertSendFailure(service, input));
  assertOneAlert(stored, "log-7");
  const attempts = service.queries.filter((q) => q.table === "notifications_company");
  assert.equal(attempts.length, RECIPIENTS.length * 2, "the second pass was attempted and refused");
});

test("an alert write that throws leaves deliverEmail's return value unchanged", async () => {
  const baseline = await runEmail(world().service, { configured: true });
  for (const broken of [{ bells: "throw" }, { jobLookup: "throw" }]) {
    const { service, stored } = world(broken);
    const outcome = await runEmail(service, { configured: true });
    assert.deepEqual(outcome, baseline, `${JSON.stringify(broken)}: the outcome moved`);
    assert.equal(stored.length, 0);
    assert.equal(failedWrites(service).length, 1, "the record is still marked failed");
  }
});

test("an alert write that throws leaves the WhatsApp paths' throw behaviour unchanged", async () => {
  const terminal = await runWhatsApp(world().service, "terminal");
  const transient = await runWhatsApp(world().service, "transient");
  for (const broken of [{ bells: "throw" }, { jobLookup: "throw" }]) {
    const t = await runWhatsApp(world(broken).service, "terminal");
    assert.deepEqual(t, terminal, `${JSON.stringify(broken)}: the terminal path moved`);
    const x = await runWhatsApp(world(broken).service, "transient");
    assert.deepEqual(x, transient, `${JSON.stringify(broken)}: the transient path moved`);
  }
});

test("an alert write that throws leaves the webhook's response unchanged", async () => {
  const row = {
    id: "log-wa",
    status: "sent",
    company_id: COMPANY,
    application_id: APP_ID,
    event: "interview",
  };
  const baseline = await runWebhook(world({ webhookRow: row }).service, "wamid.x");
  const { service, stored } = world({ webhookRow: row, bells: "throw" });
  const response = await runWebhook(service, "wamid.x");
  assert.deepEqual(response, baseline);
  assert.equal(stored.length, 0);
});

test("the bell carries no candidate data: not the name, the address or the number", async () => {
  const { service, stored } = world();
  await runEmail(service, { configured: true });
  assert.ok(stored.length > 0);
  const leaks = [
    CANDIDATE.first,
    CANDIDATE.last,
    CANDIDATE.email,
    CANDIDATE.phone,
    CANDIDATE.digits,
  ];
  for (const row of stored) {
    for (const field of ["title", "body", "href"]) {
      for (const leak of leaks) {
        assert.ok(!String(row[field] ?? "").includes(leak), `${field} carries "${leak}"`);
      }
    }
    assert.ok(
      row.body.includes(APP_ID.slice(-6)),
      "the applicant is named by the last six of the id",
    );
    assert.ok(!row.body.includes(APP_ID.slice(0, 8)), "and not by more of it");
    assert.equal(row.href, `/ai-dashboard/applicants?applicant=${APP_ID}`);
  }
  // The text itself, independent of the world.
  const text = sendFailureText({ channel: "whatsapp", event: "interview", applicationId: APP_ID });
  assert.equal(text.title, "A WhatsApp message didn't arrive");
  assert.ok(!/—/.test(`${text.title}${text.body}`), "no em dash in user-visible copy");
});

test("the actor is left out of the fan-out when one is passed", async () => {
  const { service, stored } = world();
  const outcome = await runEmail(service, { configured: false, actorMemberId: "m-admin" });
  assert.deepEqual(bellsFor(stored, outcome.logId), ["m-owner", "m-rec"]);
});

test("bell ids are one per failure record per recipient", () => {
  const a = sendFailureBellId("log-1", "m-owner");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sendFailureBellId("log-1", "m-owner"), a, "stable");
  assert.notEqual(sendFailureBellId("log-1", "m-admin"), a, "per recipient");
  assert.notEqual(sendFailureBellId("log-2", "m-owner"), a, "per record");
});
