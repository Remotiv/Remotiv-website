/**
 * Restarting a live first attempt (F10 C3, live-restart.ts): eligibility as
 * migration 053 decides it, the decision by an Owner or Admin with a note, the
 * restart through live_restart_session, a re-issued link for the same attempt
 * 2, and the deadline after delivery.
 *
 * The database here is this file's own: fake-live-db.mjs predates 053 (its
 * live_interview_actions rules refuse decide_restart), so a small store over
 * fake-postgrest.mjs stands in, with 053's decision trigger, unique index and
 * both functions written out below from the SQL. Synthetic data only.
 *
 *   node --test src/lib/interviews/live-restart.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { decideLiveRestart, extendRestartDeadline, reissueRestartLink, restartEligibility } =
  await import("./live-restart.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const CO = "7aad434d-0000-4000-8000-000000000053";
const OTHER_CO = "7aad434d-0000-4000-8000-000000000099";
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000c1";
const RESTART = "5b0f2c1e-0000-4000-8000-0000000000c2";
const NOTE = "  The call dropped on the candidate's side; run it again.  ";
const EMAIL = "alex.synthetic@example.test";

function firstAttempt(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    application_id: "a0000000-0000-4000-8000-000000000001",
    job_id: "j0000000-0000-4000-8000-000000000001",
    kind: "live",
    attempt: 1,
    previous_attempt_id: null,
    status: "started",
    token_hash: "1".repeat(64),
    live_ended_at: iso(NOW - 2 * HOUR),
    live_outcome: { v: 6, outcome: "technical_failure", final: true },
    live_settings: { v: 2, interviewer_name: "Sarah" },
    questions_snapshot: [{ position: 1, text: "Synthetic question" }],
    scoring_snapshot: [{ position: 1, guide: "Synthetic guide" }],
    expires_at: iso(NOW + 24 * HOUR),
    delete_after: iso(NOW + 180 * 24 * HOUR),
    ...over,
  };
}

function restartRow(over = {}) {
  return {
    ...firstAttempt(),
    id: RESTART,
    attempt: 2,
    previous_attempt_id: SESSION,
    status: "invited",
    token_hash: "2".repeat(64),
    live_ended_at: null,
    live_outcome: null,
    expires_at: iso(NOW + 30 * HOUR),
    ...over,
  };
}

const actor = (role, over = {}) => ({
  userId: "u0000000-0000-4000-8000-000000000001",
  memberId: "m0000000-0000-4000-8000-000000000001",
  name: "Synthetic Member",
  role,
  companyId: CO,
  ...over,
});

const err = (code, message) => ({ code, message, details: null, hint: null });

/** 053's live_interview_actions_restart_rules, in its order. Null when the row may land. */
function decisionRefusal(tables, sessionId) {
  const s = tables.interview_sessions.find((x) => x.id === sessionId);
  if (!s) return err("23514", "decide_restart: session not found");
  if (s.kind !== "live" || s.attempt !== 1) return err("23514", "only a live first attempt");
  if (s.status !== "started") return err("23514", "not started");
  if (s.live_ended_at === null) return err("23514", "no verified end yet");
  if (s.live_outcome === null) {
    if (Date.parse(s.live_ended_at) > NOW - HOUR) return err("23514", "less than an hour ago");
  } else if (String(s.live_outcome.final) !== "true") return err("23514", "not final yet");
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

/** 042/053's row rules for a decision: the shape the constraints accept. */
function decisionRowRefusal(row) {
  const ok =
    row.action === "decide_restart" &&
    ["restart", "no_restart"].includes(row.decision) &&
    (row.question_position ?? null) === null &&
    (row.turn_id ?? null) === null &&
    (row.turn_sequence ?? null) === null &&
    typeof row.note === "string" &&
    row.note.trim().length >= 1 &&
    row.note.length <= 2000 &&
    ["owner", "admin", "super_admin"].includes(row.actor_role) &&
    !!row.actor_user_id &&
    !!row.session_id &&
    !!row.company_id;
  return ok ? null : err("23514", "violates live_interview_actions constraints");
}

/** live_restart_session and live_restart_extend_deadline, from 053, in one transaction each. */
const RPC = {
  live_restart_session(tables, a) {
    const prev = tables.interview_sessions.find(
      (s) => s.id === a.p_session_id && s.company_id === a.p_company_id,
    );
    if (!prev) return { data: null, error: err("P0002", "session not found in company") };
    const action = {
      session_id: prev.id,
      company_id: prev.company_id,
      action: "decide_restart",
      decision: "restart",
      note: a.p_note,
      actor_user_id: a.p_actor_user_id,
      actor_name: a.p_actor_name,
      actor_role: a.p_actor_role,
    };
    const refusal = decisionRowRefusal(action) ?? decisionRefusal(tables, prev.id);
    if (refusal) return { data: null, error: refusal };
    const deadline = Math.max(Date.parse(prev.expires_at), NOW + 72 * HOUR);
    if (prev.delete_after && deadline >= Date.parse(prev.delete_after))
      return { data: null, error: err("23514", "retention date before the deadline") };
    tables.live_interview_actions.push({ id: crypto.randomUUID(), ...action });
    prev.status = "abandoned";
    tables.interview_sessions.push({
      id: a.p_new_session_id,
      company_id: prev.company_id,
      application_id: prev.application_id,
      job_id: prev.job_id,
      token_hash: a.p_token_hash,
      status: "invited",
      kind: "live",
      live_settings: structuredClone(prev.live_settings),
      attempt: 2,
      previous_attempt_id: prev.id,
      allow_rerecord: false,
      questions_snapshot: structuredClone(prev.questions_snapshot),
      scoring_snapshot: structuredClone(prev.scoring_snapshot),
      live_ended_at: null,
      live_outcome: null,
      expires_at: iso(deadline),
      delete_after: prev.delete_after,
      invited_by: a.p_invited_by,
      invited_by_name: a.p_invited_by_name,
    });
    return { data: iso(deadline), error: null };
  },
  live_restart_extend_deadline(tables, a) {
    const s = tables.interview_sessions.find(
      (x) => x.id === a.p_session_id && x.company_id === a.p_company_id,
    );
    if (s?.attempt !== 2) return { data: null, error: err("P0002", "no restart in company") };
    if (s.status !== "invited") return { data: null, error: err("23514", "not invited") };
    const deadline = Math.max(Date.parse(s.expires_at), NOW + 72 * HOUR);
    if (deadline >= Date.parse(s.delete_after))
      return { data: null, error: err("23514", "past its retention date") };
    s.expires_at = iso(deadline);
    return { data: iso(deadline), error: null };
  },
};

/** The store: eq filters, select / maybeSingle / limit, insert, update, and the two functions. */
function world({ sessions = [firstAttempt()], actions = [] } = {}) {
  const tables = {
    interview_sessions: structuredClone(sessions),
    live_interview_actions: structuredClone(actions),
  };
  const faults = [];
  const take = (key) => {
    const i = faults.findIndex((f) => f.key === key);
    return i < 0 ? null : faults.splice(i, 1)[0].error;
  };
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) {
      const fault = take(table);
      if (fault) return { data: null, error: fault };
      return RPC[table.slice(4)](tables, calls[0][1]);
    }
    const rows = tables[table];
    const match = (r) =>
      calls.every((c) => {
        if (c[0] === "eq") return r[c[1]] === c[2];
        // Timestamps here are all toISOString(), so they compare as text.
        if (c[0] === "gt") return r[c[1]] !== null && r[c[1]] > c[2];
        return true;
      });
    const insert = calls.find((c) => c[0] === "insert");
    const update = calls.find((c) => c[0] === "update");
    const op = insert ? "insert" : update ? "update" : "select";
    const fault = take(`${table}:${op}`);
    if (fault) return { data: null, error: fault };
    if (insert) {
      const row = structuredClone(insert[1]);
      if (table === "live_interview_actions") {
        const refusal = decisionRowRefusal(row) ?? decisionRefusal(tables, row.session_id);
        if (refusal) return { data: null, error: refusal };
      }
      rows.push({ id: row.id ?? crypto.randomUUID(), ...row });
      return { data: null, error: null };
    }
    const hit = rows.filter(match);
    if (update) {
      for (const r of hit) Object.assign(r, structuredClone(update[1]));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (calls.some((c) => c[0] === "maybeSingle")) {
      return { data: hit[0] ? structuredClone(hit[0]) : null, error: null };
    }
    const limit = calls.find((c) => c[0] === "limit");
    return { data: structuredClone(limit ? hit.slice(0, limit[1]) : hit), error: null };
  });
  return { tables, service, fail: (key, error) => faults.push({ key, error }) };
}

/** Console output while fn runs, every line, and fn's result. */
async function captured(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}
const quiet = async (fn) => (await captured(fn)).result;

const decide = (w, over = {}) =>
  quiet(() =>
    decideLiveRestart({
      service: w.service,
      sessionId: SESSION,
      actor: actor("owner"),
      decision: "restart",
      note: NOTE,
      now: () => NOW,
      ...over,
    }),
  );

const eligibility = (over) =>
  restartEligibility(
    {
      kind: "live",
      attempt: 1,
      status: "started",
      live_ended_at: iso(NOW - 2 * HOUR),
      live_outcome: { outcome: "technical_failure", final: true },
      decided: false,
      ...over,
    },
    NOW,
  );

// ── a: eligibility ──────────────────────────────────────────

test("a: eligibility mirrors 053: the three outcomes, final; no export after an hour; every refusal its code", () => {
  for (const outcome of ["ending_unconfirmed", "technical_failure", "abandoned"]) {
    assert.deepEqual(
      eligibility({ live_outcome: { outcome, final: true } }),
      { eligible: true },
      outcome,
    );
  }
  assert.deepEqual(eligibility({ live_outcome: null }), { eligible: true }, "no export, 2h");
  assert.deepEqual(
    eligibility({ live_outcome: null, live_ended_at: iso(NOW - HOUR) }),
    { eligible: true },
    "exactly an hour, as > now() - 1 hour",
  );
  const refusals = [
    [{ live_outcome: { outcome: "partial", final: true } }, "not_eligible_outcome"],
    [{ live_outcome: { outcome: "completed", final: true } }, "not_eligible_outcome"],
    [{ live_outcome: { final: true } }, "not_eligible_outcome"],
    [{ live_outcome: { outcome: "technical_failure", final: false } }, "not_final"],
    [{ live_outcome: { outcome: "technical_failure" } }, "not_final"],
    [{ attempt: 2 }, "not_first_attempt"],
    [{ kind: "async" }, "not_live"],
    [{ live_ended_at: null }, "not_ended"],
    [{ live_ended_at: null, live_outcome: null }, "not_ended"],
    [{ live_outcome: null, live_ended_at: iso(NOW - HOUR + 1) }, "too_soon"],
    [{ live_outcome: null, live_ended_at: iso(NOW - 30 * 60_000) }, "too_soon"],
    [{ decided: true }, "already_decided"],
    [{ status: "abandoned" }, "already_decided"],
    [{ status: "invited" }, "not_started"],
    [{ status: "expired" }, "not_started"],
  ];
  for (const [over, code] of refusals) {
    assert.deepEqual(eligibility(over), { eligible: false, code }, JSON.stringify(over));
  }
});

test("a: the decision refuses a partial attempt before any write", async () => {
  const w = world({
    sessions: [firstAttempt({ live_outcome: { outcome: "partial", final: true } })],
  });
  assert.deepEqual(await decide(w), { ok: false, code: "not_eligible_outcome" });
  assert.deepEqual(w.service.rpcs, []);
  assert.equal(w.tables.live_interview_actions.length, 0);
});

// ── b: no restart ───────────────────────────────────────────

test("b: no_restart is one action row and nothing else; a second decision is already_decided", async () => {
  const w = world();
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await decide(w, { decision: "no_restart" }), {
    ok: true,
    decision: "no_restart",
  });
  assert.equal(w.tables.live_interview_actions.length, 1);
  const [row] = w.tables.live_interview_actions;
  assert.deepEqual(
    [row.session_id, row.company_id, row.action, row.decision, row.note, row.actor_role],
    [SESSION, CO, "decide_restart", "no_restart", NOTE.trim(), "owner"],
  );
  assert.equal(row.actor_user_id, actor("owner").userId);
  assert.deepEqual(w.service.rpcs, [], "no function called");
  assert.deepEqual(w.tables.interview_sessions, before, "no session changed or created");

  for (const decision of ["no_restart", "restart"]) {
    assert.deepEqual(await decide(w, { decision }), { ok: false, code: "already_decided" });
  }
  assert.equal(w.tables.live_interview_actions.length, 1);
  assert.deepEqual(w.service.rpcs, []);
  assert.deepEqual(w.tables.interview_sessions, before);
});

// ── c: restart ──────────────────────────────────────────────

test("c: restart calls live_restart_session once, with the hash, never the token; returns the token and deadline", async () => {
  const w = world();
  const result = await decide(w);
  assert.equal(result.ok, true);
  assert.equal(result.decision, "restart");
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url, as invites");
  assert.match(result.newSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.deadline, iso(NOW + 72 * HOUR), "greatest(attempt 1's deadline, now + 72h)");

  assert.equal(w.service.rpcs.length, 1);
  const [{ name, args }] = w.service.rpcs;
  assert.equal(name, "live_restart_session");
  assert.deepEqual(args, {
    p_session_id: SESSION,
    p_company_id: CO,
    p_new_session_id: result.newSessionId,
    p_token_hash: sha256(result.token),
    p_note: NOTE.trim(),
    p_actor_user_id: actor("owner").userId,
    p_actor_name: "Synthetic Member",
    p_actor_role: "owner",
    p_invited_by: actor("owner").memberId,
    p_invited_by_name: "Synthetic Member",
  });
  assert.ok(!JSON.stringify(args).includes(result.token), "the plain token is never sent");

  const [prev, next] = w.tables.interview_sessions;
  assert.equal(prev.status, "abandoned");
  assert.deepEqual(
    [next.id, next.attempt, next.previous_attempt_id, next.status, next.token_hash],
    [result.newSessionId, 2, SESSION, "invited", sha256(result.token)],
  );
});

test("c: a later first-attempt deadline is kept; a restart ending at or after retention is refused before the call", async () => {
  const late = iso(NOW + 100 * HOUR);
  const w = world({ sessions: [firstAttempt({ expires_at: late })] });
  assert.equal((await decide(w)).deadline, late);

  const tight = world({ sessions: [firstAttempt({ delete_after: iso(NOW + 72 * HOUR) })] });
  assert.deepEqual(await decide(tight), { ok: false, code: "past_retention" });
  assert.deepEqual(tight.service.rpcs, []);
  assert.equal(tight.tables.live_interview_actions.length, 0);
});

// ── d: role ─────────────────────────────────────────────────

test("d: owner and admin decide; super_admin, hiring_manager and recruiter are refused before any read or write", async () => {
  for (const role of ["owner", "admin"]) {
    const w = world();
    assert.deepEqual(await decide(w, { actor: actor(role), decision: "no_restart" }), {
      ok: true,
      decision: "no_restart",
    });
    assert.equal(w.tables.live_interview_actions[0].actor_role, role);
    const r = world();
    assert.equal((await decide(r, { actor: actor(role) })).ok, true, `${role} restarts`);
  }
  for (const role of ["super_admin", "hiring_manager", "recruiter", "", "OWNER"]) {
    for (const decision of ["restart", "no_restart"]) {
      const w = world();
      assert.deepEqual(await decide(w, { actor: actor(role), decision }), {
        ok: false,
        code: "role_not_allowed",
      });
      assert.equal(w.service.queries.length, 0, `${role}: nothing read`);
      assert.deepEqual(w.service.rpcs, [], `${role}: nothing called`);
      assert.equal(w.tables.live_interview_actions.length, 0);
    }
    const w = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
    assert.deepEqual(
      await quiet(() =>
        reissueRestartLink({ service: w.service, restartSessionId: RESTART, actor: actor(role) }),
      ),
      { ok: false, code: "role_not_allowed" },
    );
    assert.equal(w.service.queries.length, 0);
  }
});

test("d: another company's session is not found, and nothing is written", async () => {
  const w = world();
  assert.deepEqual(await decide(w, { actor: actor("owner", { companyId: OTHER_CO }) }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(w.service.rpcs, []);
});

// ── e: note ─────────────────────────────────────────────────

test("e: a blank or too long note is refused before any read or write; a note is trimmed, 2000 allowed", async () => {
  for (const note of ["", "   ", "\n\t", "x".repeat(2001), ` ${"x".repeat(2001)} `, null, 42]) {
    for (const decision of ["restart", "no_restart"]) {
      const w = world();
      assert.deepEqual(await decide(w, { note, decision }), { ok: false, code: "bad_note" });
      assert.equal(w.service.queries.length, 0);
      assert.deepEqual(w.service.rpcs, []);
    }
  }
  const w = world();
  await decide(w, { note: ` ${"x".repeat(2000)} `, decision: "no_restart" });
  assert.equal(w.tables.live_interview_actions[0].note, "x".repeat(2000));
  const bad = world();
  assert.deepEqual(await decide(bad, { decision: "maybe" }), { ok: false, code: "bad_input" });
  assert.equal(bad.service.queries.length, 0);
});

// ── f: the database's refusals ──────────────────────────────

test("f: check_violation, unique_violation and no_data_found map to codes; the raw message never comes back", async () => {
  const RAW = "decide_restart: session 5b0f2c1e is RAW-SQL-DETAIL";
  const cases = [
    ["23514", "not_eligible"],
    ["23505", "already_decided"],
    ["P0002", "not_found"],
    ["XX000", "db_error"],
  ];
  for (const [code, mapped] of cases) {
    const a = world();
    a.fail("live_interview_actions:insert", err(code, RAW));
    const noRestart = await captured(() =>
      decideLiveRestart({
        service: a.service,
        sessionId: SESSION,
        actor: actor("owner"),
        decision: "no_restart",
        note: NOTE,
        now: () => NOW,
      }),
    );
    assert.deepEqual(noRestart.result, { ok: false, code: mapped }, `no_restart ${code}`);

    const b = world();
    b.fail("rpc:live_restart_session", err(code, RAW));
    const restart = await captured(() =>
      decideLiveRestart({
        service: b.service,
        sessionId: SESSION,
        actor: actor("owner"),
        decision: "restart",
        note: NOTE,
        now: () => NOW,
      }),
    );
    assert.deepEqual(restart.result, { ok: false, code: mapped }, `restart ${code}`);
    assert.equal(b.tables.interview_sessions.length, 1, "no restart created");
    for (const run of [noRestart, restart]) {
      assert.ok(!JSON.stringify(run.result).includes("RAW-SQL"));
      assert.ok(!run.lines.join("\n").includes("RAW-SQL"), "nor logged");
    }
  }
});

test("f: a decision that lands between the read and the write is refused by the database as already_decided", async () => {
  const w = world();
  const from = w.service.from.bind(w.service);
  let raced = false;
  w.service.from = (table) => {
    // Another Owner's decision, landing after this one's reads.
    if (table === "live_interview_actions" && !raced && w.service.queries.length >= 2) {
      raced = true;
      w.tables.live_interview_actions.push({
        id: crypto.randomUUID(),
        session_id: SESSION,
        company_id: CO,
        action: "decide_restart",
        decision: "no_restart",
        note: "other",
        actor_user_id: "u-other",
        actor_role: "admin",
      });
    }
    return from(table);
  };
  assert.deepEqual(await decide(w, { decision: "no_restart" }), {
    ok: false,
    code: "already_decided",
  });
  assert.ok(raced);
  assert.equal(w.tables.live_interview_actions.length, 1, "only the other decision");
});

// ── g: a re-issued link ─────────────────────────────────────

const reissue = (w, over = {}) =>
  quiet(() =>
    reissueRestartLink({
      service: w.service,
      restartSessionId: RESTART,
      actor: actor("owner"),
      now: () => NOW,
      ...over,
    }),
  );

test("g: a restart still invited gets a new token on the same session; no session is created", async () => {
  const w = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  const before = structuredClone(w.tables.interview_sessions);
  const result = await reissue(w);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, RESTART);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(w.tables.interview_sessions.length, 2, "no new session");
  const [prev, next] = w.tables.interview_sessions;
  assert.deepEqual(prev, before[0], "attempt 1 untouched");
  assert.equal(next.id, RESTART);
  assert.equal(next.token_hash, sha256(result.token), "the hash stored, on that session");
  assert.notEqual(next.token_hash, before[1].token_hash, "the old link no longer works");
  assert.deepEqual(
    { ...next, token_hash: null },
    { ...before[1], token_hash: null },
    "only the hash",
  );
  assert.deepEqual(w.service.rpcs, []);
  const again = await reissue(w);
  assert.notEqual(again.token, result.token, "a fresh token each time");
  assert.equal(w.tables.interview_sessions.length, 2);
});

test("g: a started restart, a first attempt, another company's or a missing session is refused, nothing changed", async () => {
  const cases = [
    [
      [firstAttempt({ status: "abandoned" }), restartRow({ status: "started" })],
      RESTART,
      "not_invited",
    ],
    [
      [firstAttempt({ status: "abandoned" }), restartRow({ status: "expired" })],
      RESTART,
      "not_invited",
    ],
    [[firstAttempt()], SESSION, "not_restart"],
    [
      [firstAttempt({ status: "abandoned" }), restartRow({ company_id: OTHER_CO })],
      RESTART,
      "not_found",
    ],
    [[firstAttempt()], RESTART, "not_found"],
  ];
  for (const [sessions, id, code] of cases) {
    const w = world({ sessions });
    const before = structuredClone(w.tables.interview_sessions);
    assert.deepEqual(await reissue(w, { restartSessionId: id }), { ok: false, code }, code);
    assert.deepEqual(w.tables.interview_sessions, before);
  }
});

test("g: a restart that starts between the read and the write keeps its link", async () => {
  const w = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  const from = w.service.from.bind(w.service);
  w.service.from = (table) => {
    if (w.service.queries.length === 1) w.tables.interview_sessions[1].status = "started";
    return from(table);
  };
  assert.deepEqual(await reissue(w), { ok: false, code: "not_invited" });
  assert.equal(w.tables.interview_sessions[1].token_hash, "2".repeat(64));
});

// ── j, k, l: a re-issue and the restart's deadline ──────────

const wrote = (w) => w.service.queries.filter((q) => q.calls.some((c) => c[0] === "update"));

test("j: a restart still invited but past its deadline is refused (expired), token_hash unchanged", async () => {
  for (const expires_at of [iso(NOW - 1000), iso(NOW), iso(NOW - 48 * HOUR)]) {
    const w = world({
      sessions: [firstAttempt({ status: "abandoned" }), restartRow({ expires_at })],
    });
    const before = structuredClone(w.tables.interview_sessions);
    assert.deepEqual(await reissue(w), { ok: false, code: "expired" }, expires_at);
    assert.deepEqual(w.tables.interview_sessions, before, "token_hash unchanged");
    assert.deepEqual(wrote(w), [], "refused at the read: nothing written");
  }
});

test("k: a deadline passing between the read and the write is refused by the write's own filter, unchanged", async () => {
  const w = world({
    sessions: [firstAttempt({ status: "abandoned" }), restartRow({ expires_at: iso(NOW + 1000) })],
  });
  const before = structuredClone(w.tables.interview_sessions);
  // Before the deadline at the read; past it at the write.
  const times = [NOW, NOW + 2000];
  const clock = () => (times.length > 1 ? times.shift() : times[0]);
  assert.deepEqual(await reissue(w, { now: clock }), { ok: false, code: "expired" });
  assert.deepEqual(w.tables.interview_sessions, before, "token_hash unchanged");
  const [update] = wrote(w);
  assert.ok(update, "the read let it through: the write's filter refused it");
  assert.deepEqual(
    update.calls.filter((c) => c[0] === "eq" || c[0] === "gt").map((c) => c.slice(1)),
    [
      ["id", RESTART],
      ["company_id", CO],
      ["kind", "live"],
      ["attempt", 2],
      ["status", "invited"],
      ["expires_at", iso(NOW + 2000)],
    ],
    "company, invited, attempt 2 and the deadline at the write's time, in the filter",
  );
});

test("l: another company's restart is not found, token_hash unchanged", async () => {
  const w = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await reissue(w, { actor: actor("owner", { companyId: OTHER_CO }) }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(w.tables.interview_sessions, before);
  assert.deepEqual(wrote(w), []);
});

// ── h: the deadline after delivery ──────────────────────────

const extend = (w, over = {}) =>
  quiet(() =>
    extendRestartDeadline({
      service: w.service,
      restartSessionId: RESTART,
      companyId: CO,
      ...over,
    }),
  );

test("h: extend calls live_restart_extend_deadline with the ids and returns the deadline", async () => {
  const w = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  assert.deepEqual(await extend(w), { ok: true, deadline: iso(NOW + 72 * HOUR) });
  assert.deepEqual(w.service.rpcs, [
    { name: "live_restart_extend_deadline", args: { p_session_id: RESTART, p_company_id: CO } },
  ]);
  assert.equal(w.tables.interview_sessions[1].expires_at, iso(NOW + 72 * HOUR));
  assert.equal(w.service.queries.length, 0, "the function does the work, not a table write");
});

test("h: the function's refusals map to codes, never its message", async () => {
  const started = world({
    sessions: [firstAttempt({ status: "abandoned" }), restartRow({ status: "started" })],
  });
  assert.deepEqual(await extend(started), { ok: false, code: "not_extendable" });
  const missing = world();
  assert.deepEqual(await extend(missing), { ok: false, code: "not_found" });
  const other = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  assert.deepEqual(await extend(other, { companyId: OTHER_CO }), { ok: false, code: "not_found" });
  const broken = world({ sessions: [firstAttempt({ status: "abandoned" }), restartRow()] });
  broken.fail("rpc:live_restart_extend_deadline", err("XX000", "RAW-SQL-DETAIL"));
  const run = await captured(() =>
    extendRestartDeadline({ service: broken.service, restartSessionId: RESTART, companyId: CO }),
  );
  assert.deepEqual(run.result, { ok: false, code: "db_error" });
  assert.ok(!run.lines.join("\n").includes("RAW-SQL"));
});

// ── i: logs ─────────────────────────────────────────────────

test("i: no token, hash, note or email in any log line: ids, roles and codes only", async () => {
  const note = `Candidate ${EMAIL} said the call dropped.`;
  const lines = [];
  const tokens = [];
  const run = async (fn) => {
    const r = await captured(fn);
    lines.push(...r.lines);
    return r.result;
  };
  const w = world();
  const restarted = await run(() =>
    decideLiveRestart({
      service: w.service,
      sessionId: SESSION,
      actor: actor("owner"),
      decision: "restart",
      note,
      now: () => NOW,
    }),
  );
  tokens.push(restarted.token);
  const next = w.tables.interview_sessions[1];
  const reissued = await run(() =>
    reissueRestartLink({
      service: w.service,
      restartSessionId: next.id,
      actor: actor("admin"),
      now: () => NOW,
    }),
  );
  tokens.push(reissued.token);
  await run(() =>
    extendRestartDeadline({ service: w.service, restartSessionId: next.id, companyId: CO }),
  );
  // Refusals too: another decision, a refused re-issue, a decision on a fresh world.
  await run(() =>
    decideLiveRestart({
      service: w.service,
      sessionId: SESSION,
      actor: actor("owner"),
      decision: "no_restart",
      note,
      now: () => NOW,
    }),
  );
  const n = world();
  await run(() =>
    decideLiveRestart({
      service: n.service,
      sessionId: SESSION,
      actor: actor("admin"),
      decision: "no_restart",
      note,
      now: () => NOW,
    }),
  );

  assert.ok(lines.length >= 5, "every step logged a line");
  const text = lines.join("\n");
  for (const t of tokens) {
    assert.ok(t && !text.includes(t), "no raw token");
    assert.ok(!text.includes(sha256(t)), "no token hash");
  }
  assert.ok(!text.includes(note) && !text.includes(note.trim().slice(0, 20)), "no note");
  assert.ok(!text.includes(EMAIL), "no email");
  assert.ok(!text.includes("Synthetic Member"), "no names");
  for (const line of lines) assert.match(line, /^\[live-restart\] /);
});
