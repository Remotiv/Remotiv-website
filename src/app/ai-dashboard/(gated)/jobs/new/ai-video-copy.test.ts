/**
 * #12, #45, #46: the job wizard's AI Video Interview words, as approved on
 * 23 and 24 Nov, and the mode, length and hiring challenges controls on the
 * Interview questions step, rendered with react-dom/server.
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
const {
  AI_VIDEO_OPTION_DESCRIPTION,
  AI_VIDEO_QUESTION_COUNT_WARNING,
  aiVideoQuestionCountOutOfRange,
  aiVideoQuestionsHint,
} = copy;

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
  assert.equal(
    AI_VIDEO_QUESTION_COUNT_WARNING,
    "AI Video Interview requires 4 to 8 questions. Please update the job's interview questions to continue.",
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

test("the warning shows below 4 and above 8, matching the send's refusal", () => {
  for (const n of [0, 1, 3, 9, 20]) assert.equal(aiVideoQuestionCountOutOfRange(n), true, `${n}`);
  for (const n of [4, 5, 6, 7, 8]) assert.equal(aiVideoQuestionCountOutOfRange(n), false, `${n}`);
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

/** The AI Video Interview OptionRow, from its title to its closing tag. */
function aiVideoRow() {
  const start = WIZARD.lastIndexOf("<OptionRow", WIZARD.indexOf('title="AI Video Interview"'));
  const end = WIZARD.indexOf("</OptionRow>", start);
  assert.ok(start > 0 && end > start);
  return WIZARD.slice(start, end);
}

test("the controls sit at the top of the Interview questions step, on the job's own toggle and values", () => {
  const step5 = WIZARD.slice(
    WIZARD.indexOf("{step === 5 && ("),
    WIZARD.indexOf("{step === 9 && ("),
  );
  assert.match(
    step5,
    /^\{step === 5 && \(\s*<>\s*<LiveInterviewSettings\s+enabled=\{state\.avatar_interview_enabled\}/,
  );
  for (const k of ["live_interview_mode", "live_interview_minutes", "live_hiring_challenges"]) {
    assert.ok(step5.includes(`set("${k}", v)`), k);
  }
});

test("the option row: description, the hint on the chosen length, and the warning on the same count", () => {
  const row = aiVideoRow();
  assert.match(row, /desc=\{AI_VIDEO_OPTION_DESCRIPTION\}/);
  assert.match(
    row,
    /<p className=\{HINT_CLS\}>\s*\{aiVideoQuestionsHint\(\s*state\.live_interview_minutes \?\? DEFAULT_LIVE_INTERVIEW_MINUTES,?\s*\)\}\s*<\/p>/,
  );
  assert.match(
    row,
    /\{aiVideoQuestionCountOutOfRange\(\s*state\.interview_questions\.filter\(\(q\) => q\.question\.trim\(\)\)\.length,\s*\) && \(\s*<p className="[^"]+">\s*\{AI_VIDEO_QUESTION_COUNT_WARNING\}\s*<\/p>\s*\)\}/,
  );
});

test("no CV promise and no 'the first 4' left in the option or the wizard's AI Video copy", () => {
  assert.doesNotMatch(aiVideoRow(), /CV/);
  assert.doesNotMatch(WIZARD, /CV-based|the first\{" "\}|describeQuestionMix|questionMixFor/);
  const strings = [
    AI_VIDEO_OPTION_DESCRIPTION,
    aiVideoQuestionsHint(30),
    aiVideoQuestionsHint(60),
    AI_VIDEO_QUESTION_COUNT_WARNING,
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
