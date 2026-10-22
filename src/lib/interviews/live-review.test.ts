/**
 * The recruiter review of an AI Video Interview: the view the page is sent
 * (lib/interviews/live-review.ts), what the page renders from it
 * (_live-review-client.tsx, through react-dom/server), who may act, and what
 * never reaches the browser. The commit 2 fixture is saved, transcribed and
 * scored (fake Whisper, fake model) into fake-live-db.mjs. Every word is made
 * up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-review.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__liveReviewService; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { throw new Error('test: pass a scope'); }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
  ].join("\\n"),
  "next/navigation": "export function useRouter() { return { refresh() {} }; }",
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
// The next/link stub above is a data: module, which cannot import react itself.
globalThis.__h = createElement;
const {
  loadLiveReview,
  buildLiveReviewView,
  canActOnLiveReview,
  runLiveRecovery,
  signLiveTurnAudio,
} = await import("./live-review.ts");
const { LiveReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client.tsx"
);
const { scoreLiveSession } = await import("./live-scoring.ts");
const { resolveNeedsCheck } = await import("./live-recovery.ts");
const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { CONFIRMED_EXIT_CODES, saveLiveExport } = await import("./live-ingest.ts");

/** D10 switched on for one test: candidate_ended counts as a confirmed exit, for the whole test. */
async function withD10(fn) {
  CONFIRMED_EXIT_CODES.add("candidate_ended");
  try {
    return await fn();
  } finally {
    CONFIRMED_EXIT_CODES.delete("candidate_ended");
  }
}

const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000e8";
const RESTART = "5b0f2c1e-0000-4000-8000-0000000000e9";
const CO = "7aad434d-0000-4000-8000-000000000001";
const OTHER_CO = "7aad434d-0000-4000-8000-000000000002";
const JOB = "2d4a8cde-0000-4000-8000-000000000008";
const OTHER_JOB = "2d4a8cde-0000-4000-8000-000000000009";
const APP = "03e4863f-0000-4000-8000-000000000008";
const CV_EMAIL = "alex.example@example.com";
const GUIDE = (p) =>
  `PRIVATE GUIDE ${p}: strong answers name their own work; weak ones stay general.`;
const QUESTIONS = FIXTURE.questions
  .filter((q) => q.position <= 8)
  .map((q) => ({
    question_id: `q-${q.position}`,
    position: q.position,
    text: q.text,
    source: q.position <= 4 ? "job" : q.position === 8 ? "general_experience" : "cv",
    competency: "Ownership",
    scoring_guide: GUIDE(q.position),
    guide_source: "ai",
    weight: null,
  }));

function frozenRow(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    kind: "live",
    attempt: 1,
    previous_attempt_id: null,
    provider_session_id: FIXTURE.session_id,
    live_outcome: null,
    live_settings: {
      v: 2,
      interviewer_name: "Sarah",
      questions_frozen: {
        at: "2026-10-16T05:40:00.000Z",
        prompt_version: "live-questions-v1",
        policy_version: "question-mix-v1",
        model: "claude-haiku-5-5",
        calls: 1,
        input_tokens: 1,
        output_tokens: 1,
        rewritten: 0,
        replaced: 0,
      },
    },
    ...snapshotsFor(QUESTIONS),
    ...over,
  };
}

async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

const ctxOf = (role, over = {}) => ({
  user: { id: `u-${role}`, email: `${role}@company.test` },
  companyId: CO,
  role,
  memberName: `${role} name`,
  ...over,
});
const ALL = async () => ({ scoped: false });
const deps = (db, scope = ALL) => ({ service: db.service, scope });

const positionOf = (db, t) =>
  t.question_position ??
  db.tables.interview_turns.find((x) => x.id === t.responds_to_turn_id)?.question_position;
const candidateTurns = (db, id = SESSION) =>
  db.tables.interview_turns
    .filter((t) => t.session_id === id && t.speaker === "candidate")
    .sort((a, b) => a.sequence - b.sequence);

async function saved(text) {
  const db = fakeLiveDb({
    interview_sessions: [frozenRow()],
    jobs: [{ id: JOB, company_id: CO, title: "Backend Engineer" }],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Example",
        cv_text: `Alex Example, ${CV_EMAIL}, +92 300 0000000`,
      },
    ],
  });
  globalThis.__liveReviewService = db.service;
  const provider = createFakeLiveProvider(FIXTURE);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  await quiet(() =>
    saveLiveExport(
      SESSION,
      {
        ...parseExport(provider.exportOf(providerSessionId)),
        provider_session_id: FIXTURE.session_id,
      },
      {
        service: db.service,
        fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
        now: () => Date.now(),
      },
    ),
  );
  for (const t of candidateTurns(db)) {
    await quiet(() =>
      handleLiveTurnTranscribe(
        {
          id: `j${t.sequence}`,
          payload: { turnId: t.id, sessionId: SESSION },
          attempts: 0,
          max_attempts: 3,
        },
        undefined,
        {
          service: db.service,
          onDecided: async () => {},
          transcribe: async () => {
            const said =
              text?.(positionOf(db, t)) ??
              `On question ${positionOf(db, t)} I personally rebuilt the import service and cut the runtime in half.`;
            return { text: said, segments: [{ start: 0, end: 4, text: said, noSpeech: 0.01 }] };
          },
        },
      ),
    );
  }
  return db;
}

const SCORES = { 1: 70, 2: 60, 3: 80, 4: 50, 5: 90 };
function fakeModel() {
  const requests = [];
  return {
    requests,
    call: async (request) => {
      requests.push(request);
      const user = request.messages[0].content;
      const asked = user.match(/## Question asked\n([^\n]+)/)[1];
      const p = QUESTIONS.find((q) => q.text === asked).position;
      const line = user.split("\n").find((l) => l.startsWith("Candidate: "));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              score: SCORES[p],
              confidence: "high",
              rationale: `The candidate named their own work on question ${p}.`,
              quotes: [line.slice(11).split(" ").slice(0, 6).join(" ")],
            }),
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 120 },
      };
    },
  };
}
const score = (db, model, id = SESSION) =>
  quiet(() => scoreLiveSession(id, { service: db.service, call: model.call, enabled: true }));

async function resolveAll(db, model, decision = "score") {
  const r = {
    service: db.service,
    caller: { kind: "company", userId: "u-admin", name: "A", role: "admin", companyId: CO },
    score: (id) => score(db, model, id),
  };
  for (const q of db.tables.interview_sessions[0].live_outcome.questions.filter(
    (x) => x.needs_check,
  )) {
    await quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position: q.position, decision, note: "Checked." },
        r,
      ),
    );
  }
}

const view = (db, role = "owner", id = SESSION) =>
  quiet(() => loadLiveReview(ctxOf(role), id, deps(db)));
const render = (v, role = "owner") =>
  renderToStaticMarkup(
    createElement(LiveReviewClient, {
      view: v,
      candidateName: "Alex Example",
      jobTitle: "Backend Engineer",
      canAct: canActOnLiveReview(role),
    }),
  );
const byPos = (v, p) => v.questions.find((q) => q.position === p);

/* ── each state ───────────────────────────────────────────────── */

test("waiting for review: every answered question waits for a timing check; no overall; the ending is not confirmed", async () => {
  const db = await saved();
  await score(db, fakeModel());
  const v = await view(db);
  assert.deepEqual(
    [v.header.state, v.header.label, v.header.overall, v.header.scoreStatus],
    ["ending_unconfirmed", "Ending not confirmed - needs review", null, "pending"],
  );
  assert.deepEqual(
    v.questions.map((q) => [q.position, q.status]),
    [
      [1, "waiting_review"],
      [2, "waiting_review"],
      [3, "waiting_review"],
      [4, "waiting_review"],
      [5, "waiting_review"],
      [6, "skipped"],
      [7, "not_reached"],
      [8, "not_reached"],
    ],
  );
  assert.ok(
    v.questions
      .slice(0, 5)
      .every((q) => q.flags.some((f) => f.kind === "timing" && f.resolved === null)),
  );
  assert.ok(
    v.questions.slice(0, 5).every((q) => q.score === null),
    "no score while waiting",
  );
  const html = render(v);
  assert.match(html, /data-no-overall/);
  assert.doesNotMatch(html, /data-overall/);
  assert.equal((html.match(/data-status="waiting_review"/g) ?? []).length, 5);
  assert.equal((html.match(/data-flag="timing"/g) ?? []).length, 5);
  assert.match(html, /overlapped the interviewer&#x27;s speech/);
});

test("partial: the overall, labelled partial; scores, confidence apart, rationales, quotes on the candidate's turn", () =>
  withD10(async () => {
    const db = await saved();
    const model = fakeModel();
    await resolveAll(db, model);
    const v = await view(db);
    assert.deepEqual(
      [
        v.header.state,
        v.header.overall,
        v.header.answered,
        v.header.total,
        v.header.skipped,
        v.header.completionPercent,
        v.header.partial,
      ],
      ["partial", 58, 5, 8, 1, 63, true],
    );
    const q2 = byPos(v, 2);
    assert.deepEqual(
      [q2.status, q2.score, q2.confidence, q2.followUps],
      ["answered", 60, "high", 2],
    );
    assert.match(q2.rationale, /question 2/);
    const candidateIds = new Set(candidateTurns(db).map((t) => t.id));
    assert.ok(
      q2.quotes.length === 1 && candidateIds.has(q2.quotes[0].turnId),
      "the quote jumps to a candidate turn",
    );
    assert.equal(q2.quotes[0].startSeconds, 0);
    assert.deepEqual([byPos(v, 6).status, byPos(v, 6).score], ["skipped", 0]);
    assert.deepEqual([byPos(v, 7).status, byPos(v, 7).score], ["not_reached", null]);
    assert.deepEqual(
      [byPos(v, 1).sourceLabel, byPos(v, 5).sourceLabel, byPos(v, 8).sourceLabel],
      ["Job question", "CV question", "General question"],
    );
    // The conversation: Sarah's question, follow-ups and the candidate's answers, each playable.
    assert.deepEqual(
      q2.conversation.map((t) => [t.speaker, t.label, t.hasAudio]),
      [
        ["interviewer", "Sarah", true],
        ["candidate", "Candidate", true],
        ["interviewer", "Sarah · follow-up", true],
        ["candidate", "Candidate", true],
        ["interviewer", "Sarah · follow-up", true],
        ["candidate", "Candidate", true],
        ["interviewer", "Sarah", true],
      ],
    );
    const html = render(v);
    assert.match(html, /data-overall/);
    assert.match(html, />58</);
    assert.match(html, /data-partial/);
    assert.match(html, /Partial interview: not comparable with completed interviews/);
    assert.match(html, /Confidence: high/);
    assert.match(html, /Conversation · 2 follow-ups/);
    assert.match(html, /Skipped - 0 \(no answer\)/);
    // A skipped 0 is never shown as a bare number, so it cannot read like a bad answer's 0.
    const skippedCard = html.slice(
      html.indexOf('data-question="6"'),
      html.indexOf('data-question="7"'),
    );
    assert.doesNotMatch(skippedCard, /text-\[28px\][^>]*>0</);
    assert.match(html, /5 of 8 answered/);
    assert.match(html, /1 skipped/);
    assert.match(html, /63% complete/);
  }));

test("incomplete: per-question scores, never an overall, 'Incomplete - 3 of 8 answered'", () =>
  withD10(async () => {
    const db = await saved((p) => ([4, 5].includes(p) ? "um... uh" : undefined));
    const model = fakeModel();
    await resolveAll(db, model);
    assert.equal(db.tables.live_interview_scores[0].status, "incomplete");
    const v = await view(db);
    assert.deepEqual(
      [v.header.state, v.header.label, v.header.overall, v.header.partial],
      ["incomplete", "Incomplete - 3 of 8 answered", null, true],
    );
    assert.deepEqual(
      [byPos(v, 1).score, byPos(v, 4).status, byPos(v, 4).score],
      [70, "skipped", 0],
    );
    const html = render(v);
    assert.match(html, /Incomplete - 3 of 8 answered/);
    assert.match(html, /No overall score: the interview ended early/);
    assert.doesNotMatch(html, /data-overall/);
  }));

/** A small synthetic completed interview: two questions, both answered and scored. */
function completedInput() {
  const turn = (id, sequence, speaker, kind, position, text, extra = {}) => ({
    id,
    sequence,
    speaker,
    kind,
    question_position: position,
    responds_to_turn_id: null,
    text: speaker === "interviewer" ? text : null,
    transcript: speaker === "candidate" ? text : null,
    transcript_status: speaker === "candidate" ? "done" : null,
    transcript_segments:
      speaker === "candidate" ? [{ start: 2, end: 6, text, noSpeech: 0.01 }] : null,
    transcript_error: null,
    media_path: `s/t${sequence}.wav`,
    content_purged_at: null,
    offset_ms: sequence * 10_000,
    ...extra,
  });
  const entry = (position, s) => ({
    position,
    source: "job",
    competency: "Ownership",
    weight: 1,
    status: "scored",
    reason: "answered",
    score: s,
    confidence: "medium",
    rationale: `Specific about their own work on ${position}.`,
    quotes: ["I led the migration myself"],
    dropped_quotes: 0,
    model: "m",
    input_tokens: 1,
    output_tokens: 1,
    scored_at: "2026-10-20T10:00:00.000Z",
    timing_check: false,
    style_check: false,
  });
  const facts = (position) => ({
    position,
    source: "job",
    status: "answered",
    confirmed: true,
    follow_ups: 0,
    repeats: 0,
    answer_ms: 5000,
    wording_differs: false,
    needs_check: false,
  });
  return {
    session: {
      id: "s",
      live_settings: { interviewer_name: "Sarah" },
      live_outcome: {
        final: true,
        outcome: "completed",
        questions: [facts(1), facts(2)],
        answered_count: 2,
        skipped_count: 0,
        total: 2,
        completion_percent: 100,
      },
    },
    frozenQuestions: [
      { position: 1, source: "job", text: "Tell me about a migration you led." },
      { position: 2, source: "cv", text: "How did you find the bottleneck?" },
    ],
    turns: [
      turn("a", 1, "interviewer", "base_question", 1, "Tell me about a migration you led."),
      {
        ...turn("b", 2, "candidate", null, null, "I led the migration myself over two months."),
        responds_to_turn_id: "a",
      },
      turn("c", 3, "interviewer", "base_question", 2, "How did you find the bottleneck?"),
      {
        ...turn("d", 4, "candidate", null, null, "I ran the profiler and found a slow query."),
        responds_to_turn_id: "c",
      },
    ],
    actions: [],
    row: {
      status: "scored",
      overall_score: 76,
      questions: [entry(1, 80), { ...entry(2, 72), quotes: ["ran the profiler and found"] }],
    },
    attempt: { number: 1, of: 1, isLatest: true, latestSessionId: "s", earlierSessionIds: [] },
  };
}

test("completed: 'Completed', the overall, no partial label", () => {
  const v = buildLiveReviewView(completedInput());
  assert.deepEqual(
    [v.header.state, v.header.label, v.header.overall, v.header.partial],
    ["completed", "Completed", 76, false],
  );
  // Turn d starts at 40 s on the conversation clock; the quote 2 s into it.
  assert.deepEqual(byPos(v, 2).quotes, [
    { text: "ran the profiler and found", turnId: "d", startSeconds: 2, atMs: 42_000 },
  ]);
  const html = render(v);
  assert.match(html, /data-outcome="completed"/);
  assert.match(html, />76</);
  assert.match(html, /2 of 2 answered/);
  assert.doesNotMatch(html, /data-partial/);
});

test("attempt 2: only the latest attempt is the result; the earlier one opens for audit, with no actions", async () => {
  const db = await saved((p) => ([4, 5].includes(p) ? "um... uh" : undefined));
  const model = fakeModel();
  await resolveAll(db, model);
  db.tables.interview_sessions.push(
    frozenRow({ id: RESTART, attempt: 2, previous_attempt_id: SESSION }),
  );

  const latest = await view(db, "owner", RESTART);
  assert.deepEqual(
    [
      latest.attempt.number,
      latest.attempt.of,
      latest.attempt.isLatest,
      latest.attempt.earlierSessionIds,
    ],
    [2, 2, true, [SESSION]],
  );
  assert.deepEqual(
    [latest.header.state, latest.header.overall, latest.header.scoreStatus],
    ["in_progress", null, "not_scored"],
  );
  assert.ok(
    latest.questions.every((q) => q.score === null),
    "attempt 1's scores never show as attempt 2's",
  );
  // Audio of either attempt is signed only after the company and hiring-team gate.
  const oldTurn = db.tables.interview_turns.find((t) => t.session_id === SESSION);
  const otherTeam = async () => ({ scoped: true, jobIds: [OTHER_JOB] });
  assert.equal(
    (await signLiveTurnAudio(ctxOf("recruiter"), SESSION, oldTurn.id, deps(db, otherTeam))).ok,
    false,
  );
  assert.equal(
    (
      await signLiveTurnAudio(
        ctxOf("owner", { companyId: OTHER_CO }),
        SESSION,
        oldTurn.id,
        deps(db),
      )
    ).ok,
    false,
  );
  const signed = await signLiveTurnAudio(ctxOf("owner"), SESSION, oldTurn.id, deps(db));
  assert.match(signed.url, /\?ttl=300$/, "five minutes, as on the async page");
  const latestHtml = render(latest);
  assert.match(latestHtml, /Attempt 2 of 2/);
  assert.match(latestHtml, /View attempt 1 \(audit only\)/);

  // Opening attempt 1 directly: its own row, marked audit only, and no actions even for an owner.
  const earlier = await view(db, "owner", SESSION);
  assert.deepEqual(
    [earlier.attempt.isLatest, earlier.attempt.latestSessionId, earlier.attempt.number],
    [false, RESTART, 1],
  );
  const html = render(earlier, "owner");
  assert.match(html, /data-audit-only/);
  assert.match(html, /kept for audit only. This is not the candidate&#x27;s result/);
  assert.doesNotMatch(html, /data-actions/);
  const refused = await quiet(() =>
    runLiveRecovery(
      ctxOf("owner"),
      {
        action: "resolve_needs_check",
        sessionId: SESSION,
        position: 1,
        decision: "exclude",
        note: "x",
      },
      deps(db),
    ),
  );
  assert.deepEqual(refused, {
    ok: false,
    error: "This is an earlier attempt, kept for audit only.",
  });
});

/* ── who may act ──────────────────────────────────────────────── */

test("a recruiter or hiring manager sees no action and the server refuses; an owner or admin acts and it is logged", async () => {
  const db = await saved();
  const model = fakeModel();
  await score(db, model);
  const v = await view(db, "recruiter");
  for (const role of ["recruiter", "hiring_manager"]) {
    assert.equal(canActOnLiveReview(role), false);
    const html = render(v, role);
    assert.doesNotMatch(html, /data-actions|data-action=/, `${role} sees no action`);
    assert.doesNotMatch(html, /Don&#x27;t include personal details/);
    const r = await quiet(() =>
      runLiveRecovery(
        ctxOf(role),
        {
          action: "resolve_needs_check",
          sessionId: SESSION,
          position: 1,
          decision: "score",
          note: "x",
        },
        deps(db),
      ),
    );
    assert.deepEqual(r, { ok: false, error: "Only an owner or admin can do this." });
  }
  assert.equal(db.tables.live_interview_actions.length, 0);

  const ownerHtml = render(v, "owner");
  assert.equal(
    (ownerHtml.match(/data-actions/g) ?? []).length,
    5,
    "one action box per timing flag",
  );
  assert.match(ownerHtml, /Don&#x27;t include personal details\./);
  assert.match(ownerHtml, /data-action="resolve_needs_check"/);

  const r = await quiet(() =>
    runLiveRecovery(
      ctxOf("admin"),
      {
        action: "resolve_needs_check",
        sessionId: SESSION,
        position: 1,
        decision: "score",
        note: "Checked the audio.",
      },
      { ...deps(db), recovery: { score: (id) => score(db, model, id) } },
    ),
  );
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(
    db.tables.live_interview_actions.map((a) => [
      a.action,
      a.decision,
      a.question_position,
      a.actor_role,
      a.note,
    ]),
    [["resolve_needs_check", "score", 1, "admin", "Checked the audio."]],
  );
  // The page refreshes from the store: the question is now scored.
  const after = await view(db, "admin");
  assert.deepEqual([byPos(after, 1).status, byPos(after, 1).score], ["answered", 70]);
  assert.equal(byPos(after, 1).flags[0].resolved, "score");
});

test("the hiring team and the company gate the page, the audio and the actions alike", async () => {
  const db = await saved();
  const otherTeam = async () => ({ scoped: true, jobIds: [OTHER_JOB] });
  assert.equal(
    await quiet(() => loadLiveReview(ctxOf("recruiter"), SESSION, deps(db, otherTeam))),
    null,
  );
  assert.equal(
    await quiet(() => loadLiveReview(ctxOf("owner", { companyId: OTHER_CO }), SESSION, deps(db))),
    null,
  );
  const turn = db.tables.interview_turns.find((t) => t.session_id === SESSION);
  assert.equal(
    (await signLiveTurnAudio(ctxOf("recruiter"), SESSION, turn.id, deps(db, otherTeam))).ok,
    false,
  );
  const ok = await signLiveTurnAudio(
    ctxOf("recruiter"),
    SESSION,
    turn.id,
    deps(db, async () => ({ scoped: true, jobIds: [JOB] })),
  );
  assert.equal(ok.ok, true, "a recruiter on the job can listen");
  assert.ok(
    !JSON.stringify(ok).includes(turn.media_path) || ok.url.startsWith("https://"),
    "a signed URL, not the path",
  );
  const r = await quiet(() =>
    runLiveRecovery(
      ctxOf("owner", { companyId: OTHER_CO }),
      {
        action: "resolve_needs_check",
        sessionId: SESSION,
        position: 1,
        decision: "score",
        note: "x",
      },
      deps(db),
    ),
  );
  assert.equal(r.ok, false);
});

/* ── what reaches the browser ─────────────────────────────────── */

test("never sent to the browser: guides, follow-up reasons, storage paths, segments, CV details", async () => {
  const db = await saved();
  const model = fakeModel();
  await resolveAll(db, model);
  // A failed turn too, so its error is in play.
  const t = candidateTurns(db)[0];
  t.transcript_status = "failed";
  t.transcript_error = "Raw provider text: 503 upstream at whisper-1 for path s/t2.wav";
  const v = await view(db);
  const payload = JSON.stringify(v);
  const html = render(v);
  const reasons = db.tables.interview_turns.map((x) => x.follow_up_reason).filter(Boolean);
  assert.ok(reasons.length > 0);
  for (const text of [payload, html]) {
    for (const p of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(!text.includes(GUIDE(p)), `guide ${p}`);
    assert.doesNotMatch(text, /PRIVATE GUIDE|scoring_guide|rubric/);
    for (const r of reasons) assert.ok(!text.includes(r), "a follow-up reason");
    for (const path of db.tables.interview_turns.map((x) => x.media_path).filter(Boolean)) {
      assert.ok(!text.includes(path), "a storage path");
    }
    assert.doesNotMatch(text, /transcript_segments|noSpeech|media_path|follow_up_reason/);
    assert.ok(!text.includes(CV_EMAIL) && !text.includes("+92 300"), "CV contact details");
    assert.ok(!text.includes("Raw provider text"), "a raw error");
  }
  assert.match(html, /data-flag="transcription_failed"/);
  assert.match(html, /This answer could not be transcribed\./);
});

test("a style check: the question waits for review, its reason shown, its held score never shown", () => {
  const input = completedInput();
  input.row = {
    status: "pending",
    overall_score: null,
    questions: [
      input.row.questions[0],
      { ...input.row.questions[1], status: "waiting", reason: "style_check", style_check: true },
    ],
  };
  const v = buildLiveReviewView(input);
  const q2 = byPos(v, 2);
  assert.deepEqual(
    [q2.status, q2.statusLabel, q2.score, q2.rationale, q2.quotes],
    ["waiting_review", "Waiting for review", null, null, []],
  );
  assert.deepEqual(
    q2.flags.map((f) => [f.kind, f.resolved]),
    [["style", null]],
  );
  assert.equal(v.header.overall, null);
  const html = render(v, "admin");
  assert.match(html, /data-flag="style"/);
  assert.match(html, /described how the candidate spoke/);
  assert.match(html, /data-action="resolve_style_check"/);
  assert.doesNotMatch(html, />72</, "the held score is not shown while it waits");
});

/* ── D2 (revised): the ending, said on the page ───────────────── */

const END_TEXTS = {
  closed_early: "Sarah closed the interview before asking 2 questions.",
  exit_unconfirmed:
    "The provider says the candidate ended the interview, but that isn't confirmed yet. Check the recording before relying on it.",
  left_after_last_answer:
    "The candidate answered every question but left before Sarah closed. Check the recording before relying on it.",
  ending_unknown:
    "How this interview ended couldn't be confirmed. Check the recording before relying on it.",
  provider_error_saved:
    "The provider reported an error, but every answer was saved. Check the recording, then decide whether to offer a restart.",
};
const RESTART_TEXT = "A restart is your decision for this interview.";
const section = (html, marker) => {
  const at = html.indexOf(marker);
  return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at));
};
const escaped = (text) => text.replaceAll("'", "&#x27;");

test("ending not confirmed: scored like partial, X of 8 answered, a Needs review list, the restart in plain words only", async () => {
  const db = await saved();
  await resolveAll(db, fakeModel());
  const row = db.tables.live_interview_scores[0];
  assert.deepEqual(
    [row.status, row.outcome, row.partial, row.overall_score],
    ["scored", "ending_unconfirmed", true, 58],
  );
  const v = await view(db);
  assert.deepEqual(
    [v.header.state, v.header.label, v.header.overall, v.header.partial, v.header.restartNote],
    ["ending_unconfirmed", "Ending not confirmed - needs review", 58, true, RESTART_TEXT],
  );
  assert.deepEqual(
    v.header.reviewReasons,
    [END_TEXTS.exit_unconfirmed],
    "every timing check was resolved",
  );
  const html = render(v);
  assert.match(html, /data-outcome="ending_unconfirmed"/);
  assert.match(html, /5 of 8 answered/);
  assert.match(html, /data-overall/);
  assert.match(
    html,
    /Not comparable with completed interviews: how it ended needs a check first\./,
  );
  const needs = section(html, "data-needs-review");
  assert.ok(needs.includes(escaped(END_TEXTS.exit_unconfirmed)));
  assert.ok(needs.includes(RESTART_TEXT));
  assert.doesNotMatch(html, /<button[^>]*>[^<]*[Rr]estart/, "no restart button");
  assert.doesNotMatch(needs, /[–—]/, "hyphens only");
});

test("while checks are open, the Needs review list names each one with its question", async () => {
  const db = await saved();
  await score(db, fakeModel());
  const v = await view(db);
  assert.equal(v.header.reviewReasons[0], END_TEXTS.exit_unconfirmed);
  assert.deepEqual(
    v.header.reviewReasons.slice(1).map((r) => r.slice(0, 11)),
    ["Question 1:", "Question 2:", "Question 3:", "Question 4:", "Question 5:"],
  );
  assert.ok(
    v.header.reviewReasons.slice(1).every((r) => r.includes("overlapped the interviewer's speech")),
  );
  const needs = section(render(v), "data-needs-review");
  assert.equal((needs.match(/data-review-reason/g) ?? []).length, 6);
});

test("every end reason is shown in plain words, hyphens only", async () => {
  const db = await saved();
  await score(db, fakeModel());
  for (const [reason, text] of Object.entries(END_TEXTS)) {
    const o = db.tables.interview_sessions[0].live_outcome;
    db.tables.interview_sessions[0].live_outcome = {
      ...o,
      outcome: reason === "closed_early" ? "completed" : "ending_unconfirmed",
      end_check: { reason, never_asked: 2 },
    };
    const v = await view(db);
    assert.equal(v.header.reviewReasons[0], text, reason);
    const needs = section(render(v), "data-needs-review");
    assert.ok(needs.includes(escaped(text)), reason);
    assert.doesNotMatch(needs, /[–—]/, reason);
  }
  const one = {
    ...db.tables.interview_sessions[0].live_outcome,
    end_check: { reason: "closed_early", never_asked: 1 },
  };
  db.tables.interview_sessions[0].live_outcome = one;
  assert.equal(
    (await view(db)).header.reviewReasons[0],
    "Sarah closed the interview before asking 1 question.",
  );
});

test("completed, but Sarah closed before asking every question: completed, held from ranking, flagged", async () => {
  const db = await saved();
  const o = db.tables.interview_sessions[0].live_outcome;
  db.tables.interview_sessions[0].live_outcome = {
    ...o,
    provider_status_code: "completed",
    outcome: "completed",
    end_check: { reason: "closed_early", never_asked: 2 },
    held_from_ranking: true,
    restart_needs_person: false,
    restart_allowed: false,
  };
  await resolveAll(db, fakeModel());
  const row = db.tables.live_interview_scores[0];
  assert.deepEqual(
    [row.outcome, row.partial, row.status],
    ["completed", true, "scored"],
    "held from ranking",
  );
  const v = await view(db);
  assert.deepEqual(
    [v.header.state, v.header.label, v.header.partial, v.header.restartNote],
    ["completed", "Completed", true, null],
  );
  assert.deepEqual(v.header.reviewReasons, [END_TEXTS.closed_early]);
  const html = render(v);
  assert.match(html, /Held from ranking: Sarah closed before asking every question/);
  assert.ok(section(html, "data-needs-review").includes(END_TEXTS.closed_early));
});
