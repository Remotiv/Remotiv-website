/**
 * The async interview cap, run through the real sendInterviewInvite.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/interview-invite-cap.test.ts"
 *
 * The action, the allowance module, the Karachi helpers and the token minting
 * are the shipped code. The database, the company context, the email path and
 * the queue are fakes (interview-invite-test-hook.mjs), and every call to any
 * of them lands on one timeline, so order is asserted, not inferred.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { sendInterviewInvite, sendLiveInterviewInvite } = await import("./interview-actions.ts");

const COMPANY = "co-acme";
const APPLICATION = "app-123";
const USAGE = "usage-777";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ok = (data) => ({ data, error: null });

const GRANT = {
  allowed: true,
  unlimited: false,
  reason: "within_limit",
  used: 1,
  allowance: 5,
  usage_id: USAGE,
  period_start: "2026-09-30T19:00:00Z",
};
const REFUSAL = {
  allowed: false,
  unlimited: false,
  reason: "limit_reached",
  used: 5,
  allowance: 5,
  usage_id: null,
  period_start: "2026-09-30T19:00:00Z",
};

const EMAIL = {
  accepted: () => ({ ok: true, logId: "log-1", providerId: "re_1" }),
  refused: () => ({
    ok: false,
    kind: "provider",
    message: "The email provider rejected the message.",
    logId: "log-1",
  }),
  capped: () => ({ ok: false, kind: "cap", message: "Daily limit reached.", logId: null }),
  throws: () => {
    throw new Error("fetch failed");
  },
};

/**
 * One invite attempt against a fake world. Every database call, the email and
 * every enqueue are pushed onto `timeline` in the order they happen.
 */
async function send({
  decision = GRANT,
  consumeError = null,
  existing = [],
  insert = "ok",
  email = "accepted",
  enqueue = "ok",
  live = false,
} = {}) {
  const timeline = [];
  const service = fakeService((table, calls) => {
    const verb =
      ["insert", "update", "upsert", "delete"].find((v) => calls.some((c) => c[0] === v)) ??
      "select";
    timeline.push(table.startsWith("rpc:") ? table : `${table}:${verb}`);
    switch (table) {
      case "rpc:consume_allowance":
        return consumeError ? { data: null, error: consumeError } : ok([decision]);
      case "rpc:release_allowance":
        return ok(true);
      case "job_applications":
        return ok({
          id: APPLICATION,
          first_name: "Sam",
          last_name: "Lee",
          email: "sam@example.test",
          job_id: "job-1",
          job_title_snapshot: "Engineer",
          jobs: { title: "Engineer" },
        });
      case "jobs":
        return ok({ allow_rerecord: true, async_interview_enabled: true });
      case "interview_questions":
        return ok([
          {
            id: "q1",
            position: 1,
            question: "Tell us about a project.",
            prep_seconds: 30,
            answer_seconds: 120,
            required: true,
            competency: null,
            rubric: null,
            weight: null,
          },
        ]);
      case "interview_sessions":
        if (verb === "insert") {
          if (insert === "error") return { data: null, error: { message: "insert failed" } };
          if (insert === "throw") throw new Error("socket hang up");
          return ok({ id: call(calls, "insert")[1].id ?? "db-generated-id" });
        }
        if (verb === "update") return ok(null);
        return ok(existing);
      case "companies":
        return ok({ name: "Acme", candidate_reply_email: null });
      default:
        throw new Error(`unexpected ${table}`);
    }
  });

  globalThis.__inviteServiceForTests = () => service;
  globalThis.__inviteCtxForTests = { companyId: COMPANY, memberId: "m-1", memberName: "Rae" };
  globalThis.__inviteDeliverForTests = (input) => {
    timeline.push("email");
    return EMAIL[email](input);
  };
  globalThis.__inviteEnqueueForTests = (job) => {
    timeline.push(`enqueue:${job.type}`);
    if (enqueue === "throw") throw new Error("queue down");
    return { ok: true };
  };
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };

  const quiet = {};
  for (const m of ["error", "warn", "log"]) {
    quiet[m] = console[m];
    console[m] = () => {};
  }
  try {
    const action = live ? sendLiveInterviewInvite : sendInterviewInvite;
    let result = null;
    let thrown = null;
    try {
      result = await action(APPLICATION);
    } catch (err) {
      thrown = err;
    }
    return { result, thrown, timeline, service };
  } finally {
    for (const m of Object.keys(quiet)) console[m] = quiet[m];
  }
}

const consumes = (r) => r.service.rpcs.filter((x) => x.name === "consume_allowance");
const releases = (r) => r.service.rpcs.filter((x) => x.name === "release_allowance");
const insertOf = (r) =>
  r.service.queries.find((q) => q.table === "interview_sessions" && call(q.calls, "insert"));
const at = (r, label) => r.timeline.indexOf(label);

/** One attempt with the clock set, so the refusal's reset date is deterministic. */
async function sendAt(iso, opts) {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
  try {
    return await send(opts);
  } finally {
    mock.timers.reset();
  }
}

/* ── the gate's position and arguments ──────────────────────────── */

test("the credit is reserved before the supersede, the session insert and the email", async () => {
  const r = await send();
  assert.equal(r.result.success, true);
  const consume = at(r, "rpc:consume_allowance");
  assert.ok(consume >= 0, "no reservation was made");
  assert.ok(consume < at(r, "interview_sessions:select"), "reserved after the supersede read");
  assert.ok(consume < at(r, "interview_sessions:insert"), "reserved after the session insert");
  assert.ok(consume < at(r, "email"), "reserved after the email");
});

test("one call, for this company, metric interview_sent, referencing the session it pays for", async () => {
  const r = await send();
  assert.equal(consumes(r).length, 1);
  const { args } = consumes(r)[0];
  assert.equal(args.p_company, COMPANY);
  assert.equal(args.p_metric, "interview_sent");
  assert.match(args.p_ref, UUID, "the reference is a fresh UUID");
  assert.notEqual(args.p_ref, APPLICATION, "the application id is not a per-invitation reference");
  // The same UUID is the session's id: one credit, one session.
  assert.equal(call(insertOf(r).calls, "insert")[1].id, args.p_ref);
});

test("every attempt gets its own reference, including a re-send to the same applicant", async () => {
  const refs = new Set();
  for (let i = 0; i < 3; i++) {
    const r = await send({
      existing: i ? [{ id: "old", status: "invited", submitted_at: null }] : [],
    });
    refs.add(consumes(r)[0].args.p_ref);
  }
  assert.equal(refs.size, 3);
});

test("a re-send consumes a credit too", async () => {
  const r = await send({ existing: [{ id: "old", status: "invited", submitted_at: null }] });
  assert.equal(r.result.success, true);
  assert.equal(consumes(r).length, 1);
  assert.equal(releases(r).length, 0);
});

/* ── release on every failure before the provider accepts ───────── */

for (const [label, opts, expectInsert, expectEmail] of [
  [
    "an already-submitted interview",
    { existing: [{ id: "s", status: "submitted", submitted_at: "2026-10-02T10:00:00Z" }] },
    false,
    false,
  ],
  ["a failed session insert", { insert: "error" }, true, false],
  ["a refused email", { email: "refused" }, true, true],
  ["an email the daily cap stopped", { email: "capped" }, true, true],
]) {
  test(`${label} gives the same credit back, once, and reports failure`, async () => {
    const r = await send(opts);
    assert.equal(r.result.success, false);
    assert.deepEqual(
      releases(r).map((x) => x.args),
      [{ p_usage_id: USAGE }],
    );
    assert.ok(at(r, "rpc:release_allowance") > at(r, "rpc:consume_allowance"));
    assert.equal(at(r, "interview_sessions:insert") >= 0, expectInsert, "insert");
    assert.equal(at(r, "email") >= 0, expectEmail, "email");
    assert.ok(!r.timeline.some((e) => e.startsWith("enqueue:")), "nothing may be scheduled");
  });
}

test("a failed email still cancels the session, as before", async () => {
  const r = await send({ email: "refused" });
  assert.equal(r.result.error, "The email provider rejected the message.");
  const sessionId = consumes(r)[0].args.p_ref;
  const cancel = r.service.queries.find(
    (q) => q.table === "interview_sessions" && call(q.calls, "update"),
  );
  assert.deepEqual(call(cancel.calls, "update"), ["update", { status: "cancelled" }]);
  assert.deepEqual(call(cancel.calls, "eq"), ["eq", "id", sessionId]);
  assert.ok(at(r, "interview_sessions:update") < at(r, "rpc:release_allowance"));
});

for (const [label, opts] of [
  ["a thrown session insert", { insert: "throw" }],
  ["a thrown email send", { email: "throws" }],
]) {
  test(`${label} gives the credit back and lets the error through`, async () => {
    const r = await send(opts);
    assert.ok(r.thrown, "the error must not be swallowed");
    assert.deepEqual(
      releases(r).map((x) => x.args),
      [{ p_usage_id: USAGE }],
    );
  });
}

/* ── no release once the provider has accepted ──────────────────── */

test("after the provider accepts, nothing releases, even when everything after it fails", async () => {
  const r = await send({ enqueue: "throw" });
  assert.equal(r.result.success, true, "a queue outage after delivery is not a failed invite");
  assert.ok(at(r, "email") >= 0);
  assert.ok(r.timeline.includes("enqueue:send_message"), "the WhatsApp enqueue ran and threw");
  assert.equal(releases(r).length, 0);
});

test("a delivered invite schedules its reminder, and the reminder spends nothing", async () => {
  const r = await send();
  assert.ok(r.timeline.includes("enqueue:interview_reminder"));
  assert.ok(r.timeline.includes("enqueue:interview_expiry"));
  assert.equal(consumes(r).length, 1, "one credit per invitation, none for its reminder");
  assert.equal(releases(r).length, 0);
});

/* ── a refusal does nothing at all ──────────────────────────────── */

test("a refusal creates no session, sends no email, does not retry, and says exactly why", async () => {
  // Mid-October in Karachi: the limit resets on 1 November.
  const r = await sendAt("2026-10-15T09:00:00Z", {
    decision: REFUSAL,
    existing: [{ id: "old", status: "invited" }],
  });
  assert.deepEqual(r.result, {
    success: false,
    error:
      "This company has used all its async interview invitations for this month. The limit resets on 1 November 2026 or can be raised by Remotiv.",
  });
  assert.equal(consumes(r).length, 1, "retried");
  assert.equal(releases(r).length, 0, "a refusal reserved nothing, so nothing is released");
  assert.ok(
    !r.timeline.some((e) => e.startsWith("interview_sessions:")),
    "no session may be read, cancelled or created: the candidate's current link stays open",
  );
  assert.ok(!r.timeline.includes("email"));
  assert.ok(!r.timeline.some((e) => e.startsWith("enqueue:")));
});

test("the refusal's reset date is the Karachi month, not the UTC one", async () => {
  // 20:00 UTC on 31 October is 01:00 on 1 November in Karachi.
  const r = await sendAt("2026-10-31T20:00:00Z", { decision: REFUSAL });
  assert.match(
    r.result.error,
    /The limit resets on 1 December 2026 or can be raised by Remotiv\.$/,
  );
});

test("no decision from the allowance sends nothing and releases nothing", async () => {
  const r = await send({ consumeError: { message: "permission denied" } });
  assert.equal(r.result.success, false);
  assert.match(r.result.error, /monthly allowance couldn't be checked\. Nothing was sent\./);
  assert.equal(releases(r).length, 0);
  assert.ok(!r.timeline.some((e) => e.startsWith("interview_sessions:")));
  assert.ok(!r.timeline.includes("email"));
});

/* ── unlimited companies and the live invite ────────────────────── */

for (const reason of ["unlimited_no_plan", "unlimited_internal"]) {
  test(`${reason}: the invitation goes out normally and keeps its credit`, async () => {
    const r = await send({
      decision: { ...GRANT, unlimited: true, reason, allowance: null, usage_id: "usage-u" },
    });
    assert.equal(r.result.success, true);
    assert.ok(at(r, "interview_sessions:insert") >= 0);
    assert.ok(at(r, "email") >= 0);
    assert.equal(releases(r).length, 0);
  });
}

test("the live AI invite is not capped: it never asks for a credit", async () => {
  const r = await send({ live: true });
  assert.equal(r.result.success, true);
  assert.ok(at(r, "interview_sessions:insert") >= 0);
  assert.equal(r.service.rpcs.length, 0);
});
