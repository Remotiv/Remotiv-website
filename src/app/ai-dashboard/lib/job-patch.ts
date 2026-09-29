import type { ScreeningQuestion } from "@/lib/jobs";
import { resolveNumericMode } from "@/lib/screening";
import {
  INTERVIEW_CRITERIA_MAX,
  JOB_CATEGORIES,
  JOB_EXPERIENCE_LEVELS,
  MUST_HAVE_MAX,
  MUST_HAVE_MAX_LENGTH,
} from "./job-types";

/**
 * The pure half of saving a job: the normalisers buildPatch runs a wizard
 * payload through, and the comparison that decides whether a save changed
 * what the CV scorer reads.
 *
 * ── Why these left jobs/actions.ts ───────────────────────────
 *
 * They were private to a "use server" module, which meant the one comparison
 * that costs recruiters money - a criteria_version bump marks every scorecard
 * on the job stale - could not be tested. It turned out to be wrong: it
 * compared the STORED row against the NORMALISED patch with JSON.stringify,
 * and jsonb hands back object keys in its own canonical order while
 * sanitizeQuestions rebuilds them in source order. Every save of a job with a
 * screening question read as a criteria change. Two live jobs reached
 * criteria_version 17 and 15 that way, and 28 of 42 scorecards wore the
 * "Scored against older criteria" banner for saves that changed nothing.
 *
 * scoringInputsChanged now normalises BOTH sides through the same functions
 * and compares structurally. job-patch.test.ts pins the cases.
 */

export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Server-side cleanup of the screening-questions array — mirrors the admin
 * sanitizeQuestions exactly so both surfaces write the identical jsonb shape
 * that /api/apply re-reads and scores against. Empty result ([]) is valid.
 *
 * An unset/invalid `ideal` now stores "" rather than coercing to "0".
 *
 * That coercion was the bug: /api/apply matches numeric answers with
 * `answer >= ideal`, the answer field can't go below 0, so `>= 0` passed
 * EVERY candidate. A manager applicant answering 0 years leading teams,
 * 0 team size and 0 years Agile met all three "thresholds".
 *
 * "" is the honest "not set yet", and it is fail-CLOSED for yesno and
 * multiple (`answer === ""` never matches a real answer). It is NOT
 * fail-closed for numeric — `Number("")` is 0, not NaN, which reproduces the
 * same tautology — so assertPublishableQuestions below keeps "" off any job
 * that is actually open. Drafts keep it, so a half-built question survives a
 * save instead of being silently dropped.
 */
export function sanitizeQuestions(input: unknown): ScreeningQuestion[] {
  if (!Array.isArray(input)) return [];

  const cleaned: ScreeningQuestion[] = [];
  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Partial<ScreeningQuestion>;

    const question = (typeof q.question === "string" ? q.question : "").trim().slice(0, 200);
    if (!question) continue;

    const type = q.type;
    if (type !== "yesno" && type !== "numeric" && type !== "multiple") continue;

    const id = typeof q.id === "string" && q.id ? q.id : crypto.randomUUID();
    const essential = q.essential === true;

    if (type === "yesno") {
      // Defaults to "Yes" — the one type where a default is honest rather than
      // a hidden decision. Screening questions are near-universally phrased so
      // that Yes is the good answer ("Do you have a work permit?"), and there
      // are only two options, both visible in the select. Numeric and multiple
      // choice keep their no-default rule: those have no natural right answer,
      // and inventing one is what shipped the 0-threshold bug.
      const ideal = q.ideal === "No" ? "No" : "Yes";
      cleaned.push({ id, question, type, ideal, options: [], essential });
    } else if (type === "numeric") {
      // "collect this number, don't filter on it" IS the mode now — a company
      // asking current salary or times-terminated wants a ceiling or nothing,
      // and forcing a floor on those made them write a meaningless threshold.
      const mode = resolveNumericMode(q);

      if (mode === "none") {
        // No threshold to store, so `ideal` is cleared rather than left to
        // carry a stale number that nothing reads but the drawer might show.
        cleaned.push({
          id,
          question,
          type,
          ideal: "",
          options: [],
          essential,
          numeric_mode: "none",
        });
      } else {
        // `> 0` for BOTH directions. A minimum of 0 passes everyone (the answer
        // field can't go below 0); a maximum of 0 demands exactly 0, which is a
        // threshold nobody means to set from a number input defaulting to empty.
        const n = Number.parseFloat(String(q.ideal ?? ""));
        const ideal = Number.isFinite(n) && n > 0 ? String(n) : "";
        cleaned.push({
          id,
          question,
          type,
          ideal,
          options: [],
          essential,
          numeric_mode: mode,
        });
      }
    } else {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter((o) => o.length > 0);
      if (options.length < 2) continue; // multiple requires >= 2 options
      // No fallback to index 0 either: "the first option" was never a choice
      // the company made, just what an unset field happened to mean.
      const idx = Number.parseInt(String(q.ideal ?? ""), 10);
      const ideal = Number.isInteger(idx) && idx >= 0 && idx < options.length ? String(idx) : "";
      cleaned.push({ id, question, type, ideal, options, essential });
    }
  }
  return cleaned;
}

/**
 * Publish gate for screening questions.
 *
 * A question whose `ideal` is "" scores nothing meaningful, so it must not
 * reach a public job. Returns an error string naming the offender, or null.
 *
 * Only enforced for status 'open'. Drafts are allowed to be half-built —
 * that is what a draft is — and 'closed' jobs take no new applications.
 */
export function assertPublishableQuestions(questions: ScreeningQuestion[]): string | null {
  // A numeric_mode 'none' question has an empty `ideal` BY DESIGN — there is no
  // threshold to set — so it is the one legitimate empty and must not be caught
  // by the unset check below.
  const unset = questions.find(
    (q) => q.ideal === "" && !(q.type === "numeric" && resolveNumericMode(q) === "none"),
  );
  if (!unset) return null;

  if (unset.type === "numeric") {
    const bound = resolveNumericMode(unset) === "max" ? "maximum" : "minimum";
    return `Screening question "${unset.question}" needs a ${bound} above 0, or set it to collect the number without a threshold, before this job can be published.`;
  }
  // yesno can no longer reach here — sanitizeQuestions defaults it to "Yes",
  // including legacy rows stored with "". Kept in the map so the record stays
  // exhaustive over the type union rather than silently losing a case if the
  // default is ever removed.
  const NEEDS: Record<"multiple" | "yesno", string> = {
    multiple: "needs its ideal option chosen",
    yesno: "needs an ideal answer chosen",
  };
  return `Screening question "${unset.question}" ${NEEDS[unset.type]} before this job can be published.`;
}

/**
 * Clean the must-have list on its way to the column.
 *
 * Trimmed, empties dropped, de-duplicated case-insensitively, each capped at
 * MUST_HAVE_MAX_LENGTH and the list capped at `max`. Shared by both step-7
 * lists so the two cannot drift apart. Enforced HERE and
 * not only in the wizard: the client cap is a courtesy, and this is the one a
 * direct server-action call cannot skip. Over-long input is TRUNCATED rather
 * than rejected — it is a label, and failing an otherwise valid publish over
 * one long line helps nobody.
 *
 * Returns [] for anything unrecognisable, which is the column default and the
 * behaviour every job had before step 7 existed.
 */
export function namedList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const item = raw.replace(/\s+/g, " ").trim().slice(0, MUST_HAVE_MAX_LENGTH);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Columns the SCORER reads. Editing any of them changes what a scorecard was
 * judged against, so criteria_version bumps and every existing score for the
 * job becomes stale.
 *
 * Taken from the job SELECT in handleAiCvScore, not from intuition — if that
 * select ever grows a column, this list has to grow with it or staleness goes
 * undetected again.
 *
 * `title` is included even though it reads like mere labelling: buildUserMessage
 * puts it at the top of the job block, and re-titling "Junior Analyst" to "Head
 * of Analytics" genuinely changes the seniority the model judges against.
 *
 * Deliberately EXCLUDED — the scorer never reads them, so they cannot make a
 * scorecard stale: location, work_type, contract_type, positions, salary_*,
 * show_salary, status, and the five interview/scoring option columns.
 *
 * ── The four cv_weight_* columns are ALSO excluded, deliberately ──
 *
 * They ARE read by the scorer, so this is the one exception to the rule above
 * and it needs justifying. criteria_version marks a scorecard stale because the
 * MODEL WAS ASKED A DIFFERENT QUESTION — new requirements, a new seniority, new
 * screening questions — so its judgement no longer applies and only a re-run
 * can fix it. Re-weighting asks the model nothing new. The dimension scores,
 * the evidence, the quotes and the reasoning are all still exactly right; only
 * the arithmetic that combines them into one number has changed.
 *
 * Marking every score stale would therefore invite a full re-score — real money
 * and real latency — to recompute something derivable from data already stored.
 * Worse, it would read as "your scorecards are wrong" when they are not.
 *
 * The honest consequence, and it is a real one: after a weight change, stored
 * overalls were computed under the OLD weighting until each application is
 * re-scored. If that divergence starts to matter, the fix is to recompute the
 * overall from the stored dimension_scores — no model call needed — not to
 * bump criteria_version. See applyCvWeights, which is already a pure function
 * over (overall, dimensions, weights) precisely so it can be reused that way.
 */
export const SCORING_RELEVANT_COLUMNS = [
  "title",
  "description",
  "responsibilities",
  "requirements",
  "experience_level",
  "category",
  "screening_questions",
  // Step 7. The scorer reports on each of these by name, so editing the list
  // genuinely changes what a scorecard was judged against — same contract as
  // editing the requirements text.
  "scoring_must_haves",
  // Same argument as scoring_must_haves: the interview scorer reports on each
  // of these by name, so editing the list changes what a scorecard was judged
  // against.
  "interview_criteria",
] as const;

/**
 * What buildPatch writes when the wizard sends an enum the list does not
 * contain. Shared with the normaliser below so a stored value outside the list
 * and its coerced replacement compare equal - that coercion is a repair, not a
 * criteria change.
 */
export const SCORING_ENUM_FALLBACKS = {
  category: "Engineering",
  experience_level: "Intermediate",
} as const;

function textOrNull(value: unknown): string | null {
  return (typeof value === "string" ? value : "").trim() || null;
}

/**
 * The nine scoring inputs as buildPatch would WRITE them, whatever shape they
 * arrived in - a stored row straight from PostgREST or a wizard payload. Both
 * sides of scoringInputsChanged go through this, so the comparison is between
 * two things the same code produced.
 */
export function normaliseScoringInputs(
  row: Record<string, unknown>,
): Record<(typeof SCORING_RELEVANT_COLUMNS)[number], unknown> {
  return {
    title: textOrNull(row.title),
    description: textOrNull(row.description),
    responsibilities: textOrNull(row.responsibilities),
    requirements: textOrNull(row.requirements),
    experience_level: oneOf(
      typeof row.experience_level === "string" ? row.experience_level : "",
      JOB_EXPERIENCE_LEVELS,
      SCORING_ENUM_FALLBACKS.experience_level,
    ),
    category: oneOf(
      typeof row.category === "string" ? row.category : "",
      JOB_CATEGORIES,
      SCORING_ENUM_FALLBACKS.category,
    ),
    screening_questions: sanitizeQuestions(row.screening_questions),
    scoring_must_haves: namedList(row.scoring_must_haves, MUST_HAVE_MAX),
    interview_criteria: namedList(row.interview_criteria, INTERVIEW_CRITERIA_MAX),
  };
}

/**
 * Structural form for comparison: object keys sorted, so jsonb's canonical
 * key order and source order read the same; `id` dropped, because a question's
 * id is a handle, not a criterion; null and undefined folded together.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => key !== "id")
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value ?? null;
}

/**
 * Did this save change what the scorer reads?
 *
 * Both sides are normalised through the functions buildPatch uses and then
 * compared structurally. What no longer counts as a change: jsonb key order,
 * trimming, "" versus null, whitespace or duplicates in a must-have list, an
 * enum outside its list being coerced to the fallback, a legacy numeric
 * question (`ideal "0"`, no mode) being written as `""` / `"none"` - it never
 * filtered anyone either way - and a question gaining an id. What still
 * counts: different text in any of the four prose columns or a question, a
 * different level or category, a question added, removed, retyped or given a
 * different threshold or direction, a must-have or criterion added, removed or
 * reworded.
 */
export function scoringInputsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const a = normaliseScoringInputs(before);
  const b = normaliseScoringInputs(after);
  return SCORING_RELEVANT_COLUMNS.some(
    (col) => JSON.stringify(canonical(a[col])) !== JSON.stringify(canonical(b[col])),
  );
}
