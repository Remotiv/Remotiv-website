/**
 * The invitation email and the interview jobs, moved out of the send actions
 * into lib/interviews/invite-delivery.ts (F10 C4) with no change: the same
 * email, the same jobs and the same writes, in the same order, and a failed
 * email still cancels the session on the send path. sendInviteEmail on its own
 * never touches a session (a restart keeps its attempt 2, F10 decision 6).
 *
 *   node --test src/lib/interviews/invite-delivery.test.ts
 *
 * The send actions, the allowance module and the token minting are the shipped
 * code; the company context, the email path and the queue are the fakes of
 * interview-invite-test-hook.mjs; the database is fake-live-db.mjs. Tests a, b
 * and d go through the send actions only, so the same file run against HEAD's
 * interview-actions.ts compares the behaviour before the move. Set
 * INVITE_TRACE_OUT to a path to write every send's normalised trace there, for
 * a byte-for-byte diff between the two. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/interview-invite-test-hook.mjs", import.meta.url));

process.env.NEXT_PUBLIC_SITE_URL = "https://invite-test.example";

const { sendInterviewInvite, sendLiveInterviewInvite } = await import(
  "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts"
);
const { scheduleInterviewJobs, sendInviteEmail } = await import("./invite-delivery.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");
const { withLiveCopies } = await import("../../test-support/question-kinds.mjs");

const NOW = Date.parse("2026-11-02T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = new Date(NOW + 5 * DAY).toISOString();
const DEADLINE = "7 November";
const CO = "c0000000-0000-4000-8000-0000000000c4";
const APP = "a0000000-0000-4000-8000-0000000000c4";
const JOB = "b0000000-0000-4000-8000-0000000000c4";
const OLD = "d0000000-0000-4000-8000-0000000000c4";
const SITE = "https://invite-test.example";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const PROVIDER_FAILED = {
  ok: false,
  kind: "provider",
  message: "The email provider rejected the message.",
  logId: "log-1",
};

/** The open session already sent, for a re-send: async, or live and never joined. */
const oldSession = (kind) => ({
  id: OLD,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind,
  status: "invited",
  token_hash: "0".repeat(64),
  expires_at: new Date(NOW + 2 * DAY).toISOString(),
  created_at: new Date(NOW - DAY).toISOString(),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
});

/** A database, the fakes installed, and every step recorded in order. */
function world({
  sessions = [],
  deliver = () => ({ ok: true, logId: "log-1", providerId: "re_1" }),
} = {}) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: " Candidate@Example.test ",
        job_id: JOB,
        job_title_snapshot: "Test role",
      },
    ],
    jobs: [
      {
        id: JOB,
        company_id: CO,
        title: "Test role",
        allow_rerecord: true,
        async_interview_enabled: true,
      },
    ],
    interview_questions: withLiveCopies([
      {
        id: "q1",
        job_id: JOB,
        company_id: CO,
        position: 1,
        question: "Describe a project you worked on.",
        prep_seconds: 30,
        answer_seconds: 120,
        required: true,
        competency: null,
        rubric: null,
        weight: null,
      },
    ]),
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: "hiring@testco.example" }],
  });
  const steps = [];
  const from = w.service.from.bind(w.service);
  w.service.from = (table) => {
    steps.push({ step: "db", query: w.service.queries.length });
    return from(table);
  };
  w.service.rpc = async (name, args) => {
    steps.push({ step: "rpc", name, args });
    return name === "consume_allowance"
      ? {
          data: [{ allowed: true, unlimited: true, reason: "unlimited", usage_id: "usage-1" }],
          error: null,
        }
      : { data: true, error: null };
  };
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    steps.push({ step: "email", input });
    return deliver(input);
  };
  globalThis.__inviteWhatsAppForTests = async (input) => {
    steps.push({ step: "whatsapp", input });
    return { kind: "queued", logId: "log-1" };
  };
  globalThis.__inviteEnqueueForTests = (job) => {
    steps.push({
      step: "job",
      job: { ...job, runAfter: job.runAfter ? job.runAfter.toISOString() : undefined },
    });
    return { ok: true };
  };
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };
  w.steps = steps;
  return w;
}

/** Each step with its query's calls resolved; writes only, reads named. */
function trace(w) {
  return w.steps.map((s) => {
    if (s.step !== "db") return s;
    const { table, calls } = w.service.queries[s.query];
    const write = calls.find((c) => ["insert", "update", "upsert", "delete"].includes(c[0]));
    return write
      ? {
          step: "write",
          table,
          op: write[0],
          value: write[1],
          filters: calls.filter((c) => c !== write),
        }
      : { step: "read", table };
  });
}

/** The trace with the random token, its hash and the new session's id named instead. */
function normalised(w) {
  const t = trace(w);
  const email = t.find((s) => s.step === "email");
  const insert = t.find(
    (s) => s.step === "write" && s.table === "interview_sessions" && s.op === "insert",
  );
  let text = JSON.stringify(t);
  if (email) {
    const link = email.input.html.match(/href="([^"]+)"/)[1];
    const token = link.slice(`${SITE}/interview/`.length);
    assert.ok(link.startsWith(`${SITE}/interview/`), "the link is the interview link");
    assert.equal(sha256(token), insert.value.token_hash, "the emailed token is the stored hash's");
    text = text.replaceAll(token, "<TOKEN>");
  }
  if (insert) {
    text = text.replaceAll(insert.value.token_hash, "<HASH>");
    if (insert.value.id) text = text.replaceAll(insert.value.id, "<SESSION>");
  }
  return JSON.parse(text);
}

const traces = {};
after(() => {
  if (process.env.INVITE_TRACE_OUT) {
    writeFileSync(process.env.INVITE_TRACE_OUT, `${JSON.stringify(traces, null, 2)}\n`);
  }
});

async function run(name, w, action) {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const orig = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    const result = await action(APP);
    const steps = normalised(w);
    traces[name] = { result, steps };
    return { result, steps };
  } finally {
    Object.assign(console, orig);
    mock.timers.reset();
  }
}

const only = (steps, kind) => steps.filter((s) => s.step === kind);
const writes = (steps) =>
  only(steps, "write")
    .filter((s) => s.table === "interview_sessions")
    .map((s) => [s.op, s.value]);

/** The invite's WhatsApp, queued through the outbox with its row (#52, migration 064). */
const ASYNC_WHATSAPP = {
  applicationId: APP,
  companyId: CO,
  event: "interview",
  sentByName: "Test Member",
  deadline: DEADLINE,
};

const ASYNC_JOBS = (sessionId) => [
  {
    type: "interview_reminder",
    payload: { sessionId, deadline: DEADLINE, expiresAt: EXPIRES },
    companyId: CO,
    runAfter: new Date(NOW + 4 * DAY).toISOString(),
  },
  {
    type: "interview_expiry",
    payload: { sessionId },
    companyId: CO,
    runAfter: EXPIRES,
  },
];

function assertEmail(steps, subject) {
  const [email] = only(steps, "email");
  const { html, ...rest } = email.input;
  assert.deepEqual(rest, {
    companyId: CO,
    applicationId: APP,
    event: "interview",
    to: "candidate@example.test",
    subject,
    companyName: "Test Co",
    replyTo: "hiring@testco.example",
    sentByName: "Test Member",
    // #87: the sender's member, so their own failure does not bell them.
    actorMemberId: "m-1",
  });
  assert.match(html, /^<p>Hi Test,<\/p>\n/);
  assert.ok(
    html.includes(
      `<a href="${SITE}/interview/<TOKEN>" style="color:#7E47FF;font-weight:700">Start your interview</a>`,
    ),
  );
  assert.ok(html.includes(`<strong>${DEADLINE}</strong>`));
  return html;
}

// ── a: today's send and re-send ─────────────────────────────

test("a: the async send and re-send: same email, same jobs, same writes, same result", async () => {
  for (const [name, sessions] of [
    ["async send", []],
    ["async re-send", [oldSession("async")]],
  ]) {
    const w = world({ sessions });
    const { result, steps } = await run(name, w, sendInterviewInvite);
    assert.deepEqual(result, { success: true, data: { expiresAt: EXPIRES } }, name);
    const html = assertEmail(steps, "Your video interview for Test role at Test Co");
    assert.ok(html.includes("There's a practice round first, and it isn't recorded."));
    assert.deepEqual(
      only(steps, "job").map((s) => s.job),
      ASYNC_JOBS("<SESSION>"),
      name,
    );
    const expectedWrites = [
      ...(sessions.length ? [["update", { status: "cancelled" }]] : []),
      ["insert", writes(steps).at(-1)[1]],
    ];
    assert.deepEqual(writes(steps), expectedWrites, name);
    assert.equal(writes(steps).at(-1)[1].kind, "async");
    assert.deepEqual(
      only(steps, "whatsapp").map((s) => s.input),
      [ASYNC_WHATSAPP],
      name,
    );
    // Order: the session row, then the email, then WhatsApp, the reminder and the expiry.
    assert.deepEqual(
      steps
        .filter((s) => ["write", "email", "whatsapp", "job"].includes(s.step))
        .map((s) => s.step)
        .slice(-4),
      ["email", "whatsapp", "job", "job"],
    );
    assert.deepEqual(
      only(steps, "rpc").map((s) => s.name),
      ["consume_allowance"],
    );
  }
});

test("a: the live send and re-send of an invite nobody joined: same email, the expiry only, same result", async () => {
  for (const [name, sessions] of [
    ["live send", []],
    ["live re-send", [oldSession("live")]],
  ]) {
    const w = world({ sessions });
    const { result, steps } = await run(name, w, sendLiveInterviewInvite);
    assert.deepEqual(result, { success: true, data: { expiresAt: EXPIRES } }, name);
    const html = assertEmail(steps, "Your AI Video Interview for Test role at Test Co");
    assert.ok(html.includes("Have your camera and microphone ready."));
    const jobs = only(steps, "job").map((s) => s.job);
    assert.deepEqual(
      jobs.map(({ payload, ...j }) => j),
      [{ type: "interview_expiry", companyId: CO, runAfter: EXPIRES }],
      name,
    );
    assert.deepEqual(
      writes(steps).map(([op]) => op),
      sessions.length ? ["update", "insert"] : ["insert"],
    );
    assert.equal(writes(steps).at(-1)[1].kind, "live");
    assert.deepEqual(only(steps, "rpc"), [], "the live invite is not capped");
  }
});

// ── b: a failed email on today's path ───────────────────────

test("b: a failed email cancels the new session exactly as before, and nothing is scheduled", async () => {
  for (const [name, action, sessions] of [
    ["async send, email fails", sendInterviewInvite, []],
    ["async re-send, email fails", sendInterviewInvite, [oldSession("async")]],
    ["live send, email fails", sendLiveInterviewInvite, []],
    ["live re-send, email fails", sendLiveInterviewInvite, [oldSession("live")]],
  ]) {
    const w = world({ sessions, deliver: () => PROVIDER_FAILED });
    const { result, steps } = await run(name, w, action);
    assert.deepEqual(
      result,
      { success: false, error: "The email couldn't be sent - please try again." },
      name,
    );
    const cancel = only(steps, "write").at(-1);
    // The async send supplies its id (normalised to <SESSION>); fake-live-db gives the
    // live insert none, so its cancel filters on that missing id, before and after the move.
    const newId = action === sendInterviewInvite ? "<SESSION>" : null;
    assert.deepEqual(
      [cancel.table, cancel.op, cancel.value, cancel.filters],
      ["interview_sessions", "update", { status: "cancelled" }, [["eq", "id", newId]]],
      `${name}: the cancel, by id only, as before`,
    );
    const after = steps.slice(steps.findIndex((s) => s.step === "email") + 1);
    assert.equal(
      after.find((s) => s.step === "write"),
      cancel,
      "the cancel comes straight after the email",
    );
    // Landed for the async session; the live row has no id in this fake, so its cancel
    // matches nothing here (in the database the insert returns the id it filters on).
    if (action === sendInterviewInvite) {
      assert.equal(w.tables.interview_sessions.at(-1).status, "cancelled", name);
    }
    assert.deepEqual(only(steps, "job"), [], "nothing scheduled");
    if (action === sendInterviewInvite) {
      assert.deepEqual(
        only(steps, "rpc").map((s) => s.name),
        ["consume_allowance", "release_allowance"],
        "the credit given back",
      );
    }
  }
});

// ── c: the email alone ──────────────────────────────────────

const emailInput = (over = {}) => ({
  ctx: { companyId: CO, memberName: "Test Member" },
  applicationId: APP,
  app: {
    id: APP,
    first_name: "Test",
    last_name: "Candidate",
    email: "candidate@example.test",
    job_id: JOB,
    job_title_snapshot: "Test role",
  },
  rawToken: "synthetic-token",
  expiresAt: EXPIRES,
  copy: (link, deadline) => ({
    subject: "Subject {{job_title}}",
    body: `<p>${link} ${deadline}</p>`,
  }),
  ...over,
});

test("c: sendInviteEmail on a failure returns ok:false with deliverEmail's code, and touches no session", async () => {
  for (const kind of ["provider", "cap", "duplicate", "not_configured", "log"]) {
    const w = world({
      sessions: [oldSession("live")],
      deliver: () => ({ ...PROVIDER_FAILED, kind, message: `msg-${kind}` }),
    });
    const before = structuredClone(w.tables.interview_sessions);
    const result = await sendInviteEmail(w.service, emailInput());
    assert.deepEqual(result, {
      ok: false,
      code: kind,
      message:
        kind === "provider" ? "The email couldn't be sent - please try again." : `msg-${kind}`,
    });
    assert.deepEqual(w.tables.interview_sessions, before, "the session untouched");
    assert.deepEqual(
      w.service.queries.map((q) => [q.table, q.calls[0][0]]),
      [["companies", "select"]],
      "only the company read",
    );
  }
  const ok = world();
  assert.deepEqual(await sendInviteEmail(ok.service, emailInput()), {
    ok: true,
    deadline: DEADLINE,
  });
  const [{ input }] = only(ok.steps, "email");
  assert.equal(input.subject, "Subject Test role");
  assert.equal(input.html, `<p>${SITE}/interview/synthetic-token ${DEADLINE}</p>`);
  assert.ok(!ok.service.queries.some((q) => q.table === "interview_sessions"));
});

// ── d: the jobs for a given session ─────────────────────────

test("d: scheduleInterviewJobs for any session id queues the same jobs the send actions queue", async () => {
  const sent = world();
  const { steps } = await run("async send for d", sent, sendInterviewInvite);
  // Every job the send queues is the reminder and the expiry: its WhatsApp goes
  // through the outbox, not the queue (#52).
  const byAction = only(steps, "job").map((s) => s.job);
  const live = world();
  const liveSteps = (await run("live send for d", live, sendLiveInterviewInvite)).steps;
  const liveByAction = only(liveSteps, "job").map((s) => s.job);

  for (const [reminder, expected] of [
    [true, byAction],
    [false, liveByAction],
  ]) {
    const w = world();
    mock.timers.enable({ apis: ["Date"], now: NOW });
    try {
      await scheduleInterviewJobs({
        sessionId: "<SESSION>",
        companyId: CO,
        expiresAt: EXPIRES,
        expiresAtMs: NOW + 5 * DAY,
        deadline: DEADLINE,
        reminder,
      });
    } finally {
      mock.timers.reset();
    }
    const jobs = only(w.steps, "job").map((s) => s.job);
    assert.deepEqual(
      jobs.map((j) => ({ ...j, payload: { ...j.payload, sessionId: "<SESSION>" } })),
      expected.map((j) => ({ ...j, payload: { ...j.payload, sessionId: "<SESSION>" } })),
      `reminder ${reminder}`,
    );
  }
  // Any session id: a restart's attempt 2 gets the same jobs, carrying its own id.
  const attempt2 = world();
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    await scheduleInterviewJobs({
      sessionId: "attempt-2",
      companyId: CO,
      expiresAt: EXPIRES,
      expiresAtMs: NOW + 5 * DAY,
      deadline: DEADLINE,
      reminder: false,
    });
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(
    only(attempt2.steps, "job").map((s) => s.job),
    [
      {
        type: "interview_expiry",
        payload: { sessionId: "attempt-2" },
        companyId: CO,
        runAfter: EXPIRES,
      },
    ],
  );
});

// ── e: a second send inside a minute is refused (#52) ───────

test("e: an open session sent 10 s ago: the second send is refused as 'just sent'; no cancel, no email, no WhatsApp, no jobs", async () => {
  for (const [kind, action] of [
    ["async", sendInterviewInvite],
    ["live", sendLiveInterviewInvite],
  ]) {
    const w = world({
      sessions: [{ ...oldSession(kind), created_at: new Date(NOW - 10_000).toISOString() }],
    });
    const { result, steps } = await run(`${kind} within a minute`, w, action);
    // The live send carries the supersede's `code` key (undefined here), so compare the two fields.
    assert.deepEqual(
      { success: result.success, error: result.error },
      {
        success: false,
        error: "An invite was just sent to this person. Wait a minute before sending it again.",
      },
      kind,
    );
    assert.deepEqual(writes(steps), [], `${kind}: nothing cancelled, nothing inserted`);
    assert.equal(only(steps, "email").length, 0, `${kind}: no email`);
    assert.equal(only(steps, "whatsapp").length, 0, `${kind}: no WhatsApp`);
    assert.equal(only(steps, "job").length, 0, `${kind}: no jobs`);
  }
});

test("e: the same open session sent 61 s ago is superseded and re-sent as before", async () => {
  const w = world({
    sessions: [{ ...oldSession("async"), created_at: new Date(NOW - 61_000).toISOString() }],
  });
  const { result, steps } = await run("async after a minute", w, sendInterviewInvite);
  assert.equal(result.success, true);
  assert.deepEqual(writes(steps)[0], ["update", { status: "cancelled" }]);
  assert.equal(only(steps, "whatsapp").length, 1);
});
