import "server-only";
import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";
import { isUseful, type JdGroup, splittableLines, toGroups } from "@/lib/jd/partition";

/**
 * Ask the model where a pasted job description's sections begin and end.
 *
 * ── Why this exists at all ───────────────────────────────────
 *
 * lib/jd/parse.ts reads structure the recruiter supplied — headings, blank
 * lines — and that is enough for every job Remotiv has published. It is not
 * enough for a JD pasted out of a Word document, which frequently arrives as
 * one unbroken run of lines. There, telling "Build the cloud management plane"
 * from "Demonstrated Go operator development" needs to know what the sentences
 * MEAN. Nothing structural separates them: same bullet, overlapping lengths,
 * same capitalisation, adjacent.
 *
 * That is the parser's real limit, and the alternative to this is asking the
 * company to reformat their own job description — pushing our problem onto
 * them for a JD they are entitled to write however they like.
 *
 * ── Never throws. Returns null. ──────────────────────────────
 *
 * Same contract as extractTalentFieldsFromCv: missing key, network error,
 * timeout, non-JSON, wrong shape, unusable partition — all null, all logged.
 * A null falls back to asking the recruiter directly, which is what the screen
 * did before this existed. Publishing a job must never wait on a model and must
 * never fail because of one.
 */

/** Moves when the rubric changes. Mirrors interview-scoring's convention. */
export const JD_SPLIT_PROMPT_VERSION = "jd-split-v1";

/** Enough for ~60 ranges. The response is numbers, so it is tiny. */
const MAX_TOKENS = 700;

/** A JD is short. Anything past this is not a job description. */
const MAX_LINES = 200;

/**
 * Wall-clock ceiling.
 *
 * The recruiter is sitting in front of the box waiting, so this is tuned for a
 * person's patience rather than for the model's benefit. Past it we stop
 * waiting and ask them ourselves — a worse experience than a good split, and a
 * much better one than a spinner.
 */
const TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = `You divide a job description into its sections.

You are given the job description as NUMBERED LINES. You return the line ranges
of each section. You never return the text of any line.

Return JSON only, no prose, no code fences:

{"groups":[{"kind":"description","start":1,"end":1},{"kind":"responsibilities","start":2,"end":7}]}

RULES

1. "kind" is exactly one of: description, responsibilities, requirements.
   - description     — what the role and the company are. Context, not a list.
   - responsibilities — what the person will DO in the job. Duties, tasks.
   - requirements    — what the candidate must ALREADY HAVE. Experience,
                       skills, qualifications, years, tools they have used.

2. THE RANGES MUST COVER EVERY LINE EXACTLY ONCE, IN ORDER. The first group
   starts at line 1. Each group starts at the line after the previous group
   ends. The last group ends at the last line. No gaps, no overlaps.

3. Sections are CONTIGUOUS. A job description does not interleave its duties
   and its requirements, so neither do your ranges.

4. The distinction that matters is duties versus requirements, and it is about
   tense and ownership, not wording:
   - "Build the CI/CD pipeline"          → responsibilities (they will do it)
   - "Demonstrated Go operator development" → requirements (they have done it)
   - "5+ years in production Kubernetes" → requirements
   - "Own the compute plane"             → responsibilities

5. A section may be absent. Return only the groups that exist. Do NOT invent a
   requirements section for a job that states none.

6. If you genuinely cannot tell where one section ends and the next begins,
   return ONE group covering every line with the kind that fits best. A wrong
   boundary costs the recruiter a correction; a guessed one they do not notice
   costs a candidate the match.`;

export type JdSplitOutcome =
  | { groups: JdGroup[]; failure: null }
  | { groups: null; failure: JdSplitFailure };

/** Why no proposal came back. Recorded, so a silent path stays countable. */
export type JdSplitFailure =
  | "too_long"
  | "no_key"
  | "timeout"
  | "model_error"
  | "not_json"
  | "bad_partition"
  | "not_useful";

export async function proposeSplit(box: string): Promise<JdSplitOutcome> {
  const lines = splittableLines(box);
  if (lines.length === 0 || lines.length > MAX_LINES) {
    return { groups: null, failure: "too_long" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { groups: null, failure: "no_key" };
  }

  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");

  let raw: string;
  try {
    const response = await getAnthropic().messages.create(
      {
        model: AI_MATCHING_MODEL,
        max_tokens: MAX_TOKENS,
        /*
         * 0, for the same reason the CV scorer uses 0: sampling variety is a
         * feature when writing prose and a defect when partitioning a document
         * someone is about to publish. The same paste twice should not put the
         * boundary in two different places.
         */
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `JOB DESCRIPTION (${lines.length} lines):\n\n${numbered}`,
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
    console.error(`[jd-split] ${timedOut ? "timed out" : "model error"}: ${message}`);
    return { groups: null, failure: timedOut ? "timeout" : "model_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    console.error(`[jd-split] non-JSON response: ${raw.slice(0, 160)}`);
    return { groups: null, failure: "not_json" };
  }

  const groups = toGroups((parsed as { groups?: unknown })?.groups, lines);
  if (groups === null) {
    /*
     * Rejected whole. See lib/jd/partition.ts — a proposal that misses a line
     * or overlaps two groups is not nearly right, and there is no version of
     * repairing it that does not amount to guessing which half to trust.
     */
    console.error(`[jd-split] response is not a valid partition of ${lines.length} lines`);
    return { groups: null, failure: "bad_partition" };
  }
  if (!isUseful(groups)) {
    return { groups: null, failure: "not_useful" };
  }

  return { groups, failure: null };
}
