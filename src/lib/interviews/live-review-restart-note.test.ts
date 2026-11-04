/**
 * "A restart is your decision for this interview" (F10 C6f, live-review.ts
 * restartNoteFor): shown only on the company's review, to an owner or admin,
 * of the latest, undecided first attempt while a restart can be decided now or
 * soon (a recruiter or hiring manager keeps C5's waiting line); hidden after a
 * restart or a no restart, on an earlier attempt, on the restart itself, on
 * the super admin's read-only view, for an outcome that is never restarted,
 * past the retention date, and whenever the restart state is unknown. The
 * page's retention rule agrees with decideLiveRestart's past_retention.
 *
 *   node --test src/lib/interviews/live-review-restart-note.test.ts
 *
 * loadLiveReview, loadPlatformLiveReview, restartEligibility and the review
 * client are the shipped code; the database is this file's own small store.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
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
const { loadLiveReview, loadPlatformLiveReview } = await import("./live-review.ts");
const { decideLiveRestart } = await import("./live-restart.ts");
const { restartPanelFor } = await import("./live-review-types.ts");
const { LiveReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client.tsx"
);
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const CO = "7aad434d-0000-4000-8000-0000000000f6";
const JOB = "2d4a8cde-0000-4000-8000-0000000000f6";
const APP = "03e4863f-0000-4000-8000-0000000000f6";
const FIRST = "5b0f2c1e-0000-4000-8000-0000000000f6";
const SECOND = "5b0f2c1e-0000-4000-8000-0000000000f7";
const NOTE = "A restart is your decision for this interview.";
const RESTARTABLE = ["ending_unconfirmed", "technical_failure", "abandoned"];

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
    live_ended_at: iso(NOW - 2 * HOUR),
    live_outcome: { v: 6, outcome: "technical_failure", final: true },
    live_settings: { v: 2, interviewer_name: "Sarah" },
    questions_snapshot: [],
    scoring_snapshot: [],
    expires_at: iso(NOW + DAY),
    delete_after: iso(NOW + 180 * DAY),
    created_at: iso(NOW - 2 * DAY),
    ...over,
  };
}
const outcome = (name, final = true) => ({ v: 6, outcome: name, final });
const secondAttempt = (over = {}) =>
  firstAttempt({
    id: SECOND,
    attempt: 2,
    previous_attempt_id: FIRST,
    status: "invited",
    live_ended_at: null,
    live_outcome: null,
    expires_at: iso(NOW + 60 * HOUR),
    created_at: iso(NOW - HOUR),
    ...over,
  });
const decided = (decision, sessionId = FIRST) => ({
  session_id: sessionId,
  company_id: CO,
  action: "decide_restart",
  decision,
  note: "Synthetic note.",
  actor_name: "Synthetic Owner",
  actor_role: "owner",
  created_at: iso(NOW - HOUR),
});

/** Tables with eq/in/is/limit/maybeSingle and inserts; `failDecisionRead` fails the decision's read. */
function world({ sessions = [firstAttempt()], actions = [], failDecisionRead = false } = {}) {
  const tables = {
    interview_sessions: structuredClone(sessions),
    live_interview_actions: structuredClone(actions),
    admin_access_logs: [],
  };
  const service = fakeService((table, calls) => {
    const insert = calls.find((c) => c[0] === "insert");
    // Any restart that reaches the database is refused there: nothing is written.
    if (table.startsWith("rpc:")) return { data: null, error: { code: "XX000", message: "test" } };
    if (insert) {
      if (!tables[table]) tables[table] = [];
      tables[table].push(structuredClone(insert[1]));
      return { data: null, error: null };
    }
    const decisionRead =
      table === "live_interview_actions" &&
      calls.some((c) => c[0] === "eq" && c[1] === "action" && c[2] === "decide_restart");
    if (decisionRead && failDecisionRead) {
      return { data: null, error: { code: "57014", message: "RAW-SQL-DETAIL timeout" } };
    }
    const hit = (tables[table] ?? []).filter((r) =>
      calls.every((c) => {
        if (c[0] === "eq") return r[c[1]] === c[2];
        if (c[0] === "in") return c[2].includes(r[c[1]]);
        if (c[0] === "is") return (r[c[1]] ?? null) === c[2];
        return true;
      }),
    );
    if (calls.some((c) => c[0] === "maybeSingle")) {
      return { data: hit[0] ? structuredClone(hit[0]) : null, error: null };
    }
    const limit = calls.find((c) => c[0] === "limit");
    return { data: structuredClone(limit ? hit.slice(0, limit[1]) : hit), error: null };
  });
  return { tables, service };
}

const ctx = (role) => ({
  user: { id: "u0000000-0000-4000-8000-0000000000f6", email: "member@example.test" },
  companyId: CO,
  role,
  memberName: "Synthetic Member",
  memberId: "m0000000-0000-4000-8000-0000000000f6",
});

async function at(ms, fn) {
  mock.timers.enable({ apis: ["Date"], now: ms });
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
    mock.timers.reset();
  }
}

const render = (view, mode = "company", canAct = true) =>
  renderToStaticMarkup(
    createElement(LiveReviewClient, {
      view,
      candidateName: "C",
      jobTitle: "J",
      canAct,
      mode,
      restartActions: mode === "company" && canAct ? { decide: async () => ({}) } : undefined,
    }),
  );

/** The company's review of `id`: the note the server set, and whether the page shows it. */
async function company(w, id = FIRST, role = "owner", nowMs = NOW) {
  const view = await at(nowMs, () =>
    loadLiveReview(ctx(role), id, { service: w.service, scope: async () => ({ scoped: false }) }),
  );
  assert.ok(view, `the review of ${id} loads`);
  const html = render(view, "company", role === "owner" || role === "admin");
  return {
    view,
    note: view.header.restartNote,
    shown: /data-restart-note="true"/.test(html),
    html,
  };
}

function shown(r, name) {
  assert.equal(r.note, NOTE, `${name}: the server sets the note`);
  assert.ok(r.shown, `${name}: the page shows it`);
}
function hidden(r, name) {
  assert.equal(r.note, null, `${name}: no note from the server`);
  assert.ok(!r.shown, `${name}: the page shows none`);
}

test("a: the latest, undecided first attempt with a restartable outcome shows the note to an owner or admin", async () => {
  for (const name of RESTARTABLE) {
    for (const role of ["owner", "admin"]) {
      const r = await company(
        world({ sessions: [firstAttempt({ live_outcome: outcome(name) })] }),
        FIRST,
        role,
      );
      shown(r, `${name} for ${role}`);
    }
  }
});

test("a: pending counts as possible: too soon after the end, or not final yet with a restartable outcome", async () => {
  const tooSoon = firstAttempt({ live_outcome: null, live_ended_at: iso(NOW - 10 * 60_000) });
  const r = await company(world({ sessions: [tooSoon] }));
  assert.equal(r.view.restart.reason, "too_soon");
  shown(r, "too soon");
  // An hour after the end with no export at all: decidable (053's backstop).
  shown(
    await company(world({ sessions: [firstAttempt({ live_outcome: null })] })),
    "no export, an hour later",
  );
  for (const name of RESTARTABLE) {
    const w = world({ sessions: [firstAttempt({ live_outcome: outcome(name, false) })] });
    const n = await company(w);
    assert.equal(n.view.restart.reason, "not_final", name);
    shown(n, `not final yet, ${name}`);
  }
});

const WAITING = "A restart decision is waiting for an owner or admin.";

test("a: a recruiter or hiring manager never sees the note, keeps the waiting line and the same review", async () => {
  for (const name of RESTARTABLE) {
    const w = world({ sessions: [firstAttempt({ live_outcome: outcome(name) })] });
    const owner = await company(w, FIRST, "owner");
    shown(owner, `${name} for owner`);
    assert.ok(!owner.html.includes(WAITING), "the owner decides; no waiting line");
    for (const role of ["recruiter", "hiring_manager"]) {
      const r = await company(w, FIRST, role);
      hidden(r, `${name} for ${role}`);
      assert.ok(r.html.includes(WAITING), `${name}: ${role} sees the waiting line`);
      assert.match(r.html, /data-restart-panel="awaiting_decision"/);
      assert.doesNotMatch(r.html, /data-restart-form/, `${role}: no decision form`);
      const { restartNote: _o, ...ownerHeader } = owner.view.header;
      const { restartNote: _r, ...theirHeader } = r.view.header;
      assert.deepEqual(theirHeader, ownerHeader, `${role}: the same review otherwise`);
      assert.deepEqual(
        r.view.questions.map((q) => q.position),
        owner.view.questions.map((q) => q.position),
      );
    }
  }
});

test("b: after a restart, neither attempt 1 nor attempt 2 shows it", async () => {
  const w = world({
    sessions: [firstAttempt({ status: "abandoned" }), secondAttempt()],
    actions: [decided("restart")],
  });
  hidden(await company(w, FIRST), "attempt 1 after the restart");
  hidden(await company(w, SECOND), "attempt 2, invited");
  const started = world({
    sessions: [
      firstAttempt({ status: "abandoned" }),
      secondAttempt({
        status: "started",
        live_ended_at: iso(NOW - 2 * HOUR),
        live_outcome: outcome("technical_failure"),
      }),
    ],
    actions: [decided("restart")],
  });
  hidden(await company(started, SECOND), "attempt 2, ended with a restartable outcome");
  // An earlier attempt 1 that still looks decidable (no decision row, still started):
  // only being superseded hides it.
  const stale = world({ sessions: [firstAttempt(), secondAttempt()] });
  const r = await company(stale, FIRST);
  assert.equal(r.view.attempt.isLatest, false);
  hidden(r, "a superseded attempt 1 with no decision recorded");
});

test("c: after no restart it is hidden, including when the outcome is later reopened (not final again)", async () => {
  const w = world({ actions: [decided("no_restart")] });
  hidden(await company(w), "no restart");
  const reopened = world({
    sessions: [firstAttempt({ live_outcome: outcome("technical_failure", false) })],
    actions: [decided("no_restart")],
  });
  const r = await company(reopened);
  assert.equal(r.view.restart.reason, "not_final", "eligibility alone would read it as pending");
  hidden(r, "no restart, outcome not final again");
});

test("d: the super admin's read-only view never shows it; company admins still do", async () => {
  const w = world();
  const platform = await at(NOW, () =>
    loadPlatformLiveReview("a0000000-0000-4000-8000-0000000000aa", FIRST, { service: w.service }),
  );
  assert.equal(platform.ok, true);
  assert.equal(platform.view.header.restartNote, null, "the platform view carries no note");
  assert.doesNotMatch(render(platform.view, "platform", false), /data-restart-note="true"/);
  // Even a view that carries the note renders none in platform mode.
  const theirs = await company(world());
  shown(theirs, "the company admin's own view");
  assert.doesNotMatch(render(theirs.view, "platform", false), /data-restart-note="true"/);
  assert.doesNotMatch(render(theirs.view, "platform", true), /data-restart-note="true"/);
  shown(await company(world(), FIRST, "admin"), "a company admin");
});

test("e: an outcome that is never restarted, final or not yet, shows nothing", async () => {
  for (const name of ["completed", "partial"]) {
    hidden(
      await company(world({ sessions: [firstAttempt({ live_outcome: outcome(name) })] })),
      name,
    );
    hidden(
      await company(world({ sessions: [firstAttempt({ live_outcome: outcome(name, false) })] })),
      `${name}, not final yet`,
    );
  }
  hidden(
    await company(world({ sessions: [firstAttempt({ live_outcome: { v: 6, final: false } })] })),
    "not final, no outcome named",
  );
});

test("unknown or impossible: not ended, never started, no status, a failed decision read, past retention", async () => {
  const cases = [
    ["not ended", firstAttempt({ live_ended_at: null })],
    ["never started", firstAttempt({ status: "invited", live_ended_at: null, live_outcome: null })],
    ["no status", firstAttempt({ status: undefined })],
    [
      "deleted after the restart's deadline would end",
      firstAttempt({ delete_after: iso(NOW + 72 * HOUR) }),
    ],
    ["retention already expired", firstAttempt({ delete_after: iso(NOW - DAY) })],
  ];
  for (const [name, session] of cases) hidden(await company(world({ sessions: [session] })), name);
  shown(
    await company(
      world({ sessions: [firstAttempt({ delete_after: iso(NOW + 72 * HOUR + 60_000) })] }),
    ),
    "deleted just after the restart's deadline",
  );

  const failed = world({ failDecisionRead: true });
  const r = await company(failed);
  hidden(r, "the decision could not be read");
  assert.equal(r.view.restart, null, "the restart state is unknown");
  assert.deepEqual(restartPanelFor(r.view.restart, { canAct: true, platform: false }), {
    panel: "none",
  });
  assert.doesNotMatch(r.html, /data-restart-form/, "no decision offered while it is unknown");
});

test("f: the rest of the header is the same with or without the note", async () => {
  const withNote = await company(
    world({ sessions: [firstAttempt({ live_outcome: outcome("ending_unconfirmed") })] }),
  );
  const without = await company(
    world({
      sessions: [firstAttempt({ live_outcome: outcome("ending_unconfirmed") })],
      actions: [decided("no_restart")],
    }),
  );
  shown(withNote, "undecided");
  hidden(without, "decided");
  const { restartNote: _a, ...a } = withNote.view.header;
  const { restartNote: _b, ...b } = without.view.header;
  assert.deepEqual(a, b, "only the note differs");
  assert.equal(a.state, "ending_unconfirmed");
  assert.equal(a.label, "Ending not confirmed - needs review");
});

test("retention parity: the page hides the note exactly when decideLiveRestart refuses past_retention", async () => {
  const actor = {
    userId: "u0000000-0000-4000-8000-0000000000f6",
    memberId: "m0000000-0000-4000-8000-0000000000f6",
    name: "Synthetic Owner",
    role: "owner",
    companyId: CO,
  };
  // The deadline a restart decided at NOW would get: greatest(the invite's, NOW + 72h).
  const deadline = (expires) => Math.max(expires, NOW + 72 * HOUR);
  const invites = [
    NOW - 3 * DAY,
    NOW - 1,
    NOW + HOUR,
    NOW + 72 * HOUR,
    NOW + 72 * HOUR + 1,
    NOW + 9 * DAY,
  ];
  const seen = { past: 0, open: 0, boundary: 0 };
  for (const expires of invites) {
    const d = deadline(expires);
    const deletions = [
      null,
      NOW - DAY,
      NOW,
      d - 60_000,
      d - 1,
      d,
      d + 1,
      d + 60_000,
      NOW + 180 * DAY,
    ];
    for (const deleteAfter of deletions) {
      const session = firstAttempt({
        expires_at: iso(expires),
        delete_after: deleteAfter === null ? null : iso(deleteAfter),
      });
      const name = `invite ${expires - NOW}ms, delete_after ${deleteAfter === null ? "none" : `${deleteAfter - d}ms from the deadline`}`;
      const page = await company(world({ sessions: [session] }));
      const pagePast = page.note === null;
      const w = world({ sessions: [session] });
      const decided = await at(NOW, () =>
        decideLiveRestart({
          service: w.service,
          sessionId: FIRST,
          actor,
          decision: "restart",
          note: "Synthetic note.",
          now: () => NOW,
        }),
      );
      const decidePast = !decided.ok && decided.code === "past_retention";
      assert.equal(pagePast, decidePast, name);
      // Not past retention: decideLiveRestart went on to the database (refused there here).
      assert.equal(w.service.rpcs.length, decidePast ? 0 : 1, `${name}: reached the restart`);
      seen[decidePast ? "past" : "open"] += 1;
      if (deleteAfter === d) {
        assert.equal(decidePast, true, `${name}: the exact boundary is past retention`);
        seen.boundary += 1;
      }
    }
  }
  assert.ok(seen.past > 10 && seen.open > 10, `both sides covered: ${JSON.stringify(seen)}`);
  assert.equal(seen.boundary, invites.length);
});
