/**
 * #15 and #16 (26 Nov 2026), on small synthetic exports through the shipped
 * parser (parse-export.ts), assessLiveExport, the transcript settle
 * (settleOutcome) and the scoring plan (planLiveScoring).
 *
 *   #15 the order check   base questions in the FROZEN position order, each
 *                         once, follow-ups and answers on the question being
 *                         asked. Anything else is kept and held, never refused.
 *   #16 F15c turn types   repeat_offer and not_answered are procedural; a
 *                         question Sarah moved on from is skipped unless a real
 *                         answer for it follows.
 *
 *   node --test src/lib/interviews/live-ingest-order.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
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

const { assessLiveExport } = await import("./live-ingest.ts");
const { settleOutcome } = await import("./live-transcribe.ts");
const { planLiveScoring } = await import("./live-scoring.ts");
const { parseExport, LiveExportError } = await import("./live-provider/parse-export.ts");
const { readFrozenQuestionSet, snapshotsFor } = await import("./frozen-questions.ts");

const TEXT = [
  "Tell me about a project you owned end to end.",
  "Tell me about a hard customer conversation you led.",
  "Tell me about a process you changed for the team.",
  "Tell me about a mistake you owned.",
];

/** The invitation's frozen questions: positions 1 to 4, in the recruiter's order. */
function frozen() {
  const questions = TEXT.map((text, i) => ({
    question_id: `q-${i + 1}`,
    position: i + 1,
    text,
    source: "job",
    competency: "Ownership",
    scoring_guide: "Strong answer: specific. Weak answer: general.",
    weight: null,
  }));
  return readFrozenQuestionSet({
    id: "5b0f2c1e-0000-4000-8000-000000000150",
    kind: "live",
    live_settings: {
      v: 2,
      questions_frozen: {
        at: "2026-11-20T08:50:00.000Z",
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
    ...snapshotsFor(questions),
  });
}

/**
 * A synthetic export, built step by step. Each turn is 5 s long and starts
 * 10 s after the one before, so nothing overlaps (no timing check).
 */
function script() {
  const turns = [];
  let lastInterviewer = null;
  let lastCandidate = null;
  const push = (t) => {
    const n = turns.length + 1;
    const turn = {
      turn_id: `t${n}`,
      sequence: n,
      offset_ms: n * 10_000,
      audio_duration_ms: 5_000,
      audio_file: `t${n}.wav`,
      ...t,
    };
    turns.push(turn);
    if (turn.role === "interviewer") lastInterviewer = turn;
    else lastCandidate = turn;
    return turn;
  };
  const s = {
    turns,
    ask: (q, text = TEXT[q - 1]) =>
      push({ role: "interviewer", turn_type: "base_question", question_id: q, text }),
    followUp: (q, index) =>
      push({
        role: "interviewer",
        turn_type: "follow_up",
        question_id: q,
        follow_up_index: index,
        follow_up_reason: "Asked for an example.",
        text: "Can you give me a specific example?",
        responds_to_turn_id: lastCandidate.turn_id,
      }),
    say: (turn_type, text, extra = {}) => push({ role: "interviewer", turn_type, text, ...extra }),
    answer: (to = lastInterviewer, ms = 5_000) =>
      push({
        role: "candidate",
        turn_type: "answer",
        responds_to_turn_id: to.turn_id,
        audio_duration_ms: ms,
      }),
    export: () => ({
      session_id: "provider-session-150",
      started_at: "2026-11-26T10:00:00.000Z",
      status: "completed",
      end_reason: "completed",
      completed_gracefully: true,
      questions: TEXT.map((text, i) => ({ position: i + 1, text })),
      turns: structuredClone(turns),
    }),
  };
  return s;
}

const assess = (s) => assessLiveExport(parseExport(s.export()), frozen(), 1);
const byPos = (o, p) => o.questions.find((q) => q.position === p);
const orderOf = (o) => o.questions.map((q) => [q.position, q.order_check ?? null]);

/** The outcome as the settle leaves it once every answer has real words. */
function settled(o, s) {
  const parsed = parseExport(s.export());
  const byId = new Map(parsed.turns.map((t) => [t.provider_turn_id, t]));
  const turns = parsed.turns
    .filter((t) => t.speaker === "candidate")
    .map((t) => ({
      sequence: t.sequence,
      position: t.question_position ?? byId.get(t.responds_to_provider_turn_id)?.question_position,
      transcript_status: "done",
      transcript: "I led the migration and wrote the runbook myself.",
      transcript_segments: [{ start: 0, end: 4, text: "I led the migration.", noSpeech: 0.01 }],
    }));
  return settleOutcome(o, turns, 1);
}

const NONE = new Map();
const plan = (o, resolved = {}) =>
  planLiveScoring(o, frozen().questions, {
    needsCheck: NONE,
    repeatCheck: NONE,
    wordingCheck: NONE,
    excludedPositions: new Set(),
    ...resolved,
  });
const planOf = (o, resolved) => plan(o, resolved).map((p) => [p.position, p.decision, p.reason]);

/** Q1 to Q4 in order, each answered, Q1 with two follow-ups. */
function inOrder() {
  const s = script();
  s.say("greeting", "Hi Alex, I'm Sarah.");
  s.ask(1);
  s.answer();
  s.followUp(1, 1);
  s.answer();
  s.followUp(1, 2);
  s.answer();
  for (const q of [2, 3, 4]) {
    s.ask(q);
    s.answer();
  }
  s.say("closing", "Thank you, that's everything.");
  return s;
}

/* ── #15 the order check ─────────────────────────────────────────── */

test("#15 in order (with follow-ups): no order check, every question answered and scored", () => {
  const s = inOrder();
  const o = assess(s);
  assert.deepEqual(orderOf(o), [
    [1, null],
    [2, null],
    [3, null],
    [4, null],
  ]);
  assert.deepEqual(o.order_check_turns, []);
  assert.equal(o.needs_review, false);
  assert.deepEqual(
    planOf(settled(o, s)).map(([, d, r]) => [d, r]),
    Array(4).fill(["ai", "answered"]),
  );
});

test("#15 Q3 before Q2: Q2 and Q3 held with the order check, Q1 and Q4 scored, every turn kept", () => {
  const s = script();
  s.ask(1);
  s.answer();
  const early = s.ask(3);
  s.answer();
  const late = s.ask(2);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  assert.deepEqual(orderOf(o), [
    [1, null],
    [2, "out_of_order"],
    [3, "out_of_order"],
    [4, null],
  ]);
  // Q3 passed over Q2 when it was asked, and Q2 came after it.
  assert.deepEqual(o.order_check_turns, [early.sequence, late.sequence]);
  assert.equal(o.turn_count, 8, "nothing dropped");
  assert.equal(o.answered_count, 4, "both still answered: only held");
  assert.equal(o.needs_review, true);
  assert.deepEqual(planOf(settled(o, s)), [
    [1, "ai", "answered"],
    [2, "wait", "order_check"],
    [3, "wait", "order_check"],
    [4, "ai", "answered"],
  ]);
});

test("#15 the order is the FROZEN positions', never the order of the export's own questions list", () => {
  const s = script();
  for (const q of [1, 2, 3, 4]) {
    s.ask(q);
    s.answer();
  }
  const raw = s.export();
  // The provider lists its questions in another order: the frozen set decides.
  raw.questions.reverse();
  const o = assessLiveExport(parseExport(raw), frozen(), 1);
  assert.deepEqual(o.order_check_turns, []);
});

test("#15 Q2 asked twice: kept, both turns, and Q2 held; the others are not", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  s.answer();
  const again = s.ask(2);
  s.answer();
  s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  assert.deepEqual(orderOf(o), [
    [1, null],
    [2, "asked_twice"],
    [3, null],
    [4, null],
  ]);
  assert.deepEqual(o.order_check_turns, [again.sequence]);
  assert.equal(o.questions.length, 4, "no extra question or scoring entry");
  assert.deepEqual(planOf(settled(o, s))[1], [2, "wait", "order_check"]);
});

test("#15 a follow-up on a question other than the one being asked: both held", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  s.answer();
  const stray = s.followUp(1, 1);
  const reply = s.answer();
  s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  assert.deepEqual(orderOf(o), [
    [1, "follow_up_elsewhere"],
    [2, "follow_up_elsewhere"],
    [3, null],
    [4, null],
  ]);
  // The stray follow-up, and the candidate's reply to it: also out of place.
  assert.deepEqual(o.order_check_turns, [stray.sequence, reply.sequence]);
});

test("#15 questions never reached at the end are not an order problem", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  s.answer();
  const o = assess(s);
  assert.deepEqual(o.order_check_turns, []);
  assert.deepEqual(
    o.questions.map((q) => [q.position, q.status, q.order_check]),
    [
      [1, "answered", null],
      [2, "answered", null],
      [3, "not_reached", null],
      [4, "not_reached", null],
    ],
  );
});

test("#15 combined with another reason: both kept, and both decisions needed", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(3);
  s.answer();
  s.ask(2, `Quick hint first: mention the outcome. ${TEXT[1]}`);
  s.answer();
  s.ask(4);
  s.answer();
  const o = settled(assess(s), s);
  const q2 = byPos(o, 2);
  assert.deepEqual([q2.wording_check, q2.order_check], ["unexpected_lead_in", "out_of_order"]);
  const yes = new Map([[2, "score"]]);
  assert.deepEqual(planOf(o)[1], [2, "wait", "wording_check"], "neither resolved");
  assert.deepEqual(planOf(o, { wordingCheck: yes })[1], [2, "wait", "order_check"]);
  assert.deepEqual(planOf(o, { orderCheck: yes })[1], [2, "wait", "wording_check"]);
  assert.deepEqual(planOf(o, { wordingCheck: yes, orderCheck: yes })[1], [2, "ai", "answered"]);
  assert.deepEqual(planOf(o, { wordingCheck: yes, orderCheck: new Map([[2, "exclude"]]) })[1], [
    2,
    "left_out",
    "order_excluded",
  ]);
});

/* ── #16 repeat_offer and not_answered (F15c) ─────────────────────── */

test("#16 repeat_offer: accepted, procedural, and nothing is scored from it or from the reply to it", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  const offer = s.say("repeat_offer", "Would you like me to repeat the question?", {
    question_id: 2,
  });
  const reply = s.answer(offer, 800);
  const o = assess(s);
  const parsed = parseExport(s.export());
  const t = parsed.turns.find((x) => x.sequence === offer.sequence);
  assert.deepEqual([t.kind, t.repeat_offer, t.repeat], ["procedural", true, false]);
  assert.deepEqual(o.repeat_offer_turns, [offer.sequence]);
  assert.deepEqual(o.offer_reply_turns, [reply.sequence]);
  // "Yes please" is not an answer to question 2.
  assert.deepEqual([byPos(o, 2).status, byPos(o, 2).answer_ms], ["skipped", 0]);
  assert.equal(byPos(o, 2).follow_ups, 0);
  assert.equal(o.questions.length, 4);
  // And its transcript never confirms one.
  const settledO = settled(o, s);
  assert.equal(byPos(settledO, 2).status, "skipped");
});

test("#16 not_answered with no speech before or after it: the question is skipped, never answered", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  const moved = s.say("not_answered", "That's all right, let's move on.");
  s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  const q2 = byPos(o, 2);
  assert.deepEqual(
    [q2.status, q2.answer_ms, q2.moved_on_after, q2.order_check],
    ["skipped", 0, moved.sequence, null],
  );
  assert.deepEqual([o.answered_count, o.skipped_count, o.completion_percent], [3, 1, 75]);
  // Placed at the question being asked, though it named none.
  const t = parseExport(s.export()).turns.find((x) => x.sequence === moved.sequence);
  assert.deepEqual([t.kind, t.not_answered, t.question_position], ["procedural", true, 2]);
  assert.deepEqual(o.not_answered_turns, [moved.sequence]);
  assert.deepEqual(o.order_check_turns, [], "moving on with the marker is fine");
  // The skipped rule: the lowest score.
  assert.deepEqual(planOf(settled(o, s))[1], [2, "lowest", "skipped"]);
});

test("#16 not_answered, then a real answer for it: answered normally, and checked for the order", () => {
  const s = script();
  s.ask(1);
  s.answer();
  const q2 = s.ask(2);
  s.say("not_answered", "Let's come back to that.", { question_id: 2 });
  // The candidate answers question 2 right away, before Sarah asks anything else.
  s.answer(q2);
  s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  assert.deepEqual([byPos(o, 2).status, byPos(o, 2).order_check], ["answered", null]);
  assert.deepEqual(planOf(settled(o, s))[1], [2, "ai", "answered"]);

  // After Sarah has moved on to question 3, a late answer for 2 is kept, and both are held.
  const late = script();
  late.ask(1);
  late.answer();
  const two = late.ask(2);
  late.say("not_answered", "Let's move on.", { question_id: 2 });
  late.ask(3);
  const lateAnswer = late.answer(two);
  late.answer();
  late.ask(4);
  late.answer();
  const lo = assess(late);
  assert.equal(byPos(lo, 2).status, "answered", "the late answer is preserved");
  assert.deepEqual(orderOf(lo).slice(1, 3), [
    [2, "answer_elsewhere"],
    [3, "answer_elsewhere"],
  ]);
  assert.deepEqual(lo.order_check_turns, [lateAnswer.sequence]);
});

test("#15/#16 speech BEFORE not_answered: kept as the answer and held for a person, never the lowest score", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  const spoke = s.answer(undefined, 4_000);
  const moved = s.say("not_answered", "Let's move on.", { question_id: 2 });
  s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  const q2 = byPos(o, 2);
  assert.deepEqual(
    [q2.status, q2.answer_ms, q2.order_check, q2.moved_on_after],
    ["answered", 4_000, "answer_before_not_answered", null],
    "the speech is the answer, and the question waits",
  );
  assert.ok(o.order_check_turns.includes(spoke.sequence));
  assert.ok(o.not_answered_turns.includes(moved.sequence));
  assert.equal(o.turn_count, 9, "every turn kept");
  const done = settled(o, s);
  assert.deepEqual(byPos(done, 2).confirmed, true, "its transcript counts");
  assert.deepEqual(planOf(done)[1], [2, "wait", "order_check"], "never the lowest score unseen");
  assert.deepEqual(planOf(done, { orderCheck: new Map([[2, "score"]]) })[1], [2, "ai", "answered"]);
  assert.deepEqual(planOf(done, { orderCheck: new Map([[2, "exclude"]]) })[1], [
    2,
    "left_out",
    "order_excluded",
  ]);
});

test("#15 skipped in the middle: Q1, then Q3 with Q2 never asked and no not_answered for it, holds Q2 and Q3", () => {
  const s = script();
  s.ask(1);
  s.answer();
  const jump = s.ask(3);
  s.answer();
  s.ask(4);
  s.answer();
  const o = assess(s);
  assert.deepEqual(orderOf(o), [
    [1, null],
    [2, "skipped_question"],
    [3, "skipped_question"],
    [4, null],
  ]);
  assert.deepEqual(o.order_check_turns, [jump.sequence], "reported once, at the jump");
  assert.equal(byPos(o, 2).status, "not_reached");
  assert.equal(o.needs_review, true);
  assert.deepEqual(planOf(settled(o, s))[2], [3, "wait", "order_check"]);
});

test("#15 skipped in the middle WITH a not_answered for it: moving on is fine, no flag", () => {
  // Sarah says she is skipping question 2, without asking it.
  const unasked = script();
  unasked.ask(1);
  unasked.answer();
  unasked.say("not_answered", "Let's skip that one.", { question_id: 2 });
  unasked.ask(3);
  unasked.answer();
  unasked.ask(4);
  unasked.answer();
  assert.deepEqual(assess(unasked).order_check_turns, []);
  // Or asks it, hears nothing, and moves on.
  const asked = script();
  asked.ask(1);
  asked.answer();
  asked.ask(2);
  asked.say("not_answered", "Let's move on.");
  asked.ask(3);
  asked.answer();
  asked.ask(4);
  asked.answer();
  const o = assess(asked);
  assert.deepEqual(o.order_check_turns, []);
  assert.equal(byPos(o, 2).status, "skipped");
});

test("#15 Q1, Q2, then the interview ends: Q3 and Q4 not reached, never an order problem", () => {
  const s = script();
  s.ask(1);
  s.answer();
  s.ask(2);
  s.answer();
  s.say("closing", "That's all the time we have.");
  const o = assess(s);
  assert.deepEqual(o.order_check_turns, []);
  assert.deepEqual(
    o.questions.map((q) => [q.position, q.status, q.order_check]),
    [
      [1, "answered", null],
      [2, "answered", null],
      [3, "not_reached", null],
      [4, "not_reached", null],
    ],
  );
});

test("#16 the new turns keep their own sequence, offsets and place in the record", () => {
  const s = script();
  s.ask(1);
  const offer = s.say("repeat_offer", "Would you like me to hear it again?");
  const moved = s.say("not_answered", "Let's move on.");
  s.ask(2);
  s.answer();
  const raw = s.export();
  const p = parseExport(raw);
  for (const [sent, kept] of [
    [offer, p.turns.find((t) => t.provider_turn_id === offer.turn_id)],
    [moved, p.turns.find((t) => t.provider_turn_id === moved.turn_id)],
  ]) {
    assert.deepEqual(
      [kept.sequence, kept.offset_ms, kept.duration_ms, kept.text],
      [sent.sequence, sent.offset_ms, sent.audio_duration_ms, sent.text],
    );
    assert.equal(
      kept.started_at,
      new Date(Date.parse(raw.started_at) + sent.offset_ms).toISOString(),
    );
  }
  assert.deepEqual(
    p.turns.map((t) => t.sequence),
    [1, 2, 3, 4, 5],
    "in their order",
  );
});

test("#16 any other unknown turn type is still refused", () => {
  for (const turn_type of ["mystery_type", "repeat-offer", "notanswered", ""]) {
    const s = script();
    s.ask(1);
    s.say(turn_type, "Something.");
    assert.throws(
      () => parseExport(s.export()),
      (e) => e instanceof LiveExportError && e.code === "unknown_turn_type",
      JSON.stringify(turn_type),
    );
  }
});
