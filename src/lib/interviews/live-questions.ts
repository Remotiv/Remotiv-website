import "server-only";
import { COMPETENCIES } from "@/lib/ai/interview-questions";
import { extractText, thinkingOffParams } from "@/lib/ai/model-params";
import { AI_MATCHING_MODEL } from "@/lib/anthropic";
import {
  CANDIDATE_TAG,
  type CandidateName,
  mentionsCandidateName,
} from "@/lib/interviews/candidate-name";
import {
  ADDRESS_TAG,
  EMAIL_TAG,
  LINK_TAG,
  PHONE_TAG,
  sanitizeCvForInterview,
} from "@/lib/interviews/cv-sanitize";
import type { LiveQuestionSource } from "@/lib/interviews/frozen-questions";
import { cvSupportsQuestions } from "@/lib/interviews/question-mix";
import { QUESTION_TEXT_MAX, RUBRIC_MAX } from "@/lib/interviews/types";
import { logProviderCall } from "@/lib/queue/budgets";

/**
 * The CV-slot questions of an AI Video Interview, written per candidate.
 *
 * ── Only the CV slots ────────────────────────────────────────
 *
 * The job slots hold the job's own authored questions, word for word, the
 * same for every candidate of the job (live-question-freeze.ts takes them from
 * the invite's snapshot). The model never writes or rewrites them. It is
 * given their text only so its questions do not cover the same ground.
 *
 * Each CV slot gets a CV question, or a general experience question when the
 * CV is too thin to support one. A CV slot never becomes a job question.
 *
 * ── What the model sees ──────────────────────────────────────
 *
 * The job text, the job questions, and the CV only after sanitizeCvForInterview
 * and removeCandidateName: no email, phone, link, address or name. A CV too
 * thin to ask about is not sent at all; every CV slot is then general
 * experience.
 *
 * ── Strict, then checked, then safe ──────────────────────────
 *
 *   1. One Haiku 5.5 call, thinking off. The reply must have exactly the CV
 *      slots' count, every source right, every field present and within
 *      length, a known competency, no question twice. Anything else: one more
 *      call, then LiveQuestionsError. Nothing partial is returned.
 *   2. Every question's TEXT is checked for safety (no contact detail or
 *      placeholder, no candidate name, no protected or personal topic) and
 *      quality (one ask, at most one "?", no list or "such as" hint of what to
 *      cover). Failing questions are rewritten in one more call; a rewrite that
 *      still fails, or the call failing, is replaced from a fixed bank of
 *      general experience questions that pass both checks.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * The CV, the job text, the model's reply and the questions. A provider-call
 * line per call carries the model, timing and outcome; the caller records the
 * token totals and check counts with the frozen set.
 */

export const LIVE_QUESTIONS_PROMPT_VERSION = "live-questions-v1";

const MAX_TOKENS = 2_000;
const TIMEOUT_MS = 45_000;
const MAX_SECTION_CHARS = 4_000;
const MAX_CV_CHARS = 8_000;
const QUESTION_WORDS_MIN = 6;
const QUESTION_WORDS_MAX = 40;
const GUIDE_STRONG_MIN = 20;
const GUIDE_WEAK_MIN = 10;
const GUIDE_PART_MAX = 450;

export type LiveQuestionsErrorCode = "no_job_text" | "bad_output" | "model_error";

/** The writer could not produce a usable set. Nothing about the candidate in the message. */
export class LiveQuestionsError extends Error {
  readonly code: LiveQuestionsErrorCode;
  constructor(code: LiveQuestionsErrorCode, detail: string) {
    super(`live questions: ${code}: ${detail}`);
    this.name = "LiveQuestionsError";
    this.code = code;
  }
}

/** What a model client must offer: the Anthropic SDK's messages.create, or a fake. */
export type LiveQuestionsClient = {
  messages: {
    create(
      request: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      content: ReadonlyArray<{ type: string; text?: unknown }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
};

export type JobText = {
  title: string | null;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
};

/** A written CV-slot question. `slot` is 1..count among the CV slots, not the interview position. */
export type WrittenQuestion = {
  slot: number;
  text: string;
  source: Exclude<LiveQuestionSource, "job">;
  competency: string;
  scoring_guide: string;
};

export type CheckIssue = SafetyIssue | QualityIssue;

export type LiveQuestionsResult = {
  questions: WrittenQuestion[];
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** Which slots failed which checks on the first reply; codes only, never text. */
  flagged: { slot: number; issues: CheckIssue[] }[];
  rewritten: number;
  replaced: number;
};

/* ── the general experience bank: the last resort ─────────────── */

/**
 * Used only when a written question fails a check twice. Fixed and reviewed:
 * each is one ask, no hints, safe, about past work in general, of similar
 * difficulty to a CV question, with a guide of the same shape the model writes.
 */
export const GENERAL_EXPERIENCE_BANK: readonly Omit<WrittenQuestion, "slot">[] = [
  {
    text: "Tell me about a piece of work relevant to this role that you are proud of.",
    source: "general_experience",
    competency: "Ownership",
    scoring_guide:
      "Strong answer: describes one specific piece of work, what the candidate personally did, the decisions they made and the result, and links it to what this role needs. Weak answer: stays general, describes what the team did without the candidate's part, or gives no result.",
  },
  {
    text: "Tell me about a time a piece of your work did not go as planned.",
    source: "general_experience",
    competency: "Problem solving",
    scoring_guide:
      "Strong answer: names a real setback, explains how the candidate understood the cause, what they changed and what they learned. Weak answer: no concrete example, blames others, or describes no action of their own.",
  },
  {
    text: "Tell me about a time you had to learn something new quickly to get a piece of work done.",
    source: "general_experience",
    competency: "Adaptability",
    scoring_guide:
      "Strong answer: gives a specific situation, how the candidate learned, how they applied it and the outcome. Weak answer: claims to learn quickly without an example, or the example has no outcome.",
  },
  {
    text: "Tell me about your own part in a piece of work you delivered with other people.",
    source: "general_experience",
    competency: "Collaboration",
    scoring_guide:
      "Strong answer: describes the goal, who was involved, the candidate's own contribution and how they worked with others to reach the result. Weak answer: only describes the team's work, or cannot say what their own part was.",
  },
  {
    text: "Tell me about a decision you made at work where you had to weigh up two options.",
    source: "general_experience",
    competency: "Problem solving",
    scoring_guide:
      "Strong answer: sets out the two options, the facts the candidate weighed, the choice and why, and what happened. Weak answer: no real trade-off, or a decision someone else made.",
  },
  {
    text: "Tell me about a time you improved the way something was done in your work.",
    source: "general_experience",
    competency: "Ownership",
    scoring_guide:
      "Strong answer: describes what was wrong before, what the candidate changed, how they got it adopted and the difference it made. Weak answer: an idea that was never acted on, or no clear before and after.",
  },
  {
    text: "Tell me about a time you had to explain something complex to someone outside your field.",
    source: "general_experience",
    competency: "Communication",
    scoring_guide:
      "Strong answer: names the audience, what made it hard, how the candidate adapted the explanation and how they checked it was understood. Weak answer: no specific example, or an explanation pitched only at specialists.",
  },
  {
    text: "Tell me about a time you had to decide what to do first under a tight deadline.",
    source: "general_experience",
    competency: "Handling pressure",
    scoring_guide:
      "Strong answer: gives the situation, how the candidate prioritised, what they left out or delayed and why, and the outcome. Weak answer: says they work well under pressure without an example, or describes no choices.",
  },
];

/* ── safety: what the candidate and the provider must never see ── */

const PLACEHOLDERS = [CANDIDATE_TAG, EMAIL_TAG, PHONE_TAG, LINK_TAG, ADDRESS_TAG];

/**
 * Protected or personal topics. Unambiguous words are refused anywhere; words
 * that are also ordinary job words ("health", "family", "children") only when
 * the question makes them about the candidate ("your family"), so a question
 * about a healthcare product or a children's education platform stands.
 * "race" and "background" are left out on purpose: "race condition" and "your
 * background in data engineering" are ordinary interview language.
 */
const PROTECTED_ALWAYS =
  /\b(?:how old|date of birth|birth ?day|born in|religio\w*|faith|pray\w*|church|mosque|temple|married|marital|spouse|husband|wife|pregnan\w*|disabilit\w*|nationality|citizenship|ethnic\w*|racial|caste|sexual\w*|gender|sex|maternity|paternity)\b/i;
const PROTECTED_PERSONAL =
  /\b(?:your|you have|do you have|are you)\s+(?:\w+\s+){0,2}(?:age|family|children|kids|health|medical|illness|country of origin|origin|home town|hometown)\b/i;

export type SafetyIssue = "contact" | "placeholder" | "name" | "protected_topic";
const SAFETY_ISSUES: ReadonlySet<string> = new Set<SafetyIssue>([
  "contact",
  "placeholder",
  "name",
  "protected_topic",
]);

/** What is unsafe about a question's text, if anything. */
export function questionSafetyIssues(text: string, name: CandidateName): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const { counts } = sanitizeCvForInterview(text);
  if (counts.emails + counts.phones + counts.links + counts.addresses > 0) issues.push("contact");
  if (PLACEHOLDERS.some((p) => text.includes(p))) issues.push("placeholder");
  if (mentionsCandidateName(text, name)) issues.push("name");
  if (PROTECTED_ALWAYS.test(text) || PROTECTED_PERSONAL.test(text)) issues.push("protected_topic");
  return issues;
}

/* ── quality: one clear ask, no hints ─────────────────────────── */

export type QualityIssue = "two_question_marks" | "second_ask" | "hint_list" | "overlap";

/** A sentence that asks for something: a question, or an instruction to tell, describe, walk through. */
const ASK_START =
  /^(?:how|what|why|when|where|which|who|did|do|does|can|could|would|will|have|has|is|are|tell|walk|describe|explain|talk|share|give|take)\b/i;
/** A second ask joined to the first: "... and how you tested it", "..., and why?" */
const JOINED_ASK = /,?\s+(?:and|or|then)\s+(?:how|what|why|when|where|which|who|whether)\b/i;
/** Telling the candidate what to cover. */
const HINT_WORDS = /\b(?:such as|including|for example|for instance|in particular)\b|\be\.\s?g\./i;
/** Three or more items in a row: "ordering, duplicates and consumer failures". */
const ITEM = String.raw`[\w.+#/-]+(?:\s[\w.+#/-]+){0,2}`;
const LIST_OF_THREE = new RegExp(
  String.raw`\b${ITEM}(?:,\s*${ITEM}){1,},?\s+(?:and|or)\s+${ITEM}`,
  "i",
);

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};
/** Words every interview question shares; they say nothing about what is asked. */
const FILLER: ReadonlySet<string> = new Set(
  "a an the and or of to in on at for with from by as is are was were be been it its this that these those you your yours me my i we our us tell about walk through describe explain talk share give take how what why when where which who did do does have has had can could would will time times something some any one work worked".split(
    " ",
  ),
);
/**
 * Above this share of content words in common (shared over all distinct), two
 * questions ask about the same thing. "brought first-response time from nine
 * hours to two" against "from 9 hours to 2" scores 1.0; two questions about
 * different work at the same employer score well under it.
 */
const OVERLAP_THRESHOLD = 0.6;

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((w) => NUMBER_WORDS[w] ?? w)
      .filter((w) => w && !FILLER.has(w)),
  );
}

/** Whether two questions cover the same ground: most of their content words are shared. */
export function questionsOverlap(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared) >= OVERLAP_THRESHOLD;
}

/**
 * What is unclear about a question's text, if anything. With `others` (the
 * job questions and the CV questions before it), also whether it repeats one.
 */
export function questionQualityIssues(
  text: string,
  others: readonly string[] = [],
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if ((text.match(/\?/g) ?? []).length > 1) issues.push("two_question_marks");
  const sentences = text.split(/(?<=[.?!])\s+/).filter((s) => s.trim());
  const asks = sentences.filter((s) => s.trim().endsWith("?") || ASK_START.test(s.trim()));
  if (asks.length > 1 || JOINED_ASK.test(text)) issues.push("second_ask");
  if (HINT_WORDS.test(text) || LIST_OF_THREE.test(text)) issues.push("hint_list");
  if (others.some((o) => questionsOverlap(text, o))) issues.push("overlap");
  return issues;
}

/* ── the prompt ───────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You write the CV-based questions for a live, spoken AI video interview, and a private scoring guide for each.

An AI interviewer reads each question aloud, listens, and may ask up to two short follow-ups of its own. The interview also has job questions written by the employer; you are shown them only so that your questions do not cover the same ground. Never repeat, rephrase or rewrite them.

Return JSON only, no prose, no code fences:

{"questions":[{"slot":1,"source":"cv","question":"...","competency":"...","strong":"...","weak":"..."}]}

═══ SLOTS ═══

Write exactly one question per slot, in slot order, slots numbered from 1.
  - source "cv" when the CV states a specific role, project or achievement you can ask about that no other slot uses;
  - otherwise source "general_experience". When told the CV is too thin, every slot is "general_experience".

═══ ONE CLEAR ASK ═══

Every question asks ONE thing, in ONE sentence, ${QUESTION_WORDS_MIN} to ${QUESTION_WORDS_MAX} words, spoken naturally, under ${QUESTION_TEXT_MAX} characters.
  - At most one question mark. Never a second question or a second instruction after the first.
  - Never join a second ask with "and how", "and what", "and why", "or what".
  - Never list points, steps, aspects or technologies the answer should cover, and never write "such as", "including", "e.g." or "for example". Naming the one project you are asking about is fine; naming what a good answer contains is not.
  - Neutral wording: no praise, no assumption that the work went well or badly.

NOT THIS — two asks and a hint list:
  "You built the event pipeline at Northwind. How did you design it to handle ordering, duplicates and failures, and what would you change?"
THIS:
  "Walk me through how you designed the event pipeline at Northwind."

CV questions ask about ONE specific role, project or achievement the CV states, named plainly enough that the candidate knows which one. Each slot uses a different item.
GENERAL EXPERIENCE questions ask about past work relevant to this role in general terms, not tied to any detail of the CV, with similar difficulty to a CV question.

NEVER ask about or mention: age, date of birth, religion, marital status, spouse, family, children, pregnancy, health, disability, nationality, citizenship, ethnicity, race, caste, gender, sexual orientation, appearance, where someone is from, gaps in employment, or why they left a job. Never use the candidate's name. The CV contains placeholders such as ${CANDIDATE_TAG}, ${EMAIL_TAG}, ${PHONE_TAG}, ${LINK_TAG} and ${ADDRESS_TAG}: never repeat or refer to them.

"competency" must be EXACTLY one of:
${COMPETENCIES.join(", ")}

═══ THE SCORING GUIDE ═══

"strong": one or two sentences on what a strong answer contains. "weak": one sentence on what a weak answer looks like. This is where the detail you were tempted to put in the question belongs.

A guide may only describe a standard the job description states, applied to what the question asks. For a CV question, judge the depth and ownership of the experience it names against the job's requirements. NEVER introduce a number, tool, qualification or requirement the job description does not contain. NEVER mark down accent, fluency, grammar, filler words or hesitation.`;

function section(label: string, value: string | null | undefined, cap = MAX_SECTION_CHARS) {
  const v = (value ?? "").trim().slice(0, cap);
  return v ? `${label}:\n${v}` : "";
}

function userMessage(input: WriteInput, cvThin: boolean): string {
  const { job, jobQuestions, cvSlots } = input;
  const jobBlock = [
    `Job title: ${(job.title ?? "").trim()}`,
    section("About the role", job.description),
    section("What they'll do", job.responsibilities),
    section("What we're looking for", job.requirements),
  ]
    .filter(Boolean)
    .join("\n\n");
  const asked = jobQuestions.length
    ? `The employer's job questions (do not overlap with them):\n${jobQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
    : "";
  const cvBlock = cvThin
    ? "The CV is too thin to ask about: every slot must be general_experience."
    : section("CV (contact details and the candidate's name removed)", input.cvText, MAX_CV_CHARS);
  return [`Slots: ${cvSlots}.`, jobBlock, asked, cvBlock].filter(Boolean).join("\n\n");
}

/* ── reading the reply ────────────────────────────────────────── */

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function snapCompetency(value: unknown): string | null {
  const wanted = clean(value).toLowerCase();
  return (COMPETENCIES as readonly string[]).find((c) => c.toLowerCase() === wanted) ?? null;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The reply's questions for `slots`, or the reason they cannot be used. Only
 * "cv" and "general_experience" are accepted, and only "general_experience"
 * when the CV is thin.
 */
function readReply(
  raw: string,
  slots: readonly number[],
  cvThin: boolean,
): { ok: true; questions: WrittenQuestion[] } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return { ok: false, why: "not JSON" };
  }
  const list = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) return { ok: false, why: "no questions array" };
  if (list.length !== slots.length) {
    return { ok: false, why: `${list.length} questions, wanted ${slots.length}` };
  }
  const allowed = cvThin ? ["general_experience"] : ["cv", "general_experience"];
  const out: WrittenQuestion[] = [];
  for (const [i, slot] of slots.entries()) {
    const e = (list[i] ?? {}) as Record<string, unknown>;
    if (e.slot !== slot) return { ok: false, why: `slot ${slot} out of order` };
    if (typeof e.source !== "string" || !allowed.includes(e.source)) {
      return { ok: false, why: `slot ${slot} has the wrong source` };
    }
    const text = clean(e.question);
    const n = words(text);
    if (n < QUESTION_WORDS_MIN || n > QUESTION_WORDS_MAX || text.length > QUESTION_TEXT_MAX) {
      return { ok: false, why: `slot ${slot} question length` };
    }
    const competency = snapCompetency(e.competency);
    if (!competency) return { ok: false, why: `slot ${slot} competency` };
    const strong = clean(e.strong);
    const weak = clean(e.weak);
    if (
      strong.length < GUIDE_STRONG_MIN ||
      weak.length < GUIDE_WEAK_MIN ||
      strong.length > GUIDE_PART_MAX ||
      weak.length > GUIDE_PART_MAX
    ) {
      return { ok: false, why: `slot ${slot} scoring guide length` };
    }
    out.push({
      slot,
      text,
      source: e.source as WrittenQuestion["source"],
      competency,
      scoring_guide: `Strong answer: ${strong} Weak answer: ${weak}`.slice(0, RUBRIC_MAX),
    });
  }
  if (new Set(out.map((q) => q.text.toLowerCase())).size !== out.length) {
    return { ok: false, why: "a question is repeated" };
  }
  return { ok: true, questions: out };
}

/* ── the calls ────────────────────────────────────────────────── */

type Usage = { calls: number; input_tokens: number; output_tokens: number };

async function call(client: LiveQuestionsClient, usage: Usage, content: string): Promise<string> {
  const started = Date.now();
  usage.calls += 1;
  try {
    const response = await client.messages.create(
      {
        model: AI_MATCHING_MODEL,
        max_tokens: MAX_TOKENS,
        ...thinkingOffParams(AI_MATCHING_MODEL),
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;
    logProviderCall({
      jobType: "live_questions",
      provider: "anthropic",
      model: AI_MATCHING_MODEL,
      durationMs: Date.now() - started,
      remainingAtStartMs: null,
      outcome: "ok",
    });
    return response.content.some((b) => b.type === "text")
      ? extractText(response, AI_MATCHING_MODEL)
      : "";
  } catch (err) {
    const aborted = /abort|timeout/i.test(err instanceof Error ? err.message : String(err));
    logProviderCall({
      jobType: "live_questions",
      provider: "anthropic",
      model: AI_MATCHING_MODEL,
      durationMs: Date.now() - started,
      remainingAtStartMs: null,
      outcome: aborted ? "aborted" : "error",
    });
    throw new LiveQuestionsError("model_error", aborted ? "timed out" : "the model call failed");
  }
}

/** Everything a question must pass: safety first, then quality, against the questions around it. */
function checkIssues(text: string, name: CandidateName, others: readonly string[]): CheckIssue[] {
  return [...questionSafetyIssues(text, name), ...questionQualityIssues(text, others)];
}

const ISSUE_WORDS: Readonly<Record<CheckIssue, string>> = {
  contact: "it contained a contact detail",
  placeholder: "it repeated a placeholder",
  name: "it used the candidate's name",
  protected_topic: "it touched a personal or protected topic",
  two_question_marks: "it asked two questions",
  second_ask: "it asked a second thing",
  hint_list: "it listed what the answer should cover",
  overlap: "it covered the same ground as another question",
};

export type WriteInput = {
  job: JobText;
  /** The job questions' text, in order: shown to the model to avoid overlap, never written. */
  jobQuestions: readonly string[];
  /** Already sanitised, name removed (live-question-freeze.ts does both). */
  cvText: string;
  cvSlots: number;
  /** Used only to check no question names the candidate. */
  name: CandidateName;
};

/** Write the CV-slot questions for one candidate. */
export async function writeLiveQuestions(
  input: WriteInput,
  deps: { client: LiveQuestionsClient },
): Promise<LiveQuestionsResult> {
  const { job, name, cvSlots } = input;
  if (!(job.description ?? job.requirements ?? job.responsibilities ?? "").trim()) {
    throw new LiveQuestionsError("no_job_text", "the job has no description or requirements");
  }
  const cvThin = !cvSupportsQuestions(input.cvText);
  const slots = Array.from({ length: cvSlots }, (_, i) => i + 1);
  const usage: Usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const ask = userMessage(input, cvThin);

  // 1. One call, and one more if the reply cannot be used.
  let first = readReply(await call(deps.client, usage, ask), slots, cvThin);
  if (!first.ok) {
    const why = first.why;
    first = readReply(
      await call(
        deps.client,
        usage,
        `${ask}\n\nYour previous reply could not be used (${why}). Reply again with exactly ${cvSlots} questions in the JSON format, following every rule.`,
      ),
      slots,
      cvThin,
    );
    if (!first.ok) throw new LiveQuestionsError("bad_output", first.why);
  }
  const questions = first.questions;

  // 2. Safety and quality on what is spoken, each question against the job
  //    questions and the CV questions before it; failing ones rewritten once.
  const othersFor = (i: number, list: readonly WrittenQuestion[]) => [
    ...input.jobQuestions,
    ...list.slice(0, i).map((q) => q.text),
  ];
  const flagged = questions
    .map((q, i) => ({ slot: q.slot, issues: checkIssues(q.text, name, othersFor(i, questions)) }))
    .filter((f) => f.issues.length > 0);
  let replaced = 0;
  if (flagged.length > 0) {
    // Self-contained: each question to replace, why, and what to keep. The
    // replacements are numbered 1..n and matched back by order, because a
    // model asked for "slot 3 only" renumbers from 1 and rewrites the wrong one.
    const keep = questions.filter((q) => !flagged.some((f) => f.slot === q.slot));
    const lines = flagged.map((f, i) => {
      const q = questions[f.slot - 1];
      // An unsafe question is never repeated back, even to the model.
      const was = f.issues.some((x) => SAFETY_ISSUES.has(x)) ? "" : ` (was: "${q.text}")`;
      return `${i + 1}. a ${q.source === "cv" ? "cv" : "general_experience"} question${was}: ${f.issues.map((x) => ISSUE_WORDS[x]).join("; ")}.`;
    });
    let rewritten: WrittenQuestion[] = [];
    try {
      const reply = readReply(
        await call(
          deps.client,
          usage,
          `${ask}\n\nReplace these ${flagged.length} question(s). Return exactly ${flagged.length} question(s), numbered 1 to ${flagged.length} in this order, each one clear ask in one sentence with no list or example of what to cover:\n${lines.join("\n")}${keep.length ? `\n\nKeep these, and do not repeat them:\n${keep.map((q) => `- ${q.text}`).join("\n")}` : ""}`,
        ),
        flagged.map((_, i) => i + 1),
        cvThin,
      );
      if (reply.ok) {
        rewritten = reply.questions.map((q, i) => ({ ...q, slot: flagged[i].slot }));
      }
    } catch {
      // The rewrite call failing is the same as the rewrite failing: the bank fills in.
    }
    const bank = [...GENERAL_EXPERIENCE_BANK];
    for (const { slot } of flagged) {
      const others = [
        ...input.jobQuestions,
        ...questions.filter((q) => q.slot !== slot).map((q) => q.text),
      ];
      const fresh = rewritten.find((r) => r.slot === slot);
      let replacement: WrittenQuestion;
      if (fresh && checkIssues(fresh.text, name, others).length === 0) {
        replacement = fresh;
      } else {
        const at = bank.findIndex((b) => checkIssues(b.text, name, others).length === 0);
        if (at < 0) throw new LiveQuestionsError("bad_output", "the general bank ran out");
        const [fallback] = bank.splice(at, 1);
        replacement = { ...fallback, slot };
        replaced += 1;
      }
      questions[slot - 1] = replacement;
    }
  }

  return {
    questions,
    model: AI_MATCHING_MODEL,
    ...usage,
    flagged,
    rewritten: flagged.length,
    replaced,
  };
}
