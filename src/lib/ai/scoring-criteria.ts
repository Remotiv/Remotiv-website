import "server-only";
import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";

/**
 * Propose scoring criteria — CV must-haves and interview criteria — from the
 * job description.
 *
 * ── Why a model, when a heuristic already exists ─────────────
 *
 * `suggestCriteria` in ai-dashboard/lib/job-types.ts mines these from the
 * requirements and responsibilities text, and on a tidily written job it does
 * the work with no call at all. It stays the instant path.
 *
 * What it cannot do is SHORTEN. It selects whole lines, and a criterion must
 * fit in 90 characters — so a requirement stated at length is not shortened,
 * it is dropped. Measured across the 20 live JDs, 143 of 242 lines (59%) are
 * over that cap, and 9 of the 20 jobs end up with fewer than the three CV
 * must-haves the step pre-fills. `senior-platform-engineer` yields exactly one,
 * because five of its six requirements are 93 to 147 characters long.
 *
 * One criterion out of six is worse than none: the step looks filled in.
 *
 * A model can restate "MIG profile management experience on A100/H100 GPUs with
 * per-profile utilisation metrics exposure via DCGM and OTel" as something that
 * fits. That is the whole reason this exists.
 *
 * ── The routing is the dangerous part ────────────────────────
 *
 * Each criterion is checked against ONE document and comes back evidenced or
 * not-found. Put a behavioural trait on the CV list and it returns not-found
 * for every candidate — no CV says "comfortable picking up the phone" — which
 * is noise on every scorecard and, in the words of the column's own comment,
 * "makes the feature look broken". Put a concrete fact on the interview list
 * and it is scored on whether they happened to say it out loud.
 *
 * The heuristic misroutes today: "Willing to travel occasionally" goes to the
 * interview list on the word "willing", and no transcript evidences a travel
 * preference. A model can do better mainly because it can DECLINE — some lines
 * belong on neither list, and a rule that must place every surviving line has
 * no way to say so.
 *
 * ── What was measured, so it is not measured again ───────────
 *
 * Eight runs over the 20-job corpus, ~160 real calls. Per run, over 20 jobs:
 * 0-2 trait words on the CV list, 0-1 CV facts on the interview list, 0 over
 * 90 chars, 0 numbers absent from the job description, 0 hard failures.
 * Latency median ~2s against a 30s timeout. The two lines the heuristic
 * misroutes ("Willing to travel occasionally", "Maintain accurate pipeline
 * records in the CRM") are dropped every run.
 *
 * THE UNDER-FILL IS REAL AND PROMPTING DID NOT FIX IT. On the 9 corpus jobs
 * where the heuristic yields fewer than three CV must-haves, this reaches three
 * on 4-5 of them and returns two on most of the rest, even where the job
 * description plainly supports a third. Two revisions were written and
 * measured, and CV-lists-at-three (of 20) came out:
 *
 *   this wording                                    14, 14, 14, 13
 *   + "these line types are always CV must-haves"    9, 14
 *   + "fill the cv list first", work sequenced      12, 12
 *
 * Neither beat this one; the run-to-run spread is larger than either effect.
 * If you are about to add a paragraph about counting, it has been tried twice.
 *
 * What justifies shipping it anyway is the delta, not the absolute: across two
 * full runs it returned FEWER CV criteria than the heuristic on zero of 18
 * panel-job generations, and more on 13. `suggestScoringCriteria` enforces that
 * as a floor rather than trusting it.
 *
 * ── A hole in the harness, for whoever measures next ─────────
 *
 * The routing check keys on the opening verb: an interview criterion that does
 * not begin "Explains…/Describes…/Demonstrates…" and carries a CV signal is
 * flagged as a leaked fact. A CV fact WRAPPED as "Describes their experience
 * with X" passes that test and is a leaked fact all the same. One was found by
 * hand, not by the harness — `it-business-partner` returned zero CV must-haves
 * while its interview list carried "Describes leading a digital transformation
 * initiative independently", which is its CV line wearing a verb.
 *
 * So a clean routing number is weaker evidence than it looks, and the run that
 * matters is the one where someone reads the interview list. Do not treat a
 * zero here as proof.
 *
 * ── Never throws. Returns null. ──────────────────────────────
 *
 * Same contract as the other generators. A failure leaves step 6 exactly as it
 * was, with whatever the heuristic already offered.
 */

/** Moves when the brief changes. Mirrors interview-scoring's convention. */
export const SCORING_CRITERIA_PROMPT_VERSION = "scoring-criteria-v1";

/** Matches MUST_HAVE_MAX / INTERVIEW_CRITERIA_MAX and MUST_HAVE_MAX_LENGTH. */
const MAX_PER_LIST = 3;
const MAX_CRITERION_CHARS = 90;

const MAX_TOKENS = 900;
const TIMEOUT_MS = 30_000;
const MAX_SECTION_CHARS = 4_000;

export type ScoringCriteriaFailure =
  | "no_job_text"
  | "no_key"
  | "timeout"
  | "model_error"
  | "not_json"
  | "bad_shape";

export type ScoringCriteriaOutcome =
  | { cv: string[]; interview: string[]; failure: null }
  | { cv: null; interview: null; failure: ScoringCriteriaFailure };

const SYSTEM_PROMPT = `You pick SCORING CRITERIA for a job, from the job
description the employer wrote.

Each criterion is checked against ONE document and comes back "evidenced" or
"not found". A criterion only works if that document could actually show it.

TWO LISTS. A criterion belongs to exactly one, or to neither:

  cv         checked against the candidate's CV. A CV states history: tools
             used, systems built, sectors worked in, things shipped, scale,
             qualifications held.
  interview  checked against the TRANSCRIPT of their recorded interview. A
             transcript shows how someone talks and what they say they did:
             manner, approach, judgement, how they explain a decision.

═══ THE ROUTING IS THE PART THAT MATTERS ═══

A behavioural trait on the CV list returns "not found" for EVERY candidate. No
CV says "comfortable picking up the phone without being told". That is noise on
every scorecard and it makes the feature look broken.

A concrete fact on the interview list is nearly as bad: it gets scored on
whether the candidate happened to mention it out loud in a five-minute
recording, not on whether they have it.

Ask of each one: COULD A CV STATE THIS? If yes, cv. If only hearing them talk
could show it, interview.

  cv         "Built and shipped Kubernetes operators in Go"
  cv         "Terraform authorship at production standard"
  interview  "Explains a technical decision clearly to a non-specialist"
  interview  "Describes how they handled a difficult client"

SOME THINGS BELONG ON NEITHER LIST. Leave them out — do not force them:

  - A preference or willingness. "Willing to travel", "happy to work
    weekends", "open to occasional travel". These are facts about what someone
    will agree to, and NEITHER a CV nor a transcript evidences them. They
    belong on an application form, and the job already has one.
  - A DUTY the person will perform. "Maintain accurate CRM records" is the job
    itself, not something to check they already have.
  - Anything the job description does not state.

Returning two good criteria beats returning three with one that cannot be
evidenced. But do not under-fill either: if the job description supports three,
give three. A fact moved to the interview list is not merely misplaced — it is
gone from the CV check, and the CV is the only document every applicant has.

Never restate a cv fact as "Describes their experience with…". That is the same
fact on the wrong list, wearing a verb.

═══ WRITING A CRITERION ═══

1. ONE checkable thing, under ${MAX_CRITERION_CHARS} characters.

   The employer may have written it at length. Shorten it to the thing being
   checked, in their terms — this is the main reason you are being asked.
   "MIG profile management experience on A100/H100 GPUs with per-profile
   utilisation metrics exposure via DCGM and OTel" becomes "MIG profile
   management on A100/H100 GPUs".

2. NEVER ADD A NUMBER THE JOB DESCRIPTION DOES NOT GIVE. "5+ years of B2B
   sales" only if it says 5. If it says "proven experience", write "proven
   experience" — a number you chose becomes a bar nobody set.

3. Take them from what the job description states. You are naming what to check
   for, not adding requirements of your own.

4. At most ${MAX_PER_LIST} on each list.

Return JSON only, no prose, no code fences:
{"cv":["..."],"interview":["..."]}`;

function section(label: string, value: string | null | undefined): string {
  const v = (value ?? "").trim().slice(0, MAX_SECTION_CHARS);
  return v ? `${label}:\n${v}` : "";
}

/**
 * Clean one criterion, or drop it.
 *
 * Over-length is DROPPED rather than truncated. A criterion cut mid-phrase is
 * checked against the CV as a fragment and evidences nothing — the same
 * not-found-for-everyone failure the routing rules exist to prevent, arrived at
 * by tidiness instead of by misrouting.
 */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:\d+[.)]|[-*•·▪])\s*/, "")
    .trim();
  if (text.length < 3 || text.length > MAX_CRITERION_CHARS) return null;
  return text;
}

function list(raw: unknown, taken: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const text = clean(entry);
    if (!text) continue;
    const key = text.toLowerCase();
    // Never the same criterion twice, and never on both lists — the scorers
    // would report it in two places as if the employer had asked twice.
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(text);
    if (out.length >= MAX_PER_LIST) break;
  }
  return out;
}

export async function generateScoringCriteria(input: {
  title: string;
  description?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
}): Promise<ScoringCriteriaOutcome> {
  if (!(input.description ?? input.requirements ?? "").trim()) {
    return { cv: null, interview: null, failure: "no_job_text" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { cv: null, interview: null, failure: "no_key" };
  }

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
        // Unpinned, like the other generators.
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Pick scoring criteria for this role.\n\n${job}` }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const block = response.content[0];
    raw = block && block.type === "text" ? block.text : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /abort|timeout/i.test(message);
    console.error(`[scoring-criteria] ${timedOut ? "timed out" : "model error"}: ${message}`);
    return { cv: null, interview: null, failure: timedOut ? "timeout" : "model_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    console.error(`[scoring-criteria] non-JSON response: ${raw.slice(0, 160)}`);
    return { cv: null, interview: null, failure: "not_json" };
  }

  const taken = new Set<string>();
  const p = parsed as { cv?: unknown; interview?: unknown };
  const cv = list(p?.cv, taken);
  const interview = list(p?.interview, taken);

  if (cv.length === 0 && interview.length === 0) {
    console.error("[scoring-criteria] response carried no usable criteria");
    return { cv: null, interview: null, failure: "bad_shape" };
  }

  return { cv, interview, failure: null };
}
