/**
 * #12, #45, #46: the job wizard's AI Video Interview words, as approved on
 * 23 and 24 Nov, and the mode, length and hiring challenges controls on the
 * AI Video Interview step (6), rendered with react-dom/server.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/ai-video-copy.test.ts"
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const copy = await import("./ai-video-copy.ts");
const { LiveInterviewSettings } = await import("./_live-interview-settings.tsx");
const { AI_VIDEO_OPTION_DESCRIPTION, aiVideoQuestionsHint } = copy;

test("the approved option strings, exactly, with the hint following the length", () => {
  assert.equal(
    AI_VIDEO_OPTION_DESCRIPTION,
    "The AI interviewer asks all approved job questions in order. In AI-Guided mode, Sarah can ask up to 2 relevant follow-up questions per question.",
  );
  assert.equal(
    aiVideoQuestionsHint(30),
    "4 to 8 questions. Estimated duration: 30 minutes. Candidates using the same approved question set receive identical questions in the same order.",
  );
  assert.equal(
    aiVideoQuestionsHint(60),
    "4 to 8 questions. Estimated duration: 60 minutes. Candidates using the same approved question set receive identical questions in the same order.",
  );
});

test("the approved mode, length and challenges strings, exactly", () => {
  assert.equal(copy.AI_VIDEO_MODE_HEADING, "How would you like to conduct the interview?");
  assert.equal(
    copy.AI_VIDEO_MODE_SUB,
    "Choose how the AI interviewer will ask questions during the interview.",
  );
  assert.deepEqual(copy.AI_VIDEO_MODE_CARDS, [
    {
      value: "structured",
      title: "Recruiter-Defined",
      tagline: "Your questions, your control.",
      detail: "Up to 8 fixed questions, asked in order. No AI follow-ups.",
    },
    {
      value: "ai_guided",
      title: "AI-Guided",
      tagline: "Smarter, natural conversations.",
      detail:
        "AI drafts questions for your approval, with up to 2 relevant follow-ups per question.",
    },
  ]);
  assert.equal(copy.AI_VIDEO_LENGTH_LABEL, "Interview length");
  assert.deepEqual(copy.AI_VIDEO_LENGTH_OPTIONS, [
    { value: 30, label: "30 minutes - Standard interview" },
    { value: 60, label: "60 minutes - In-depth interview" },
  ]);
  assert.equal(copy.aiVideoLengthHint(30), "Recommended: 4 to 6 questions.");
  assert.equal(
    copy.aiVideoLengthHint(60),
    "Recommended: 6 to 8 questions. This is a maximum - the interview ends when all questions are done.",
  );
  assert.equal(copy.AI_VIDEO_CHALLENGES_LABEL, "Hiring challenges");
  assert.equal(
    copy.AI_VIDEO_CHALLENGES_HELPER,
    "Describe the main problems this hire must solve, for example 'reduce customer churn'. Used only to draft interview questions. Never shown to candidates or the AI interviewer.",
  );
});

/* ── the controls, rendered ────────────────────────────────────── */

const render = (props) =>
  renderToStaticMarkup(
    createElement(LiveInterviewSettings, {
      enabled: true,
      mode: "structured",
      minutes: 30,
      challenges: "",
      onModeChange() {},
      onMinutesChange() {},
      onChallengesChange() {},
      ...props,
    }),
  );
const decode = (html) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
/** Every radio input, as [name, value, checked], whatever the attribute order. */
const radiosIn = (html) =>
  [...html.matchAll(/<input type="radio"[^>]*>/g)].map(([tag]) => [
    tag.match(/ name="([^"]+)"/)?.[1],
    tag.match(/ value="([^"]+)"/)?.[1],
    / checked=""/.test(tag),
  ]);

test("hidden entirely while AI Video Interview is off for the job", () => {
  for (const mode of ["structured", "ai_guided"]) {
    assert.equal(render({ enabled: false, mode, challenges: "Secret." }), "");
  }
});

test("Recruiter-Defined: heading, two radio cards as one group, the length, no challenges box", () => {
  const html = decode(render({ mode: "structured", challenges: "Kept but unused." }));
  for (const s of [
    copy.AI_VIDEO_MODE_HEADING,
    copy.AI_VIDEO_MODE_SUB,
    ...copy.AI_VIDEO_MODE_CARDS.flatMap((c) => [c.title, c.tagline, c.detail]),
    copy.AI_VIDEO_LENGTH_LABEL,
    ...copy.AI_VIDEO_LENGTH_OPTIONS.map((o) => o.label),
    copy.aiVideoLengthHint(30),
  ]) {
    assert.ok(html.includes(s), s);
  }
  // A fieldset whose legend is the heading, and two native radios sharing one name.
  assert.match(
    html,
    /<fieldset[^>]*><legend[^>]*>How would you like to conduct the interview\?<\/legend>/,
  );
  const radios = radiosIn(html);
  assert.deepEqual(
    radios.map(([, value, checked]) => [value, checked]),
    [
      ["structured", true],
      ["ai_guided", false],
    ],
  );
  assert.ok(radios[0][0] && radios[0][0] === radios[1][0], "one radio group");
  // Each radio sits inside its card's label, which carries the wizard's focus ring.
  assert.match(
    html,
    /<label class="[^"]*has-\[:focus-visible\]:ring-\[3px\][^"]*"><span[^>]*><input type="radio"/,
  );
  assert.ok(!html.includes("<textarea"), "no challenges box in Recruiter-Defined");
  assert.ok(!html.includes(copy.AI_VIDEO_CHALLENGES_LABEL));
  assert.ok(!html.includes("Kept but unused."));
});

test("AI-Guided: the challenges box with its label, helper, 2000 cap and counter", () => {
  const html = decode(render({ mode: "ai_guided", challenges: "Reduce churn \u{1F680}" }));
  assert.deepEqual(
    radiosIn(html).map(([, value, checked]) => [value, checked]),
    [
      ["structured", false],
      ["ai_guided", true],
    ],
  );
  assert.match(html, /<label for="([^"]+)"[^>]*>Hiring challenges<\/label><textarea id="\1"/);
  assert.ok(html.includes('maxLength="2000"'));
  assert.ok(html.includes(copy.AI_VIDEO_CHALLENGES_HELPER));
  assert.ok(html.includes("Reduce churn \u{1F680}</textarea>"));
  // Counted as the database counts: 14 characters, the rocket is one.
  assert.match(html, /aria-live="polite"[^>]*>14(<!-- -->)?\/(<!-- -->)?2000</);
});

test("the length hint follows the length", () => {
  assert.ok(decode(render({ minutes: 30 })).includes(copy.aiVideoLengthHint(30)));
  const sixty = decode(render({ minutes: 60 }));
  assert.ok(sixty.includes(copy.aiVideoLengthHint(60)));
  assert.ok(!sixty.includes(copy.aiVideoLengthHint(30)));
  assert.match(sixty, /<option value="60" selected="">60 minutes - In-depth interview<\/option>/);
});

/* ── where the wizard puts them ────────────────────────────────── */

const WIZARD = readFileSync(new URL("./_wizard-client.tsx", import.meta.url), "utf8");
/** Step 5's question editor, moved out of the wizard unchanged (#58 commit 2). */
const EDITOR = readFileSync(new URL("./_interview-question-editor.tsx", import.meta.url), "utf8");

/** The AI Video Interview OptionRow, from its title to its closing tag. */
function aiVideoRow() {
  const start = WIZARD.lastIndexOf("<OptionRow", WIZARD.indexOf('title="AI Video Interview"'));
  const end = WIZARD.indexOf("</OptionRow>", start);
  assert.ok(start > 0 && end > start);
  return WIZARD.slice(start, end);
}

/*
 * #58 commit 6: the AI Video Interview moved from step 5 to its own step 6,
 * and Review from 9 to 10. The step bodies, in source order: 5, 6, 10, then 7.
 */
const between = (a, b) => WIZARD.slice(WIZARD.indexOf(a), WIZARD.indexOf(b));
const STEP5 = between("{step === 5 && (", "{step === 6 && (");
const STEP6 = between("{step === 6 && (", "{step === 10 && (");
const STEP10 = between("{step === 10 && (", "{step === 7 && (");

test("step 6 opens with the AI Video Interview toggle, then the mode, length and challenges", () => {
  assert.match(
    STEP6,
    /^\{step === 6 && \(\s*<>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="mb-5">\s*<OptionRow\s+title="AI Video Interview"/,
  );
  assert.ok(!STEP5.includes('title="AI Video Interview"'), "not on step 5 any more");
  const toggle = STEP6.indexOf('title="AI Video Interview"');
  const cards = STEP6.indexOf("<LiveInterviewSettings");
  const questionsList = STEP6.indexOf("<InterviewQuestionEditor");
  assert.ok(
    toggle > 0 && toggle < cards && cards < questionsList,
    "toggle, then cards, then questions",
  );
  // The same saved field, toggled here.
  assert.match(
    STEP6,
    /on=\{state\.avatar_interview_enabled\}\s*onToggle=\{\(\) =>\s*set\("avatar_interview_enabled", !state\.avatar_interview_enabled\)\s*\}/,
  );
  assert.match(STEP6, /<LiveInterviewSettings\s+enabled=\{state\.avatar_interview_enabled\}/);
  for (const k of ["live_interview_mode", "live_interview_minutes", "live_hiring_challenges"]) {
    assert.ok(STEP6.includes(`set("${k}", v)`), k);
  }
});

test("Review (step 10) has no AI Video Interview toggle, and no interviewer name anywhere", () => {
  assert.ok(!STEP10.includes('title="AI Video Interview"'));
  assert.equal((WIZARD.match(/title="AI Video Interview"/g) ?? []).length, 1);
  assert.doesNotMatch(
    WIZARD,
    /avatar_interviewer_name|AI_VIDEO_INTERVIEWER_NAME|label="Interviewer name"/,
  );
  // The toggle keeps its "Not yet active" pill: no `live` prop on its row.
  assert.doesNotMatch(aiVideoRow(), /^<OptionRow[^>]*\blive\b/);
});

test("the line, exactly, is step 6's own description now; step 5 no longer adds it", () => {
  assert.equal(
    copy.AI_VIDEO_STEP_LINE,
    "With AI Video Interview on, Sarah asks these questions live, in this order.",
  );
  assert.match(
    WIZARD,
    /n: 6,\s*label: "AI Video Interview",\s*title: "AI Video Interview",\s*\/\/[^\n]*\n\s*desc: AI_VIDEO_STEP_LINE,/,
  );
  assert.doesNotMatch(WIZARD, /\{step === 5 && state\.avatar_interview_enabled/);
  // The async description stays as it was.
  assert.ok(
    WIZARD.includes(
      'desc: "The candidate records their answers alone, with no interviewer on the call."',
    ),
  );
});

test("the wizard's question list stops at 8: add, AI suggestions and the button all use MAX_QUESTIONS", async () => {
  const { MAX_QUESTIONS } = await import("../../../../../lib/interviews/types.ts");
  assert.equal(MAX_QUESTIONS, 8);
  // Add and the button live in the editor, capped at maxQuestions, which is
  // MAX_QUESTIONS unless a caller passes another; step 5 passes none.
  assert.match(EDITOR, /maxQuestions = MAX_QUESTIONS,/);
  assert.match(EDITOR, /if \(questions\.length >= maxQuestions\) return;/);
  assert.match(WIZARD, /questions\.slice\(0, MAX_QUESTIONS\)/);
  assert.match(EDITOR, /disabled=\{questions\.length >= maxQuestions\}/);
  const step5Editor = STEP5.slice(STEP5.indexOf("<InterviewQuestionEditor"));
  assert.doesNotMatch(step5Editor.slice(0, step5Editor.indexOf("/>")), /maxQuestions/);
  for (const [name, src] of [
    ["the wizard", WIZARD],
    ["the editor", EDITOR],
  ]) {
    assert.doesNotMatch(
      src,
      /\b6\b[^\n]*question|question[^\n]*\b6\b/i,
      `no question count of 6 in ${name}`,
    );
  }
});

test("the option row: description and the hint on the chosen length; no red line of its own (#61: one line, by Continue)", () => {
  const row = aiVideoRow();
  assert.match(row, /desc=\{AI_VIDEO_OPTION_DESCRIPTION\}/);
  assert.match(
    row,
    /<p className=\{HINT_CLS\}>\s*\{aiVideoQuestionsHint\(\s*state\.live_interview_minutes \?\? DEFAULT_LIVE_INTERVIEW_MINUTES,?\s*\)\}\s*<\/p>/,
  );
  assert.doesNotMatch(row, /C4362F|QUESTION_COUNT_WARNING|requires 4 to 8/);
  assert.doesNotMatch(WIZARD, /AI Video Interview requires/);
});

test("no CV promise and no 'the first 4' left in the option or the wizard's AI Video copy", () => {
  assert.doesNotMatch(aiVideoRow(), /CV/);
  assert.doesNotMatch(WIZARD, /CV-based|the first\{" "\}|describeQuestionMix|questionMixFor/);
  const strings = [
    AI_VIDEO_OPTION_DESCRIPTION,
    aiVideoQuestionsHint(30),
    aiVideoQuestionsHint(60),
    copy.AI_VIDEO_STEP_LINE,
    copy.AI_VIDEO_MODE_HEADING,
    copy.AI_VIDEO_MODE_SUB,
    ...copy.AI_VIDEO_MODE_CARDS.flatMap((c) => [c.title, c.tagline, c.detail]),
    ...copy.AI_VIDEO_LENGTH_OPTIONS.map((o) => o.label),
    copy.aiVideoLengthHint(30),
    copy.aiVideoLengthHint(60),
    copy.AI_VIDEO_CHALLENGES_LABEL,
    copy.AI_VIDEO_CHALLENGES_HELPER,
  ];
  for (const s of strings) assert.doesNotMatch(s, /CV|first 4|[\u2013\u2014]/, s);
});

/* ── #58 commit 6: two steps, two lists, ten steps, the Review cards ── */

const lists = await import("./question-lists.ts");

test("ten steps: 1-4 unchanged, 5 Async, 6 AI Video Interview, 7-9 scoring, 10 Review", () => {
  const steps = [...WIZARD.matchAll(/\{\s*n: (\d+),\s*label: "([^"]+)",\s*title: "([^"]+)"/g)].map(
    (m) => [Number(m[1]), m[2], m[3]],
  );
  assert.deepEqual(steps, [
    [1, "Basics", "Basics"],
    [2, "Description", "Description"],
    [3, "Compensation", "Compensation"],
    [4, "Screening", "Screening"],
    [5, "Async Video Interview", "Async Video Interview"],
    [6, "AI Video Interview", "AI Video Interview"],
    [7, "AI scoring", "AI scoring criteria"],
    [8, "Answer weighting", "Answer weighting"],
    [9, "Auto-shortlist", "Auto-shortlist"],
    [10, "Review", "Review"],
  ]);
  // Each body is on its own number, once.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
    assert.equal(
      (WIZARD.match(new RegExp(`\\{step === ${n} && \\(`, "g")) ?? []).length,
      1,
      `${n}`,
    );
  }
  assert.equal((WIZARD.match(/\{step === 9 && <AutoshortlistStep/g) ?? []).length, 1);
  // Step 8's question weights are the async list's.
  assert.match(WIZARD, />\s*Async interview questions\s*<\/h3>/);
});

test("step 5 edits only the async list; step 6 only the live list", () => {
  const editor = (step) => {
    const at = step.indexOf("<InterviewQuestionEditor");
    return step.slice(at, step.indexOf("/>", at));
  };
  const five = editor(STEP5);
  assert.match(five, /questions=\{interviewQs\}/);
  assert.match(five, /set\("interview_questions", next\)/);
  assert.match(five, /otherCompetencyIds=\{otherCompetency\.async\}/);
  assert.match(five, /setOtherCompetencyFor\("async", id, on\)/);
  assert.doesNotMatch(STEP5, /live_interview_questions|liveQs/);
  const six = editor(STEP6);
  assert.match(six, /variant="live"/);
  assert.match(six, /questions=\{liveQs\}/);
  assert.match(six, /set\("live_interview_questions", next\)/);
  assert.match(six, /otherCompetencyIds=\{otherCompetency\.live\}/);
  assert.match(six, /setOtherCompetencyFor\("live", id, on\)/);
  assert.match(six, /showWeightAndTiming=\{false\}/);
  assert.match(six, /maxQuestions=\{MAX_JOB_QUESTIONS\}/);
  assert.doesNotMatch(STEP6, /"interview_questions"|interviewQs/);
  assert.match(WIZARD, /const interviewQs = questionsOf\(state, "async"\);/);
});

test("the drafting panel fills the live list, counts it, and lives on step 6 only", () => {
  const handler = WIZARD.slice(WIZARD.indexOf("function onDraftAction("));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /set\(\s*"live_interview_questions",\s*draftsAsJobQuestions\(next\.apply/);
  assert.doesNotMatch(body, /"interview_questions"/);
  assert.match(STEP6, /<QuestionDraftPanel[\s\S]*?existingQuestions=\{askedCount\(liveQs\)\}/);
  assert.doesNotMatch(STEP5, /QuestionDraftPanel/);
  // Step 5's suggest panel is no longer hidden in AI-Guided mode.
  assert.match(
    STEP5,
    /\{interviewQs\.length === 0 && !qsPanelDismissed && \(\s*<QuestionSuggestPanel/,
  );
  assert.doesNotMatch(WIZARD, /aiGuided/);
});

test("step 5: the async switch and its name first, re-recording under it, then the questions; team call fields always", () => {
  const sw = STEP5.indexOf('title="Async video interview"');
  const name = STEP5.indexOf('label="Async interview name"');
  const rerecord = STEP5.indexOf('title="Allow re-recording"');
  const off = STEP5.indexOf("asyncOffLine(");
  const list = STEP5.indexOf("<InterviewQuestionEditor");
  const team = STEP5.indexOf("<TeamCallFields state={state} set={set} />");
  assert.ok(sw > 0 && sw < name && name < rerecord && rerecord < off && off < list && list < team);
  // The team call fields sit at the step's top level, under no switch.
  assert.match(STEP5, /\/>\s*<TeamCallFields state=\{state\} set=\{set\} \/>\s*<\/>\s*\)\}\s*$/);
  assert.doesNotMatch(EDITOR, /Leave this empty to skip the video round/);
});

test("the off lines: exactly, and shown only while that interview is off", () => {
  assert.equal(
    lists.asyncOffLine(0),
    "Async video interview is off - turn it on to send recorded interviews.",
  );
  assert.equal(
    lists.asyncOffLine(5),
    "Async video interview is off - your 5 questions and the re-recording setting are saved but not sent to candidates.",
  );
  assert.equal(
    lists.asyncOffLine(1),
    "Async video interview is off - your 1 question and the re-recording setting are saved but not sent to candidates.",
  );
  assert.equal(
    lists.liveOffLine(0),
    "AI Video Interview is off - turn it on to set up Sarah's questions.",
  );
  assert.equal(
    lists.liveOffLine(4),
    "AI Video Interview is off - your 4 questions are saved but Sarah won't ask them until you turn it on.",
  );
  assert.match(
    STEP5,
    /\{!state\.async_interview_enabled && \(\s*<p className=\{OFF_LINE_CLS\} data-interview-off="async">\s*\{asyncOffLine\(askedCount\(interviewQs\)\)\}/,
  );
  assert.match(
    STEP6,
    /\{!state\.avatar_interview_enabled && \(\s*<p className=\{OFF_LINE_CLS\} data-interview-off="live">\s*\{liveOffLine\(askedCount\(liveQs\)\)\}/,
  );
  assert.equal(
    lists.LIVE_EQUAL_WEIGHT_LINE,
    "Each question counts equally and is marked against its own scoring guide.",
  );
  for (const line of [lists.asyncOffLine(2), lists.liveOffLine(2), lists.LIVE_EQUAL_WEIGHT_LINE]) {
    assert.doesNotMatch(line, /[–—]/);
  }
});

test("the Review cards: the right values, both Off when neither is on, each with its Edit link", () => {
  const q = (question) => ({ id: question, question, competency: "", rubric: "" });
  const base = {
    async_interview_enabled: true,
    allow_rerecord: true,
    avatar_interview_enabled: true,
    interview_questions: [q("a1"), q("a2"), q("   ")],
    live_interview_questions: [q("l1"), q("l2"), q("l3"), q("l4"), q("l5")],
  };
  assert.deepEqual(lists.interviewReviewLines(base, { mode: "ai_guided", minutes: 60 }), {
    async: ["On", "Re-recording allowed", "2 questions"],
    live: ["On", "AI-Guided", "60 minutes", "5 questions"],
    liveWarning: null,
    // Async on with 2 questions: the #61 line.
    asyncWarning: "Needs at least 3 questions before publishing.",
  });
  assert.deepEqual(
    lists.interviewReviewLines(
      {
        ...base,
        async_interview_enabled: false,
        allow_rerecord: false,
        avatar_interview_enabled: false,
      },
      { mode: "structured", minutes: 30 },
    ),
    {
      async: ["Off", "No re-recording", "2 questions"],
      live: ["Off", "Recruiter-Defined", "30 minutes", "5 questions"],
      liveWarning: null,
      asyncWarning: null,
    },
  );
  assert.match(
    STEP10,
    /<ReviewCard label="Async Video Interview" onEdit=\{\(\) => setStep\(5\)\}>\s*<span data-review-interview="async">\{reviewLines\.async\.join\(" · "\)\}<\/span>/,
  );
  assert.match(
    STEP10,
    /<ReviewCard label="AI Video Interview" onEdit=\{\(\) => setStep\(6\)\}>\s*<span data-review-interview="live">\{reviewLines\.live\.join\(" · "\)\}<\/span>/,
  );
});

test("Review's More options keeps only AI CV scoring, Measure response relevancy and Automated rejection email", () => {
  // From the panel's own toggle: "More options" is also named in a comment above it.
  const more = STEP10.slice(STEP10.indexOf("onClick={() => setMoreOpen("));
  const titles = [...more.matchAll(/<OptionRow\s+title="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(titles, [
    "AI CV scoring",
    "Measure response relevancy",
    "Automated rejection email",
  ]);
  assert.doesNotMatch(STEP10, /title="Allow re-recording"|title="Async video interview"/);
});

test("the two editors' Other... state is separate: an edit on one list cannot touch the other", () => {
  const start = lists.NO_OTHER_COMPETENCY;
  const live = lists.setOtherCompetency(start, "live", "q-1", true);
  assert.deepEqual([...live.live], ["q-1"]);
  assert.equal(live.async, start.async, "the async set is the same object, untouched");
  assert.deepEqual([...live.async], []);
  const both = lists.setOtherCompetency(live, "async", "q-1", true);
  const offLive = lists.setOtherCompetency(both, "live", "q-1", false);
  assert.deepEqual([...offLive.async], ["q-1"], "turning live off leaves async on");
  assert.deepEqual([...offLive.live], []);
  // And the lists themselves: replacing one leaves the other as it was.
  const state = { interview_questions: [{ id: "a" }], live_interview_questions: [{ id: "l" }] };
  const next = lists.withQuestions(state, "live", []);
  assert.equal(next.interview_questions, state.interview_questions);
  assert.deepEqual(next.live_interview_questions, []);
  assert.deepEqual(lists.questionsOf({ interview_questions: [] }, "live"), []);
});

test("switching mode on step 6 only sets the mode: no list is touched", () => {
  assert.match(STEP6, /onModeChange=\{\(v\) => set\("live_interview_mode", v\)\}/);
  const settings = readFileSync(new URL("./_live-interview-settings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /interview_questions|onQuestions|setQuestions/);
});

/* ── #59 commit 2: the Review line, the buttons, unsaved changes ── */

const unsaved = await import("./unsaved-changes.ts");

test("Review: AI Video Interview on with fewer than 4 questions says it needs 4 to 8 before publishing", () => {
  const q = (question) => ({ id: question, question, competency: "", rubric: "" });
  const with_ = (n, on = true) =>
    lists.interviewReviewLines(
      {
        async_interview_enabled: false,
        allow_rerecord: true,
        avatar_interview_enabled: on,
        interview_questions: [],
        live_interview_questions: Array.from({ length: n }, (_, i) => q(`l${i}`)),
      },
      { mode: "structured", minutes: 30 },
    ).liveWarning;
  assert.equal(lists.LIVE_NEEDS_QUESTIONS_LINE, "Needs 4 to 8 questions before publishing.");
  for (const n of [0, 3])
    assert.equal(with_(n), "Needs 4 to 8 questions before publishing.", `${n}`);
  for (const n of [4, 8]) assert.equal(with_(n), null, `${n}`);
  assert.equal(with_(0, false), null, "AI Video Interview off: no line");
  assert.match(
    STEP10,
    /\{reviewLines\.liveWarning && \(\s*<span[^>]*data-review-warning>\s*\{reviewLines\.liveWarning\}/,
  );
});

test("the buttons and the status they save: Save draft / Save as draft = On hold; Publish = Published; Save changes keeps the job's status", () => {
  assert.match(
    WIZARD,
    /onClick=\{\(\) => submit\("on_hold"\)\}[\s\S]{0,400}?\{isEdit \? "Save as draft" : "Save draft"\}/,
  );
  assert.match(WIZARD, /onClick=\{\(\) => submit\(isEdit \? state\.status : "open"\)\}/);
  assert.equal((WIZARD.match(/submit\(isEdit \? state\.status : "open"\)/g) ?? []).length, 2);
});

test("dirty: a change is dirty; the saved form is clean; the description box counts, not the columns parsed from it", () => {
  const base = {
    title: "Synthetic role",
    description: "A",
    responsibilities: "",
    requirements: "",
    status: "on_hold",
  };
  const saved = unsaved.formSnapshot(base, "A");
  assert.equal(unsaved.isDirty(saved, unsaved.formSnapshot(base, "A")), false, "nothing changed");
  assert.equal(
    unsaved.isDirty(saved, unsaved.formSnapshot({ ...base, title: "Renamed" }, "A")),
    true,
  );
  assert.equal(unsaved.isDirty(saved, unsaved.formSnapshot(base, "A, edited")), true, "the box");
  // The effect that re-parses the box into the three columns on load is not a change.
  assert.equal(
    unsaved.isDirty(
      saved,
      unsaved.formSnapshot({ ...base, description: "parsed", requirements: "x" }, "A"),
    ),
    false,
  );
  // After a save the baseline is the saved form: clean again.
  const next = { ...base, title: "Renamed" };
  assert.equal(
    unsaved.isDirty(unsaved.formSnapshot(next, "A"), unsaved.formSnapshot(next, "A")),
    false,
  );
  // The wizard resets its baseline on a successful save, and on "Post another".
  // Only a FULL save moves it: a partial one (questions failed) stays dirty.
  assert.match(
    WIZARD,
    /if \(savedEverything\(result\)\) setSavedSnapshot\(formSnapshot\(payload, jdBox\)\);/,
  );
  // After a save the wizard navigates through the guard, never past it.
  assert.equal((WIZARD.match(/leaveGuard\.go\(/g) ?? []).length, 3);
  assert.doesNotMatch(WIZARD, /router\.push\("\/ai-dashboard\/jobs"\)/);
  assert.match(
    WIZARD,
    /setState\(EMPTY_JOB_INPUT\);\s*setSavedSnapshot\(formSnapshot\(EMPTY_JOB_INPUT, jdBox\)\);/,
  );
});

test("moving between steps never warns: the step is not in the compared form, and the rail and Back/Continue are buttons, not links", () => {
  const s = { title: "x", description: "", responsibilities: "", requirements: "" };
  assert.doesNotMatch(unsaved.formSnapshot(s, ""), /"step"/);
  const row = WIZARD.slice(
    WIZARD.indexOf("function StepRow("),
    WIZARD.indexOf("function positionOf("),
  );
  assert.match(row, /<button\s+type="button"\s+onClick=\{\(\) => onGo\(step\.n\)\}/);
  assert.doesNotMatch(row, /<a\b|<Link\b/);
  // Only an <a> is ever stopped.
  const click = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  assert.equal(unsaved.guardedHref(click, null, "https://app.test/ai-dashboard/jobs/new"), null);
});

test("which link clicks are stopped while dirty: in-app pages only", () => {
  const here = "https://app.test/ai-dashboard/jobs/new";
  const click = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  const link = (href, extra = {}) => ({ href, target: "", download: false, ...extra });
  const g = (l, c = click) => unsaved.guardedHref(c, l, here);
  assert.equal(g(link("/ai-dashboard/jobs")), "/ai-dashboard/jobs", "the Jobs button");
  assert.equal(
    g(link("https://app.test/ai-dashboard/applicants?x=1")),
    "/ai-dashboard/applicants?x=1",
  );
  assert.equal(g(link("#preview")), null, "same page");
  assert.equal(g(link("https://other.example/")), null, "another site: the browser's own prompt");
  assert.equal(g(link("/ai-dashboard/jobs", { target: "_blank" })), null, "new tab");
  assert.equal(g(link("/file.pdf", { download: true })), null);
  assert.equal(g(link("/ai-dashboard/jobs"), { ...click, metaKey: true }), null, "cmd-click");
  assert.equal(g(link("/ai-dashboard/jobs"), { ...click, defaultPrevented: true }), null);
});

test("the dialog's wording, exactly; Stay is the default (first focus, Escape)", () => {
  assert.deepEqual(
    [unsaved.LEAVE_TITLE, unsaved.LEAVE_BODY, unsaved.STAY_LABEL, unsaved.LEAVE_LABEL],
    ["Leave without saving?", "Your changes to this job will be lost.", "Stay", "Leave"],
  );
  assert.match(
    WIZARD,
    /useModalFocus\(leaveDialogRef, leaveGuard\.pending !== null, \{\s*onClose: leaveGuard\.stay,\s*initialFocus: stayButtonRef,/,
  );
  assert.match(WIZARD, /ref=\{stayButtonRef\}[\s\S]{0,160}onClick=\{leaveGuard\.stay\}/);
  assert.match(
    WIZARD,
    /const leaveGuard = useUnsavedChangesGuard\(\s*dirty,\s*\(href\) => router\.push\(href\),\s*\(href\) => router\.replace\(href\),\s*\);/,
  );
  for (const s of [unsaved.LEAVE_TITLE, unsaved.LEAVE_BODY]) assert.doesNotMatch(s, /[–—]/);
});

/* ── #61: the async minimum on step 5 and Review ── */

test("#61 the Review card says it needs at least 3 questions while async is on with fewer; step 5 itself does not", () => {
  const q = (question) => ({ id: question, question, competency: "", rubric: "" });
  const state = (on, n) => ({
    async_interview_enabled: on,
    interview_questions: Array.from({ length: n }, (_, i) => q(`a${i}`)),
  });
  assert.equal(lists.ASYNC_NEEDS_QUESTIONS_LINE, "Needs at least 3 questions before publishing.");
  for (const n of [0, 2]) assert.equal(lists.asyncNeedsQuestions(state(true, n)), true, `${n}`);
  for (const n of [3, 8]) assert.equal(lists.asyncNeedsQuestions(state(true, n)), false, `${n}`);
  assert.equal(lists.asyncNeedsQuestions(state(false, 0)), false, "off: no line");
  assert.doesNotMatch(
    STEP5,
    /data-async-needs-questions|ASYNC_NEEDS_QUESTIONS_LINE|asyncNeedsQuestions/,
  );
  assert.match(
    STEP10,
    /\{reviewLines\.asyncWarning && \(\s*<span[^>]*data-review-warning>\s*\{reviewLines\.asyncWarning\}/,
  );
});

/* ── #61 follow-up: Continue stops on a step whose interview needs questions ── */

const SEQ = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const stepState = ({ asyncOn = false, async = 0, liveOn = false, live = 0 } = {}) => {
  const q = (question) => ({ id: question, question, competency: "", rubric: "" });
  const n = (k, p) => Array.from({ length: k }, (_, i) => q(`${p}${i}`));
  return {
    async_interview_enabled: asyncOn,
    interview_questions: n(async, "a"),
    avatar_interview_enabled: liveOn,
    live_interview_questions: n(live, "l"),
  };
};
/** The wizard's move: walkForward with the interview rule as the step check. */
const move = (state, from, target) =>
  lists.walkForward(SEQ, from, target, (k) => lists.interviewStepBlock(k, state) === null);

test("#61 Continue: the two messages, exactly, hyphens only", () => {
  assert.equal(
    lists.ASYNC_CONTINUE_BLOCKED,
    "Add at least 3 questions, or turn Async Video Interview off, to continue.",
  );
  assert.equal(
    lists.LIVE_CONTINUE_BLOCKED,
    "Add 4 to 8 questions, or turn AI Video Interview off, to continue.",
  );
  for (const m of [lists.ASYNC_CONTINUE_BLOCKED, lists.LIVE_CONTINUE_BLOCKED]) {
    assert.doesNotMatch(m, /[‒-―]/);
  }
});

test("#61 Continue on step 5: blocked at 0 and 2 async questions, allowed at 3; off never blocks", () => {
  for (const async of [0, 2]) {
    const s = stepState({ asyncOn: true, async });
    assert.equal(lists.interviewStepBlock(5, s), lists.ASYNC_CONTINUE_BLOCKED, `${async}`);
    assert.equal(move(s, 5, 6), 5, `Continue stays on step 5 at ${async}`);
  }
  for (const async of [3, 8]) {
    const s = stepState({ asyncOn: true, async });
    assert.equal(lists.interviewStepBlock(5, s), null);
    assert.equal(move(s, 5, 6), 6, `${async}`);
  }
  const off = stepState({ asyncOn: false, async: 0 });
  assert.equal(lists.interviewStepBlock(5, off), null);
  assert.equal(move(off, 5, 6), 6, "off: never blocked");
});

test("#61 Continue on step 6: blocked at 0 and 3 live questions, allowed at 4; off never blocks", () => {
  for (const live of [0, 3]) {
    const s = stepState({ liveOn: true, live });
    assert.equal(lists.interviewStepBlock(6, s), lists.LIVE_CONTINUE_BLOCKED, `${live}`);
    assert.equal(move(s, 6, 7), 6, `Continue stays on step 6 at ${live}`);
  }
  for (const live of [4, 8]) {
    const s = stepState({ liveOn: true, live });
    assert.equal(lists.interviewStepBlock(6, s), null);
    assert.equal(move(s, 6, 7), 7);
  }
  const off = stepState({ liveOn: false, live: 0 });
  assert.equal(move(off, 6, 7), 7, "off: never blocked");
  // Each step asks only about its own interview; every other step never blocks.
  const both = stepState({ asyncOn: true, async: 0, liveOn: true, live: 0 });
  for (const k of [1, 2, 3, 4, 7, 8, 9, 10]) assert.equal(lists.interviewStepBlock(k, both), null);
});

test("#61 the rail: a later step from a blocked step is blocked, and nothing skips over it; earlier steps stay clickable", () => {
  const asyncShort = stepState({ asyncOn: true, async: 2 });
  for (const target of [6, 7, 9, 10])
    assert.equal(move(asyncShort, 5, target), 5, `5 -> ${target}`);
  assert.equal(move(asyncShort, 2, 9), 5, "from an earlier step, it stops on the blocked one");
  for (const target of [1, 2, 3, 4]) assert.equal(move(asyncShort, 5, target), target, "back");
  assert.equal(move(asyncShort, 9, 2), 2, "back from a later step");
  const liveShort = stepState({ asyncOn: true, async: 3, liveOn: true, live: 3 });
  assert.equal(move(liveShort, 6, 10), 6);
  assert.equal(move(liveShort, 1, 10), 6, "step 5 passes, step 6 stops it");
  assert.equal(move(liveShort, 6, 5), 5, "back to 5");
  assert.equal(move(stepState({ liveOn: true, live: 4 }), 1, 10), 10, "nothing blocked: lands");
});

test("#61 wiring: Continue and the rail go through the walk; validate asks the rule first; the line sits by the button", () => {
  assert.match(
    WIZARD,
    /function goTo\(target: number\) \{\s*setStep\(walkForward\(SEQUENCE, step, target, validate\)\);\s*\}/,
  );
  assert.match(
    WIZARD,
    /function validate\(target: number\): boolean \{[\s\S]{0,200}?const blocked = interviewStepBlock\(target, state\);\s*if \(blocked\) \{\s*showToast\(blocked\);\s*return false;/,
  );
  assert.match(
    WIZARD,
    /const next = stepAt\(positionOf\(step\) \+ 1\);\s*if \(next !== null\) goTo\(next\);/,
  );
  assert.equal((WIZARD.match(/onGo=\{goTo\}/g) ?? []).length, 3, "every rail block");
  assert.match(
    WIZARD,
    /\{interviewStepBlock\(step, state\) && \(\s*<p className="text-xs text-\[#C4362F\]" data-step-blocked>\s*\{interviewStepBlock\(step, state\)\}/,
  );
  // The same rules in create and edit: nothing in the rule or the walk reads isEdit.
  assert.doesNotMatch(
    WIZARD.slice(WIZARD.indexOf("function validate("), WIZARD.indexOf("// ── Screening builder")),
    /isEdit/,
  );
});

test("#61 Back and Save draft are never blocked: neither goes through the walk or the step rule", () => {
  // Back: straight to the previous step.
  assert.match(
    WIZARD,
    /onClick=\{\(\) => \{\s*const prev = stepAt\(positionOf\(step\) - 1\);\s*if \(prev !== null\) setStep\(prev\);\s*\}\}/,
  );
  // Save draft: submit("on_hold"), whose draft branch checks the title only; the
  // publish branch validates steps 1 to 4, never 5 or 6 (the server gates Publish).
  const submit = WIZARD.slice(
    WIZARD.indexOf("async function submit("),
    WIZARD.indexOf("inFlightRef.current = true;", WIZARD.indexOf("async function submit(")),
  );
  assert.match(submit, /if \(status === "open"\) \{[\s\S]*?for \(let k = 1; k <= 4; k\+\+\)/);
  assert.match(submit, /\} else if \(!state\.title\.trim\(\)\) \{/);
  assert.doesNotMatch(submit, /interviewStepBlock|walkForward|goTo\(/);
  // And while blocked, the walk itself never stops a move back.
  const blocked = stepState({ asyncOn: true, async: 0, liveOn: true, live: 0 });
  assert.equal(move(blocked, 6, 5), 5);
  assert.equal(move(blocked, 5, 4), 4);
});

test("#61 a blocked step shows ONE red line, by Continue: none on step 5 or step 6 themselves", () => {
  for (const [name, src] of [
    ["step 5", STEP5],
    ["step 6", STEP6],
  ]) {
    assert.doesNotMatch(src, /C4362F/, `${name}: no red line of its own`);
  }
  const footer = WIZARD.slice(WIZARD.indexOf("{step === 9 && <AutoshortlistStep"));
  assert.equal(
    (footer.match(/data-step-blocked/g) ?? []).length,
    1,
    "the one line, by the buttons",
  );
});
