import { SCORING_OFF_REASON } from "@/app/ai-dashboard/lib/applicant-types";
import { getAnthropic } from "@/lib/anthropic";
import type { ScreeningAnswerSnapshot, ScreeningQuestion } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/usage";

/**
 * AI CV scoring (Step 4).
 *
 * Scores one application against the job it was actually submitted for. Two
 * halves, kept separate on purpose:
 *
 *   1. `scoreCv` — pure-ish: takes an application + a job, calls the model,
 *      verifies the evidence, returns a scorecard. No database.
 *   2. `handleAiCvScore` — the queue handler: loads everything server-side,
 *      calls scoreCv, upserts application_scores, records usage.
 *
 * A plain module, NOT "use server": it exports types and constants, and such a
 * module may only export async functions.
 */

// ── Versioning ───────────────────────────────────────────────

/**
 * Bump on ANY change to the prompt, the band definitions, the dimension set,
 * OR the sampling parameters. Stored on every row as prompt_version, so a
 * scorecard can always be traced to the exact rubric that produced it — and so
 * a re-score after a prompt change is distinguishable from a re-score after a
 * criteria change (which is what job_criteria_version tracks).
 *
 * "or the sampling parameters" is new at v7 and is the reason v7 exists: the
 * rubric is byte-identical to v6, only SCORING_TEMPERATURE changed. Nothing
 * else in the schema records sampling — there is no temperature column and
 * ai_model doesn't move — so without a bump the calibration set would silently
 * pool two different generation processes under one label, with no way to
 * separate them afterwards. Splitting a rubric-identical version into two
 * buckets costs sample size and is recoverable in analysis; pooling two
 * sampling regimes is not recoverable at all.
 */
export const PROMPT_VERSION = "cv-scoring-v9";

/** Swappable without a deploy; the resolved value is stored on every row. */
export const DEFAULT_SCORING_MODEL = "claude-sonnet-4-5";

export function resolveScoringModel(): string {
  return process.env.AI_SCORING_MODEL?.trim() || DEFAULT_SCORING_MODEL;
}

/**
 * Sampling temperature for the scoring call.
 *
 * Previously unset, which meant the API default — and the consistency harness
 * measured what that costs on an obviously-unqualified candidate: overall
 * spread 7, experience_depth spread 10, three different verdicts and a
 * missing_requirements list that changed between runs. A candidate whose
 * rejection should be unambiguous was scored three different ways.
 *
 * 0 is the right setting for a scorer specifically. Sampling variety is a
 * feature when generating prose and a defect when assigning a number a
 * recruiter acts on: nothing about a fixed CV read against a fixed job should
 * come out differently on a second look.
 *
 * Two things this does NOT do, both worth knowing before reading the re-run:
 *
 *   - It does not guarantee identical output. Temperature 0 is greedy
 *     decoding, not determinism; ties and floating-point non-associativity in
 *     batched inference still leave a little movement. Expect small spread,
 *     not zero.
 *   - It does not make the scorer CORRECT. It makes it repeatable, including
 *     where it is repeatably wrong. Residual spread after this change is the
 *     part the rubric owns, which is exactly what this pass is isolating.
 *
 * CAUTION on model swaps: `temperature` is REJECTED WITH A 400 on Opus 4.7 and
 * later, Sonnet 5, and Fable 5 — the parameter was removed on those models.
 * It is accepted on Sonnet 4.5, which is what DEFAULT_SCORING_MODEL resolves
 * to. Pointing AI_SCORING_MODEL at a newer model therefore fails every scoring
 * call until this is removed. That failure is loud (every application lands on
 * status 'failed' with the API's message), not silent, so it is documented
 * here rather than branched on.
 */
const SCORING_TEMPERATURE = 0;

/**
 * Cache lifetime for the system prompt.
 *
 * "5m" is the SDK default and what we want. Writes cost 1.25x standard input at
 * 5m versus 2x at 1h; reads are ~0.1x either way.
 *
 * Scoring runs from a worker every 5 minutes in bursts of whatever arrived. The
 * saving that matters is INSIDE a burst — first CV writes the cache, every
 * other CV in the same burst reads it — and 5m captures all of that at the
 * cheaper write. 1h would only pay off if a later burst landed within the hour
 * often enough to cover the extra 0.75x on every write: break-even needs that
 * roughly 65% of the time, and at current volume (single figures of
 * applications per job across days) bursts are usually hours apart, where no
 * TTL helps. Revisit if volume rises to a steady trickle.
 */
const CACHE_TTL = "5m" as const;

/**
 * Report the cache split so the saving is verifiable rather than assumed.
 *
 * `input_tokens` on a cached response counts ONLY the uncached remainder, so it
 * is not comparable to the pre-cache figure on its own — the three numbers have
 * to be read together.
 */
function logCacheUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null): void {
  if (!usage) return;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  console.log("[cv-scoring] tokens", {
    uncached_input: fresh,
    cache_write: written,
    cache_read: read,
    output: usage.output_tokens ?? 0,
    total_input: fresh + written + read,
    cache: read > 0 ? "HIT" : written > 0 ? "WRITE" : "MISS",
  });
}

/** Ceiling for the model's JSON reply. Generous — evidence quotes are verbose. */
const MAX_TOKENS = 3000;

/** Below this a CV carries too little text to score honestly. */
const MIN_CV_TEXT_CHARS = 200;

/** Hard cap on what we send. Long CVs are truncated, never rejected. */
const MAX_CV_TEXT_CHARS = 24_000;

/**
 * Output caps, mirrored in the prompt as maximums.
 *
 * Enforced here as well as asked for there: the prompt is a request, the slice
 * is a guarantee. A model that returns eight strengths still produces a card a
 * recruiter can read.
 */
const MAX_STRENGTHS = 4;
const MAX_MISSING = 3;
const MAX_CONCERNS = 3;
/** Verdict is a headline, not a sentence — clipped hard if it overruns. */
const MAX_VERDICT_CHARS = 120;

/** The four dimensions. Fixed so scores stay comparable across jobs. */
export const SCORE_DIMENSIONS = [
  "requirements_match",
  "experience_depth",
  "domain_relevance",
  "responsibilities_fit",
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export type Confidence = "high" | "medium" | "low";

// ── Result shapes ────────────────────────────────────────────

export type EvidenceItem = {
  /** What this quote supports: a dimension name, or "strength". */
  claim: string;
  /** Verbatim span from the CV. Verified to actually appear before storage. */
  quote: string;
};

export type DimensionScore = {
  dimension: ScoreDimension;
  score: number;
  reasoning: string;
  /** The CV span supporting THIS dimension. Empty when none survived. */
  quote: string;
};

/** A strength and the span that proves it — one object, never two arrays. */
export type Strength = {
  point: string;
  quote: string;
};

export type Scorecard = {
  /** One-line headline, max ~12 words. Empty for v1-v3 rows. */
  verdict: string;
  overall_score: number;
  dimension_scores: DimensionScore[];
  evidence: EvidenceItem[];
  strengths: Strength[];
  missing_requirements: string[];
  concerns: string[];
  confidence: Confidence;
  summary: string;
  screening_score: number | null;
  ai_model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
};

export type ScoreInput = {
  cvText: string;
  screeningAnswers: ScreeningAnswerSnapshot[];
  candidate: {
    yearsExperience: number | null;
    city: string | null;
    country: string | null;
    noticePeriod: string | null;
    availability: string | null;
  };
  job: {
    title: string;
    description: string | null;
    responsibilities: string | null;
    requirements: string | null;
    experienceLevel: string | null;
    category: string | null;
    screeningQuestions: ScreeningQuestion[];
  };
};

// ── Screening score ──────────────────────────────────────────

/**
 * Derive screening_score from the snapshot frozen at apply time.
 *
 * The model is never asked to re-judge declared answers: they were scored
 * deterministically in /api/apply against the employer's stated ideal, and a
 * language model second-guessing "did they answer Yes" would only add noise
 * and disagreement with what the employer already sees in the drawer.
 *
 * Essential questions carry double weight — an employer marking a question
 * essential is saying it matters more, and a flat average would let three
 * nice-to-haves paper over a missed must-have.
 *
 * Returns null when the job asked nothing, which is different from scoring 0 —
 * and, since numeric questions gained a "no threshold" mode, also null when the
 * job asked only questions that were never tests.
 *
 * NOT a rubric change. This is deterministic arithmetic over a frozen snapshot;
 * it touches no prompt text, so PROMPT_VERSION does not move.
 */
export function computeScreeningScore(
  answers: ScreeningAnswerSnapshot[],
): number | null {
  if (answers.length === 0) return null;

  let earned = 0;
  let possible = 0;
  for (const a of answers) {
    // Collected, never tested (numeric_mode 'none'). Excluded from BOTH sides
    // of the fraction: counting it in `possible` alone would deflate every
    // candidate for a question nobody could pass, and counting it in `earned`
    // too would inflate them for one nobody could fail. `scored` is absent on
    // every snapshot written before the mode existed, so those still count.
    if (a.scored === false) continue;
    const weight = a.essential ? 2 : 1;
    possible += weight;
    if (a.matched) earned += weight;
  }
  if (possible === 0) return null;
  return Math.round((earned / possible) * 100);
}

/**
 * Essential questions the candidate did not match, phrased for the employer.
 *
 * `scored === false` is excluded for the same reason it is excluded from
 * computeScreeningScore: a numeric_mode 'none' question has no ideal by design,
 * so it cannot be missed. Without this check it produced a live scorecard
 * reading `Screening: "How many qualified leads…" — answered "1", you asked for
 * ""` — a missing requirement invented from a question that was never a test,
 * with the empty ideal printed straight into the recruiter's card.
 */
function unmatchedEssentials(answers: ScreeningAnswerSnapshot[]): string[] {
  return answers
    .filter((a) => a.scored !== false && a.essential && !a.matched)
    .map((a) => {
      const given = a.answer_label || a.answer || "no answer";
      const wanted = a.ideal_label || a.ideal;
      return `Screening: "${a.question}" — answered "${given}", you asked for "${wanted}"`;
    });
}

// ── Prompt ───────────────────────────────────────────────────

/**
 * Band definitions for the 0-100 scale.
 *
 * Stated in the prompt verbatim so a 92 means the same thing on a Frontend
 * role and a Finance role. Without an anchor, models drift toward 70-85 for
 * everything and the ranking stops discriminating.
 */
const BAND_DEFINITIONS = `SCORE BANDS — anchor every number to these. They are absolute, not relative to the other applicants:
- 90-100  Exceptional. Every stated essential requirement is met with direct, specific evidence in the CV, and there is demonstrated depth beyond the minimum asked for.
- 75-89   Strong. All essential requirements are met with evidence. Gaps, if any, are on nice-to-haves rather than essentials.
- 60-74   Viable. Most essentials are evidenced, but at least one real gap would need to be explored in an interview.
- 40-59   Partial. Some essentials are evidenced; several stated requirements have no supporting evidence at all.
- 20-39   Weak. Little overlap between what the CV shows and what this job asks for.
- 0-19    Unrelated. A different field, or the CV contains no evidence relevant to this role.`;

/**
 * Exported so the rubric can be reproduced outside the scoring path — the
 * consistency harness and any fabrication diagnostic need to issue the exact
 * request scoreCv issues, and a prompt that can't be read from a test is a
 * prompt whose failures can only be guessed at. Read-only: nothing mutates it.
 */
export const SYSTEM_PROMPT = `You are an experienced technical recruiter assessing ONE candidate's CV against ONE specific job description.

You judge against THAT JOB'S stated requirements and responsibilities — never against a generic idea of a good CV. A CV that is excellent for a different role scores low here if it does not match what this job asks for.

${BAND_DEFINITIONS}

EVIDENCE IS MANDATORY, AND IT MUST BE THE RIGHT EVIDENCE.
Every dimension score and every strength carries its own "quote" field. Three rules, and each matters as much as the first:

1. VERBATIM, AND ONE CONTIGUOUS SPAN. Copy the span EXACTLY, character for character, from the CV text you are given. Do not paraphrase, do not summarise, do not tidy up spelling or spacing inside a quote. A quote that is not literally present in the CV is discarded.

The quote must be a SINGLE UNBROKEN RUN of characters from one place in the CV. Never join two separate places together, and never use "..." or "…" to skip over intervening text. Both halves being real does not make the joined string real: the quote as you wrote it appears nowhere in the CV, so it is discarded exactly like an invented one. If the proof you want is split across two parts of the CV, pick the ONE span that best supports this specific claim. If no single span supports it, drop the claim.

2. DIRECTLY RELEVANT. The quote must be the span that supports THAT SPECIFIC claim — the sentence a reader would point at to check it. A real quote from elsewhere in the CV is NOT partial credit; it is a failure, and worse than omitting the claim, because it makes an unsupported statement look verified.

3. FROM THE CV TEXT ONLY — NOT FROM THE JOB DESCRIPTION. Every quote must come from the section marked "CV TEXT". The job's requirements and responsibilities are what you are judging the candidate AGAINST; they are never evidence that the candidate did the thing. Quoting the job description back as proof is circular — it says what the employer wants, not what this person has done — and it is the most dangerous possible error, because it makes a candidate look like a perfect match for exactly the duties the CV is silent on. If a responsibility has no support in the CV, that is a MISSING REQUIREMENT, not a quote.

Strengths must be evidenced from the CV. The screening answers and the candidate profile are given to you as CONTEXT for your judgement — they are not a source of strengths either, because neither contains a CV span you could quote. If something is shown only by a screening answer or a self-reported profile field, it does NOT become a strength: put it in the relevant dimension's reasoning or in the summary instead, where no quote is required.

Examples of these rules being broken — do not do this:
- Claim "led large engineering teams" with quote "Led global teams of 25+... managed teams of up to 35+ professionals". BOTH halves are real sentences from the CV, and joining them still fails: that string appears nowhere in the document. This is the most common way a well-intentioned quote breaks — you found two supporting facts and stitched them. Pick one and stop: "Led global teams of 25+". Never reach for the ellipsis.
- Claim "currently employed at Acme since July 2024" with quote "Increased profits by 15,000 AED per month". The quote is real but it proves the profit figure, not the employment date. The correct quote names the employer and the date.
- Claim "built pipelines of 70+ companies" with quote "MBA in Marketing". Unrelated.
- Claim "multi-channel outreach using LinkedIn Sales Navigator" with quote "100% month on month growth". Unrelated.
- Claim "substantial cold calling experience, validated by the screening answer of 5 years" with quote "Successfully increased company profits by over 15,000 AED each month". This is a different and worse mistake: the claim came from a screening answer, so no CV span could ever have proved it, and rather than dropping it you reached for the nearest real sentence. The five years of cold calling belongs in reasoning or the summary. It is NOT a strength, because it is not quotable from the CV.

DROPPING A CLAIM IS ALWAYS AVAILABLE AND ALWAYS CORRECT when the CV does not support it. Do not attach an approximate quote to keep a claim alive. Do not treat a claim as too important to drop. Before you emit any strength, ask: is there a CV span that, read alone, proves this? If no — drop it, or move it to the summary. Reporting four well-evidenced strengths is better than reporting eight with three mismatched quotes. An empty strengths array is an acceptable answer.

DIMENSIONS — score each 0-100 using the same bands. Reasoning is ONE OR TWO SENTENCES, never more; the quote carries the proof, so do not restate it in prose:
- requirements_match     Against the job's stated requirements specifically.
- experience_depth       Is the depth and seniority consistent with the stated experience level?
- domain_relevance       Is their background in the same domain, industry, or technical area this role sits in?
- responsibilities_fit   Have they demonstrably done the things this job lists as responsibilities?

WEIGHT CORE REQUIREMENTS FAR ABOVE INCIDENTAL ONES.
Job descriptions mix the things the role actually exists to do with administrative or incidental duties that happen to be listed. Judge against the former. A candidate with no evidence for a minor listed task — scheduling meetings, maintaining a spreadsheet, attending a weekly stand-up — should NOT drop a band for it; a candidate with no evidence for a core requirement should. Ask what this person is being hired to DO, and weight accordingly.
This is not permission to be generous. Missing evidence for a core requirement is still missing, and still scores low. You are being told which absences matter, not told to overlook absences.
If the job description is thin, vague, or mostly generic boilerplate, say so in the reasoning — "the description lists few concrete requirements, so this is judged on domain fit alone" — rather than scoring the candidate down for failing to evidence trivia the employer happened to write. A weak job description is the employer's gap, not the candidate's.

MISSING REQUIREMENTS — the most useful thing you produce. MAXIMUM 3. List the job's stated requirements for which the CV shows no supporting evidence. Be specific and concrete: "No Kubernetes or container orchestration experience mentioned" — never "lacks some technical skills". Return only gaps that would change a hiring decision; if every stated requirement has evidence, return an empty array.

CONCERNS — MAXIMUM 3. These are shown to the recruiter under the heading "Risks / points to verify": they are things to CHECK in an interview, not reasons to reject. Neutral factual observations only — an unexplained multi-year gap, a run of very short tenures, a career change mid-CV. NEVER recommend rejecting, advancing, or interviewing anyone. You do not make hiring decisions; you surface what the CV does and does not show. If there is nothing genuinely worth verifying, return an empty array.

CONTRADICTIONS BETWEEN THE SCREENING ANSWERS AND THE CV — include these as concerns, and rank them first when present. The screening answers are the candidate's own claims; the CV is what they chose to document. When a claim and the document point in different directions, that gap is the most useful thing on this card, and the recruiter should hear it in one line.

Name BOTH sides — what was claimed, and what the CV actually shows:
  "Claims 2 years of business development; the CV describes only software engineering roles."

Phrase it NEUTRALLY, as something to establish in the interview. NEVER imply dishonesty. A CV can legitimately leave out real work — people tailor CVs, omit short contracts, or under-describe a side of a job they no longer want. A thin CV is not evidence of a lie. You are flagging a question to ask, not an accusation to make.

ONLY A GENUINE CONTRADICTION, never a mere absence of detail. The line:
  ABSENCE, do NOT flag — "claims 5 years cold calling; CV describes sales roles but doesn't mention phone outreach." The CV is consistent with the claim, just less specific. Silence is not a contradiction.
  CONTRADICTION, DO flag — "claims 2 years business development; CV shows only software engineering roles." The CV is not merely quiet about business development; it accounts for the candidate's time doing something else.
Test it this way: if the CV's own account of their time leaves room for the claim to be true, it is an absence — say nothing. If the CV's account of the same period describes different work entirely, it is a contradiction — flag it.

This does NOT change the score. The dimension scores and overall_score already reflect what the CV evidences, and the CV evidencing nothing has already been counted there. Flagging it here is an extra observation for the reader, not a second penalty for the same gap. Do not lower any number because you wrote a contradiction concern.

Contradiction concerns count against the maximum of 3 like any other.

CONFIDENCE — how much usable signal the CV actually contained, NOT how good the candidate is:
- high    A detailed CV with dates, employers, and concrete descriptions of work done.
- medium  Adequate detail, but thin in places, or the format made parts ambiguous.
- low     Sparse, very short, badly extracted, or largely a list of skills with no context.
A one-page CV listing only skills is low confidence even if those skills match perfectly.

VERDICT — the first thing you output and the only thing many recruiters will read. ONE line, MAXIMUM 12 WORDS. State the fit AND the single most important caveat, if there is one. It must be readable on its own, with no other context.
Good: "Strong match — verify cold-calling experience."
Good: "Partial fit — no evidence of the core requirement."
Good: "Excellent fit across every stated requirement."
Bad: "This candidate has a number of relevant strengths and some gaps." (says nothing)
Bad: "Recommend interviewing." (you do not make hiring decisions)

SUMMARY — 3 to 5 sentences. This is a HARD CAP, not a target; 3 good sentences beat 5 padded ones. Prose only — DO NOT LIST, do not use bullets, dashes or numbering. In this order:
  1. Who they are and their headline fit for THIS role.
  2. The strongest specific evidence for that fit.
  3. The main gap or caveat.
  4. Anything a manager must verify before deciding.
Length tracks the DECISION, not the CV. A seven-page CV does not earn a longer summary than a two-page one. If the decision is obvious, three sentences is the right answer.

NO REPETITION — this is the rule that keeps the card readable, and it is as important as the evidence rules.
Every fact appears EXACTLY ONCE, in the single most useful place. Before you emit a field, check it does not repeat something you already said.
- A fact stated in the summary must NOT reappear as a strength.
- A gap named in missing_requirements must NOT be restated in concerns.
- A dimension's reasoning must NOT restate its own quote in prose.
- The summary's "what to verify" sentence must NAME the concern in a few words, not explain it. The concerns array is where it gets explained. If a concern is fully stated in concerns, the summary REFERENCES it in a clause — it does not spend a sentence on it.

Violation 1, do not do this: summary says "She has eight years in B2B sales at Acme", strengths contains {"point": "Eight years of B2B sales experience at Acme"}, and requirements_match reasoning says "Eight years of B2B sales at Acme meets the requirement." That is one fact charged three times to the reader.

Violation 2 — summary and concerns saying the same thing twice, do not do this:
  summary ends: "...However, his roles have emphasised account growth and relationship management rather than new lead generation. His interest in a high-volume outbound calling role should be verified given his background is weighted towards farming existing accounts."
  concerns:     ["Roles emphasise account growth over new lead generation", "Fit for a high-volume outbound role should be verified"]
The reader pays for both. Two sentences of the summary were spent on what the concerns array already says.
Correct: summary ends "...though his background leans towards account growth over new lead generation — see the points to verify." and concerns carries the detail. One clause names it; the array explains it.

Correct in general: state it once, in the place where it does the most work — usually the summary if it drives the verdict, otherwise a strength with its quote or a concern with its explanation.
The recruiter is reading 60 of these. Repetition is not thoroughness; it is a cost you impose on them.

OUTPUT — return ONLY valid JSON. No prose before or after, no markdown, no code fences. Every claim carries its quote INSIDE the same object, so nothing has to be matched up by position. Exactly this shape:
{
  "verdict": "<one line, max 12 words: the fit and the key caveat>",
  "overall_score": <integer 0-100>,
  "dimension_scores": [
    {"dimension": "requirements_match", "score": <integer 0-100>, "reasoning": "<one sentence>", "quote": "<exact CV span supporting THIS dimension>"},
    {"dimension": "experience_depth", "score": <integer 0-100>, "reasoning": "<one sentence>", "quote": "<exact CV span supporting THIS dimension>"},
    {"dimension": "domain_relevance", "score": <integer 0-100>, "reasoning": "<one sentence>", "quote": "<exact CV span supporting THIS dimension>"},
    {"dimension": "responsibilities_fit", "score": <integer 0-100>, "reasoning": "<one sentence>", "quote": "<exact CV span supporting THIS dimension>"}
  ],
  "strengths": [
    {"point": "<specific strength>", "quote": "<exact CV span that directly proves THIS strength>"}
  ],
  "missing_requirements": ["<specific stated requirement with no CV evidence>"],
  "concerns": ["<neutral observation to verify>"],
  "confidence": "high" | "medium" | "low",
  "summary": "<3-5 sentences, prose, no lists>"
}

CAPS — these are MAXIMUMS, not targets. Fewer is better every time. Return only the items that would change a decision:
  strengths            max 4
  missing_requirements max 3
  concerns             max 3
Four weak strengths are worse than two strong ones. An empty array is a valid, useful answer.

Each quote belongs to the object it sits in. Before you emit each one, re-read it and ask: does this span, on its own, show that this specific claim is true? If not, find the right span or drop the claim.

overall_score is your holistic judgement anchored to the bands — not a mechanical average of the dimensions — but it must be defensible given them. For any dimension you score above 40, the quote must be a real span; if you cannot find one, score it lower and say why in the reasoning.`;

function section(label: string, value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v ? `${label}:\n${v}` : `${label}: (not specified)`;
}

export function buildUserMessage(input: ScoreInput): string {
  const { job, candidate, screeningAnswers } = input;

  const cv =
    input.cvText.length > MAX_CV_TEXT_CHARS
      ? `${input.cvText.slice(0, MAX_CV_TEXT_CHARS)}\n\n[CV truncated at ${MAX_CV_TEXT_CHARS} characters]`
      : input.cvText;

  const screening =
    screeningAnswers.length > 0
      ? screeningAnswers
          .map((a) => {
            const head = `- ${a.essential ? "[essential] " : ""}${a.question}\n  answered: ${
              a.answer_label || a.answer || "(no answer)"
            }`;
            // A numeric_mode 'none' question was collected, never tested. It has
            // no ideal by design, so the ideal/matched pair is OMITTED rather
            // than printed as an empty ideal and "matched: no" — that read as a
            // failed test, and the model duly invented a missing requirement
            // out of a question nobody could fail.
            if (a.scored === false) {
              return `${head}\n  (collected for context — the employer set no threshold, so there is nothing to pass or fail here)`;
            }
            return `${head}\n  employer's ideal: ${a.ideal_label || a.ideal}\n  matched: ${
              a.matched ? "yes" : "no"
            }`;
          })
          .join("\n")
      : "(this job asked no screening questions)";

  const profile = [
    candidate.yearsExperience != null
      ? `years of experience (self-reported): ${candidate.yearsExperience}`
      : null,
    [candidate.city, candidate.country].filter(Boolean).join(", ") || null,
    candidate.noticePeriod ? `notice period: ${candidate.noticePeriod}` : null,
    candidate.availability ? `availability: ${candidate.availability}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `=== THE JOB ===
Title: ${job.title}
${section("Category", job.category)}
${section("Experience level sought", job.experienceLevel)}

${section("Description", job.description)}

${section("Responsibilities", job.responsibilities)}

${section("Requirements", job.requirements)}

=== SCREENING ANSWERS (already scored — do not re-judge these. Context for your judgement only: NOT a source of strengths, because there is no CV span to quote for them) ===
${screening}

=== CANDIDATE PROFILE (self-reported at apply time — context only, not quotable, so not a source of strengths) ===
${profile || "(nothing beyond the CV)"}

=== CV TEXT (quote from this, exactly) ===
${cv}`;
}

// ── Evidence verification ────────────────────────────────────

/**
 * Normalise for comparison: lowercase, unify the quote/dash/space characters
 * PDF extraction mangles, and collapse all whitespace.
 *
 * Deliberately NOT fuzzy. The point of the evidence rule is that the span is
 * genuinely in the CV; a similarity threshold would let a plausible-sounding
 * near-quote through, which is exactly the failure this guards against. The
 * only tolerance is for characters that carry no meaning.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Models sometimes wrap a quote in quotation marks; strip those before comparing. */
function trimQuoteArtifacts(quote: string): string {
  return quote.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * Split a quote at any ellipsis into the spans the model actually meant.
 *
 * Ellipsis-stitching is the dominant fabrication mode in practice, and it is
 * not invention: measured on a live application, EVERY unverifiable quote was
 * two or more real CV sentences joined by "...", none drawn from the job
 * description or the screening answers. The model reads rule 1 as satisfied —
 * each half IS verbatim — and marks the elision honestly. The old contiguous
 * `includes` test then failed the lot, and at four-plus bad quotes out of
 * eight that tripped MAX_FAIL_RATE and threw the whole scorecard away.
 *
 * A leading or trailing ellipsis produces an empty segment, which the filter
 * removes — that also replaces the previous start/end stripping, which had a
 * latent bug: in `/^\.{3}|…/g` the `^` anchored only the first alternative, so
 * a unicode ellipsis was stripped anywhere in the string while an ASCII one
 * mid-quote (what models actually emit) was left in place.
 */
function ellipsisSegments(quote: string): string[] {
  return quote
    .split(/\s*(?:\.{3,}|…)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Below this a quote proves nothing — "React" appears in half of all CVs. */
const MIN_QUOTE_CHARS = 8;

export type VerificationOutcome = {
  verified: EvidenceItem[];
  dropped: EvidenceItem[];
  /** Fraction of quotes that could not be found, 0-1. */
  failRate: number;
};

/**
 * Check every quote actually appears in the CV.
 *
 * Anything not found is dropped, and the claim it supported goes with it —
 * a fabricated quote is the one failure mode that would make the whole feature
 * untrustworthy, so it is never stored.
 *
 * A quote split by an ellipsis is checked SEGMENT BY SEGMENT, and every segment
 * must be found: one real half plus one invented half is still fabrication and
 * still drops. What gets STORED is the single longest verified segment, never
 * the stitched string — so the quote a recruiter reads is always a contiguous
 * run that genuinely appears in the CV, which is the whole point of the gate.
 * Salvaging the segment rather than the join is what keeps this from being a
 * loosening: nothing is stored now that could not have been stored before.
 */
export function verifyEvidence(
  evidence: EvidenceItem[],
  cvText: string,
): VerificationOutcome {
  const haystack = normalise(cvText);
  const verified: EvidenceItem[] = [];
  const dropped: EvidenceItem[] = [];

  for (const item of evidence) {
    const cleaned = trimQuoteArtifacts(item.quote ?? "");
    const segments = ellipsisSegments(cleaned);

    // Fabrication test: EVERY segment must appear in the CV.
    const allFound =
      segments.length > 0 &&
      segments.every((segment) => haystack.includes(normalise(segment)));
    if (!allFound) {
      dropped.push(item);
      continue;
    }

    // Triviality test, applied to the span actually stored rather than to the
    // whole quote — a short fragment that IS in the CV isn't fabrication, it
    // just proves nothing on its own.
    const best = segments.reduce((a, b) => (b.length > a.length ? b : a));
    if (normalise(best).length < MIN_QUOTE_CHARS) {
      dropped.push(item);
      continue;
    }

    verified.push({ claim: item.claim, quote: best });
  }

  const total = verified.length + dropped.length;
  return {
    verified,
    dropped,
    failRate: total === 0 ? 0 : dropped.length / total,
  };
}

/** More than half the quotes unverifiable → the response is not trustworthy. */
const MAX_FAIL_RATE = 0.5;

const CONFIDENCE_ORDER: Confidence[] = ["high", "medium", "low"];

function lowerConfidence(c: Confidence): Confidence {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return CONFIDENCE_ORDER[Math.min(i + 1, CONFIDENCE_ORDER.length - 1)];
}

// ── Parsing ──────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function stringList(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 400))
    .slice(0, max);
}

type RawResponse = {
  verdict: string;
  overall_score: number;
  dimension_scores: DimensionScore[];
  strengths: Strength[];
  missing_requirements: string[];
  concerns: string[];
  confidence: Confidence;
  summary: string;
};

/** Defensive parse — the model is instructed to return bare JSON, but a
 *  malformed reply must fail cleanly rather than store garbage. */
export function parseScoreJson(raw: string): RawResponse | null {
  try {
    const parsed = JSON.parse(stripCodeFences(raw)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const dims: DimensionScore[] = Array.isArray(parsed.dimension_scores)
      ? (parsed.dimension_scores as Record<string, unknown>[])
          .filter(
            (d) =>
              d &&
              typeof d.dimension === "string" &&
              (SCORE_DIMENSIONS as readonly string[]).includes(d.dimension),
          )
          .map((d) => ({
            dimension: d.dimension as ScoreDimension,
            score: clampScore(d.score),
            reasoning:
              typeof d.reasoning === "string" ? d.reasoning.slice(0, 400) : "",
            quote: typeof d.quote === "string" ? d.quote.slice(0, 1000) : "",
          }))
      : [];

    // Strengths are objects now. A v1 row (bare strings) still parses — the
    // quote is simply absent, and an unquoted strength is dropped below.
    const strengths: Strength[] = Array.isArray(parsed.strengths)
      ? (parsed.strengths as unknown[])
          .map((raw) => {
            if (typeof raw === "string") return { point: raw.trim(), quote: "" };
            const o = raw as Record<string, unknown>;
            return {
              point: typeof o?.point === "string" ? o.point.trim().slice(0, 400) : "",
              quote: typeof o?.quote === "string" ? o.quote.slice(0, 1000) : "",
            };
          })
          .filter((x) => x.point.length > 0)
          .slice(0, MAX_STRENGTHS)
      : [];

    const conf = parsed.confidence;
    const confidence: Confidence =
      conf === "high" || conf === "medium" || conf === "low" ? conf : "low";

    return {
      verdict:
        typeof parsed.verdict === "string"
          ? parsed.verdict.trim().slice(0, MAX_VERDICT_CHARS)
          : "",
      overall_score: clampScore(parsed.overall_score),
      dimension_scores: dims,
      strengths,
      missing_requirements: stringList(parsed.missing_requirements, MAX_MISSING),
      concerns: stringList(parsed.concerns, MAX_CONCERNS),
      confidence,
      summary:
        typeof parsed.summary === "string" ? parsed.summary.slice(0, 1500) : "",
    };
  } catch {
    return null;
  }
}

// ── Scorer ───────────────────────────────────────────────────

export class ScoringSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ScoringSkipped";
  }
}

/**
 * Score one application against one job.
 *
 * Throws on a model or parse failure so the queue's retry/backoff handles it.
 * Throws ScoringSkipped when there is nothing worth scoring — the handler
 * translates that into status 'skipped' rather than a retry.
 */
export async function scoreCv(input: ScoreInput): Promise<Scorecard> {
  const cvText = (input.cvText ?? "").trim();
  if (cvText.length < MIN_CV_TEXT_CHARS) {
    throw new ScoringSkipped(
      `CV text too short to score (${cvText.length} chars, minimum ${MIN_CV_TEXT_CHARS}).`,
    );
  }

  const model = resolveScoringModel();
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: SCORING_TEMPERATURE,
    // Same text as the plain-string form this replaces — a single text block
    // renders identically — with a cache breakpoint on it. The rubric is
    // byte-identical on every call and ~3.7k tokens, so re-sending it at full
    // price per CV was the single largest line on the bill. PURELY a billing
    // change: the model receives exactly the same bytes, which is why
    // PROMPT_VERSION does NOT move.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral", ttl: CACHE_TTL },
      },
    ],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  logCacheUsage(response.usage);

  const block = response.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const parsed = parseScoreJson(text);
  if (!parsed) {
    throw new Error(
      `Model returned unparseable JSON (${text.length} chars, model ${model}).`,
    );
  }

  // ── Evidence gate ──
  //
  // Verification is now PER CLAIM, because each claim owns its quote. Under v1
  // the model returned two parallel arrays and the UI paired strengths[i] with
  // the i-th strength-evidence entry — a positional join the model was never
  // told to maintain, which is how a real quote ended up attached to the wrong
  // strength. There is no longer any pairing step to get wrong.
  const dimensionScores: DimensionScore[] = parsed.dimension_scores.map((d) => {
    const [ok] = verifyEvidence([{ claim: d.dimension, quote: d.quote }], cvText)
      .verified;
    return ok
      ? { ...d, quote: ok.quote }
      : {
          ...d,
          quote: "",
          reasoning: `${d.reasoning} (no verifiable CV quote)`.trim(),
        };
  });

  // A strength IS a claim about the CV, so an unverifiable one is dropped
  // outright rather than shown without its proof.
  const strengths: Strength[] = parsed.strengths.flatMap((st) => {
    const [ok] = verifyEvidence([{ claim: "strength", quote: st.quote }], cvText)
      .verified;
    return ok ? [{ point: st.point, quote: ok.quote }] : [];
  });

  // Flat list kept for the `evidence` jsonb column and for the fail-rate maths.
  // Derived from the claims above, so it can never disagree with them.
  const allQuotes: EvidenceItem[] = [
    ...parsed.dimension_scores.map((d) => ({ claim: d.dimension, quote: d.quote })),
    ...parsed.strengths.map((st) => ({ claim: "strength", quote: st.quote })),
  ].filter((e) => e.quote.trim().length > 0);

  const verified: EvidenceItem[] = [
    ...dimensionScores
      .filter((d) => d.quote)
      .map((d) => ({ claim: d.dimension as string, quote: d.quote })),
    ...strengths.map((st) => ({ claim: "strength", quote: st.quote })),
  ];

  const failRate =
    allQuotes.length === 0
      ? 0
      : (allQuotes.length - verified.length) / allQuotes.length;

  if (failRate > MAX_FAIL_RATE) {
    throw new Error(
      `Evidence verification failed: ${Math.round(failRate * 100)}% of ${
        allQuotes.length
      } quotes could not be found in the CV. Refusing to store a fabricated scorecard.`,
    );
  }

  const confidence =
    failRate > 0 ? lowerConfidence(parsed.confidence) : parsed.confidence;

  const screeningScore = computeScreeningScore(input.screeningAnswers);

  // Unmatched essentials are a missing requirement by definition, and the
  // employer already declared them essential — surface them alongside the
  // model's own findings, de-duplicated.
  const missing = [
    ...unmatchedEssentials(input.screeningAnswers),
    ...parsed.missing_requirements,
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    verdict: parsed.verdict,
    overall_score: parsed.overall_score,
    dimension_scores: dimensionScores,
    evidence: verified,
    strengths,
    missing_requirements: missing,
    concerns: parsed.concerns,
    confidence,
    summary: parsed.summary,
    screening_score: screeningScore,
    ai_model: model,
    prompt_version: PROMPT_VERSION,
    // TOTAL prompt tokens, not the uncached remainder. With caching on,
    // usage.input_tokens counts only what was NOT served from cache, so
    // storing it raw would silently redefine this column mid-history and make
    // every cost figure computed from it collapse overnight for the wrong
    // reason. Summing the three keeps `input_tokens` meaning exactly what it
    // has always meant; the cache split goes to the log instead.
    input_tokens:
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.cache_creation_input_tokens ?? 0) +
      (response.usage?.cache_read_input_tokens ?? 0),
    output_tokens: response.usage?.output_tokens ?? 0,
  };
}

// ── Queue handler ────────────────────────────────────────────

type ApplicationRow = {
  id: string;
  job_id: string | null;
  company_id_snapshot: string | null;
  cv_text: string | null;
  screening_answers: unknown;
  years_experience: number | null;
  city: string | null;
  country: string | null;
  notice_period: string | null;
  availability: string | null;
};

type JobRow = {
  id: string;
  title: string | null;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
  experience_level: string | null;
  category: string | null;
  screening_questions: unknown;
  criteria_version: number | null;
  /** Null only on a row written before the column existed — treated as ON. */
  ai_cv_scoring_enabled: boolean | null;
};

/**
 * Columns a HUMAN owns. The model must never write them, at any status.
 *
 * A human override is the only ground truth we will ever have about where this
 * model runs high or low, and it is not reproducible — nobody re-reviews a
 * candidate to regenerate it. Losing one to a routine re-score destroys the
 * data the whole calibration effort depends on, silently.
 */
const HUMAN_OVERRIDE_COLUMNS: readonly string[] = [
  "human_adjusted_score",
  "human_feedback",
  "adjusted_by",
  "adjusted_by_name",
  "adjusted_at",
];

/**
 * Upsert on the unique application_id so a retry overwrites rather than
 * erroring on the constraint — the handler is safe to run repeatedly.
 *
 * The human-override columns are STRIPPED from the payload rather than merged
 * into it. On the ON CONFLICT DO UPDATE branch the SET list is built from the
 * keys actually sent, so a column that was never in the payload is not
 * assigned at all and keeps whatever the last adjustScore wrote.
 *
 * This is deliberately NOT a read-then-merge. Reading the override and writing
 * it back opens a lost-update window: an adjustScore committing between the
 * read and the write would be overwritten by the stale value we had already
 * loaded. Never naming the columns has no such window — the re-score and a
 * concurrent adjust touch disjoint column sets, so whichever row lock lands
 * second leaves the other's work intact regardless of ordering.
 *
 * The strip is defensive, not decorative: it means a future caller that adds
 * one of these keys to its payload gets a loud log instead of quiet data loss.
 */
async function writeScoreRow(
  row: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const service = createServiceClient();

  const payload: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [column, value] of Object.entries(row)) {
    if (HUMAN_OVERRIDE_COLUMNS.includes(column)) {
      refused.push(column);
      continue;
    }
    payload[column] = value;
  }
  if (refused.length > 0) {
    console.error(
      "[cv-scoring] refused to write human-override columns — a re-score must never clobber a reviewer's correction",
      { applicationId: row.application_id, refused },
    );
  }

  const { error } = await service
    .from("application_scores")
    .upsert(payload, { onConflict: "application_id" });
  return { error: error?.message ?? null };
}

/**
 * The `ai_cv_score` job handler.
 *
 * Payload is `{ applicationId }` and NOTHING else is trusted from it —
 * company, job and CV are all loaded server-side from the application row, so
 * a forged payload cannot make one company's job score another's applicant.
 */
export async function handleAiCvScore(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const applicationId = job.payload?.applicationId;
  if (typeof applicationId !== "string" || !applicationId) {
    throw new Error(`ai_cv_score: payload.applicationId missing (job ${job.id})`);
  }

  const service = createServiceClient();

  const { data: appData, error: appErr } = await service
    .from("job_applications")
    .select(
      "id, job_id, company_id_snapshot, cv_text, screening_answers, years_experience, city, country, notice_period, availability",
    )
    .eq("id", applicationId)
    .maybeSingle();

  if (appErr) throw new Error(`ai_cv_score: application lookup failed: ${appErr.message}`);
  const app = appData as ApplicationRow | null;
  if (!app) throw new Error(`ai_cv_score: application ${applicationId} not found`);

  const screeningAnswers = Array.isArray(app.screening_answers)
    ? (app.screening_answers as ScreeningAnswerSnapshot[])
    : [];

  // ── Skip paths: nothing to score, and retrying will not change that ──
  const skip = async (reason: string) => {
    await writeScoreRow({
      application_id: app.id,
      company_id: app.company_id_snapshot,
      job_id: app.job_id,
      status: "skipped",
      error: reason,
      screening_score: computeScreeningScore(screeningAnswers),
      ai_model: resolveScoringModel(),
      prompt_version: PROMPT_VERSION,
    });
    console.warn(`[cv-scoring] skipped ${app.id}: ${reason}`);
  };

  if (!app.job_id) {
    await skip("Application has no job_id — nothing to score against.");
    return;
  }

  const { data: jobData, error: jobErr } = await service
    .from("jobs")
    .select(
      "id, title, description, responsibilities, requirements, experience_level, category, screening_questions, criteria_version, ai_cv_scoring_enabled",
    )
    .eq("id", app.job_id)
    .maybeSingle();

  if (jobErr) throw new Error(`ai_cv_score: job lookup failed: ${jobErr.message}`);
  const jobRow = jobData as JobRow | null;
  if (!jobRow) {
    await skip("The job this application targets no longer exists.");
    return;
  }

  // The company turned scoring off for this job. This is the ONLY place the
  // check lives: /api/apply could refuse to enqueue, but that writes no row,
  // and "no row" is indistinguishable from "queued, not run yet" — the list
  // would read Pending forever. Skipping here writes a row that says why.
  //
  // Deliberately BEFORE the CV-text check: a scoring-off job whose CV is an
  // image-only PDF should report the setting, not blame the PDF.
  //
  // `=== false` so a row predating the column (null) still scores.
  if (jobRow.ai_cv_scoring_enabled === false) {
    await skip(SCORING_OFF_REASON);
    return;
  }

  const cvText = (app.cv_text ?? "").trim();
  if (cvText.length < MIN_CV_TEXT_CHARS) {
    await skip(
      `No usable CV text (${cvText.length} chars, minimum ${MIN_CV_TEXT_CHARS}). The CV may be an image-only PDF.`,
    );
    return;
  }

  // ── Score ──
  let card: Scorecard;
  try {
    card = await scoreCv({
      cvText,
      screeningAnswers,
      candidate: {
        yearsExperience: app.years_experience,
        city: app.city,
        country: app.country,
        noticePeriod: app.notice_period,
        availability: app.availability,
      },
      job: {
        title: jobRow.title ?? "Untitled role",
        description: jobRow.description,
        responsibilities: jobRow.responsibilities,
        requirements: jobRow.requirements,
        experienceLevel: jobRow.experience_level,
        category: jobRow.category,
        screeningQuestions: Array.isArray(jobRow.screening_questions)
          ? (jobRow.screening_questions as ScreeningQuestion[])
          : [],
      },
    });
  } catch (err) {
    if (err instanceof ScoringSkipped) {
      await skip(err.message);
      return;
    }
    // Record the failure so the UI can show it, then rethrow so the queue
    // applies backoff and eventually buries the job. NOT swallowed.
    const message = err instanceof Error ? err.message : String(err);
    await writeScoreRow({
      application_id: app.id,
      company_id: app.company_id_snapshot,
      job_id: app.job_id,
      status: "failed",
      error: message.slice(0, 1000),
      screening_score: computeScreeningScore(screeningAnswers),
      ai_model: resolveScoringModel(),
      prompt_version: PROMPT_VERSION,
      job_criteria_version: jobRow.criteria_version ?? 1,
    });
    throw err;
  }

  const { error: writeErr } = await writeScoreRow({
    application_id: app.id,
    company_id: app.company_id_snapshot,
    job_id: app.job_id,
    overall_score: card.overall_score,
    dimension_scores: card.dimension_scores,
    verdict: card.verdict,
    evidence: card.evidence,
    missing_requirements: card.missing_requirements,
    concerns: card.concerns,
    strengths: card.strengths,
    confidence: card.confidence,
    summary: card.summary,
    screening_score: card.screening_score,
    ai_model: card.ai_model,
    prompt_version: card.prompt_version,
    job_criteria_version: jobRow.criteria_version ?? 1,
    input_tokens: card.input_tokens,
    output_tokens: card.output_tokens,
    status: "scored",
    error: null,
    scored_at: new Date().toISOString(),
  });

  if (writeErr) throw new Error(`ai_cv_score: score write failed: ${writeErr}`);

  // Metering. Never throws — see src/lib/usage.ts.
  if (app.company_id_snapshot) {
    await recordUsage({
      companyId: app.company_id_snapshot,
      type: "cv_scored",
      refId: app.id,
    });
  }
}
