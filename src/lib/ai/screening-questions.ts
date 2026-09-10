import "server-only";
import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";
import type { ScreeningQuestion } from "@/lib/jobs";
import type { NumericMode } from "@/lib/screening";

/**
 * Propose screening questions from the job the recruiter just wrote.
 *
 * ── Not interview questions ──────────────────────────────────
 *
 * These are FIELDS ON THE APPLICATION FORM. The candidate types or picks an
 * answer while applying, and /api/apply scores every one of them
 * deterministically against the employer's stated ideal — no model reads them,
 * ever. So a question only earns its place if exact comparison can tell a good
 * answer from a bad one, which is a much narrower bar than the video round's.
 *
 * Measured target: under 15 words, factual, checkable. The generator lands at a
 * median of 10-11.
 *
 * ── The ideal answer is a FILTER, and that is the risk ───────
 *
 * lib/ai/interview-questions.ts worries about the rubric, because a rubric
 * marks someone low. This is worse: `ideal` decides automatically whether a
 * candidate counts as matching, nobody sees the decision, and a bar the
 * employer never set removes people for failing a test that was never theirs.
 *
 * Two rules exist because measurement found them, not because they sounded
 * prudent — see the notes on each in the prompt below.
 *
 * ── Never throws. Returns null. ──────────────────────────────
 *
 * Same contract as the other three generators. A failure leaves step 4 exactly
 * as it was.
 */

/** Moves when the brief changes. Mirrors interview-scoring's convention. */
export const SCREENING_QUESTIONS_PROMPT_VERSION = "screening-questions-v1";

/**
 * How many to ask for, and how many may be marked essential.
 *
 * `sanitizeQuestions` caps the column at 10; six is what a form can carry
 * without becoming the application itself.
 *
 * MAX_ESSENTIAL exists because the first version marked 24 of 26 essential. The
 * rule was "essential only for what the job description calls required" — and a
 * requirements section calls everything required, so nearly every question got
 * the flag. `essential` doubles the weight in screening_score and lists a miss
 * in missing_requirements; applied to everything it makes the score near-binary
 * and says nothing about what actually matters most.
 */
const QUESTION_COUNT = 5;
const MAX_ESSENTIAL = 3;

/** Short, factual, checkable. Measured median is 10-11. */
const MAX_QUESTION_WORDS = 15;

const MAX_TOKENS = 1_500;
const TIMEOUT_MS = 30_000;
const MAX_SECTION_CHARS = 4_000;

export type ScreeningQuestionsFailure =
  | "no_job_text"
  | "no_key"
  | "timeout"
  | "model_error"
  | "not_json"
  | "bad_shape";

export type ScreeningQuestionsOutcome =
  | { questions: ScreeningQuestion[]; failure: null }
  | { questions: null; failure: ScreeningQuestionsFailure };

const SYSTEM_PROMPT = `You write SCREENING questions for a job application form.

These are FORM FIELDS, not interview questions. The candidate types or picks an
answer while applying, and every answer is scored automatically — the same way
for everyone, by exact comparison, with no human and no model reading it. A
question only earns its place if a machine can tell a good answer from a bad
one.

Return JSON only, no prose, no code fences:

{"questions":[{"question":"...","type":"yesno","ideal":"Yes","options":[],"essential":true,"numeric_mode":null}]}

TYPES — exactly one of:
  yesno     ideal is "Yes" or "No". options [].
  numeric   ideal is a number as a string. options []. numeric_mode is "min"
            (at least), "max" (at most), or "none" (collect, do not test).
  multiple  options is 2 to 5 short choices. ideal is the INDEX of the good
            answer as a string ("0", "1", ...).

Prefer yesno. It is the only type whose ideal answer has an obvious right
default, and a clear yes/no question is worth more than a richer one whose
scoring can go quietly wrong.

═══ WHAT MAKES A SCREENING QUESTION ═══

1. Under ${MAX_QUESTION_WORDS} words. Factual. CHECKABLE.

   A work permit, a notice period, a tool they have used, a willingness to
   travel. Anything that needs a paragraph belongs in the video interview.

2. NEVER ASK SOMEONE TO RATE THEMSELVES.

   No "rate your confidence from 1 to 10", no "how would you score your
   proficiency", no scales of any kind. An earlier version of this prompt
   produced "Rate your confidence running discovery calls and product demos"
   as a numeric with a pass mark of 7 — a scale nobody defined, a threshold
   nobody set, and a dimension the employer never mentioned, filtering real
   candidates on a number they cannot verify and you invented. A self-rating is
   never a checkable fact.

3. ASK ONLY WHAT THE JOB DESCRIPTION STATES. If it names no qualification, do
   not ask about one. If it names no tools, do not ask about tools. You are
   turning stated requirements into checkable fields, not adding requirements.

═══ THE IDEAL ANSWER IS A FILTER ═══

It decides, automatically and invisibly, whether a candidate counts as matching.
Nobody reviews that decision. So:

NEVER SET A BAR THE JOB DESCRIPTION DOES NOT STATE.
  - no number of years unless the job description gives that number
  - no threshold you chose yourself, for anything

WHEN THERE IS NO STATED THRESHOLD, USE numeric WITH numeric_mode "none" AND
ideal "". That collects the answer and tests nothing.

This is the most important behaviour in this prompt and it must survive any
future edit of it. A job description saying "proven B2B sales experience" states
no number, so "How many years of B2B sales experience do you have?" is a
collect-only question. Turning it into "min 3" invents a hurdle, applies it to
everyone, and tells nobody. Collecting the number still puts it in front of the
recruiter — they can judge it themselves, which is the whole difference between
informing a decision and making one.

═══ ESSENTIAL ═══

At most ${MAX_ESSENTIAL} questions may have essential true, and fewer is fine.

"essential" doubles a question's weight and reports a miss on the scorecard. A
requirements section calls everything required, so "mark what the JD requires"
marks everything — which makes the score near-binary and says nothing about what
matters MOST. Choose the ${MAX_ESSENTIAL} without which an application is not
worth reading. Everything else is essential false.

Write exactly ${QUESTION_COUNT} questions.`;

function section(label: string, value: string | null | undefined): string {
  const v = (value ?? "").trim().slice(0, MAX_SECTION_CHARS);
  return v ? `${label}:\n${v}` : "";
}

function text(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, cap);
}

/**
 * Coerce one entry into a storable question, or drop it.
 *
 * Mirrors `sanitizeQuestions` in the jobs actions deliberately — the server
 * re-sanitises everything on save, so anything this lets through is checked
 * again. Doing it here as well means the recruiter never SEES a question the
 * server would silently reshape.
 *
 * The numeric branch is where the safety lives: a threshold that is not a real
 * positive number becomes a collect-only question rather than a filter, which
 * is the same direction the sanitiser takes and the same direction a wrong
 * guess should always fall.
 */
function coerce(raw: unknown): ScreeningQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;

  const question = text(q.question, 200);
  if (!question) return null;

  const id = crypto.randomUUID();
  const essential = q.essential === true;
  const type = q.type;

  if (type === "yesno") {
    return {
      id,
      question,
      type,
      ideal: q.ideal === "No" ? "No" : "Yes",
      options: [],
      essential,
    };
  }

  if (type === "numeric") {
    const mode: NumericMode =
      q.numeric_mode === "min" || q.numeric_mode === "max" ? q.numeric_mode : "none";
    const n = Number.parseFloat(String(q.ideal ?? ""));
    const usable = mode !== "none" && Number.isFinite(n) && n > 0;
    return {
      id,
      question,
      type,
      ideal: usable ? String(n) : "",
      options: [],
      essential: usable ? essential : false,
      numeric_mode: usable ? mode : "none",
    };
  }

  if (type === "multiple") {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => text(o, 80))
      .filter(Boolean)
      .slice(0, 5);
    if (options.length < 2) return null;
    const idx = Number.parseInt(String(q.ideal ?? ""), 10);
    // No fallback to 0. An index nobody chose is a silent filter on the first
    // option, which is exactly the failure the sanitiser refuses too.
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return null;
    return { id, question, type, ideal: String(idx), options, essential };
  }

  return null;
}

export async function generateScreeningQuestions(input: {
  title: string;
  description?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
}): Promise<ScreeningQuestionsOutcome> {
  if (!(input.description ?? input.requirements ?? "").trim()) {
    return { questions: null, failure: "no_job_text" };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { questions: null, failure: "no_key" };

  const job = [
    `Job title: ${(input.title ?? "").trim()}`,
    section("About the role", input.description),
    section("What they'll do", input.responsibilities),
    section("What we're looking for", input.requirements),
  ]
    .filter(Boolean)
    .join("\n\n");

  let raw: string;
  try {
    const response = await getAnthropic().messages.create(
      {
        model: AI_MATCHING_MODEL,
        max_tokens: MAX_TOKENS,
        // Unpinned, like the other generators. Two roles at one company should
        // not get the same five questions.
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Write screening questions for this role.\n\n${job}` }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const block = response.content[0];
    raw = block && block.type === "text" ? block.text : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /abort|timeout/i.test(message);
    console.error(`[screening-questions] ${timedOut ? "timed out" : "model error"}: ${message}`);
    return { questions: null, failure: timedOut ? "timeout" : "model_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    console.error(`[screening-questions] non-JSON response: ${raw.slice(0, 160)}`);
    return { questions: null, failure: "not_json" };
  }

  const list = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || list.length === 0) {
    console.error("[screening-questions] response carried no questions");
    return { questions: null, failure: "bad_shape" };
  }

  const questions: ScreeningQuestion[] = [];
  for (const entry of list.slice(0, QUESTION_COUNT)) {
    const q = coerce(entry);
    if (q) questions.push(q);
  }
  if (questions.length === 0) {
    console.error("[screening-questions] every entry was unusable");
    return { questions: null, failure: "bad_shape" };
  }

  /*
   * The essential cap, enforced rather than requested.
   *
   * The prompt asks for at most MAX_ESSENTIAL and the first version ignored a
   * softer version of that instruction 24 times out of 26. Keeping the first
   * few in the order the model returned them preserves its own ranking, which
   * is better information than dropping the flag entirely.
   */
  let kept = 0;
  for (const q of questions) {
    if (!q.essential) continue;
    kept += 1;
    if (kept > MAX_ESSENTIAL) q.essential = false;
  }

  return { questions, failure: null };
}
