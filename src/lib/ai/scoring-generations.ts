/**
 * Which prompt versions share scoring SEMANTICS.
 *
 * ── Two different questions, two different keys ──────────────
 *
 * PROMPT_VERSION answers "which exact rubric text and sampling produced this
 * row?" It moves for any change to the prompt - including a change that alters
 * no number, such as de-gendering the summary (cv v11) or telling the model
 * that candidate text is data, not instructions (cv v12, interview v7). That
 * is the right key for a calibration set, where pooling two generation
 * processes is unrecoverable.
 *
 * It is the WRONG key for "should a recruiter read this card's number
 * differently from a fresh one?" A badge that compared PROMPT_VERSION would
 * light up every card in the system the day an isolation paragraph shipped,
 * and would teach recruiters that the badge means nothing.
 *
 * So each version is assigned a GENERATION, and a generation changes only when
 * the scoring semantics do: the bands, the dimensions, what counts as
 * evidence, or the sampling. Additive reporting fields, prose rules and
 * instruction hardening stay in the same generation. Every entry carries the
 * reason, so the next bump is a one-line decision made in the open.
 *
 * Historical cards are classified retroactively from their stored
 * prompt_version. Nothing here needs a schema change. Nothing reads this yet;
 * it is the groundwork for the "scored under an earlier rubric" badge
 * (Phase 4, AI-9), so that badge is built on the right key from the start.
 */

export type GenerationEntry = { generation: number; reason: string };

export const CV_SCORING_GENERATIONS: Record<string, GenerationEntry> = {
  "cv-scoring-v1": { generation: 1, reason: "first rubric" },
  "cv-scoring-v2": { generation: 1, reason: "wording" },
  "cv-scoring-v3": { generation: 1, reason: "wording" },
  "cv-scoring-v4": { generation: 1, reason: "verdict added - additive field" },
  "cv-scoring-v5": { generation: 1, reason: "wording" },
  "cv-scoring-v6": { generation: 1, reason: "wording" },
  "cv-scoring-v7": {
    generation: 2,
    reason: "temperature 0 - sampling changed, numbers became repeatable",
  },
  "cv-scoring-v8": { generation: 2, reason: "wording" },
  "cv-scoring-v9": { generation: 2, reason: "wording" },
  "cv-scoring-v10": {
    generation: 2,
    reason: "must-have reporting - additive, explicitly not a gate",
  },
  "cv-scoring-v11": {
    generation: 2,
    reason: "summary rewritten, de-gendered - prose, no number moves",
  },
  "cv-scoring-v12": {
    generation: 2,
    reason: "instruction isolation - candidate text declared data",
  },
};

export const INTERVIEW_SCORING_GENERATIONS: Record<string, GenerationEntry> = {
  "interview-scoring-v1": { generation: 1, reason: "first rubric" },
  "interview-scoring-v2": {
    generation: 1,
    reason: "claims carry their own quotes - shape, not bands",
  },
  "interview-scoring-v3": { generation: 1, reason: "wording" },
  "interview-scoring-v4": { generation: 1, reason: "wording" },
  "interview-scoring-v5": { generation: 1, reason: "criteria reporting - additive" },
  "interview-scoring-v6": { generation: 1, reason: "quote length rule and speech rules - wording" },
  "interview-scoring-v7": {
    generation: 1,
    reason: "instruction isolation - candidate text declared data",
  },
  "interview-scoring-v8": {
    generation: 1,
    reason:
      "rollup told how many answers it has and which it has not - summary shape, no number moves",
  },
};

/** The generation a stored prompt_version belongs to, or null for a version this map has never heard of. */
export function scoringGeneration(
  map: Record<string, GenerationEntry>,
  promptVersion: string | null | undefined,
): number | null {
  if (!promptVersion) return null;
  return map[promptVersion]?.generation ?? null;
}
