/**
 * The restart decision on the live review page and its link (F10 C5,
 * live-restart-flow.ts): the gates, no restart, restart with the email, the
 * 72-hour deadline after delivery, a failed email that cancels nothing, the
 * re-send of the same attempt 2, the expiry scheduled once, and the panel the
 * page shows for each state. F10-LOG (migration 055): the link's record
 * written as the gated actor between C5's steps, and the status the page reads
 * from it (tests "F10-LOG a" to "F10-LOG f"). F10 C7: the approved copy, the
 * email's exact UTC deadline, the decider's role named, the viewer's own time
 * on the dashboard (never UTC), and no em or en dash (tests "C7 ...").
 *
 *   node --test src/lib/interviews/live-restart-flow.test.ts
 *
 * The flow, live-restart.ts, invite-delivery.ts (sendInviteEmail and
 * scheduleInterviewJobs) and the review gate are the shipped code. The email
 * provider and the queue are stubbed below; the database is this file's own
 * small store, with migration 053's two functions written out from the SQL
 * (fake-live-db.mjs predates 053). Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { throw new Error('test: pass a scope'); }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
  ].join("\\n"),
  "@/lib/email/candidate/deliver": [
    "export function buildCandidateHtml(body) { return body; }",
    "export async function deliverEmail(service, input) { return globalThis.__restartDeliver(input); }",
  ].join("\\n"),
  "@/lib/jobs-queue": [
    "export const JOB_TYPES = { SEND_MESSAGE: 'send_message', INTERVIEW_REMINDER: 'interview_reminder', INTERVIEW_EXPIRY: 'interview_expiry' };",
    "export async function enqueue(job) { return globalThis.__restartEnqueue(job); }",
  ].join("\\n"),
  "@/lib/interviews/reminder": "export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;",
  "@/app/admin/lib/role-guards": "export async function requireSuperAdmin() { throw new Error('test'); }",
  "next/navigation": "export function useRouter() { return { refresh() {} }; } export function notFound() { throw new Error('NEXT_NOT_FOUND'); }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
  "../live-actions": "export async function getLiveTurnAudioUrl() { return { ok: false, error: 'test' }; } export async function runLiveReviewAction() { return { ok: true }; } export async function getLiveVideoPieceUrl() { return { ok: false, error: 'test' }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;
const { decideRestart, resendRestartLink } = await import("./live-restart-flow.ts");
const { sendInviteEmail, scheduleInterviewJobs } = await import("./invite-delivery.ts");
const { restartPanelFor } = await import("./live-review-types.ts");
const { canActOnLiveReview, loadLiveReview } = await import("./live-review.ts");
const { LiveReviewClient, restartSendText } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client.tsx"
);
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** The email's deadline wording for an instant: "6 November 2026 at 12:00 UTC". */
const emailDeadline = (ms) => {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${date} at ${time} UTC`;
};
/**
 * Page markup as text. Each time is the viewer's, filled in on the client
 * (LocalTime): the server markup carries only its instant, shown here as [iso].
 */
const textOf = (html) =>
  html
    .replace(/<time dateTime="([^"]+)"[^>]*><\/time>/g, "[$1]")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'");
const at = (ms) => `[${iso(ms)}]`;

const CO = "7aad434d-0000-4000-8000-0000000000c5";
const OTHER_CO = "7aad434d-0000-4000-8000-0000000000c6";
const JOB = "2d4a8cde-0000-4000-8000-0000000000c5";
const OTHER_JOB = "2d4a8cde-0000-4000-8000-0000000000c6";
const APP = "03e4863f-0000-4000-8000-0000000000c5";
const FIRST = "5b0f2c1e-0000-4000-8000-0000000000c5";
const SECOND = "5b0f2c1e-0000-4000-8000-0000000000c6";
const NOTE = "Synthetic note: the call dropped on the candidate's side.";
const CANDIDATE_EMAIL = "candidate.c5@example.test";
const MEMBER_NAME = "Synthetic Owner";

function firstAttempt(over = {}) {
  return {
    id: FIRST,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "live",
    attempt: 1,
    previous_attempt_id: null,
    status: "started",
    token_hash: "1".repeat(64),
    live_ended_at: iso(NOW - 2 * HOUR),
    live_outcome: { v: 6, outcome: "technical_failure", final: true },
    live_settings: { v: 2 },
    questions_snapshot: [{ position: 1 }],
    scoring_snapshot: [{ position: 1 }],
    expires_at: iso(NOW + 24 * HOUR),
    delete_after: iso(NOW + 180 * 24 * HOUR),
    created_at: iso(NOW - 48 * HOUR),
    ...over,
  };
}

const secondAttempt = (over = {}) => ({
  ...firstAttempt(),
  id: SECOND,
  attempt: 2,
  previous_attempt_id: FIRST,
  status: "invited",
  token_hash: "2".repeat(64),
  live_ended_at: null,
  live_outcome: null,
  expires_at: iso(NOW + 60 * HOUR),
  created_at: iso(NOW - HOUR),
  ...over,
});

const ctx = (role, over = {}) => ({
  user: { id: "u0000000-0000-4000-8000-0000000000c5", email: "owner@example.test" },
  companyId: CO,
  role,
  memberName: MEMBER_NAME,
  memberId: "m0000000-0000-4000-8000-0000000000c5",
  ...over,
});

const err = (code, message) => ({ code, message });

/** 053's decision trigger, in its order (see live-restart.test.ts). */
function decisionRefusal(tables, s, dbNow) {
  if (s.kind !== "live" || s.attempt !== 1) return err("23514", "first attempt");
  if (s.status !== "started") return err("23514", "not started");
  if (!s.live_ended_at) return err("23514", "no end");
  if (s.live_outcome === null) {
    if (Date.parse(s.live_ended_at) > dbNow - HOUR) return err("23514", "too soon");
  } else if (String(s.live_outcome.final) !== "true") return err("23514", "not final");
  else if (
    !["ending_unconfirmed", "technical_failure", "abandoned"].includes(s.live_outcome.outcome)
  )
    return err("23514", "never restarted");
  if (
    tables.live_interview_actions.some(
      (a) => a.session_id === s.id && a.action === "decide_restart",
    )
  )
    return err("23505", "already decided");
  return null;
}

/**
 * The store: tables with eq/in/is/gt/gte/contains/order/limit/maybeSingle,
 * insert, update, and 053's functions. live_restart_link_events stamps each
 * row as 055's trigger does, one tick apart (each insert is its own
 * transaction); `events` makes its inserts fail ("error" or "throw"), all of
 * them or, as { sent: "error" }, one kind only.
 */
function world({
  sessions = [firstAttempt()],
  jobs = [],
  dbClockMs = 0,
  emailOk = true,
  events = "ok",
  linkEvents = [],
} = {}) {
  const tables = {
    interview_sessions: structuredClone(sessions),
    live_interview_actions: [],
    live_restart_link_events: structuredClone(linkEvents),
    live_interview_scores: [],
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Synthetic",
        email: CANDIDATE_EMAIL,
        job_id: JOB,
        job_title_snapshot: "Synthetic role",
      },
    ],
    background_jobs: structuredClone(jobs),
    communication_logs: [],
    companies: [{ id: CO, name: "Synthetic Co", candidate_reply_email: null }],
  };
  const steps = [];
  // The database's clock: NOW (shifted by dbClockMs) unless a test sets it.
  let dbAt = null;
  const dbNow = () => dbAt ?? NOW + dbClockMs;
  let extendFailures = 0;
  let extendSkips = 0;
  let eventTick = 0;
  const RPC = {
    live_restart_session(a) {
      const prev = tables.interview_sessions.find(
        (s) => s.id === a.p_session_id && s.company_id === a.p_company_id,
      );
      if (!prev) return { data: null, error: err("P0002", "not found") };
      const refusal = decisionRefusal(tables, prev, dbNow());
      if (refusal) return { data: null, error: refusal };
      const deadline = Math.max(Date.parse(prev.expires_at), dbNow() + 72 * HOUR);
      if (deadline >= Date.parse(prev.delete_after))
        return { data: null, error: err("23514", "retention") };
      tables.live_interview_actions.push({
        session_id: prev.id,
        company_id: prev.company_id,
        action: "decide_restart",
        decision: "restart",
        note: a.p_note,
        actor_user_id: a.p_actor_user_id,
        actor_name: a.p_actor_name,
        actor_role: a.p_actor_role,
        created_at: iso(dbNow()),
      });
      prev.status = "abandoned";
      tables.interview_sessions.push({
        ...structuredClone(prev),
        id: a.p_new_session_id,
        token_hash: a.p_token_hash,
        status: "invited",
        attempt: 2,
        previous_attempt_id: prev.id,
        live_ended_at: null,
        live_outcome: null,
        expires_at: iso(deadline),
        created_at: iso(dbNow()),
        invited_by: a.p_invited_by,
      });
      return { data: iso(deadline), error: null };
    },
    live_restart_extend_deadline(a) {
      if (extendSkips > 0) extendSkips -= 1;
      else if (extendFailures > 0) {
        extendFailures -= 1;
        return { data: null, error: err("XX000", "RAW-SQL-DETAIL extension failed") };
      }
      const s = tables.interview_sessions.find(
        (x) => x.id === a.p_session_id && x.company_id === a.p_company_id,
      );
      if (s?.attempt !== 2) return { data: null, error: err("P0002", "no restart") };
      if (s.status !== "invited") return { data: null, error: err("23514", "not invited") };
      const deadline = Math.max(Date.parse(s.expires_at), dbNow() + 72 * HOUR);
      if (deadline >= Date.parse(s.delete_after))
        return { data: null, error: err("23514", "retention") };
      s.expires_at = iso(deadline);
      return { data: iso(deadline), error: null };
    },
  };
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) {
      const name = table.slice(4);
      steps.push({ step: "rpc", name });
      return RPC[name](calls[0][1]);
    }
    const rows = tables[table] ?? [];
    const match = (r) =>
      calls.every((c) => {
        if (c[0] === "eq") return r[c[1]] === c[2];
        if (c[0] === "in") return c[2].includes(r[c[1]]);
        if (c[0] === "is") return (r[c[1]] ?? null) === c[2];
        if (c[0] === "gt") return r[c[1]] != null && r[c[1]] > c[2];
        if (c[0] === "gte") return r[c[1]] != null && r[c[1]] >= c[2];
        if (c[0] === "contains") return Object.entries(c[2]).every(([k, v]) => r[c[1]]?.[k] === v);
        return true;
      });
    const insert = calls.find((c) => c[0] === "insert");
    const update = calls.find((c) => c[0] === "update");
    if (insert) {
      const row = structuredClone(insert[1]);
      const isEvent = table === "live_restart_link_events";
      steps.push({ step: "insert", table, ...(isEvent && { name: `event:${row.event}` }) });
      if (isEvent) {
        const mode = typeof events === "string" ? events : (events[row.event] ?? "ok");
        if (mode === "throw") throw new Error("RAW-SQL-DETAIL connection reset");
        if (mode === "error") return { data: null, error: err("XX000", "RAW-SQL-DETAIL") };
        eventTick += 1;
        row.created_at = iso(dbNow() + eventTick);
      }
      if (table === "live_interview_actions") {
        const s = tables.interview_sessions.find((x) => x.id === row.session_id);
        const refusal = decisionRefusal(tables, s, dbNow());
        if (refusal) return { data: null, error: refusal };
        row.created_at = iso(dbNow());
      }
      rows.push(row);
      return { data: null, error: null };
    }
    const hit = rows.filter(match);
    if (update) {
      steps.push({ step: "update", table, value: update[1] });
      for (const r of hit) Object.assign(r, structuredClone(update[1]));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (calls.some((c) => c[0] === "maybeSingle")) {
      return { data: hit[0] ? structuredClone(hit[0]) : null, error: null };
    }
    const order = calls.find((c) => c[0] === "order");
    if (order) {
      const dir = order[2]?.ascending === false ? -1 : 1;
      hit.sort((a, b) => dir * String(a[order[1]]).localeCompare(String(b[order[1]])));
    }
    const limit = calls.find((c) => c[0] === "limit");
    return { data: structuredClone(limit ? hit.slice(0, limit[1]) : hit), error: null };
  });
  const emails = [];
  globalThis.__restartDeliver = (input) => {
    steps.push({ step: "email" });
    emails.push(input);
    tables.communication_logs.push({
      company_id: input.companyId,
      application_id: input.applicationId,
      event: input.event,
      channel: "email",
      status: emailOk ? "sent" : "failed",
      created_at: iso(NOW),
    });
    return emailOk
      ? { ok: true, logId: "log", providerId: "re" }
      : { ok: false, kind: "provider", message: "rejected", logId: "log" };
  };
  globalThis.__restartEnqueue = (job) => {
    steps.push({ step: "job" });
    tables.background_jobs.push({
      id: crypto.randomUUID(),
      type: job.type,
      payload: job.payload,
      company_id: job.companyId,
      status: "queued",
      run_after: job.runAfter?.toISOString() ?? null,
    });
    return { ok: true, id: "job" };
  };
  const scope = { scoped: false, jobIds: [] };
  return {
    tables,
    service,
    steps,
    emails,
    scope,
    setEmailOk: (v) => {
      emailOk = v;
    },
    setDbNow: (ms) => {
      dbAt = ms;
    },
    /** The next `n` extensions fail, after `skip` that succeed. */
    failExtend: (n = 1, skip = 0) => {
      extendFailures = n;
      extendSkips = skip;
    },
  };
}

const deps = (w, over = {}) => ({
  service: w.service,
  scope: async () => w.scope,
  now: () => NOW,
  ...over,
});

async function captured(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}
const quiet = async (fn) => (await captured(fn)).result;

const decide = (w, over = {}, viewer = ctx("owner")) =>
  quiet(() =>
    decideRestart(viewer, { sessionId: FIRST, decision: "restart", note: NOTE, ...over }, deps(w)),
  );
const resend = (w, id = SECOND, viewer = ctx("owner"), d = {}) =>
  quiet(() => resendRestartLink(viewer, id, deps(w, d)));

const writes = (w) =>
  w.steps.filter((s) => ["insert", "update", "rpc", "email", "job"].includes(s.step));
const expiryJobs = (w, id) =>
  w.tables.background_jobs.filter(
    (j) => j.type === "interview_expiry" && j.payload.sessionId === id,
  );
const restartRow = (w) => w.tables.interview_sessions.find((x) => x.attempt === 2);
/** sendInviteEmail, recording what each email quoted and what the database held then. */
const spyEmail =
  (quoted, w, during = () => {}) =>
  (service, input) => {
    quoted.push({ emailed: input.expiresAt, held: restartRow(w).expires_at });
    during();
    return sendInviteEmail(service, input);
  };
const gateReadOnly = (w) => w.service.queries.map((q) => q.table);
const tokenOf = (email) => email.html.match(/\/interview\/([A-Za-z0-9_-]+)/)[1];

// ── a, b: gates ─────────────────────────────────────────────

test("a: another company, off the hiring team, recruiter, hiring manager and super admin are refused before any write", async () => {
  const cases = [
    ["other company", ctx("owner", { companyId: OTHER_CO }), null, "not_found"],
    ["not on the hiring team", ctx("admin"), { scoped: true, jobIds: [OTHER_JOB] }, "not_found"],
    ["recruiter", ctx("recruiter"), { scoped: true, jobIds: [JOB] }, "role_not_allowed"],
    ["hiring manager", ctx("hiring_manager"), { scoped: true, jobIds: [JOB] }, "role_not_allowed"],
    ["super admin", ctx("super_admin"), null, "role_not_allowed"],
  ];
  for (const [name, viewer, scope, code] of cases) {
    for (const decision of ["restart", "no_restart"]) {
      const w = world();
      if (scope) w.scope = scope;
      assert.deepEqual(
        await decide(w, { decision }, viewer),
        { ok: false, code },
        `${name} ${decision}`,
      );
      assert.deepEqual(writes(w), [], `${name}: nothing written, sent or called`);
      // Refused at this flow's own gate: the review gate's one read, nothing after it.
      assert.deepEqual(gateReadOnly(w), ["interview_sessions"], `${name}: stopped at the gate`);
    }
    const r = world({ sessions: [firstAttempt({ status: "abandoned" }), secondAttempt()] });
    if (scope) r.scope = scope;
    assert.deepEqual(await resend(r, SECOND, viewer), { ok: false, code }, `${name} re-send`);
    assert.deepEqual(writes(r), []);
    assert.deepEqual(
      gateReadOnly(r),
      ["interview_sessions"],
      `${name} re-send: stopped at the gate`,
    );
  }
  for (const role of ["owner", "admin"]) {
    const w = world();
    assert.deepEqual(await decide(w, { decision: "no_restart" }, ctx(role)), {
      ok: true,
      decision: "no_restart",
    });
    assert.equal(w.tables.live_interview_actions[0].actor_role, role);
  }
});

test("b: an attempt that is not the latest is refused, before any write", async () => {
  const w = world({ sessions: [firstAttempt(), secondAttempt()] });
  assert.deepEqual(await decide(w), { ok: false, code: "not_latest" });
  assert.deepEqual(writes(w), []);
});

// ── c, d, e: the decision ───────────────────────────────────

test("c: no restart is one decision, and no email, no session, no job", async () => {
  const w = world();
  assert.deepEqual(await decide(w, { decision: "no_restart" }), {
    ok: true,
    decision: "no_restart",
  });
  assert.deepEqual(
    w.tables.live_interview_actions.map((a) => [a.action, a.decision, a.note]),
    [["decide_restart", "no_restart", NOTE]],
  );
  assert.deepEqual(w.emails, []);
  assert.equal(w.tables.interview_sessions.length, 1);
  assert.deepEqual(w.tables.background_jobs, []);
  assert.deepEqual(await decide(w), { ok: false, code: "already_decided" });
});

test("d: restart, email delivered: decision, attempt 2, the email at the promised date, then the extension, then the expiry for attempt 2", async () => {
  const w = world();
  const result = await decide(w);
  const second = w.tables.interview_sessions[1];
  assert.deepEqual(result, {
    ok: true,
    decision: "restart",
    restarted: true,
    restartSessionId: second.id,
    emailFailed: false,
    deadline: second.expires_at,
    warning: null,
  });
  assert.deepEqual(
    [second.attempt, second.status, second.previous_attempt_id],
    [2, "invited", FIRST],
  );
  assert.equal(w.tables.interview_sessions[0].status, "abandoned");
  const [email] = w.emails;
  assert.equal(email.to, CANDIDATE_EMAIL);
  assert.equal(email.event, "interview");
  assert.equal(sha256(tokenOf(email)), second.token_hash, "the link is attempt 2's");
  const promised = NOW + 72 * HOUR;
  assert.ok(
    email.html.includes(`<strong>${emailDeadline(promised)}</strong>`),
    "the email shows the promised date",
  );
  assert.deepEqual(
    writes(w).map((s) => s.name ?? s.step),
    ["live_restart_session", "email", "event:sent", "live_restart_extend_deadline", "job"],
    "the extension only after the email, the job last; the record right after the email",
  );
  const [job] = expiryJobs(w, second.id);
  assert.deepEqual([job.run_after, job.company_id], [second.expires_at, CO]);
  assert.deepEqual(
    w.tables.background_jobs.map((j) => j.type),
    ["interview_expiry"],
    "the expiry only: no reminder for a live interview",
  );
});

test("e: restart, email fails: attempt 2 invited, nothing cancelled, extended or scheduled; emailFailed returned", async () => {
  const w = world({ emailOk: false });
  const result = await decide(w);
  const second = w.tables.interview_sessions[1];
  assert.deepEqual(result, {
    ok: true,
    decision: "restart",
    restarted: true,
    restartSessionId: second.id,
    emailFailed: true,
    code: "email_failed",
  });
  assert.equal(second.status, "invited", "never cancelled");
  assert.equal(second.expires_at, iso(NOW + 72 * HOUR), "its deadline from the restart");
  assert.ok(!w.steps.some((s) => s.step === "update"), "no session written");
  assert.ok(!w.steps.some((s) => s.name === "live_restart_extend_deadline"), "not extended");
  assert.deepEqual(w.tables.background_jobs, [], "nothing scheduled");
});

// ── f, g: re-sending the same attempt 2 ─────────────────────

test("f: re-send after a failed email: the same attempt 2, a new token, the email, the extension and the expiry; no new session", async () => {
  const w = world({ emailOk: false });
  await decide(w);
  const second = structuredClone(w.tables.interview_sessions[1]);
  w.setEmailOk(true);
  const later = NOW + HOUR;
  const result = await resend(w, second.id, ctx("owner"), { now: () => later });
  assert.equal(result.ok, true);
  assert.equal(result.emailFailed, false);
  assert.equal(result.restartSessionId, second.id);
  assert.equal(w.tables.interview_sessions.length, 2, "no new session");
  const now2 = w.tables.interview_sessions[1];
  assert.notEqual(now2.token_hash, second.token_hash, "a new token");
  assert.equal(sha256(tokenOf(w.emails.at(-1))), now2.token_hash, "emailed");
  assert.equal(now2.status, "invited");
  assert.equal(expiryJobs(w, second.id).length, 1);
  assert.deepEqual(
    writes(w)
      .slice(-7)
      .map((s) => s.name ?? s.step),
    [
      "live_restart_extend_deadline",
      "update",
      "event:reissued",
      "email",
      "event:sent",
      "live_restart_extend_deadline",
      "job",
    ],
    "the extension first, then the token, the email, the extension after delivery, the job; each record right after its step",
  );
});

test("g: re-sending twice after a delivered link adds no second expiry job; the queued one re-arms", async () => {
  const w = world();
  await decide(w);
  const id = w.tables.interview_sessions[1].id;
  assert.equal(expiryJobs(w, id).length, 1);
  for (const n of [1, 2]) {
    const r = await resend(w, id, ctx("admin"), { now: () => NOW + n * HOUR });
    assert.equal(r.ok, true);
    assert.equal(r.emailFailed, false);
  }
  assert.equal(w.emails.length, 3, "three emails");
  assert.equal(expiryJobs(w, id).length, 1, "one expiry job, not three");
  // Without the check, scheduleInterviewJobs alone would add one per call.
  await quiet(() =>
    scheduleInterviewJobs({
      sessionId: id,
      companyId: CO,
      expiresAt: iso(NOW),
      expiresAtMs: NOW,
      deadline: "x",
      reminder: false,
    }),
  );
  assert.equal(expiryJobs(w, id).length, 2, "scheduleInterviewJobs itself is not idempotent");
});

// ── h, i: refusals ──────────────────────────────────────────

test("h: a promised deadline at or past the retention date is refused before any email or new token", async () => {
  const decided = world({ sessions: [firstAttempt({ delete_after: iso(NOW + 72 * HOUR) })] });
  assert.deepEqual(await decide(decided), { ok: false, code: "past_retention" });
  assert.deepEqual(decided.emails, []);
  assert.equal(decided.tables.interview_sessions.length, 1);

  const w = world({
    sessions: [
      firstAttempt({ status: "abandoned" }),
      secondAttempt({ expires_at: iso(NOW + 30 * HOUR), delete_after: iso(NOW + 72 * HOUR) }),
    ],
  });
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await resend(w), { ok: false, code: "past_retention" });
  assert.deepEqual(w.emails, [], "no email");
  assert.deepEqual(w.tables.interview_sessions, before, "the link it has still works");
  assert.deepEqual(w.tables.background_jobs, []);
});

test("i: re-send on a started, expired or first attempt is refused, nothing changed", async () => {
  const cases = [
    [
      [firstAttempt({ status: "abandoned" }), secondAttempt({ status: "started" })],
      SECOND,
      "not_invited",
    ],
    [
      [firstAttempt({ status: "abandoned" }), secondAttempt({ expires_at: iso(NOW - 1) })],
      SECOND,
      "expired",
    ],
    [[firstAttempt()], FIRST, "not_eligible"],
  ];
  for (const [sessions, id, code] of cases) {
    const w = world({ sessions });
    const before = structuredClone(w.tables.interview_sessions);
    assert.deepEqual(await resend(w, id), { ok: false, code }, code);
    assert.deepEqual(w.tables.interview_sessions, before);
    assert.deepEqual(w.emails, []);
  }
});

// ── j: the emailed date ─────────────────────────────────────

test("j: the email quotes only a deadline the database already holds, whatever the clocks say", async () => {
  for (const dbClockMs of [0, 5 * 60_000, -10 * 60_000]) {
    const w = world({ dbClockMs });
    const quoted = [];
    const r = await quiet(() =>
      decideRestart(
        ctx("owner"),
        { sessionId: FIRST, decision: "restart", note: NOTE },
        deps(w, { sendEmail: spyEmail(quoted, w) }),
      ),
    );
    assert.equal(r.warning, null);
    const [{ emailed, held }] = quoted;
    assert.equal(emailed, held, `${dbClockMs}: the email quotes the database's deadline`);
    assert.ok(
      Date.parse(restartRow(w).expires_at) >= Date.parse(emailed),
      "and it only moves later",
    );
  }
});

// ── k: the panel ────────────────────────────────────────────

const first = (over = {}) => ({
  kind: "first_attempt",
  eligible: true,
  reason: null,
  availableAt: null,
  decision: null,
  ...over,
});
const DECISION = { decision: "no_restart", byName: "M", byRole: "owner", at: iso(NOW), note: "n" };

test("k: the panel per role and state", () => {
  const owner = { canAct: true, platform: false };
  const recruiter = { canAct: false, platform: false };
  const platform = { canAct: false, platform: true };
  const cases = [
    [first(), owner, { panel: "decide" }],
    [first(), recruiter, { panel: "awaiting_decision" }],
    [first(), platform, { panel: "none" }],
    [
      first({ eligible: false, reason: "too_soon", availableAt: "t" }),
      owner,
      { panel: "not_yet", reason: "too_soon", availableAt: "t" },
    ],
    [
      first({ eligible: false, reason: "not_final" }),
      recruiter,
      { panel: "not_yet", reason: "not_final", availableAt: null },
    ],
    [first({ eligible: false, reason: "not_eligible_outcome" }), owner, { panel: "none" }],
    [first({ eligible: false, reason: "not_started" }), owner, { panel: "none" }],
    [
      first({ eligible: false, reason: "already_decided", decision: DECISION }),
      owner,
      { panel: "decided", decision: DECISION },
    ],
    [
      { kind: "earlier_restarted", decision: DECISION },
      recruiter,
      { panel: "earlier_restarted", decision: DECISION },
    ],
    [
      {
        kind: "restart_attempt",
        status: "invited",
        deadline: "d",
        expired: false,
      },
      owner,
      { panel: "restart_invited", deadline: "d", canResend: true },
    ],
    [
      {
        kind: "restart_attempt",
        status: "invited",
        deadline: "d",
        expired: false,
      },
      owner,
      { panel: "restart_invited", deadline: "d", canResend: true },
    ],
    [
      {
        kind: "restart_attempt",
        status: "invited",
        deadline: "d",
        expired: false,
      },
      recruiter,
      { panel: "restart_invited", deadline: "d", canResend: false },
    ],
    [
      {
        kind: "restart_attempt",
        status: "invited",
        deadline: "d",
        expired: true,
      },
      owner,
      { panel: "restart_expired" },
    ],
    [
      {
        kind: "restart_attempt",
        status: "started",
        deadline: "d",
        expired: false,
      },
      owner,
      { panel: "none" },
    ],
    [
      {
        kind: "restart_attempt",
        status: "submitted",
        deadline: "d",
        expired: false,
      },
      owner,
      { panel: "none" },
    ],
    [null, owner, { panel: "none" }],
    [undefined, owner, { panel: "none" }],
  ];
  for (const [restart, viewer, expected] of cases) {
    assert.deepEqual(restartPanelFor(restart, viewer), expected, JSON.stringify([restart, viewer]));
  }
});

test("k: the page renders the form and the re-send button for an owner with the actions, never for anyone else", () => {
  const view = (restart, isLatest = true) => ({
    sessionId: FIRST,
    interviewerName: "Sarah",
    attempt: {
      number: 1,
      of: isLatest ? 1 : 2,
      isLatest,
      latestSessionId: isLatest ? FIRST : SECOND,
      earlierSessionIds: [],
    },
    header: {
      state: "ending_unconfirmed",
      label: "Ending not confirmed",
      answered: 1,
      total: 8,
      skipped: 0,
      completionPercent: 12,
      overall: null,
      partial: true,
      partialNote: null,
      reviewReasons: [],
      restartNote: null,
      scoreStatus: "not_scored",
      scoreNote: null,
    },
    questions: [],
    video: { pieces: [], complete: true, missing: 0, totalMs: 0 },
    restart,
  });
  const actions = { decide: async () => ({ ok: true }), resend: async () => ({ ok: true }) };
  const render = (restart, canAct, extra = {}) =>
    renderToStaticMarkup(
      createElement(LiveReviewClient, {
        view: view(restart, extra.isLatest),
        candidateName: "C",
        jobTitle: "J",
        canAct,
        restartActions: extra.noActions ? undefined : actions,
        mode: extra.mode,
      }),
    );
  assert.match(render(first(), true), /data-restart-form/);
  assert.doesNotMatch(render(first(), false), /data-restart-form/);
  assert.match(render(first(), false), /data-restart-panel="awaiting_decision"/);
  assert.doesNotMatch(render(first(), true, { noActions: true }), /data-restart-form/);
  assert.doesNotMatch(render(first(), true, { mode: "platform" }), /data-restart-panel/);
  const failed = {
    kind: "restart_attempt",
    status: "invited",
    deadline: iso(NOW),
    expired: false,
  };
  const invited = render(failed, true);
  assert.match(invited, /data-restart-resend/);
  assert.ok(
    textOf(invited).includes(`Restart link deadline: ${at(NOW)}.`),
    "the database deadline",
  );
  assert.ok(invited.includes("Delivery can&#x27;t be confirmed here"), "never claims delivery");
  assert.doesNotMatch(invited, /delivered|Restart link sent/i);
  assert.doesNotMatch(render(failed, false), /data-restart-resend/);
  assert.match(render(failed, false), /data-restart-invited/);
  const earlier = render(
    { kind: "earlier_restarted", decision: { ...DECISION, decision: "restart" } },
    true,
    { isLatest: false },
  );
  assert.match(earlier, /data-restart-earlier/);
  assert.doesNotMatch(earlier, /data-restart-form|data-restart-resend/);
  assert.doesNotMatch(
    render(
      first({ eligible: false, reason: "already_decided", decision: { ...DECISION, note: null } }),
      false,
    ),
    /data-restart-note-text/,
    "no note for someone who cannot act",
  );
});

// ── m, n, o, p: the deadline the email quotes ───────────────

/** The page's restart state as loadLiveReview builds it from the database, at `atMs`. */
async function pageState(w, sessionId, atMs) {
  mock.timers.enable({ apis: ["Date"], now: atMs });
  try {
    const view = await quiet(() =>
      loadLiveReview(ctx("owner"), sessionId, { service: w.service, scope: async () => w.scope }),
    );
    return {
      restart: view.restart,
      panel: restartPanelFor(view.restart, { canAct: true, platform: false }),
    };
  } finally {
    mock.timers.reset();
  }
}

test("m: first send, extension after delivery fails: the emailed date is the database deadline, the expiry at it, no mismatch", async () => {
  const w = world();
  w.failExtend(1);
  const quoted = [];
  const { result, lines } = await captured(() =>
    decideRestart(
      ctx("owner"),
      { sessionId: FIRST, decision: "restart", note: NOTE },
      deps(w, { sendEmail: spyEmail(quoted, w) }),
    ),
  );
  const second = restartRow(w);
  const atRestart = iso(NOW + 72 * HOUR);
  assert.deepEqual(result, {
    ok: true,
    decision: "restart",
    restarted: true,
    restartSessionId: second.id,
    emailFailed: false,
    deadline: atRestart,
    warning: "not_extended_after_delivery",
  });
  assert.deepEqual(
    quoted,
    [{ emailed: atRestart, held: atRestart }],
    "quoted: the restart's own deadline",
  );
  assert.ok(w.emails[0].html.includes(`<strong>${emailDeadline(NOW + 72 * HOUR)}</strong>`));
  assert.equal(second.expires_at, atRestart);
  assert.deepEqual(
    expiryJobs(w, second.id).map((j) => j.run_after),
    [atRestart],
    "the expiry at it",
  );
  const sentAt = w.tables.live_restart_link_events[0].created_at;
  assert.deepEqual(await pageState(w, second.id, NOW), {
    restart: {
      kind: "restart_attempt",
      status: "invited",
      deadline: atRestart,
      expired: false,
      link: { status: "sent", at: sentAt },
    },
    panel: { panel: "restart_sent", deadline: atRestart, sentAt, canResend: true },
  });
  assert.equal(
    restartSendText(result, "Asia/Karachi"),
    "Restart link sent - deadline 6 Nov, 17:00 GMT+5.",
    "the page says the date the email said",
  );
  assert.ok(
    lines.some((l) =>
      /extension after delivery failed; the emailed deadline stands, \d+s short/.test(l),
    ),
  );
});

test("n: re-send 48 hours later, the extension before sending fails: no email, the token and the old link unchanged", async () => {
  const w = world();
  await decide(w);
  const second = restartRow(w);
  const before = structuredClone(w.tables.interview_sessions);
  const jobs = structuredClone(w.tables.background_jobs);
  const later = NOW + 48 * HOUR;
  w.setDbNow(later);
  w.failExtend(1);
  assert.deepEqual(await resend(w, second.id, ctx("owner"), { now: () => later }), {
    ok: false,
    code: "deadline_not_extended",
  });
  assert.equal(w.emails.length, 1, "no email beyond the first");
  assert.equal(
    restartRow(w).token_hash,
    before[1].token_hash,
    "the persisted token hash unchanged",
  );
  assert.equal(
    sha256(tokenOf(w.emails[0])),
    restartRow(w).token_hash,
    "the link already emailed still opens it",
  );
  assert.deepEqual(w.tables.interview_sessions, before, "nothing about the sessions changed");
  assert.deepEqual(w.tables.background_jobs, jobs);
});

test("o: re-send 48 hours later, all well: the email quotes the database's deadline at send time; the final one is not earlier", async () => {
  const w = world();
  await decide(w);
  const id = restartRow(w).id;
  const later = NOW + 48 * HOUR;
  const dbAt = later + 5 * 60_000;
  w.setDbNow(dbAt);
  const quoted = [];
  const result = await resend(w, id, ctx("owner"), {
    now: () => later,
    sendEmail: spyEmail(quoted, w),
  });
  const held = iso(dbAt + 72 * HOUR);
  assert.deepEqual(
    quoted,
    [{ emailed: held, held }],
    "the database's deadline, as it held it when sending",
  );
  assert.ok(
    Date.parse(quoted[0].emailed) >= later + 72 * HOUR,
    "at least 72 hours after the re-send",
  );
  assert.deepEqual(result, {
    ok: true,
    restartSessionId: id,
    emailFailed: false,
    deadline: held,
    warning: null,
  });
  assert.ok(Date.parse(restartRow(w).expires_at) >= Date.parse(quoted[0].emailed));
  assert.equal(sha256(tokenOf(w.emails.at(-1))), restartRow(w).token_hash, "the new link");
  assert.deepEqual(
    writes(w)
      .slice(-6)
      .map((s) => s.name ?? s.step),
    [
      "live_restart_extend_deadline",
      "update",
      "event:reissued",
      "email",
      "event:sent",
      "live_restart_extend_deadline",
    ],
  );
  assert.equal(expiryJobs(w, id).length, 1, "the queued expiry re-arms");
});

test("p: re-send, extension after delivery fails: the quoted database deadline is honoured; a counts-only line says how short", async () => {
  const w = world();
  await decide(w);
  const id = restartRow(w).id;
  const later = NOW + 48 * HOUR;
  const dbAt = later + 5 * 60_000;
  w.setDbNow(dbAt);
  w.failExtend(1, 1);
  // The email takes ten minutes to go out: delivery is after the deadline was set.
  let appNow = later;
  const quoted = [];
  const slow = spyEmail(quoted, w, () => {
    appNow = later + 10 * 60_000;
  });
  const { result, lines } = await captured(() =>
    resendRestartLink(ctx("owner"), id, deps(w, { now: () => appNow, sendEmail: slow })),
  );
  const held = iso(dbAt + 72 * HOUR);
  assert.deepEqual(quoted, [{ emailed: held, held }]);
  assert.deepEqual(result, {
    ok: true,
    restartSessionId: id,
    emailFailed: false,
    deadline: held,
    warning: "not_extended_after_delivery",
  });
  assert.equal(restartRow(w).expires_at, held, "the quoted deadline, still held");
  assert.equal(
    restartSendText(result, "America/New_York"),
    "Restart link sent - deadline 8 Nov, 07:05 EST.",
  );
  const short = lines.filter((l) => l.includes("extension after delivery failed"));
  assert.deepEqual(short, [
    `[live-restart-flow] restart ${id}: extension after delivery failed; the emailed deadline stands, 300s short of 72 hours after delivery`,
  ]);
});

// ── F10-LOG: the link's record and the status the page reads ─

const RESTART_ACTIONS = { decide: async () => ({ ok: true }), resend: async () => ({ ok: true }) };
const UNCONFIRMED_TEXT = "Delivery can&#x27;t be confirmed here";
const FAILED_TEXT = "The restart email was not accepted - send the link again.";
const sentText = (atMs, deadlineMs) =>
  `Restart link sent - accepted by the email provider on ${at(atMs)}. Deadline ${at(deadlineMs)}.`;
const events = (w) =>
  w.tables.live_restart_link_events.map((e) => [
    e.event,
    e.session_id,
    e.company_id,
    e.actor_user_id,
    e.actor_role,
  ]);
/** The review page for `role`, rendered from what loadLiveReview reads. */
async function pageHtml(w, sessionId, role = "owner", atMs = NOW) {
  mock.timers.enable({ apis: ["Date"], now: atMs });
  try {
    const view = await quiet(() =>
      loadLiveReview(ctx(role), sessionId, { service: w.service, scope: async () => w.scope }),
    );
    const canAct = canActOnLiveReview(role);
    return renderToStaticMarkup(
      createElement(LiveReviewClient, {
        view,
        candidateName: "C",
        jobTitle: "J",
        canAct,
        restartActions: canAct ? RESTART_ACTIONS : undefined,
      }),
    );
  } finally {
    mock.timers.reset();
  }
}
const neverClaimsReceipt = (html) =>
  assert.doesNotMatch(html, /received it|was delivered|delivered to|opened/i);
const restarted = () => [firstAttempt({ status: "abandoned" }), secondAttempt()];
const event = (name, atMs, over = {}) => ({
  session_id: SECOND,
  company_id: CO,
  event: name,
  actor_user_id: "u-seed",
  actor_role: "owner",
  created_at: iso(atMs),
  ...over,
});

test("F10-LOG a: restart, email accepted: one 'sent' row as the gated actor, after the email; the page says accepted, never received", async () => {
  const w = world();
  const admin = ctx("admin");
  const r = await decide(w, {}, admin);
  assert.equal(r.emailFailed, false);
  assert.equal("recordWarning" in r, false);
  const second = restartRow(w);
  assert.deepEqual(events(w), [["sent", second.id, CO, admin.user.id, "admin"]]);
  const steps = writes(w).map((s) => s.name ?? s.step);
  assert.ok(steps.indexOf("email") < steps.indexOf("event:sent"), "written after the email");
  const html = await pageHtml(w, second.id);
  const sentAt = Date.parse(w.tables.live_restart_link_events[0].created_at);
  assert.ok(
    textOf(html).includes(sentText(sentAt, Date.parse(second.expires_at))),
    "accepted, with the deadline",
  );
  assert.match(html, /data-restart-link="sent"/);
  assert.ok(!html.includes(UNCONFIRMED_TEXT));
  assert.match(html, /data-restart-resend/, "an owner can still send it again");
  neverClaimsReceipt(html);
});

test("F10-LOG b: restart, email not accepted: one 'failed' row; the page says so and offers the re-send to an owner or admin only", async () => {
  const w = world({ emailOk: false });
  const r = await decide(w);
  assert.deepEqual([r.emailFailed, r.code, "recordWarning" in r], [true, "email_failed", false]);
  const second = restartRow(w);
  assert.deepEqual(events(w), [["failed", second.id, CO, ctx("owner").user.id, "owner"]]);
  const steps = writes(w).map((s) => s.name ?? s.step);
  assert.ok(steps.indexOf("email") < steps.indexOf("event:failed"), "written after the email");
  assert.equal(second.status, "invited", "never cancelled");
  for (const role of ["owner", "admin"]) {
    const html = await pageHtml(w, second.id, role);
    assert.ok(html.includes(FAILED_TEXT), role);
    assert.match(html, /data-restart-link="failed"/);
    assert.match(html, /data-restart-resend/, `${role}: the re-send`);
    assert.doesNotMatch(html, /Restart link sent/);
  }
  for (const role of ["recruiter", "hiring_manager"]) {
    const html = await pageHtml(w, second.id, role);
    assert.ok(html.includes(FAILED_TEXT), role);
    assert.doesNotMatch(html, /data-restart-resend/, `${role}: no re-send`);
  }
});

test("F10-LOG c: re-send: 'reissued' then 'sent', each right after its step; the page shows the latest acceptance", async () => {
  const w = world({ emailOk: false });
  await decide(w);
  const id = restartRow(w).id;
  w.setEmailOk(true);
  const r = await resend(w, id, ctx("admin"), { now: () => NOW + HOUR });
  assert.deepEqual([r.ok, r.emailFailed, "recordWarning" in r], [true, false, false]);
  assert.deepEqual(
    events(w).map((e) => [e[0], e[4]]),
    [
      ["failed", "owner"],
      ["reissued", "admin"],
      ["sent", "admin"],
    ],
  );
  assert.deepEqual(
    writes(w)
      .slice(-7)
      .map((s) => s.name ?? s.step),
    [
      "live_restart_extend_deadline",
      "update",
      "event:reissued",
      "email",
      "event:sent",
      "live_restart_extend_deadline",
      "job",
    ],
    "C5's order, each record right after its step",
  );
  let html = await pageHtml(w, id);
  const lastSent = Date.parse(w.tables.live_restart_link_events.at(-1).created_at);
  assert.ok(textOf(html).includes(sentText(lastSent, Date.parse(restartRow(w).expires_at))));
  // A second re-send, delivered: the newest acceptance is the one shown.
  await resend(w, id, ctx("owner"), { now: () => NOW + 2 * HOUR });
  const newest = w.tables.live_restart_link_events.at(-1);
  assert.deepEqual(
    events(w)
      .slice(-2)
      .map((e) => e[0]),
    ["reissued", "sent"],
  );
  html = await pageHtml(w, id);
  assert.ok(
    textOf(html).includes(`accepted by the email provider on ${at(Date.parse(newest.created_at))}`),
  );
  neverClaimsReceipt(html);
});

test("F10-LOG c: re-send, email not accepted: 'reissued' then 'failed'; the page shows the failure, not the earlier acceptance", async () => {
  const w = world();
  await decide(w);
  const id = restartRow(w).id;
  w.setEmailOk(false);
  const r = await resend(w, id, ctx("admin"), { now: () => NOW + HOUR });
  assert.deepEqual(r, { ok: true, restartSessionId: id, emailFailed: true, code: "email_failed" });
  assert.deepEqual(
    events(w).map((e) => [e[0], e[4]]),
    [
      ["sent", "owner"],
      ["reissued", "admin"],
      ["failed", "admin"],
    ],
  );
  assert.deepEqual(
    writes(w)
      .slice(-5)
      .map((s) => s.name ?? s.step),
    ["live_restart_extend_deadline", "update", "event:reissued", "email", "event:failed"],
    "no extension or job after a failed email; each record right after its step",
  );
  assert.equal(restartRow(w).status, "invited", "never cancelled");
  const html = await pageHtml(w, id);
  assert.match(html, /data-restart-link="failed"/);
  assert.ok(html.includes(FAILED_TEXT));
  assert.match(html, /data-restart-resend/);
  assert.doesNotMatch(html, /Restart link sent/, "the earlier acceptance is not shown");
});

test("F10-LOG d: re-send, the email accepted but its 'sent' row not written: the email stands, warning returned, the page shows unconfirmed (not the earlier 'sent')", async () => {
  const w = world({ events: { sent: "error" } });
  await decide(w);
  const id = restartRow(w).id;
  // Pretend the first send's 'sent' row was written: an earlier acceptance exists.
  w.tables.live_restart_link_events.push(event("sent", NOW - 30 * 60_000, { session_id: id }));
  const { result, lines } = await captured(() =>
    resendRestartLink(ctx("owner"), id, deps(w, { now: () => NOW + HOUR })),
  );
  assert.deepEqual(result, {
    ok: true,
    restartSessionId: id,
    emailFailed: false,
    deadline: restartRow(w).expires_at,
    warning: null,
    recordWarning: "event_not_recorded",
  });
  assert.equal(w.emails.length, 2, "the re-send's email went");
  assert.equal(sha256(tokenOf(w.emails[1])), restartRow(w).token_hash, "with the new link");
  assert.equal(restartRow(w).status, "invited");
  assert.deepEqual(
    w.tables.live_restart_link_events.map((e) => e.event),
    ["sent", "reissued"],
    "the reissued row written; the sent row not",
  );
  assert.deepEqual(
    writes(w)
      .slice(-6)
      .map((s) => s.name ?? s.step),
    [
      "live_restart_extend_deadline",
      "update",
      "event:reissued",
      "email",
      "event:sent",
      "live_restart_extend_deadline",
    ],
    "C5's steps all ran after the failed write",
  );
  assert.deepEqual(
    lines.filter((l) => l.includes("link event not recorded")),
    [`[live-restart-flow] restart ${id}: link event not recorded (sent)`],
  );
  const html = await pageHtml(w, id);
  assert.match(html, /data-restart-link="unconfirmed"/, "the reissued row is the latest");
  assert.ok(html.includes(UNCONFIRMED_TEXT));
  assert.doesNotMatch(html, /Restart link sent/);
});

test("F10-LOG c: the page's status per latest record: sent, failed, or unconfirmed (re-issued, none, or unordered)", async () => {
  const cases = [
    ["no record", [], "unconfirmed"],
    ["sent", [event("sent", NOW - HOUR)], "sent"],
    ["failed", [event("failed", NOW - 3 * HOUR)], "failed"],
    [
      "sent, then re-issued",
      [event("sent", NOW - 3 * HOUR), event("reissued", NOW - HOUR)],
      "unconfirmed",
    ],
    [
      "re-issued, then failed",
      [event("reissued", NOW - 3 * HOUR), event("failed", NOW - HOUR)],
      "failed",
    ],
    [
      "failed, re-issued, sent",
      [
        event("failed", NOW - 3 * HOUR),
        event("reissued", NOW - 2 * HOUR),
        event("sent", NOW - HOUR),
      ],
      "sent",
    ],
    // Stored newest first: the read orders them, it does not trust storage order.
    [
      "sent stored before an older failed",
      [event("sent", NOW - HOUR), event("failed", NOW - 3 * HOUR)],
      "sent",
    ],
    [
      "sent and re-issued at the same instant",
      [event("sent", NOW - HOUR), event("reissued", NOW - HOUR)],
      "unconfirmed",
    ],
  ];
  for (const [name, linkEvents, expected] of cases) {
    const w = world({ sessions: restarted(), linkEvents });
    const html = await pageHtml(w, SECOND);
    assert.match(html, new RegExp(`data-restart-link="${expected}"`), name);
    if (expected === "unconfirmed") assert.ok(html.includes(UNCONFIRMED_TEXT), name);
    if (expected === "failed") assert.ok(html.includes(FAILED_TEXT), name);
    if (expected === "sent") {
      assert.ok(textOf(html).includes(sentText(NOW - HOUR, NOW + 60 * HOUR)), name);
    }
    neverClaimsReceipt(html);
  }
});

test("F10-LOG d: a record that cannot be written: the email still goes, nothing cancelled or undone, a warning returned, the page falls back", async () => {
  for (const mode of ["error", "throw"]) {
    const w = world({ events: mode });
    const { result, lines } = await captured(() =>
      decideRestart(ctx("owner"), { sessionId: FIRST, decision: "restart", note: NOTE }, deps(w)),
    );
    const second = restartRow(w);
    assert.deepEqual(
      result,
      {
        ok: true,
        decision: "restart",
        restarted: true,
        restartSessionId: second.id,
        emailFailed: false,
        deadline: second.expires_at,
        warning: null,
        recordWarning: "event_not_recorded",
      },
      mode,
    );
    assert.equal(w.emails.length, 1, `${mode}: the email went`);
    assert.equal(second.status, "invited", `${mode}: never cancelled`);
    assert.deepEqual(
      writes(w).map((s) => s.name ?? s.step),
      ["live_restart_session", "email", "event:sent", "live_restart_extend_deadline", "job"],
      `${mode}: C5's steps all ran, in order`,
    );
    assert.deepEqual(w.tables.live_restart_link_events, []);
    const notRecorded = lines.filter((l) => l.includes("link event not recorded"));
    assert.deepEqual(notRecorded, [
      `[live-restart-flow] restart ${second.id}: link event not recorded (sent)`,
    ]);
    assert.ok(!lines.join("\n").includes("RAW-SQL-DETAIL"), "no database text logged");
    assert.match(restartSendText(result, "Europe/London"), /couldn't be recorded/);
    const html = await pageHtml(w, second.id);
    assert.match(html, /data-restart-link="unconfirmed"/, `${mode}: the page falls back`);
    assert.ok(html.includes(UNCONFIRMED_TEXT));

    // A re-send: the token replaced, the email sent, the warning returned.
    const r = await resend(w, second.id, ctx("owner"), { now: () => NOW + HOUR });
    assert.deepEqual([r.ok, r.emailFailed, r.recordWarning], [true, false, "event_not_recorded"]);
    assert.equal(w.emails.length, 2, `${mode}: the re-send's email went`);
    assert.equal(sha256(tokenOf(w.emails[1])), restartRow(w).token_hash);

    // The email not accepted either: the failure and the warning, nothing else changed.
    const f = world({ emailOk: false, events: mode });
    const failed = await decide(f);
    assert.deepEqual(failed, {
      ok: true,
      decision: "restart",
      restarted: true,
      restartSessionId: restartRow(f).id,
      emailFailed: true,
      code: "email_failed",
      recordWarning: "event_not_recorded",
    });
    assert.equal(restartRow(f).status, "invited");
  }
});

test("F10-LOG e: the actor is the gated viewer, never the request; recruiters and hiring managers never reach the write", async () => {
  const w = world();
  const admin = ctx("admin", { user: { id: "u0000000-0000-4000-8000-0000000000e5" } });
  const forged = {
    actorUserId: "u-forged",
    actor_user_id: "u-forged",
    actorRole: "owner",
    actor_role: "owner",
    role: "owner",
    companyId: OTHER_CO,
    company_id: OTHER_CO,
  };
  await quiet(() =>
    decideRestart(admin, { sessionId: FIRST, decision: "restart", note: NOTE, ...forged }, deps(w)),
  );
  const id = restartRow(w).id;
  assert.deepEqual(events(w), [["sent", id, CO, admin.user.id, "admin"]]);
  for (const role of ["recruiter", "hiring_manager", "super_admin"]) {
    const refused = { ok: false, code: "role_not_allowed" };
    const d = world();
    assert.deepEqual(await decide(d, {}, ctx(role)), refused, role);
    const s = world({ sessions: restarted() });
    assert.deepEqual(await resend(s, SECOND, ctx(role)), refused, role);
    for (const x of [d, s]) {
      assert.deepEqual(x.tables.live_restart_link_events, [], `${role}: no record`);
      assert.ok(!x.service.queries.some((q) => q.table === "live_restart_link_events"), role);
    }
  }
});

test("F10-LOG f: another company's records are never read", async () => {
  const theirs = { company_id: OTHER_CO, actor_user_id: "u-other" };
  const cases = [
    [
      "ours failed, theirs sent later",
      [event("failed", NOW - 3 * HOUR), event("sent", NOW - HOUR, theirs)],
      "failed",
    ],
    ["only theirs", [event("sent", NOW - HOUR, theirs)], "unconfirmed"],
    [
      "ours sent, theirs failed later",
      [event("sent", NOW - 3 * HOUR), event("failed", NOW - HOUR, theirs)],
      "sent",
    ],
  ];
  for (const [name, linkEvents, expected] of cases) {
    const w = world({ sessions: restarted(), linkEvents });
    const html = await pageHtml(w, SECOND);
    assert.match(html, new RegExp(`data-restart-link="${expected}"`), name);
    const reads = w.service.queries.filter((q) => q.table === "live_restart_link_events");
    assert.equal(reads.length, 1, name);
    assert.ok(
      reads[0].calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO),
      `${name}: filtered to the viewer's company`,
    );
  }
});

// ── l: logs ─────────────────────────────────────────────────

test("l: no token, note, email or name in any log line", async () => {
  const lines = [];
  const run = async (fn) => {
    const r = await captured(fn);
    lines.push(...r.lines);
    return r.result;
  };
  const w = world({ emailOk: false });
  await run(() =>
    decideRestart(ctx("owner"), { sessionId: FIRST, decision: "restart", note: NOTE }, deps(w)),
  );
  const id = w.tables.interview_sessions[1].id;
  w.setEmailOk(true);
  await run(() => resendRestartLink(ctx("owner"), id, deps(w)));
  await run(() => resendRestartLink(ctx("owner"), id, deps(w)));
  await run(() =>
    decideRestart(
      ctx("recruiter"),
      { sessionId: FIRST, decision: "no_restart", note: NOTE },
      deps(w),
    ),
  );
  const n = world();
  await run(() =>
    decideRestart(ctx("admin"), { sessionId: FIRST, decision: "no_restart", note: NOTE }, deps(n)),
  );
  assert.ok(lines.length >= 5);
  const text = lines.join("\n");
  for (const email of w.emails) {
    const token = tokenOf(email);
    assert.ok(!text.includes(token), "no token");
    assert.ok(!text.includes(sha256(token)), "no token hash");
  }
  for (const secret of [NOTE, CANDIDATE_EMAIL, MEMBER_NAME, "Alex", "Synthetic Co"]) {
    assert.ok(!text.includes(secret), `no ${secret}`);
  }
});

// ── C7: the approved copy ───────────────────────────────────

const APPROVED_EMAIL_LINE = (deadline) =>
  `<p>Your interview link will remain valid until at least <strong>${deadline}</strong>. Please have your camera and microphone ready.</p>`;

test("C7 email: the deadline is the real one, to the minute, in UTC; two deadlines, two texts; no '72 hours'", async () => {
  // One world at a time: each world() takes over the email stub.
  const first = world();
  await decide(first);
  const [a] = first.emails;
  // The database's deadline: greatest(the invite's, now + 72h).
  assert.equal(restartRow(first).expires_at, iso(NOW + 72 * HOUR));
  assert.ok(a.html.includes(APPROVED_EMAIL_LINE("6 November 2026 at 12:00 UTC")), "the first");
  // A re-send quotes the deadline the database holds then.
  const dbAt = NOW + 48 * HOUR + 7 * 60_000;
  first.setDbNow(dbAt);
  const again = await resend(first, restartRow(first).id, ctx("owner"), {
    now: () => NOW + 48 * HOUR,
  });
  assert.equal(again.ok, true);
  const resent = first.emails[1];
  assert.ok(resent.html.includes(APPROVED_EMAIL_LINE("8 November 2026 at 12:07 UTC")), "re-sent");
  assert.equal(emailDeadline(dbAt + 72 * HOUR), "8 November 2026 at 12:07 UTC");

  const later = world({
    sessions: [firstAttempt({ expires_at: iso(NOW + 100 * HOUR + 30 * 60_000) })],
  });
  await decide(later);
  const [b] = later.emails;
  assert.equal(restartRow(later).expires_at, iso(NOW + 100 * HOUR + 30 * 60_000));
  assert.ok(b.html.includes(APPROVED_EMAIL_LINE("7 November 2026 at 16:30 UTC")), "the second");
  assert.notEqual(a.html, b.html, "two deadlines, two texts");

  for (const email of [a, resent, b]) {
    assert.match(email.html, /valid until at least <strong>[^<]+ UTC<\/strong>/, "UTC written out");
    assert.doesNotMatch(`${email.subject}\n${email.html}`, /72 hours|works until/i);
  }
});

test("C7 review page: the decider is 'Owner' or 'Admin', never a role code; times are the viewer's, never UTC", async () => {
  const owner = world();
  await decide(owner, { decision: "no_restart" }, ctx("owner"));
  const admin = world();
  await decide(admin, {}, ctx("admin"));
  const other = world();
  other.tables.live_interview_actions.push({
    session_id: FIRST,
    company_id: CO,
    action: "decide_restart",
    decision: "no_restart",
    note: NOTE,
    actor_user_id: "u-other",
    actor_name: "Synthetic Member",
    actor_role: "super_admin",
    created_at: iso(NOW - HOUR),
  });
  const cases = [
    [owner, FIRST, `by ${MEMBER_NAME} (Owner), ${at(NOW)}.`],
    [admin, FIRST, `by ${MEMBER_NAME} (Admin), ${at(NOW)}.`],
    [other, FIRST, `by Synthetic Member, ${at(NOW - HOUR)}.`],
  ];
  for (const [w, id, expected] of cases) {
    const text = textOf(await pageHtml(w, id));
    assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /\((owner|admin|super_admin|recruiter|hiring_manager)\)|super_admin/);
    assert.doesNotMatch(text, /UTC/, "no UTC on the dashboard");
  }
  // The restart's own page: deadline, acceptance and failure, all in the viewer's time.
  const sent = textOf(await pageHtml(admin, restartRow(admin).id));
  assert.match(sent, /accepted by the email provider on \[[^\]]+\]\. Deadline \[[^\]]+\]\./);
  assert.doesNotMatch(sent, /UTC/);
  const tooSoon = world({
    sessions: [firstAttempt({ live_outcome: null, live_ended_at: iso(NOW - 10 * 60_000) })],
  });
  const soon = textOf(await pageHtml(tooSoon, FIRST));
  assert.ok(soon.includes(`A restart can be decided from ${at(NOW + 50 * 60_000)}.`));
  assert.doesNotMatch(soon, /UTC/);
});

test("C7 review page: 'Restart link created.' without a deadline; the provider's refusal in its own words", () => {
  const view = {
    sessionId: SECOND,
    interviewerName: "Sarah",
    attempt: {
      number: 2,
      of: 2,
      isLatest: true,
      latestSessionId: SECOND,
      earlierSessionIds: [FIRST],
    },
    header: {
      state: "in_progress",
      label: "In progress",
      answered: 0,
      total: 8,
      skipped: 0,
      completionPercent: 0,
      overall: null,
      partial: false,
      partialNote: null,
      reviewReasons: [],
      restartNote: null,
      scoreStatus: "not_scored",
      scoreNote: null,
    },
    questions: [],
    video: { pieces: [], complete: true, missing: 0, totalMs: 0 },
    restart: {
      kind: "restart_attempt",
      status: "invited",
      deadline: null,
      expired: false,
      link: { status: "unconfirmed" },
    },
  };
  const html = renderToStaticMarkup(
    createElement(LiveReviewClient, { view, candidateName: "C", jobTitle: "J", canAct: true }),
  );
  assert.ok(textOf(html).includes("Restart link created."));
  assert.doesNotMatch(textOf(html), /Restart link sent\./);
  assert.ok(
    textOf(html).includes("This interview was restarted; only this attempt counts."),
    "the attempt banner",
  );
  assert.equal(
    restartSendText({ emailFailed: true, code: "email_failed" }, "Europe/London"),
    "The email provider didn't accept the message. Send the link again.",
  );
});

/** Every string literal and JSX text in a source file, with its line (TypeScript's own parser). */
async function stringsOf(path) {
  const ts = (await import("typescript")).default;
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  const tsx = path.endsWith("x");
  const file = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const kinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const out = [];
  const visit = (node) => {
    if (kinds.has(node.kind)) {
      out.push({
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.text ?? node.getText(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const REVIEW_CLIENT =
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client.tsx";
const DRAWER = "../../app/ai-dashboard/(gated)/applicants/_interview-panel.tsx";
const DRAWER_ACTIONS = "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts";
const LIST = "../../app/ai-dashboard/(gated)/interviews/_interviews-client.tsx";
const INTERVIEW_ACTIONS = "../../app/ai-dashboard/(gated)/interviews/actions.ts";
const LOCAL_TIME = "../../app/ai-dashboard/_components/local-time.tsx";

test("C7: the approved copy is in place, word for word", async () => {
  const has = async (path, text) => {
    const all = (await stringsOf(path)).map((s) => s.text.replace(/\s+/g, " ").trim());
    assert.ok(
      all.some((t) => t.includes(text)),
      `${path}: ${text}`,
    );
  };
  await has(
    REVIEW_CLIENT,
    "Confirm restart: we'll email the candidate a new link with at least 72 hours to take it. If the email fails, you can send it again.",
  );
  await has(REVIEW_CLIENT, "The email provider didn't accept the message. Send the link again.");
  await has(REVIEW_CLIENT, "Restart link created.");
  await has(REVIEW_CLIENT, "This interview was restarted; only this attempt counts.");
  await has(DRAWER, "Restart created");
  await has(DRAWER, "Restart created - not started yet, deadline");
  await has(
    LIST,
    "Answer counts aren't available for AI Video Interviews. Open the interview to view the conversation.",
  );
  await has(
    INTERVIEW_ACTIONS,
    "Couldn't reach the recording storage. Nothing was deleted - please try again.",
  );
});

test("C7: no em or en dash in any string this change touched", async () => {
  // Files that are F10's (or new) in full, and the F10 strings in files shared with older copy.
  const whole = ["./live-restart-flow.ts", REVIEW_CLIENT, INTERVIEW_ACTIONS, LOCAL_TIME];
  const F10 =
    /restart|interview page|has started, so|already started|Answer counts|recording storage|Couldn't read the interview|Some recordings|Couldn't send - please try again/i;
  const shared = [DRAWER, DRAWER_ACTIONS, LIST];
  let scanned = 0;
  for (const path of [...whole, ...shared]) {
    const strings = (await stringsOf(path)).filter((s) => whole.includes(path) || F10.test(s.text));
    scanned += strings.length;
    for (const s of strings) {
      assert.doesNotMatch(s.text, /[\u2013\u2014]/, `${path}:${s.line}: ${s.text.trim()}`);
    }
  }
  assert.ok(scanned > 500, `strings scanned: ${scanned}`);
});
