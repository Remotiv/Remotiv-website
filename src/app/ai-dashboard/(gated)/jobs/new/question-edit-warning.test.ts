/**
 * #20: the wizard's line when a job's questions are edited after invitations
 * went out (question-edit-warning.ts), and where it is shown.
 *
 *   - a change is what a save would store differently, through the save's own
 *     normaliser, in order, never by id: text, order, competency, scoring
 *     guide, add, remove, timers, Required and the async weight;
 *   - never: whitespace, a blank row, a new id, a live weight, a title;
 *   - the wording: open, completed only, both; singular and plural; "at
 *     least" when the read was cut short; AI Video Interview the same;
 *   - steps 5, 6 and 8 show it (step 8 the async line only), still with the
 *     interview switched off, and a full save moves the baseline;
 *   - the save and the line share the normaliser (storedQuestionRows);
 *   - the drawer's new-link copy says it uses the job's current questions,
 *     and the #67 lines are as they were.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/question-edit-warning.test.ts"
 *
 * Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));

const { questionListChanged, inviteWarningLine, questionEditWarning } = await import(
  "./question-edit-warning.ts"
);
const { storedQuestionRows } = await import("../../../../../lib/interviews/question-rows.ts");
const { EMPTY_QUESTION_INPUT } = await import("../../../../../lib/interviews/types.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const WIZARD = read("./_wizard-client.tsx");
const ACTIONS = read("../actions.ts");
const PANEL = read("../../applicants/_interview-panel.tsx");

const q = (id, question, extra = {}) => ({
  ...EMPTY_QUESTION_INPUT,
  id,
  question,
  competency: "Ownership",
  rubric: "Names a decision they owned",
  ...extra,
});
const LOADED = [q("q1", "Tell us about a launch"), q("q2", "How do you plan a week?")];
const counts = (open, completed, atLeast = false) => ({
  async: { open, completed },
  live: { open, completed },
  atLeast,
});

test("each stored change counts, for both kinds", () => {
  const changes = {
    text: [q("q1", "Tell us about a release"), LOADED[1]],
    order: [LOADED[1], LOADED[0]],
    competency: [{ ...LOADED[0], competency: "Communication" }, LOADED[1]],
    guide: [{ ...LOADED[0], rubric: "Something else" }, LOADED[1]],
    add: [...LOADED, q("", "A third question")],
    remove: [LOADED[0]],
    prep: [{ ...LOADED[0], prepSeconds: "60" }, LOADED[1]],
    answer: [{ ...LOADED[0], answerSeconds: "180" }, LOADED[1]],
    required: [{ ...LOADED[0], required: false }, LOADED[1]],
  };
  for (const kind of ["async", "live"]) {
    for (const [what, current] of Object.entries(changes)) {
      assert.equal(questionListChanged(LOADED, current, kind), true, `${kind}: ${what}`);
    }
  }
});

test("the async weight counts; a live weight is not stored, so it never does", () => {
  const reweighted = [{ ...LOADED[0], weight: "6" }, LOADED[1]];
  assert.equal(questionListChanged(LOADED, reweighted, "async"), true);
  assert.equal(questionListChanged(LOADED, reweighted, "live"), false);
});

test("what a save would not store differently never counts", () => {
  const same = {
    whitespace: [{ ...LOADED[0], question: "  Tell us about a launch  " }, LOADED[1]],
    "a blank row": [...LOADED, q("", "   ")],
    "new ids": LOADED.map((r) => ({ ...r, id: "" })),
    "a blank guide either way": LOADED.map((r) => ({ ...r })),
  };
  for (const kind of ["async", "live"]) {
    for (const [what, current] of Object.entries(same)) {
      assert.equal(questionListChanged(LOADED, current, kind), false, `${kind}: ${what}`);
    }
  }
  const blank = [{ ...LOADED[0], rubric: "" }, LOADED[1]];
  assert.equal(
    questionListChanged(blank, [{ ...LOADED[0], rubric: "   " }, LOADED[1]], "async"),
    false,
  );
});

test("the wording, async: open, completed only and both, singular and plural", () => {
  const U = "New invitations will use your updated questions.";
  assert.equal(
    inviteWarningLine("async", { open: 3, completed: 0 }),
    `3 candidates already have an Async Video Interview invitation. Their questions stay as they were sent. ${U}`,
  );
  assert.equal(
    inviteWarningLine("async", { open: 1, completed: 0 }),
    `1 candidate already has an Async Video Interview invitation. Their questions stay as they were sent. ${U}`,
  );
  assert.equal(
    inviteWarningLine("async", { open: 0, completed: 5 }),
    `5 candidates have completed the Async Video Interview. Their original questions stay unchanged. ${U}`,
  );
  assert.equal(
    inviteWarningLine("async", { open: 0, completed: 1 }),
    `1 candidate has completed the Async Video Interview. Their original questions stay unchanged. ${U}`,
  );
  assert.equal(
    inviteWarningLine("async", { open: 3, completed: 5 }),
    `3 candidates already have an Async Video Interview invitation and 5 have completed it. They all keep their original questions. ${U}`,
  );
  assert.equal(
    inviteWarningLine("async", { open: 1, completed: 1 }),
    `1 candidate already has an Async Video Interview invitation and 1 has completed it. They all keep their original questions. ${U}`,
  );
  assert.equal(inviteWarningLine("async", { open: 0, completed: 0 }), null);
});

test("the wording, AI Video Interview, and 'at least' when the read was cut short", () => {
  assert.equal(
    inviteWarningLine("live", { open: 2, completed: 0 }),
    "2 candidates already have an AI Video Interview invitation. Their questions stay as they were sent. New invitations will use your updated questions.",
  );
  assert.equal(
    inviteWarningLine("live", { open: 2000, completed: 4 }, true),
    "At least 2000 candidates already have an AI Video Interview invitation and at least 4 have completed it. They all keep their original questions. New invitations will use your updated questions.",
  );
  assert.equal(
    inviteWarningLine("live", { open: 0, completed: 2000 }, true),
    "At least 2000 candidates have completed the AI Video Interview. Their original questions stay unchanged. New invitations will use your updated questions.",
  );
});

test("every line is plain hyphens: no em or en dash", () => {
  for (const kind of ["async", "live"]) {
    for (const c of [
      { open: 1, completed: 0 },
      { open: 0, completed: 1 },
      { open: 2, completed: 2 },
    ]) {
      assert.doesNotMatch(inviteWarningLine(kind, c, true), /[–—]/);
    }
  }
});

test("the line needs both a change and someone holding that interview", () => {
  const edited = [q("q1", "Tell us about a release"), LOADED[1]];
  assert.equal(questionEditWarning("async", LOADED, LOADED, counts(3, 0)), null, "no change");
  assert.equal(questionEditWarning("async", LOADED, edited, counts(0, 0)), null, "no one");
  assert.equal(questionEditWarning("async", LOADED, edited, undefined), null, "a new job");
  assert.match(questionEditWarning("async", LOADED, edited, counts(3, 0)), /^3 candidates/);
  // Each kind reads its own count.
  const split = {
    async: { open: 0, completed: 0 },
    live: { open: 2, completed: 0 },
    atLeast: false,
  };
  assert.equal(questionEditWarning("async", LOADED, edited, split), null);
  assert.match(questionEditWarning("live", LOADED, edited, split), /AI Video Interview/);
});

test("after a full save the saved lists are the baseline, so the line goes", () => {
  const edited = [q("q1", "Tell us about a release"), LOADED[1]];
  assert.ok(questionEditWarning("async", LOADED, edited, counts(3, 0)));
  // The save stores `edited`; the baseline becomes the saved lists; the form still shows `edited`.
  assert.equal(questionEditWarning("async", edited, edited, counts(3, 0)), null);
  // In the wizard: only a full save moves it, from the saved payload, both lists.
  const save = WIZARD.slice(WIZARD.indexOf("if (savedEverything(result)) {"));
  const block = save.slice(0, save.indexOf("}\n"));
  assert.match(block, /setSavedSnapshot\(formSnapshot\(payload, jdBox\)\)/);
  assert.match(block, /setQuestionBaseline\(\{/);
  assert.match(block, /async: questionsOf\(payload, "async"\)/);
  assert.match(block, /live: questionsOf\(payload, "live"\)/);
  assert.equal((WIZARD.match(/setQuestionBaseline\(/g) ?? []).length, 1, "set nowhere else");
  // Seeded from what loaded.
  assert.match(WIZARD, /async: questionsOf\(initialState \?\? EMPTY_JOB_INPUT, "async"\)/);
  assert.match(WIZARD, /live: questionsOf\(initialState \?\? EMPTY_JOB_INPUT, "live"\)/);
});

/** The JSX of one wizard step: from `{step === n && (` to the next step's. */
function stepSource(n) {
  const start = WIZARD.indexOf(`{step === ${n} && `);
  assert.ok(start > 0, `step ${n} found`);
  const next = WIZARD.slice(start + 10).search(/\{step === \d+ && /);
  return next === -1 ? WIZARD.slice(start) : WIZARD.slice(start, start + 10 + next);
}

test("step 5 shows the async line, step 6 the live line, step 8 the async line only", () => {
  const s5 = stepSource(5);
  const s6 = stepSource(6);
  assert.match(s5, /<QuestionEditNote kind="async" line=\{asyncEditWarning\} \/>/);
  assert.doesNotMatch(s5, /liveEditWarning/);
  assert.match(s6, /<QuestionEditNote kind="live" line=\{liveEditWarning\} \/>/);
  assert.doesNotMatch(s6, /asyncEditWarning/);
  // Still shown with the interview switched off: not inside the off branch.
  for (const [s, off] of [
    [s5, "!state.async_interview_enabled && ("],
    [s6, "!state.avatar_interview_enabled && ("],
  ]) {
    const offBlock = s.slice(s.indexOf(off), s.indexOf(")}", s.indexOf(off)));
    assert.doesNotMatch(offBlock, /QuestionEditNote/);
    assert.doesNotMatch(s.slice(0, s.indexOf("<QuestionEditNote")), /&&\s*<QuestionEditNote/);
  }
  // Step 8 is handed the async line, and renders it in its async questions section.
  const s8 = stepSource(8);
  assert.match(s8, /questionEditLine=\{asyncEditWarning\}/);
  assert.doesNotMatch(s8, /liveEditWarning/);
  const weighting = WIZARD.slice(WIZARD.indexOf("function WeightingStep("));
  const section = weighting.slice(weighting.indexOf("Async interview questions"));
  assert.match(
    section.slice(0, section.indexOf("questions.length === 0")),
    /<QuestionEditNote kind="async" line=\{questionEditLine\} \/>/,
  );
  // Each kind's line from that kind's list and baseline.
  assert.match(
    WIZARD,
    /questionEditWarning\(\s*"async",\s*questionBaseline\.async,\s*interviewQs,\s*inviteCounts,?\s*\)/,
  );
  assert.match(
    WIZARD,
    /questionEditWarning\("live", questionBaseline\.live, liveQs, inviteCounts\)/,
  );
});

test("the save and the line share one normaliser", () => {
  const rpc = ACTIONS.slice(ACTIONS.indexOf("function rpcQuestions("));
  const body = rpc.slice(0, rpc.indexOf("\n}\n"));
  assert.match(body, /return storedQuestionRows\(inputs, kind\);/);
  assert.doesNotMatch(body, /\.trim\(\)|snapWeight|clampInt/, "no second copy of the rules");
  assert.doesNotMatch(ACTIONS, /function clampInt\(/);
  assert.match(
    ACTIONS,
    /import \{ storedQuestionRows \} from "@\/lib\/interviews\/question-rows";/,
  );
  // The stored shape the rpc receives (082's columns), unchanged.
  assert.deepEqual(Object.keys(storedQuestionRows([q("", "A")], "async")[0]).sort(), [
    "answer_seconds",
    "competency",
    "prep_seconds",
    "question",
    "required",
    "rubric",
    "weight",
  ]);
  assert.equal(storedQuestionRows([q("", "A", { weight: "6" })], "live")[0].weight, 2);
});

test("the drawer's new-link copy says it uses the job's current questions; #67 lines unchanged", () => {
  // Async: the two confirms, the expired and the cancelled line.
  assert.match(PANEL, /carry on from it\. It uses the job&apos;s current questions\./);
  assert.match(PANEL, /It uses the job&apos;s current questions\. The link\n/);
  assert.match(PANEL, /Send a new one to reopen it\. It uses the job's current questions\./);
  assert.match(
    PANEL,
    /This interview was replaced by a newer one\. A new link uses the job's current questions\./,
  );
  // Live: the confirm, and the card when a new link can be sent.
  assert.match(
    PANEL,
    /Sends a fresh AI Video Interview invitation by email\. It uses the job's current questions\. The link/,
  );
  assert.match(
    PANEL,
    /\{session && canSend \? " A new link uses the job's current questions\." : ""\}/,
  );
  // #67: the email-only and WhatsApp sentences, exactly as shipped.
  assert.match(
    PANEL,
    / {18}\{state\?\.whatsAppOptIn\n {20}\? "Sends a fresh invitation by email, and queues a WhatsApp message as well\."\n {20}: "Sends a fresh invitation by email\."\}\{" "\}\n/,
  );
});
