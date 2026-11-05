/**
 * The email provider's own text never leaves the interview send paths (error
 * hardening, item 1). A provider failure, whose text can name an address or a
 * key, reads "The email couldn't be sent - please try again." on the async
 * send, the live send and a restart's re-send, and is in no log line. The other
 * reasons keep deliverEmail's own sentences. Every reason still drives what it
 * drove: the send actions cancel the new session and give the credit back, a
 * restart cancels nothing.
 *
 *   node --test src/lib/interviews/invite-email-failures.test.ts
 *
 * The send actions, sendInviteEmail, deliverInvite and the restart flow are the
 * shipped code; the company context, deliverEmail and the queue are the fakes of
 * interview-invite-test-hook.mjs; the database is fake-live-db.mjs. Synthetic
 * data only: the "key" below is not one.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(new URL("../../test-support/interview-invite-test-hook.mjs", import.meta.url));
// Over the hook's: live-review.ts, behind the restart flow, needs the whole module.
register(
  `data:text/javascript,${encodeURIComponent(`
const SCOPE = [
  "export async function canAccessJob() { return true; }",
  "export async function getJobScope() { return { scoped: false, jobIds: [] }; }",
  "export function isEmptyScope() { return false; }",
  "export function scopeJobIds() { return null; }",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@/app/ai-dashboard/lib/job-scope") {
    return { url: "data:text/javascript," + encodeURIComponent(SCOPE), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { sendInterviewInvite, sendLiveInterviewInvite } = await import(
  "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts"
);
const { sendInviteEmail } = await import("./invite-delivery.ts");
const { resendRestartLink } = await import("./live-restart-flow.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const CO = "c0000000-0000-4000-8000-0000000000e1";
const APP = "a0000000-0000-4000-8000-0000000000e1";
const JOB = "b0000000-0000-4000-8000-0000000000e1";
const FIRST = "d0000000-0000-4000-8000-0000000000e1";
const SECOND = "d0000000-0000-4000-8000-0000000000e2";
const CANDIDATE = "candidate.e1@example.test";
const FRIENDLY = "The email couldn't be sent - please try again.";

// What a provider can say: an address, something shaped like a key, its own wording.
const RAW_ADDRESS = "someone.else@example.test";
const RAW_KEY = "re_SyntheticNotARealKey_0123456789";
const RAW = `Invalid \`to\` field: ${RAW_ADDRESS}. API key ${RAW_KEY} is not allowed to send.`;
const provider = (message = RAW) => ({ ok: false, kind: "provider", message, logId: "log-1" });
const ACCEPTED = { ok: true, logId: "log-1", providerId: "re_1" };

const iso = (ms) => new Date(ms).toISOString();
const baseSession = (over = {}) => ({
  id: FIRST,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind: "live",
  attempt: 1,
  previous_attempt_id: null,
  status: "invited",
  token_hash: "1".repeat(64),
  expires_at: iso(NOW + 2 * DAY),
  delete_after: iso(NOW + 180 * DAY),
  created_at: iso(NOW - 3 * DAY),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
  ...over,
});
/** A restarted interview: attempt 1 abandoned, attempt 2 invited. */
const restarted = () => [
  baseSession({
    status: "abandoned",
    started_at: iso(NOW - 2 * DAY),
    provider_session_id: "provider-1",
    live_ended_at: iso(NOW - 2 * DAY + 600_000),
    live_outcome: { outcome: "technical_failure", final: true },
  }),
  baseSession({ id: SECOND, attempt: 2, previous_attempt_id: FIRST, token_hash: "2".repeat(64) }),
];

function world({ sessions = [], deliver = () => ACCEPTED } = {}) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: CANDIDATE,
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
    interview_questions: [
      {
        id: "q1",
        job_id: JOB,
        company_id: CO,
        position: 1,
        question: "Describe a project you worked on.",
        prep_seconds: 30,
        answer_seconds: 120,
        required: true,
      },
    ],
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.rpcNames = [];
  w.emails = 0;
  w.jobs = [];
  w.service.rpc = async (name, args) => {
    w.rpcNames.push(name);
    if (name === "consume_allowance") {
      return {
        data: [{ allowed: true, unlimited: true, reason: "unlimited", usage_id: "usage-1" }],
        error: null,
      };
    }
    if (name === "live_restart_extend_deadline") {
      const deadline = iso(NOW + 3 * DAY);
      const row = w.tables.interview_sessions.find((s) => s.id === args.p_session_id);
      row.expires_at = deadline;
      return { data: deadline, error: null };
    }
    return { data: true, error: null };
  };
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = {
    companyId: CO,
    memberId: "m-1",
    memberName: "Test Member",
    role: "owner",
    user: { id: "u-1" },
  };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails += 1;
    return deliver(input);
  };
  globalThis.__inviteEnqueueForTests = (job) => {
    w.jobs.push(job.type);
    return { ok: true };
  };
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };
  return w;
}

/** A function's answer and every log line written while it ran. */
async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log =
    console.warn =
    console.error =
      (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** None of the provider's text, in whole or in part, in the answer or any log line. */
function assertNoProviderText({ result, lines }, name) {
  const text = `${JSON.stringify(result)}\n${lines.join("\n")}`;
  for (const piece of [RAW, RAW_ADDRESS, RAW_KEY, "Invalid", "API key", "not allowed to send"]) {
    assert.ok(!text.includes(piece), `${name}: ${piece}`);
  }
}

const statusOf = (w, id) => w.tables.interview_sessions.find((s) => s.id === id)?.status;
const newSession = (w) => w.tables.interview_sessions.at(-1);
const owner = () => globalThis.__inviteCtxForTests;
const SENDS = [
  ["the async send", sendInterviewInvite, "async"],
  ["the live send", sendLiveInterviewInvite, "live"],
];

test("async and live send: a provider failure is the friendly sentence, one code-only line, the session cancelled", async () => {
  for (const [name, action, kind] of SENDS) {
    const w = world({ deliver: () => provider() });
    const out = await captured(() => action(APP));
    assert.deepEqual(out.result, { success: false, error: FRIENDLY }, name);
    assertNoProviderText(out, name);
    const logged = out.lines.filter((l) => l.includes("invite email not sent"));
    assert.equal(logged.length, 1, `${name}: one line`);
    assert.match(
      logged[0],
      /^\[interview\] session \S+: invite email not sent \(provider\)$/,
      name,
    );
    assert.equal(w.emails, 1, name);
    assert.deepEqual(w.jobs, [], `${name}: nothing scheduled`);
    // The async send supplies its id; fake-live-db gives the live insert none, so
    // the cancel is asserted by its write there (as invite-delivery.test.ts does).
    const cancel = w.service.queries.filter(
      (q) =>
        q.table === "interview_sessions" &&
        q.calls.some((c) => c[0] === "update" && c[1].status === "cancelled"),
    );
    assert.equal(cancel.length, 1, `${name}: the new session is cancelled`);
    if (kind === "async") {
      assert.equal(newSession(w).status, "cancelled", name);
      assert.deepEqual(
        w.rpcNames,
        ["consume_allowance", "release_allowance"],
        "the credit given back",
      );
    }
  }
});

test("restart re-send: a provider failure reads as email_failed, nothing of the provider's, nothing cancelled", async () => {
  const w = world({ sessions: restarted(), deliver: () => provider() });
  const before = statusOf(w, SECOND);
  const out = await captured(() => resendRestartLink(owner(), SECOND, { service: w.service }));
  assert.deepEqual(out.result, {
    ok: true,
    restartSessionId: SECOND,
    emailFailed: true,
    code: "email_failed",
  });
  assertNoProviderText(out, "restart");
  assert.equal(w.emails, 1, "the email was attempted");
  assert.equal(before, "invited");
  assert.equal(statusOf(w, SECOND), "invited", "never cancelled");
  assert.equal(statusOf(w, FIRST), "abandoned");
  assert.ok(
    !w.service.queries.some(
      (q) =>
        q.table === "interview_sessions" &&
        q.calls.some((c) => c[0] === "update" && c[1].status === "cancelled"),
    ),
    "no cancel at all",
  );
  assert.deepEqual(w.jobs, [], "nothing scheduled");
  // The flow's own lines, by code; deliverInvite's line is the send actions' only.
  assert.ok(out.lines.some((l) => l.endsWith("email not delivered (provider)")));
  assert.ok(!out.lines.some((l) => l.includes("invite email not sent")));
  const events = w.service.queries
    .filter((q) => q.table === "live_restart_link_events")
    .map((q) => q.calls.find((c) => c[0] === "insert")[1].event);
  assert.deepEqual(events, ["reissued", "failed"], "the link record is unchanged");
});

test("sendInviteEmail itself never returns the provider's text; the code is kept", async () => {
  const w = world({ deliver: () => provider() });
  const result = await sendInviteEmail(w.service, {
    ctx: { companyId: CO, memberName: "Test Member" },
    applicationId: APP,
    app: { id: APP, first_name: "T", last_name: "C", email: CANDIDATE, job_id: JOB },
    rawToken: "synthetic-token",
    expiresAt: iso(NOW + DAY),
    copy: () => ({ subject: "s", body: "b" }),
  });
  assert.deepEqual(result, { ok: false, code: "provider", message: FRIENDLY });
});

test("every code drives what it drove: deliverEmail's own sentences kept, the session cancelled, the credit back", async () => {
  const OWN = {
    cap: "Remotiv's daily email limit of 100 has been reached.",
    duplicate: "This candidate has already been sent this message.",
    not_configured: "Email isn't configured on this environment.",
    log: "The message couldn't be recorded, so it wasn't sent.",
  };
  for (const [code, sentence] of Object.entries(OWN)) {
    for (const [name, action, kind] of SENDS) {
      const w = world({
        deliver: () => ({ ok: false, kind: code, message: sentence, logId: null }),
      });
      const out = await captured(() => action(APP));
      assert.deepEqual(out.result, { success: false, error: sentence }, `${name} ${code}`);
      assert.ok(
        out.lines.some((l) => l.endsWith(`invite email not sent (${code})`)),
        `${name} ${code}: the code logged`,
      );
      if (kind === "async") {
        assert.equal(newSession(w).status, "cancelled", code);
        assert.ok(w.rpcNames.includes("release_allowance"), code);
      }
    }
    const r = world({
      sessions: restarted(),
      deliver: () => ({ ok: false, kind: code, message: sentence, logId: null }),
    });
    const out = await captured(() => resendRestartLink(owner(), SECOND, { service: r.service }));
    assert.equal(out.result.code, "email_failed", `restart ${code}`);
    assert.ok(!JSON.stringify(out.result).includes(sentence), `restart ${code}: codes only`);
    assert.equal(statusOf(r, SECOND), "invited", `restart ${code}`);
  }
});

test("a reason deliverEmail may add later is not shown: only the listed reasons keep their words", async () => {
  for (const [name, action] of SENDS) {
    world({ deliver: () => ({ ok: false, kind: "future_reason", message: RAW, logId: null }) });
    const out = await captured(() => action(APP));
    assert.deepEqual(out.result, { success: false, error: FRIENDLY }, name);
    assertNoProviderText(out, name);
  }
});

test("success is unchanged on all three flows, with no failure line", async () => {
  for (const [name, action, kind] of SENDS) {
    const w = world();
    const out = await captured(() => action(APP));
    assert.equal(out.result.success, true, name);
    assert.deepEqual(Object.keys(out.result.data), ["expiresAt"], name);
    assert.ok(!out.lines.some((l) => l.includes("invite email not sent")), name);
    assert.ok(w.jobs.includes("interview_expiry"), `${name}: the expiry scheduled`);
    if (kind === "async") assert.ok(!w.rpcNames.includes("release_allowance"), name);
  }
  const r = world({ sessions: restarted() });
  const out = await captured(() => resendRestartLink(owner(), SECOND, { service: r.service }));
  assert.equal(out.result.ok, true);
  assert.equal(out.result.emailFailed, false);
  assert.equal(statusOf(r, SECOND), "invited");
});
