import "server-only";
import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";
import {
  COMPETENCY_MAX,
  INTERVIEW_LENGTHS,
  type InterviewLengthId,
  QUESTION_TEXT_MAX,
  RUBRIC_MAX,
} from "@/lib/interviews/types";

/**
 * Propose video-interview questions from the job the recruiter just wrote.
 *
 * ── Where this sits ──────────────────────────────────────────
 *
 * By step 5 the job already has a description, responsibilities and
 * requirements — split into three sections on step 2, whether the recruiter
 * pasted them, wrote them or generated them. So the questions can be about THIS
 * role rather than about the job title, and that is the whole reason to offer
 * it here rather than shipping a list of generic prompts.
 *
 * ── The rubric is the dangerous field ────────────────────────
 *
 * A generated QUESTION is safe to hand over: it is one line on a page, a
 * recruiter reads it, and a bad one is obvious. A generated RUBRIC is not. It
 * is the marking scheme the interview scorer applies to every candidate, nobody
 * re-reads it after the day it was written, and a plausible-but-invented
 * standard rejects people silently. "A wrong question is visible on the page. A
 * wrong rubric is invisible until someone is rejected by it."
 *
 * So the rubric is held to a tighter rule than the rest: it may only describe a
 * standard THIS JOB DESCRIPTION ALREADY STATES. Not what the role type usually
 * needs — that licence is granted to lib/ai/jd-generate.ts, where the output is
 * prose a person reads before publishing — but what these requirements say.
 * Deriving a mark scheme from a stated requirement is reporting. Adding a
 * threshold nobody wrote down is inventing a hurdle, and the candidate never
 * finds out they were measured against it.
 *
 * ── Never throws. Returns null. ──────────────────────────────
 *
 * Same contract as proposeSplit and generateJobDescription. A failure leaves
 * step 5 exactly as it was.
 */

/** Moves when the brief changes. Mirrors interview-scoring's convention. */
export const INTERVIEW_QUESTIONS_PROMPT_VERSION = "interview-questions-v1";

/**
 * Question length, in words.
 *
 * Measured before it was set. The generator's first version produced questions
 * of 24-48 words, median 33, and 38 of 40 were two sentences whose second
 * sentence enumerated three things to cover — commas doing the work of question
 * marks, so a "one question per slot" rule was satisfied on paper and broken in
 * substance.
 *
 * The shortest outputs were already the best ("Tell me about a time you
 * presented research findings to a client. What was their reaction, and how did
 * you handle it?" — 24 words), which is why the fix is a budget rather than a
 * different instruction.
 */
const QUESTION_WORDS_LOW = 15;
const QUESTION_WORDS_HIGH = 25;

/** Six questions with a rubric each. Generous. */
const MAX_TOKENS = 2_000;

/** The recruiter pressed a button and is watching it, as with the JD draft. */
const TIMEOUT_MS = 30_000;

/** Trim the JD we send. A whole section is context; a novel is noise. */
const MAX_SECTION_CHARS = 4_000;

/**
 * The competencies the builder already offers.
 *
 * Passed to the model so a generated question lands on a value the select
 * recognises rather than inventing a fifteenth label — the builder treats an
 * unrecognised competency as "Other" and reveals a free-text box, which is a
 * fine escape hatch for a person and a poor default for a generator.
 */
const COMPETENCIES = [
  "Communication",
  "Problem solving",
  "Technical depth",
  "Domain knowledge",
  "Leadership",
  "Ownership",
  "Collaboration",
  "Customer focus",
  "Adaptability",
  "Handling pressure",
  "Attention to detail",
  "Commercial awareness",
  "Values alignment",
  "Motivation for the role",
] as const;

export type GeneratedQuestion = {
  question: string;
  competency: string;
  rubric: string;
};

export type InterviewQuestionsFailure =
  | "no_job_text"
  | "no_key"
  | "timeout"
  | "model_error"
  | "not_json"
  | "bad_shape";

export type InterviewQuestionsOutcome =
  | { questions: GeneratedQuestion[]; failure: null }
  | { questions: null; failure: InterviewQuestionsFailure };

const SYSTEM_PROMPT = `You write questions for a one-way video interview, from a
job description the employer has already written.

The candidate records each answer alone, on camera, in their own time. There is
no interviewer, no follow-up and no second take worth counting on. Write
questions that can be answered well in one pass by someone with no chance to ask
what you meant.

Return JSON only, no prose, no code fences:

{"questions":[{"question":"...","competency":"...","rubric":"..."}]}

═══ THE QUESTIONS ═══

Ask about what THIS job description says. A question that would fit any job in
the industry is a wasted slot — the employer wrote requirements, and the point
of asking here is to hear about those.

Prefer "tell me about a time you..." over "how would you...". A hypothetical
invites a rehearsed answer; a past example can be checked against a CV.

LENGTH — ${QUESTION_WORDS_LOW} to ${QUESTION_WORDS_HIGH} words. ONE ask.

This is the rule that matters most here, and it is the one easiest to satisfy
in appearance while breaking in substance. A question is ONE ask if a candidate
could answer it fully without having to remember a list. Asking three things
with commas instead of question marks is still asking three things.

NOT THIS — 48 words, four asks wearing one question mark:

  "Describe your experience with MIG on A100 or H100 GPUs. Tell me about a time
   you configured MIG profiles for a production workload — what profiles did you
   create, how did you expose utilisation metrics, and why did that profile
   split make sense for that workload?"

THIS — same subject, one ask:

  "Tell me about a time you configured MIG profiles for a production workload."

The detail you wanted to enumerate belongs in the RUBRIC. "Names the profiles,
explains how utilisation was exposed, says why that split suited the workload"
is a mark scheme, and the scorer reads it. The candidate does not have to hold
it in their head while a camera runs.

Remember what a one-way recording is. The candidate hears the question once,
alone, with no interviewer to ask "sorry, what was the third part?". Faced with
a list they answer the last clause they remember, or spend their single take
reciting the question back. A thinner answer to a clear question is worth more
than a confident answer to the wrong third of a long one.

Never ask anything that reveals what a good answer contains.

"competency" must be EXACTLY one of:
${COMPETENCIES.join(", ")}

═══ THE RUBRIC — THE STRICT PART ═══

The rubric tells a scorer what a good answer looks like. It is applied to every
candidate, nobody re-reads it after today, and a candidate rejected by it never
learns why. So it is held to a harder rule than the questions:

A RUBRIC MAY ONLY DESCRIBE A STANDARD THIS JOB DESCRIPTION ALREADY STATES.

  - If the requirements say "experience owning a design system", a rubric may
    ask for a concrete example of owning one, and may say what a weak answer
    looks like.
  - If the requirements say nothing about team size, the rubric MUST NOT ask
    for "experience leading a team of five".
  - If the requirements name no tools, the rubric MUST NOT name tools.
  - NEVER introduce a number the job description does not contain: not years,
    not team sizes, not counts of projects, not percentages.
  - NEVER introduce a qualification, certification or degree the job
    description does not ask for.

You are describing how to recognise the requirements the employer wrote. You are
not adding requirements of your own. If a question is about something the job
description covers only loosely, write a loose rubric — that is the honest
answer, and a vague standard is better than a precise invented one.

Write the rubric as two or three sentences of plain text. No headings, no
bullets, no scoring scale — the scorer supplies the scale.

Keep each question under ${QUESTION_TEXT_MAX} characters and each rubric under
${RUBRIC_MAX}.`;

function section(label: string, value: string | null | undefined): string {
  const v = (value ?? "").trim().slice(0, MAX_SECTION_CHARS);
  return v ? `${label}:\n${v}` : "";
}

function clean(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:\d+[.)]|[-*•·▪])\s*/, "")
    .trim()
    .slice(0, cap);
}

/**
 * Snap a competency onto the builder's own list, case-insensitively.
 *
 * Returns "" rather than guessing when it does not match — the builder shows an
 * empty select, which reads as "pick one" and is honest. Coercing a near-miss
 * onto the wrong competency would silently mis-file what the answer is scored
 * against.
 */
function snapCompetency(value: unknown): string {
  const wanted = clean(value, COMPETENCY_MAX).toLowerCase();
  if (!wanted) return "";
  return (COMPETENCIES as readonly string[]).find((c) => c.toLowerCase() === wanted) ?? "";
}

export async function generateInterviewQuestions(input: {
  title: string;
  description?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
  length: InterviewLengthId;
}): Promise<InterviewQuestionsOutcome> {
  const preset =
    INTERVIEW_LENGTHS.find((l) => l.id === input.length) ??
    INTERVIEW_LENGTHS.find((l) => l.id === "standard");
  if (!preset) return { questions: null, failure: "bad_shape" };

  const job = [
    `Job title: ${(input.title ?? "").trim()}`,
    section("About the role", input.description),
    section("What they'll do", input.responsibilities),
    section("What we're looking for", input.requirements),
  ]
    .filter(Boolean)
    .join("\n\n");

  /*
   * Without a description there is nothing to be specific ABOUT, and a
   * generator that falls back to generic questions is worse than the empty
   * state — it fills six slots with prompts nobody chose.
   */
  if (!(input.description ?? input.requirements ?? "").trim()) {
    return { questions: null, failure: "no_job_text" };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { questions: null, failure: "no_key" };

  let raw: string;
  try {
    const response = await getAnthropic().messages.create(
      {
        model: AI_MATCHING_MODEL,
        max_tokens: MAX_TOKENS,
        /*
         * Unpinned, like the JD generator and unlike everything that judges.
         * Two roles at the same company should not get the same six questions.
         * Left at the API default rather than raised — the failure mode of a
         * high temperature here is an invented rubric, which is the one thing
         * the prompt above spends its length preventing.
         */
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Write exactly ${preset.questions} questions for this role.\n\n${job}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const block = response.content[0];
    raw = block && block.type === "text" ? block.text : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /abort|timeout/i.test(message);
    console.error(`[interview-questions] ${timedOut ? "timed out" : "model error"}: ${message}`);
    return { questions: null, failure: timedOut ? "timeout" : "model_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    console.error(`[interview-questions] non-JSON response: ${raw.slice(0, 160)}`);
    return { questions: null, failure: "not_json" };
  }

  const list = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || list.length === 0) {
    console.error("[interview-questions] response carried no questions");
    return { questions: null, failure: "bad_shape" };
  }

  /*
   * Trimmed to the preset, never padded to it. A short answer is the model
   * declining to pad, and inventing the difference to hit a count would be the
   * generator making up questions to fill slots.
   */
  const questions: GeneratedQuestion[] = [];
  for (const entry of list.slice(0, preset.questions)) {
    const e = entry as { question?: unknown; competency?: unknown; rubric?: unknown };
    const question = clean(e?.question, QUESTION_TEXT_MAX);
    if (!question) continue;
    questions.push({
      question,
      competency: snapCompetency(e?.competency),
      rubric: clean(e?.rubric, RUBRIC_MAX),
    });
  }

  if (questions.length === 0) {
    console.error("[interview-questions] every entry was unusable");
    return { questions: null, failure: "bad_shape" };
  }

  return { questions, failure: null };
}
