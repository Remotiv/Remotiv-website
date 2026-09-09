import "server-only";
import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";
import {
  needsModelSplit,
  parseJobDescription,
  REQUIREMENTS_HEADING,
  RESPONSIBILITIES_HEADING,
} from "@/lib/jd/parse";

/**
 * Write a first-draft job description from what the wizard already knows.
 *
 * ── The second door ──────────────────────────────────────────
 *
 * lib/ai/jd-split.ts is for a recruiter who ARRIVES with a JD. This is for one
 * who does not: they have filled in a title and a location and now face an
 * empty box. One button, no questions, and what comes back is a draft in that
 * box which they edit like anything else they typed.
 *
 * ── What it must not invent ──────────────────────────────────
 *
 * The rule is NOT "invent nothing". A job description for a Registered Nurse
 * that never mentions licensure is a wrong job description, and a generator
 * forbidden from saying so would produce one. Roles are sometimes DEFINED by a
 * credential, and stating that is reporting what the job is, not making
 * something up.
 *
 * The line that actually holds:
 *
 *   FACTS ABOUT THE ROLE TYPE — allowed. A nurse holds a nursing licence, an
 *     accountant works with ledgers, a front-end engineer writes CSS. This
 *     follows from the title and any competent writer would include it.
 *   FACTS ABOUT THIS EMPLOYER — never. Team size, tech stack, tools, funding,
 *     benefits, process, clients, and every number nobody supplied.
 *
 * ── And what it must not RESTATE ─────────────────────────────
 *
 * Location, work type, contract type, seniority and headcount are structured
 * fields the job page renders on their own. Writing them into the prose as well
 * gives a job two copies of the same fact, which drift the first time someone
 * edits one of them. So they are given to the model as context it must respect
 * and must not describe.
 *
 * Salary is not passed at all: at generation time it does not exist — it is
 * collected on step 3, after this button.
 *
 * ── The residual risk, stated rather than claimed away ───────
 *
 * A prompt cannot stop a plausible invention: "partner with the design team" at
 * a company with no designers reads as ordinary and is wrong. What makes that
 * survivable is the same thing that makes the split path survivable — the draft
 * lands in an editable box, in front of the person who knows, before anything
 * is published.
 *
 * ── Never throws. Returns null. ──────────────────────────────
 *
 * Same contract as proposeSplit and extractTalentFieldsFromCv.
 */

/** Moves when the brief changes. Mirrors interview-scoring's convention. */
export const JD_GENERATE_PROMPT_VERSION = "jd-generate-v1";

/**
 * Target length, derived from what Remotiv actually publishes.
 *
 * ── Where the number comes from ──────────────────────────────
 *
 * Measured across the 20 live JDs: 180 to 337 words, median 272. This range
 * sits around that median with room either side, so a draft reads like the
 * posts beside it rather than like a different product.
 *
 * It replaced 500–600, which came from general job-board guidance rather than
 * from anything on this site. That figure was roughly double the house style,
 * and the only way the generator reached it was by writing 20-to-30-word
 * responsibilities where the corpus averages 13 — padding, dressed as detail.
 * Measured drafts at 500–600: 260–342 words, so it was not being hit anyway.
 *
 * If this moves again, move it because the corpus moved.
 */
const TARGET_WORDS_LOW = 250;
const TARGET_WORDS_HIGH = 350;

/** Enough for TARGET_WORDS_HIGH of prose plus headings, with room to run over. */
const MAX_TOKENS = 1_600;

/**
 * Longer than the split's ceiling, and deliberately.
 *
 * The split returns a handful of numbers; this writes several hundred words, so
 * the same 8 seconds would cut off drafts that were going to arrive. The
 * recruiter is watching a button that says "Writing a draft…", which is a wait
 * they asked for by pressing it — unlike the split, which happens behind a blur
 * they did not know triggered anything.
 */
const TIMEOUT_MS = 30_000;

/** What the wizard knows by the time the button is pressable. */
export type JdBrief = {
  title: string;
  location: string;
  category?: string | null;
  experienceLevel?: string | null;
  contractType?: string | null;
  workType?: string | null;
  positions?: number | null;
};

export type JdGenerateFailure =
  | "no_title"
  | "no_key"
  | "timeout"
  | "model_error"
  | "empty"
  | "unusable";

export type JdGenerateOutcome =
  | { text: string; failure: null }
  | { text: null; failure: JdGenerateFailure };

const SYSTEM_PROMPT = `You write the first draft of a job description. A recruiter
will edit it, so it should read like something a person wrote, not like a form.

STRUCTURE — exactly these three sections, exactly these headings, in this order:

About the role
<two or three sentences of prose: why the role exists, what the person will own,
what doing it well looks like. No bullet points here.>

${RESPONSIBILITIES_HEADING}
<five to eight lines, one responsibility per line, no bullet characters>

${REQUIREMENTS_HEADING}
<five to seven lines, one essential per line, no bullet characters>

LENGTH — ${TARGET_WORDS_LOW} to ${TARGET_WORDS_HIGH} words in total, and reach it
by writing FULLY rather than by adding sections:

  About the role     two or three sentences, 60 to 80 words
  each responsibility one clause of 12 to 18 words, saying what the work
                     actually involves rather than naming it
  each requirement    one clause of 12 to 18 words, saying what the person needs
                     to be able to do rather than listing a skill

"Own the component library" is a label. "Own the component library and decide
when a pattern is ready to share" is a responsibility. Write the second kind —
but stop there. A third clause is padding.

Shorter is right where the role genuinely does not need the length — a weekend
kitchen porter does not need ${TARGET_WORDS_HIGH} words — but do not pad and do
not repeat.

Write plain text. No markdown, no asterisks, no dashes at the start of lines, no
numbering. One item per line is the entire formatting.

═══ WHAT YOU MAY AND MAY NOT STATE ═══

You may state facts that follow from the JOB TITLE. A role is often defined by
what it requires, and leaving that out produces a wrong description: a
Registered Nurse post states a nursing licence, a solicitor post states
qualification, an accountant works with ledgers and reconciliation. Write what
the role is.

You may NOT state facts about THIS EMPLOYER. You have not been told any, and
inventing them is how a draft becomes a lie a candidate acts on. Never write:
  - team size, company size, funding, growth, revenue, customers or clients
  - the tech stack, tools, or systems they use, unless the TITLE names one
  - benefits, perks, equity, holiday, hours, or process
  - the company's name, mission, values, culture, or history
  - any number nobody gave you: not "5+ years", not "a team of six"

For seniority, write the LEVEL of experience in words rather than a count of
years, because you have not been told how many: "substantial experience leading
delivery", not "8+ years". If the brief gives an experience level, let it set
the register and do not name it.

Where a requirement depends on jurisdiction, name the requirement and not the
jurisdiction: "a current nursing licence", never "an active RN licence in
California". You do not know where this employer is regulated.

That includes NAMING THE REGULATOR. Do not write "registration with the Pakistan
Nursing Council", "NMC registration", "an ACCA qualification" or any other
council, board, register or professional body — naming one is naming a
jurisdiction by another route, and you inferred it from a city rather than being
told it. "Current registration with the relevant nursing body" says everything
you actually know.

═══ WHAT IS ALREADY ON THE PAGE ═══

The fields in the brief below are displayed as structured information beside
your text. Use them to pitch the writing — a Part time Entry role reads
differently from a Full time Expert one — but DO NOT WRITE THEM INTO THE PROSE.
The page already says the role is Remote, or Full time, or in Lahore. Saying it
again gives the job two copies of one fact, and they drift the first time
someone changes their mind.

Do not open with "join our team in <place>", and do not write "this is a
<work type> role" or "in our <work type> team". Name no city, no country and no
work arrangement anywhere in the text. The one exception is where the WORD is
ordinary English for the work itself — a nurse gives care on site — which is
about the job, not a restatement of the field.

Do not mention salary. It has not been decided yet.

Return the job description and nothing else. No preamble, no sign-off, no
explanation of what you wrote.`;

/** The description heading the parser treats as opening the description. */
const ABOUT_HEADING = "About the role";

function briefLines(brief: JdBrief): string {
  const rows: string[] = [`Job title: ${brief.title}`];
  if (brief.location?.trim()) rows.push(`Location: ${brief.location.trim()}`);
  if (brief.category) rows.push(`Field: ${brief.category}`);
  if (brief.experienceLevel) rows.push(`Experience level: ${brief.experienceLevel}`);
  if (brief.contractType) rows.push(`Employment type: ${brief.contractType}`);
  if (brief.workType) rows.push(`Work type: ${brief.workType}`);
  if (typeof brief.positions === "number" && brief.positions > 1) {
    rows.push(`Openings: ${brief.positions}`);
  }
  return rows.join("\n");
}

/**
 * Tidy what came back into the shape the parser reads.
 *
 * The model is told to write plain lines, and mostly does; this strips the
 * markdown it sometimes reaches for anyway rather than letting a stray "- " or
 * "**" reach the box. Bullet glyphs in particular matter: the parser strips
 * them from list items but keeps them in the description, so a bulleted line
 * that landed in the wrong section would look wrong on the job page.
 */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s*/, "")
        .replace(/^\s*(?:\d+[.)]|[-*•·▪])\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/^\*+|\*+$/g, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function generateJobDescription(brief: JdBrief): Promise<JdGenerateOutcome> {
  if (!brief.title?.trim()) return { text: null, failure: "no_title" };
  if (!process.env.ANTHROPIC_API_KEY) return { text: null, failure: "no_key" };

  let raw: string;
  try {
    const response = await getAnthropic().messages.create(
      {
        model: AI_MATCHING_MODEL,
        max_tokens: MAX_TOKENS,
        /*
         * TEMPERATURE IS DELIBERATELY UNPINNED, and this is the only model call
         * in the codebase where that is true.
         *
         * cv-scoring, interview-scoring and jd-split all pin 0, because they
         * judge or partition and the same input must produce the same answer
         * twice. This one WRITES. Two roles posted by the same company on the
         * same afternoon should not open with the same sentence, and a
         * recruiter who presses the button again after deleting a draft should
         * get something different rather than the same paragraph back.
         *
         * Left at the API default rather than raised: this is a first draft
         * someone edits, not creative writing, and the failure mode of a high
         * temperature here is invention — the one thing the prompt above spends
         * its length trying to prevent.
         */
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Write the job description for this role.\n\n${briefLines(brief)}`,
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
    console.error(`[jd-generate] ${timedOut ? "timed out" : "model error"}: ${message}`);
    return { text: null, failure: timedOut ? "timeout" : "model_error" };
  }

  const text = tidy(raw);
  if (!text) {
    console.error("[jd-generate] empty response");
    return { text: null, failure: "empty" };
  }

  /*
   * THE DRAFT MUST NOT NEED SPLITTING.
   *
   * The whole point of writing the two headings the parser already knows is
   * that the result arrives pre-split: the box parses as "split", the wizard's
   * blur handler does not fire, and splitIfNeeded no-ops on save. One model
   * call, not two.
   *
   * If the draft came back without usable headings that property is gone, and
   * rather than hand back prose that will silently trigger a second call, this
   * reports it as unusable and the recruiter writes their own. A generator that
   * quietly costs two calls is worse than one that admits it failed.
   */
  const parsed = parseJobDescription(text);
  if (needsModelSplit(parsed)) {
    console.error(`[jd-generate] draft has no usable headings (outcome ${parsed.outcome})`);
    return { text: null, failure: "unusable" };
  }

  return { text, failure: null };
}

/** Exported for the test that asserts the brief's own words stay out of the prose. */
export const JD_GENERATE_HEADINGS = [
  ABOUT_HEADING,
  RESPONSIBILITIES_HEADING,
  REQUIREMENTS_HEADING,
] as const;
