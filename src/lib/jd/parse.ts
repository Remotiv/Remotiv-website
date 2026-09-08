/**
 * Splitting a single job-description box back into three columns.
 *
 * ── What this is for ─────────────────────────────────────────
 *
 * The AI dashboard wizard is becoming ONE box. `jobs` still has three columns,
 * the CV scorer still reads three labelled sections, and the editorial page
 * still renders three blocks — so something has to put the text back. This is
 * that something, and it is deliberately deterministic: no model call, no
 * network, no queue. A parse that cannot be reproduced offline cannot be
 * regression-tested, and this one is tested against all 20 live JDs.
 *
 * The Remotiv ADMIN panel's job form is not affected. It keeps its three boxes
 * and writes the three columns directly; nothing here runs for it.
 *
 * ── Why a plain module ───────────────────────────────────────
 *
 * No imports, so the wizard can call it in the browser to preview the split as
 * the recruiter types, and the server action can call the same code before
 * writing. Same constraint that shaped lib/cv-path.ts and lib/job-ownership.ts:
 * one rule, one implementation, both sides.
 *
 * ── What it will not do ──────────────────────────────────────
 *
 * It never guesses. A box with no recognised headings comes back whole, as the
 * description, with `outcome: "no_headings"` — the columns are left empty
 * rather than filled by splitting on a hunch. Silently misfiling criteria is
 * the exact defect this project exists to fix (five live jobs had must-haves
 * typed into `description`, invisible to the scorer for months); a parser that
 * guesses would reintroduce it at scale and with more confidence.
 */

import type { JdGroup } from "./partition";

/** The three columns, in the order they appear in a job description. */
export type JdSection = "description" | "responsibilities" | "requirements";

/** The headings this module writes, and the ones it recognises when reading. */
export const RESPONSIBILITIES_HEADING = "What you'll do";
export const REQUIREMENTS_HEADING = "What we're looking for";
const DESCRIPTION_HEADING = "About this role";

/**
 * Does this box need the model?
 *
 * The parser is the fast path: a JD that already carries its own headings is
 * split for free, offline, and no model call happens. Everything else — a
 * paste with blank lines but no headings, a paste with neither — needs meaning
 * rather than structure, and that is what the model is for.
 *
 * `outcome !== "split"` is the whole test. It is the same question as "did the
 * parser manage it", asked once.
 */
export function needsModelSplit(result: JdParseResult): boolean {
  return result.outcome !== "split";
}

/**
 * Write a proposed split back into the box, as headings.
 *
 * ── The whole of what the model's answer does ────────────────
 *
 * No cards, no confirmation, no gate. The split appears in the box the
 * recruiter is already looking at, as two ordinary lines of text they can edit,
 * move or delete like anything else they typed. If it put a boundary in the
 * wrong place they fix it the way they would fix a typo.
 *
 * That is also what makes this safe without a confirmation step: the proposal
 * is not applied to a hidden column, it is applied to the text on screen. The
 * three columns are then derived from that text by parseJobDescription, so
 * whatever they leave in the box is what gets stored.
 *
 * Rebuilt from the groups rather than by splicing headings into the original,
 * because the groups are a verified partition of the box's own lines — every
 * line, exactly once, in order (see lib/jd/partition.ts). Rebuilding cannot
 * drop or duplicate anything that splicing might.
 *
 * A description group gets "About this role" ONLY when it is not the first
 * group. Leading text with no heading already parses as the description, so a
 * heading there is noise — but a description group in the middle would
 * otherwise inherit the section above it.
 */
export function applyGroups(box: string, groups: JdGroup[]): string {
  if (groups.length === 0) return box;

  const sections = groups.map((group, i) => {
    const heading =
      group.kind === "responsibilities"
        ? RESPONSIBILITIES_HEADING
        : group.kind === "requirements"
          ? REQUIREMENTS_HEADING
          : i === 0
            ? null
            : DESCRIPTION_HEADING;
    return [heading, ...group.lines].filter(Boolean).join("\n");
  });

  return sections.join("\n\n");
}

/**
 * The three columns, merged back into one box.
 *
 * The exact inverse of parseJobDescription, and it lives here BECAUSE it is the
 * inverse: the two share the heading strings above, so a heading can never be
 * changed on one side alone. It was briefly a private helper in the wizard,
 * where nothing stopped it drifting from the parser it has to agree with.
 *
 * The property that matters is the round trip. Opening an existing job for
 * editing merges its columns into the box; saving without a keystroke must
 * write back the columns it started with, or every edit silently reshapes text
 * the recruiter did not touch. Tested both ways against all 20 live JDs.
 */
export function mergeJobText(job: {
  description?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
}): string {
  const parts = [(job.description ?? "").trim()];
  const responsibilities = (job.responsibilities ?? "").trim();
  const requirements = (job.requirements ?? "").trim();
  if (responsibilities) parts.push(`${RESPONSIBILITIES_HEADING}\n${responsibilities}`);
  if (requirements) parts.push(`${REQUIREMENTS_HEADING}\n${requirements}`);
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Why the parser did or did not claim a split. This is the telemetry payload
 * as much as the return value — see `JdParseResult.outcome`.
 */
export type JdParseOutcome =
  /** Headings found, lists within bounds. The three columns are usable. */
  | "split"
  /** No heading-shaped line. Everything is description; nothing is claimed. */
  | "no_headings"
  /** Headings found, but a list is longer than a JD list plausibly is. */
  | "over_threshold";

export type JdParseResult = {
  description: string;
  responsibilities: string[];
  requirements: string[];

  outcome: JdParseOutcome;
  /** Which headings were actually recognised, in order of appearance. */
  headings: JdSection[];
  /** Items per list, after bullet stripping. */
  counts: { responsibilities: number; requirements: number };
  /** The longer of the two lists. The number `MAX_LIST_ITEMS` is compared to. */
  longestList: number;
  /** Word count of the longest single item. See the note on MAX_LIST_ITEMS. */
  longestItemWords: number;
};

/**
 * The escape hatch threshold: above this many items in one list, stop claiming
 * a split and offer to keep the text as one description.
 *
 * ── How this number was chosen ───────────────────────────────
 *
 * Measured, not felt. Across the 20 live JDs — 40 lists, since each job has a
 * responsibilities list and a requirements list:
 *
 *   items per list   5   6   7   8   9+
 *   lists            6  27   6   1   0
 *
 * min 5, median 6, p90 7, max 8. Nothing reaches 9. So this is one past the
 * ceiling of everything we have published: every real JD passes with a margin,
 * and the hatch opens only on a shape the corpus has never produced.
 *
 * ── Why it is 9 and not 8 ────────────────────────────────────
 *
 * `digital-marketing-strategist` has EIGHT responsibilities, and had eight
 * before any of this work started. At 8 the constant sat exactly ON the
 * ceiling — nothing tripped, because the gate is strictly greater-than, but
 * there was no margin at all, which is not the property this is meant to have.
 *
 * It read as 7 for a while, and the reason is worth keeping: the scraper that
 * measured the corpus read the pages in DOM order, and these pages stream. An
 * unresolved Suspense slot leaves an empty `<li>` whose text arrives later in
 * the document, and the scraper's `if (text)` filter dropped those items
 * silently — one per page, on 13 of the 20 pages. Every list was measured one
 * item short, and the resulting number looked entirely plausible.
 *
 * That is what this guard is — a tripwire for "this stopped being a list", not
 * a judgement that nine bullets is too many. The failure it catches is the
 * parser finding a heading in the middle of prose and shredding the paragraphs
 * beneath it into "items"; that produces a long list, which is why length is
 * the signal.
 *
 * ── What it is NOT evidence for ──────────────────────────────
 *
 * n=20, one company, and by the look of the distribution one author working to
 * a template. A twelve-item requirements list is entirely normal elsewhere, so
 * this ceiling describes Remotiv's house style and not the world's. It is a
 * starting value to be re-derived from `jd_parse` telemetry once real customer
 * JDs have run through it — which is the whole reason the counters below ship
 * in the same phase as the gate rather than after it.
 *
 * A second signal, deliberately not wired into the gate yet: item LENGTH. The
 * corpus items run 3–24 words, median 13. A "list item" of 60 words is a
 * paragraph that got shredded, and length catches that at any count where a
 * threshold on count alone cannot. Worth adding once telemetry says whether the
 * count gate fires at all.
 */
export const MAX_LIST_ITEMS = 9;

/**
 * A heading-shaped line.
 *
 * Anchored at both ends and matched against the TRIMMED line, so it recognises
 * a heading standing on its own and nothing else. A sentence that merely
 * contains "requirements" is prose and stays in the body — the anchors are what
 * stop the parser opening a section in the middle of a paragraph.
 */
const HEADING =
  /^(about (the|this) role|what you.?ll do|what we.?re looking for|responsibilities|requirements|nice to have|role details|compensation|benefits|about (the )?company)\s*:?\s*$/i;

/** Leading bullet glyph or ordinal, which is decoration rather than content. */
const BULLET = /^\s*(?:\d+[.)]|[-*•·▪])\s+/;

/** Which column a recognised heading opens. */
function sectionFor(heading: string): JdSection {
  const h = heading.toLowerCase();
  if (h.startsWith("responsib") || (h.includes("you") && h.includes("do"))) {
    return "responsibilities";
  }
  if (h.startsWith("requirement") || h.includes("looking") || h.includes("nice to have")) {
    return "requirements";
  }
  return "description";
}

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * Split one box into three.
 *
 * Always returns a usable result. On `no_headings` or `over_threshold` the
 * caller should write the whole box to `description` and leave the other two
 * columns alone — `responsibilities` and `requirements` are still populated so
 * the wizard can SHOW what a split would have looked like, but the outcome says
 * not to trust it.
 */
export function parseJobDescription(input: string | null | undefined): JdParseResult {
  const text = (input ?? "").replace(/\r\n?/g, "\n");

  const buckets: Record<JdSection, string[]> = {
    description: [],
    responsibilities: [],
    requirements: [],
  };
  const headings: JdSection[] = [];
  let current: JdSection = "description";

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (HEADING.test(line)) {
      current = sectionFor(line);
      headings.push(current);
      continue;
    }

    /*
     * Bullets are stripped from LIST items and kept in the description.
     *
     * In a list the glyph is decoration — the public page renders its own, and
     * leaving it would double up. In the description it is evidence: a bulleted
     * line in a prose block is someone starting a list they never gave a
     * heading, which is one of the things the review queue asks about. Stripping
     * it here made that question undetectable downstream, because by the time
     * the queue saw the line there was nothing left to distinguish it from
     * prose.
     */
    buckets[current].push(current === "description" ? line : line.replace(BULLET, ""));
  }

  const responsibilities = buckets.responsibilities;
  const requirements = buckets.requirements;
  const counts = {
    responsibilities: responsibilities.length,
    requirements: requirements.length,
  };
  const longestList = Math.max(counts.responsibilities, counts.requirements);
  const longestItemWords = [...responsibilities, ...requirements].reduce(
    (max, item) => Math.max(max, words(item)),
    0,
  );

  /*
   * A heading that opens `description` — "About this role", "About the company"
   * — is real, but it does not on its own mean the box was structured: it is
   * the shape an unstructured box already has. Only a heading that opens one of
   * the two LIST columns is evidence of a split worth claiming.
   */
  const splitHeadings = headings.filter((h) => h !== "description");

  const outcome: JdParseOutcome =
    splitHeadings.length === 0
      ? "no_headings"
      : longestList > MAX_LIST_ITEMS
        ? "over_threshold"
        : "split";

  return {
    description: buckets.description.join("\n"),
    responsibilities,
    requirements,
    outcome,
    headings,
    counts,
    longestList,
    longestItemWords,
  };
}

/**
 * The telemetry record for one parse.
 *
 * Emitted on every wizard save, whatever the outcome — a gate you only hear
 * about when it fires cannot be told apart from a gate that never fires. The
 * fields are the ones needed to answer "should MAX_LIST_ITEMS be 9?" from real
 * data rather than from the 20 JDs above: the outcome, the shape that produced
 * it, and whether the recruiter took the hatch when offered.
 *
 * No text, no job title, no company name — the counts and the decision are
 * enough to tune the threshold, and a JD body in an analytics table is customer
 * content sitting somewhere it does not need to be.
 */
export type JdParseTelemetry = {
  outcome: JdParseOutcome;
  headings: JdSection[];
  responsibilities: number;
  requirements: number;
  longestList: number;
  longestItemWords: number;
  /** Characters in the submitted box. Size without content. */
  boxChars: number;
  /**
   * What the recruiter did with an offered split. `null` until they act, so
   * "never offered" and "offered and ignored" stay distinguishable.
   */
  accepted: boolean | null;
};

export function telemetryFor(
  result: JdParseResult,
  input: string | null | undefined,
  accepted: boolean | null = null,
): JdParseTelemetry {
  return {
    outcome: result.outcome,
    headings: result.headings,
    responsibilities: result.counts.responsibilities,
    requirements: result.counts.requirements,
    longestList: result.longestList,
    longestItemWords: result.longestItemWords,
    boxChars: (input ?? "").length,
    accepted,
  };
}
