/**
 * The AI Video Interview CV-slot writer (lib/interviews/live-questions.ts)
 * against a fake model client: CV slots only, strict reading, one retry, the
 * safety and quality checks, the rewrite and the general bank. Every job
 * line, CV line and name is made up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-questions.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  GENERAL_EXPERIENCE_BANK,
  LIVE_QUESTIONS_PROMPT_VERSION,
  LiveQuestionsError,
  questionQualityIssues,
  questionSafetyIssues,
  writeLiveQuestions,
} = await import("./live-questions.ts");

const NAME = { firstName: "Alex", lastName: "Example" };
const JOB = {
  title: "Backend Engineer",
  description: "Build and run high-volume APIs for a logistics platform.",
  responsibilities: "Design REST APIs. Own services in production.",
  requirements: "TypeScript, Node.js, PostgreSQL. Experience running services in production.",
};
const JOB_QUESTIONS = [
  "Tell me about a REST API you designed for heavy traffic.",
  "Tell me about a production incident you owned from start to finish.",
  "Tell me about a time you made a slow service faster.",
  "Tell me about a code review that changed how you work.",
];
const CV = [
  "[candidate] | [email] | [phone]",
  "Backend Engineer, Northwind Logistics (2021 - Present): led the move of the order service to",
  "Node.js and TypeScript, cut report generation from 40 minutes to 4, mentored two developers.",
  "Software Engineer, Contoso Retail (2019 - 2021): built REST APIs on PostgreSQL and Redis.",
].join("\n");

const guide = {
  strong: "Describes a specific piece of work, the candidate's own decisions and the result.",
  weak: "Stays general with no example of their own.",
};
const CV_ITEMS = [
  "the order service move at Northwind",
  "the report generation work at Northwind",
  "the mentoring you did at Northwind",
  "the REST APIs you built at Contoso",
];
const GENERAL = [
  "Tell me about a deadline you met by changing how your team planned its work.",
  "Tell me about a disagreement over a technical choice that you helped settle.",
  "Tell me about something you automated that used to be done by hand.",
  "Tell me about feedback on your work that changed the way you build things.",
];
const cvQ = (slot, source = "cv") => ({
  slot,
  source,
  question:
    source === "cv"
      ? `Walk me through what you owned in ${CV_ITEMS[slot - 1]}.`
      : GENERAL[slot - 1],
  competency: "Ownership",
  ...guide,
});
const reply = (source = "cv", edit = (q) => q) => ({
  questions: [1, 2, 3, 4].map((n) => cvQ(n, source)).map(edit),
});

/** A model client answering with `replies` in turn (the last repeats); records every request. */
function fakeClient(replies) {
  const requests = [];
  let i = 0;
  return {
    requests,
    messages: {
      async create(request) {
        requests.push(request);
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return {
          content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 400 },
        };
      },
    },
  };
}

const write = (client, overrides = {}) =>
  writeLiveQuestions(
    { job: JOB, jobQuestions: JOB_QUESTIONS, cvText: CV, cvSlots: 4, name: NAME, ...overrides },
    { client },
  );

/** Run `fn` with the console silenced, returning what it logged and its result. */
async function quietly(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  try {
    return { lines, result: await fn() };
  } finally {
    Object.assign(console, orig);
  }
}

/* ── CV slots only ────────────────────────────────────────────── */

test("writes exactly the 4 CV slots, each with its source, competency and private guide", async () => {
  const client = fakeClient([reply()]);
  const { result } = await quietly(() => write(client));
  assert.equal(LIVE_QUESTIONS_PROMPT_VERSION, "live-questions-v1");
  assert.deepEqual(
    result.questions.map((q) => [q.slot, q.source]),
    [1, 2, 3, 4].map((s) => [s, "cv"]),
  );
  for (const q of result.questions)
    assert.match(q.scoring_guide, /^Strong answer: .+ Weak answer: .+/);
  assert.deepEqual([result.calls, result.input_tokens, result.output_tokens], [1, 1000, 400]);
  assert.deepEqual([result.rewritten, result.replaced, result.flagged], [0, 0, []]);
  assert.equal(result.model, "claude-haiku-5-5");
});

test("the request: the job questions to avoid, never to write; the CV as given; Haiku 5.5, thinking off", async () => {
  const client = fakeClient([reply()]);
  await quietly(() => write(client));
  const [req] = client.requests;
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.thinking, { type: "disabled" });
  const content = req.messages[0].content;
  assert.match(content, /^Slots: 4\./);
  assert.match(content, /The employer's job questions \(do not overlap with them\):/);
  for (const q of JOB_QUESTIONS) assert.ok(content.includes(q));
  assert.ok(content.includes("led the move of the order service"));
  assert.match(req.system, /Never repeat, rephrase or rewrite them/);
  assert.match(req.system, /ONE thing, in ONE sentence/);
  assert.match(req.system, /never write "such as", "including", "e\.g\." or "for example"/);
});

test("a job question is never accepted in a CV slot", async () => {
  const client = fakeClient([reply("cv", (q) => (q.slot === 1 ? { ...q, source: "job" } : q))]);
  await assert.rejects(
    quietly(() => write(client)),
    (err) => err instanceof LiveQuestionsError && err.code === "bad_output",
  );
  assert.equal(client.requests.length, 2, "one retry, then the error");
});

test("a thin CV: it is not sent, and every CV slot is a general experience question", async () => {
  const client = fakeClient([reply("cv"), reply("general_experience")]);
  const { result } = await quietly(() => write(client, { cvText: "[candidate] | [email]" }));
  assert.deepEqual(
    result.questions.map((q) => q.source),
    ["general_experience", "general_experience", "general_experience", "general_experience"],
  );
  assert.equal(result.calls, 2, "a cv source on a thin CV is refused and retried");
  for (const req of client.requests) {
    assert.match(
      req.messages[0].content,
      /too thin to ask about: every slot must be general_experience/,
    );
    assert.ok(!req.messages[0].content.includes("CV (contact details"), "no CV block at all");
  }
});

/* ── strict reading: one retry, then a typed error ────────────── */

const BAD = [
  ["not JSON", "Here are your questions!"],
  ["three questions", { questions: reply().questions.slice(0, 3) }],
  ["five questions", { questions: [...reply().questions, cvQ(5)] }],
  ["a slot out of order", reply("cv", (q) => (q.slot === 2 ? { ...q, slot: 3 } : q))],
  ["an empty question", reply("cv", (q) => (q.slot === 3 ? { ...q, question: "  " } : q))],
  [
    "a four-word question",
    reply("cv", (q) => (q.slot === 3 ? { ...q, question: "Tell me about Northwind." } : q)),
  ],
  [
    "an unknown competency",
    reply("cv", (q) => (q.slot === 4 ? { ...q, competency: "Charisma" } : q)),
  ],
  ["no strong guide", reply("cv", (q) => (q.slot === 2 ? { ...q, strong: "" } : q))],
  ["no weak guide", reply("cv", (q) => (q.slot === 3 ? { ...q, weak: "x" } : q))],
  [
    "a repeated question",
    reply("cv", (q) => (q.slot === 4 ? { ...q, question: cvQ(1).question } : q)),
  ],
  ["an unknown source", reply("cv", (q) => (q.slot === 2 ? { ...q, source: "hobby" } : q))],
];

for (const [label, bad] of BAD) {
  test(`bad output (${label}): one retry, then LiveQuestionsError bad_output`, async () => {
    const client = fakeClient([bad, bad]);
    await assert.rejects(
      quietly(() => write(client)),
      (err) => err instanceof LiveQuestionsError && err.code === "bad_output",
    );
    assert.equal(client.requests.length, 2);
    assert.match(client.requests[1].messages[0].content, /Your previous reply could not be used/);
  });
}

test("bad then good: the retry's set is used", async () => {
  const { result } = await quietly(() => write(fakeClient(["not json", reply()])));
  assert.equal(result.questions.length, 4);
  assert.equal(result.calls, 2);
});

test("a failing model call is a typed error; no job text is refused before any call", async () => {
  await assert.rejects(
    quietly(() => write(fakeClient([new Error("overloaded")]))),
    (err) => err instanceof LiveQuestionsError && err.code === "model_error",
  );
  const client = fakeClient([reply()]);
  await assert.rejects(
    quietly(() =>
      write(client, {
        job: { title: "X", description: "", responsibilities: null, requirements: " " },
      }),
    ),
    (err) => err instanceof LiveQuestionsError && err.code === "no_job_text",
  );
  assert.equal(client.requests.length, 0);
});

/* ── the quality checks ───────────────────────────────────────── */

test("quality: one clear ask passes; two asks, two question marks and hint lists are caught", () => {
  for (const text of [
    "Walk me through how you designed the event pipeline at Northwind.",
    "Tell me about the order service move you led at Northwind.",
    "At Northwind you led the order service move. Walk me through what you owned in it.",
    "What did you change in the on-call rotation at Parcelpath?",
    "Tell me about a time you worked with a designer and a product manager.",
  ]) {
    assert.deepEqual(questionQualityIssues(text), [], text);
  }
  for (const [text, issue] of [
    ["How did you design it? What would you change?", "two_question_marks"],
    ["Walk me through the migration. How did you handle the cutover?", "second_ask"],
    ["Tell me about the migration you led. What did you learn from it.", "second_ask"],
    ["Walk me through the migration and how you handled the cutover.", "second_ask"],
    ["Tell me about the matching logic you built, and why you chose it.", "second_ask"],
    ["Tell me what you owned in the rebuild or what you would do differently.", "second_ask"],
    ["How did you design it to handle ordering, duplicates and consumer failures?", "hint_list"],
    ["Tell me about a service you built with Node.js, Kafka, Redis and AWS.", "hint_list"],
    ["Tell me about a migration, such as moving a monolith to services.", "hint_list"],
    ["Tell me about the tools you used, including any monitoring you set up.", "hint_list"],
    ["Tell me about a time you improved reliability, e.g. by adding retries.", "hint_list"],
  ]) {
    assert.ok(questionQualityIssues(text).includes(issue), `${text} -> ${issue}`);
  }
});

const badAt = {
  1: "Walk me through the order service move at Northwind. How did you handle the cutover?",
  3: "How did you design the report pipeline to handle retries, ordering and duplicate jobs?",
};
const withBadQuality = () =>
  reply("cv", (q) => (badAt[q.slot] ? { ...q, question: badAt[q.slot] } : q));

const REWRITES = [
  "Tell me about the cutover plan for the order service move at Northwind.",
  "Walk me through how you sped up report generation at Northwind.",
  "Tell me about the hardest part of the REST API work at Contoso.",
];
/** A rewrite reply numbered 1..n, as the request asks; matched back to the failing slots by order. */
const rewriteOf = (n, texts = REWRITES) => ({
  questions: Array.from({ length: n }, (_, i) => ({
    ...cvQ(i + 1),
    slot: i + 1,
    question: texts[i],
  })),
});

test("a question failing a quality check is rewritten once; the request lists each one and why", async () => {
  const client = fakeClient([withBadQuality(), rewriteOf(2)]);
  const { result } = await quietly(() => write(client));
  assert.deepEqual(result.flagged, [
    { slot: 1, issues: ["second_ask"] },
    { slot: 3, issues: ["hint_list"] },
  ]);
  assert.deepEqual([result.calls, result.rewritten, result.replaced], [2, 2, 0]);
  assert.equal(
    result.questions[0].text,
    REWRITES[0],
    "the first replacement goes to the first failing slot",
  );
  assert.equal(result.questions[2].text, REWRITES[1], "the second to the second");
  const redo = client.requests[1].messages[0].content;
  assert.match(
    redo,
    /Replace these 2 question\(s\)\. Return exactly 2 question\(s\), numbered 1 to 2/,
  );
  assert.match(
    redo,
    /1\. a cv question \(was: "Walk me through the order service move at Northwind\. How did you handle the cutover\?"\): it asked a second thing\./,
  );
  assert.match(redo, /2\. a cv question \(was: .+\): it listed what the answer should cover\./);
  assert.match(
    redo,
    /Keep these, and do not repeat them:\n- Walk me through what you owned in the report generation/,
  );
  for (const q of result.questions) assert.deepEqual(questionQualityIssues(q.text), []);
});

test("a rewrite that still fails quality is replaced from the general bank", async () => {
  const client = fakeClient([withBadQuality(), rewriteOf(2, [badAt[1], badAt[3]])]);
  const { result } = await quietly(() => write(client));
  assert.equal(result.replaced, 2);
  for (const slot of [1, 3]) {
    assert.equal(result.questions[slot - 1].source, "general_experience");
    assert.ok(GENERAL_EXPERIENCE_BANK.some((b) => b.text === result.questions[slot - 1].text));
  }
});

test("overlap: a near-repeat of a job question or an earlier CV question is caught and replaced", async () => {
  const { questionsOverlap } = await import("./live-questions.ts");
  assert.equal(
    questionsOverlap(
      "Walk me through how you brought first-response time down from nine hours to two at ClinicSoft.",
      "Walk me through how you brought first-response time down from 9 hours to 2 at ClinicSoft.",
    ),
    true,
  );
  assert.equal(
    questionsOverlap(
      "Walk me through how you ran the weekly call reviews for the evening shift at ClinicSoft.",
      "Walk me through how you brought first-response time down from nine hours to two at ClinicSoft.",
    ),
    false,
    "different work at the same employer",
  );
  assert.deepEqual(questionQualityIssues(JOB_QUESTIONS[0], JOB_QUESTIONS), ["overlap"]);

  // Slot 2 repeats slot 1; slot 4 repeats a job question. The first of a pair stays.
  const client = fakeClient([
    reply("cv", (q) =>
      q.slot === 2
        ? { ...q, question: cvQ(1).question.replace("Walk me", "Please walk me") }
        : q.slot === 4
          ? { ...q, question: JOB_QUESTIONS[2] }
          : q,
    ),
    rewriteOf(2),
  ]);
  const { result } = await quietly(() => write(client));
  assert.deepEqual(result.flagged, [
    { slot: 2, issues: ["overlap"] },
    { slot: 4, issues: ["overlap"] },
  ]);
  assert.equal(result.replaced, 0);
  const texts = result.questions.map((q) => q.text);
  for (const [i, t] of texts.entries()) {
    assert.deepEqual(questionQualityIssues(t, [...JOB_QUESTIONS, ...texts.slice(0, i)]), [], t);
  }
});

/* ── the safety check ─────────────────────────────────────────── */

const unsafeAt = {
  1: "Tell me about the project Example led at Northwind.",
  2: "Tell me about your work at Northwind and confirm alex.example@example.com is yours.",
  4: "Tell me how your family shaped the way you work at Northwind.",
};
const withUnsafe = () =>
  reply("cv", (q) => (unsafeAt[q.slot] ? { ...q, question: unsafeAt[q.slot] } : q));

test("unsafe questions are rewritten in one call, and never repeated back to the model", async () => {
  const client = fakeClient([withUnsafe(), rewriteOf(3)]);
  const { result } = await quietly(() => write(client));
  assert.deepEqual([result.calls, result.replaced], [2, 0]);
  for (const q of result.questions) assert.deepEqual(questionSafetyIssues(q.text, NAME), []);
  const redo = client.requests[1].messages[0].content;
  for (const unsafe of Object.values(unsafeAt)) assert.ok(!redo.includes(unsafe), "not echoed");
  assert.match(redo, /it used the candidate's name/);
  assert.match(redo, /it touched a personal or protected topic/);
});

test("a rewrite still unsafe, or a failed rewrite call, is replaced from the general bank", async () => {
  for (const second of [
    rewriteOf(3, [unsafeAt[1], unsafeAt[2], unsafeAt[4]]),
    rewriteOf(4),
    new Error("overloaded"),
  ]) {
    const { result } = await quietly(() => write(fakeClient([withUnsafe(), second])));
    assert.equal(result.replaced, 3);
    assert.equal(new Set(result.questions.map((q) => q.text)).size, 4, "no bank question twice");
    for (const q of result.questions) assert.deepEqual(questionSafetyIssues(q.text, NAME), []);
  }
});

test("the safety check: what is caught, and ordinary interview language that is not", () => {
  for (const [text, issue] of [
    ["Tell me about Alex Example's time at Northwind.", "name"],
    ["What did Example own in that project?", "name"],
    ["Email me at jane@example.com about your project.", "contact"],
    ["Call +92 300 1234567 to discuss the role.", "contact"],
    ["See github.com/someone/repo and tell me about it.", "contact"],
    ["Tell me about [candidate]'s project.", "placeholder"],
    ["How old were you when you started programming?", "protected_topic"],
    ["Are you married, and does that affect your hours?", "protected_topic"],
    ["What religion do you follow?", "protected_topic"],
    ["Tell me about your nationality and visa.", "protected_topic"],
    ["Does your health affect the hours you can work?", "protected_topic"],
    ["Do you have children who need care?", "protected_topic"],
    ["How does your gender shape your leadership?", "protected_topic"],
  ]) {
    assert.ok(questionSafetyIssues(text, NAME).includes(issue), `${text} -> ${issue}`);
  }
  for (const text of [
    "Tell me about a race condition you debugged in production.",
    "Tell me about your background in data engineering.",
    "Tell me about a healthcare product you built.",
    "Tell me about a learning tool you built for children's schools.",
    "Alex, tell me about a project you led at Northwind.",
  ]) {
    assert.deepEqual(questionSafetyIssues(text, NAME), [], text);
  }
});

test("the general bank: eight distinct questions, each passing both checks, each with a guide", () => {
  assert.equal(GENERAL_EXPERIENCE_BANK.length, 8);
  assert.equal(new Set(GENERAL_EXPERIENCE_BANK.map((b) => b.text)).size, 8);
  for (const b of GENERAL_EXPERIENCE_BANK) {
    assert.equal(b.source, "general_experience");
    assert.deepEqual(questionSafetyIssues(b.text, NAME), [], b.text);
    assert.deepEqual(questionQualityIssues(b.text), [], b.text);
    assert.match(b.scoring_guide, /^Strong answer: .+ Weak answer: .+/);
  }
});

test("never logged: the CV, the job text, the reply or the questions", async () => {
  const { lines } = await quietly(() => write(fakeClient([withUnsafe(), new Error("overloaded")])));
  const all = lines.join("\n");
  for (const secret of [
    "order service",
    "Northwind",
    "logistics platform",
    "Tell me about",
    "Walk me",
  ]) {
    assert.ok(!all.includes(secret), secret);
  }
  assert.ok(
    lines.some((l) => l.startsWith("[provider-call] ")),
    "a provider-call line per call",
  );
});
