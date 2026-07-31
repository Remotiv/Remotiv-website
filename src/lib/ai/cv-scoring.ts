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
 * Bump on ANY change to the prompt, the band definitions, or the dimension
 * set. Stored on every row as prompt_version, so a scorecard can always be
 * traced to the exact rubric that produced it — and so a re-score after a
 * prompt change is distinguishable from a re-score after a criteria change
 * (which is what job_criteria_version tracks).
 */
export const PROMPT_VERSION = "cv-scoring-v2";

/** Swappable without a deploy; the resolved value is stored on every row. */
export const DEFAULT_SCORING_MODEL = "claude-sonnet-4-5";

export function resolveScoringModel(): string {
  return process.env.AI_SCORING_MODEL?.trim() || DEFAULT_SCORING_MODEL;
}

/** Ceiling for the model's JSON reply. Generous — evidence quotes are verbose. */
const MAX_TOKENS = 3000;

/** Below this a CV carries too little text to score honestly. */
const MIN_CV_TEXT_CHARS = 200;

/** Hard cap on what we send. Long CVs are truncated, never rejected. */
const MAX_CV_TEXT_CHARS = 24_000;

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
 * Returns null when the job asked nothing, which is different from scoring 0.
 */
export function computeScreeningScore(
  answers: ScreeningAnswerSnapshot[],
): number | null {
  if (answers.length === 0) return null;

  let earned = 0;
  let possible = 0;
  for (const a of answers) {
    const weight = a.essential ? 2 : 1;
    possible += weight;
    if (a.matched) earned += weight;
  }
  if (possible === 0) return null;
  return Math.round((earned / possible) * 100);
}

/** Essential questions the candidate did not match, phrased for the employer. */
function unmatchedEssentials(answers: ScreeningAnswerSnapshot[]): string[] {
  return answers
    .filter((a) => a.essential && !a.matched)
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

const SYSTEM_PROMPT = `You are an experienced technical recruiter assessing ONE candidate's CV against ONE specific job description.

You judge against THAT JOB'S stated requirements and responsibilities — never against a generic idea of a good CV. A CV that is excellent for a different role scores low here if it does not match what this job asks for.

${BAND_DEFINITIONS}

EVIDENCE IS MANDATORY, AND IT MUST BE THE RIGHT EVIDENCE.
Every dimension score and every strength carries its own "quote" field. Two rules, and the second matters as much as the first:

1. VERBATIM. Copy the span EXACTLY, character for character, from the CV text you are given. Do not paraphrase, do not summarise, do not tidy up spelling or spacing inside a quote. A quote that is not literally present in the CV is discarded.

2. DIRECTLY RELEVANT. The quote must be the span that supports THAT SPECIFIC claim — the sentence a reader would point at to check it. A real quote from elsewhere in the CV is NOT partial credit; it is a failure, and worse than omitting the claim, because it makes an unsupported statement look verified.

Examples of rule 2 being broken — do not do this:
- Claim "currently employed at Acme since July 2024" with quote "Increased profits by 15,000 AED per month". The quote is real but it proves the profit figure, not the employment date. The correct quote names the employer and the date.
- Claim "built pipelines of 70+ companies" with quote "MBA in Marketing". Unrelated.
- Claim "multi-channel outreach using LinkedIn Sales Navigator" with quote "100% month on month growth". Unrelated.

If the CV genuinely contains no span that directly supports a claim, DROP THE CLAIM. Reporting four well-evidenced strengths is better than reporting eight with three mismatched quotes. An empty strengths array is an acceptable answer.

DIMENSIONS — score each 0-100 using the same bands:
- requirements_match     Against the job's stated requirements specifically.
- experience_depth       Is the depth and seniority consistent with the stated experience level?
- domain_relevance       Is their background in the same domain, industry, or technical area this role sits in?
- responsibilities_fit   Have they demonstrably done the things this job lists as responsibilities?

MISSING REQUIREMENTS — the most useful thing you produce. List the job's stated requirements for which the CV shows no supporting evidence. Be specific and concrete: "No Kubernetes or container orchestration experience mentioned" — never "lacks some technical skills". If every stated requirement has evidence, return an empty array.

CONCERNS — neutral factual observations a human reviewer should look at, such as an unexplained multi-year gap, a run of very short tenures, or a career change mid-CV. State them as observations only. NEVER recommend rejecting, advancing, or interviewing anyone. You do not make hiring decisions; you surface what the CV does and does not show.

CONFIDENCE — how much usable signal the CV actually contained, NOT how good the candidate is:
- high    A detailed CV with dates, employers, and concrete descriptions of work done.
- medium  Adequate detail, but thin in places, or the format made parts ambiguous.
- low     Sparse, very short, badly extracted, or largely a list of skills with no context.
A one-page CV listing only skills is low confidence even if those skills match perfectly.

SUMMARY — two or three sentences for the hiring manager. Factual, specific to this candidate and this job, no filler.

OUTPUT — return ONLY valid JSON. No prose before or after, no markdown, no code fences. Every claim carries its quote INSIDE the same object, so nothing has to be matched up by position. Exactly this shape:
{
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
  "concerns": ["<neutral observation>"],
  "confidence": "high" | "medium" | "low",
  "summary": "<2-3 sentences>"
}

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
          .map(
            (a) =>
              `- ${a.essential ? "[essential] " : ""}${a.question}\n  answered: ${
                a.answer_label || a.answer || "(no answer)"
              }\n  employer's ideal: ${a.ideal_label || a.ideal}\n  matched: ${a.matched ? "yes" : "no"}`,
          )
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

=== SCREENING ANSWERS (already scored — do not re-judge these, use them as context) ===
${screening}

=== CANDIDATE PROFILE (self-reported at apply time) ===
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

/** Models sometimes wrap or elide a quote; strip that before comparing. */
function trimQuoteArtifacts(quote: string): string {
  return quote
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\.{3}|…/g, "")
    .replace(/\.{3}$|…$/g, "")
    .trim();
}

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
    const needle = normalise(cleaned);
    // Very short quotes prove nothing — "React" appears in half of all CVs.
    if (needle.length < 8) {
      dropped.push(item);
      continue;
    }
    if (haystack.includes(needle)) {
      verified.push({ claim: item.claim, quote: cleaned });
    } else {
      dropped.push(item);
    }
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
          .slice(0, 12)
      : [];

    const conf = parsed.confidence;
    const confidence: Confidence =
      conf === "high" || conf === "medium" || conf === "low" ? conf : "low";

    return {
      overall_score: clampScore(parsed.overall_score),
      dimension_scores: dims,
      strengths,
      missing_requirements: stringList(parsed.missing_requirements),
      concerns: stringList(parsed.concerns),
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
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

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
    input_tokens: response.usage?.input_tokens ?? 0,
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
};

/** Upsert on the unique application_id so a retry overwrites rather than
 *  erroring on the constraint — the handler is safe to run repeatedly. */
async function writeScoreRow(
  row: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const service = createServiceClient();
  const { error } = await service
    .from("application_scores")
    .upsert(row, { onConflict: "application_id" });
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
      "id, title, description, responsibilities, requirements, experience_level, category, screening_questions, criteria_version",
    )
    .eq("id", app.job_id)
    .maybeSingle();

  if (jobErr) throw new Error(`ai_cv_score: job lookup failed: ${jobErr.message}`);
  const jobRow = jobData as JobRow | null;
  if (!jobRow) {
    await skip("The job this application targets no longer exists.");
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
