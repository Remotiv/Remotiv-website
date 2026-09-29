/**
 * Parsing the two scorers' JSON replies - the pure half of cv-scoring.ts and
 * interview-scoring.ts, in a module with no server imports so it can be
 * tested under bare Node.
 *
 * ── The rule this file exists to enforce ─────────────────────
 *
 * A number the model did not give is not zero. The earlier `clampScore`
 * turned `undefined`, `null`, `"87"`, NaN and Infinity into 0, and a reply
 * that lost `overall_score` to truncation was stored as a legitimate card
 * with status `scored` and a 0 in it - indistinguishable from "worst
 * candidate". Here every REQUIRED number is read with `readScore`, which
 * returns null for anything that is not a finite number in 0-100, and a null
 * required number fails the parse. The caller throws, the queue retries, and
 * the row lands on `failed` with the reason - the existing path for garbage,
 * now taken by all garbage.
 *
 * Out of range is malformed, not clamped: a model returning 150 has not
 * followed the schema, and rounding it to 100 would store a number it never
 * produced. A finite 87.4 rounds to 87.
 *
 * The four CV dimensions must each appear exactly once. Fewer, a duplicate,
 * or an unknown name all fail. Unknown TOP-LEVEL keys are ignored (the model
 * adding a field is harmless); unknown DIMENSION names are not, because the
 * arithmetic downstream assumes the fixed four.
 *
 * What is deliberately NOT here: any rule relating overall_score to the
 * dimension scores. The prompt asks for a holistic overall "not a mechanical
 * average", and only the weighted path (applyCvWeights) defines an exact
 * relation - which it enforces by construction. There is no product
 * arithmetic behind a tolerance, so none is invented; scoreCv logs large
 * divergence so the metric exists before anyone decides.
 */

export const SCORE_DIMENSIONS = [
  "requirements_match",
  "experience_depth",
  "domain_relevance",
  "responsibilities_fit",
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export type Confidence = "high" | "medium" | "low";

export type EvidenceItem = {
  /** What this quote supports: a dimension name, or "strength". */
  claim: string;
  /** Verbatim span from the source. Verified to actually appear before storage. */
  quote: string;
};

export type DimensionScore = {
  dimension: ScoreDimension;
  score: number;
  reasoning: string;
  /** The CV span supporting THIS dimension. Empty when none survived. */
  quote: string;
  /**
   * The job stated NOTHING for this dimension to be judged against.
   *
   * The four dimensions are fixed so scores stay comparable across jobs, and
   * the model must return all four — so when `requirements` is blank it is
   * still asked to score `requirements_match`, against a section that reads
   * "Requirements: (not specified)". Whatever number that produces is invented,
   * and before this flag existed it carried full `cv_weight_requirements`
   * weight into the overall.
   *
   * Absent means applicable, so every scorecard written before this flag keeps
   * its existing arithmetic rather than silently re-weighting.
   */
  unstated?: boolean;
};

/** A strength and the span that proves it — one object, never two arrays. */
export type Strength = {
  point: string;
  quote: string;
};

/**
 * Output caps, mirrored in the prompts as maximums.
 *
 * Enforced here as well as asked for there: the prompt is a request, the slice
 * is a guarantee. A model that returns eight strengths still produces a card a
 * recruiter can read.
 */
export const MAX_STRENGTHS = 4;
export const MAX_MISSING = 3;
export const MAX_CONCERNS = 3;
/** Verdict is a headline, not a sentence — clipped hard if it overruns. */
export const MAX_VERDICT_CHARS = 120;
/** Interview lists: at most four strengths, four concerns, four missing. */
export const MAX_LIST_ITEMS = 4;

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * A required score: a finite number in 0-100, rounded to an integer. Anything
 * else - missing, null, a numeric string, NaN, Infinity, out of range - is
 * null, and the caller decides that the reply is malformed.
 */
export function readScore(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 100) return null;
  return Math.round(v);
}

export function stringList(v: unknown, max: number, maxChars = 400): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, maxChars))
    .slice(0, max);
}

/**
 * A claim WITH the span that supports it — the interview scorer's shape.
 *
 * A bare string is still ACCEPTED, with an empty quote, so that a model which
 * regresses to the v1 shape produces claims the caller can count and drop
 * rather than an empty list it cannot explain. The evidence gate in
 * `scoreAnswer` is what decides an unquoted claim's fate; parsing does not.
 */
export function pairList(v: unknown, max = MAX_LIST_ITEMS): EvidenceItem[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceItem[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const claim = item.trim();
      if (claim) out.push({ claim, quote: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const e = item as { claim?: unknown; quote?: unknown };
    const claim = typeof e.claim === "string" ? e.claim.trim() : "";
    if (!claim) continue;
    out.push({
      claim,
      quote: typeof e.quote === "string" ? e.quote.trim() : "",
    });
  }
  return out.slice(0, max);
}

function parseObject(raw: string): ParseOutcome<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ── CV scorer ────────────────────────────────────────────────

export type RawScoreResponse = {
  verdict: string;
  overall_score: number;
  /** Exactly the four dimensions, in SCORE_DIMENSIONS order. */
  dimension_scores: DimensionScore[];
  strengths: Strength[];
  missing_requirements: string[];
  concerns: string[];
  confidence: Confidence;
  summary: string;
  /**
   * Carried RAW and resolved later, in scoreCv.
   *
   * Deciding a must-have's fate needs two things this parser does not have:
   * the CV text to verify a quote against, and the list the employer actually
   * named to reconcile against. Shaping it here would mean either a second,
   * weaker verification or throwing away the item before it can be judged —
   * the same reasoning that keeps parsing out of the strengths decision.
   */
  must_haves: unknown;
};

/**
 * Exactly the four dimensions, each once, each with a real score.
 *
 * Returned in canonical order so downstream arithmetic and the drawer never
 * depend on the order the model happened to emit.
 */
function readDimensions(v: unknown): ParseOutcome<DimensionScore[]> {
  if (!Array.isArray(v)) return { ok: false, reason: "dimension_scores: not an array" };

  const byName = new Map<ScoreDimension, DimensionScore>();
  for (const entry of v) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "dimension_scores: entry is not an object" };
    }
    const d = entry as Record<string, unknown>;
    const name = d.dimension;
    if (typeof name !== "string" || !(SCORE_DIMENSIONS as readonly string[]).includes(name)) {
      return { ok: false, reason: `dimension_scores: unknown dimension ${JSON.stringify(name)}` };
    }
    const dimension = name as ScoreDimension;
    if (byName.has(dimension)) {
      return { ok: false, reason: `dimension_scores: ${dimension} appears twice` };
    }
    const score = readScore(d.score);
    if (score === null) {
      return {
        ok: false,
        reason: `dimension_scores: ${dimension} has no valid score (${JSON.stringify(d.score)})`,
      };
    }
    byName.set(dimension, {
      dimension,
      score,
      reasoning: typeof d.reasoning === "string" ? d.reasoning.slice(0, 400) : "",
      quote: typeof d.quote === "string" ? d.quote.slice(0, 1000) : "",
    });
  }

  const missing = SCORE_DIMENSIONS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: `dimension_scores: missing ${missing.join(", ")}` };
  }
  return { ok: true, value: SCORE_DIMENSIONS.map((name) => byName.get(name) as DimensionScore) };
}

/**
 * Defensive parse of the CV scorer's reply. A malformed reply is REJECTED with
 * a reason rather than repaired into a card.
 */
export function parseScoreJson(raw: string): ParseOutcome<RawScoreResponse> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const parsed = obj.value;

  const overall = readScore(parsed.overall_score);
  if (overall === null) {
    return {
      ok: false,
      reason: `overall_score is not a number in 0-100 (${JSON.stringify(parsed.overall_score)})`,
    };
  }

  const dims = readDimensions(parsed.dimension_scores);
  if (!dims.ok) return dims;

  // Strengths are objects now. A v1 row (bare strings) still parses — the
  // quote is simply absent, and an unquoted strength is dropped by the caller.
  const strengths: Strength[] = Array.isArray(parsed.strengths)
    ? (parsed.strengths as unknown[])
        .map((item) => {
          if (typeof item === "string") return { point: item.trim(), quote: "" };
          const o = item as Record<string, unknown>;
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
    ok: true,
    value: {
      verdict:
        typeof parsed.verdict === "string" ? parsed.verdict.trim().slice(0, MAX_VERDICT_CHARS) : "",
      overall_score: overall,
      dimension_scores: dims.value,
      strengths,
      missing_requirements: stringList(parsed.missing_requirements, MAX_MISSING),
      concerns: stringList(parsed.concerns, MAX_CONCERNS),
      confidence,
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 1500) : "",
      must_haves: parsed.must_haves,
    },
  };
}

// ── Interview answer scorer ──────────────────────────────────

export type RawAnswerResponse = {
  score: number;
  confidence: Confidence;
  reasoning: string;
  strengths: EvidenceItem[];
  concerns: EvidenceItem[];
  missing: string[];
};

export function parseAnswerJson(raw: string): ParseOutcome<RawAnswerResponse> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const o = obj.value;

  const score = readScore(o.score);
  if (score === null) {
    return { ok: false, reason: `score is not a number in 0-100 (${JSON.stringify(o.score)})` };
  }

  const confidence: Confidence =
    o.confidence === "high" || o.confidence === "low" ? o.confidence : "medium";

  return {
    ok: true,
    value: {
      score,
      confidence,
      reasoning: typeof o.reasoning === "string" ? o.reasoning.trim() : "",
      strengths: pairList(o.strengths),
      concerns: pairList(o.concerns),
      missing: stringList(o.missing, MAX_LIST_ITEMS, Number.POSITIVE_INFINITY),
    },
  };
}
