/**
 * The fairness rules every AI prompt that scores or ranks a person carries
 * (#71). ONE source: each scoring prompt interpolates FAIRNESS_RULES, never a
 * copy (fairness.test.ts checks both). The CV score, the async interview answer
 * score and its summary, the live interview question score and the AI talent
 * matching rank.
 *
 * The last sentence keeps every stricter rule a prompt already has: the
 * interview scorers forbid grammar and fluency from affecting anything, with
 * no exception, and that still holds there.
 *
 * Changing this text changes every scorer's prompt: move each one's prompt
 * version with it (scoring-generations.ts records why). Existing scores are
 * never re-scored by a version change.
 */
export const FAIRNESS_RULES = `FAIRNESS - THIS BINDS EVERY SCORE, EVERY RANKING AND EVERY WORD YOU WRITE.
Score only on job-related evidence: skills, experience, qualifications, achievements, and the content of what the candidate said or wrote.
Never use or infer any of the following, never let any of them affect a score or a ranking, and never treat any of them as evidence: accent, pronunciation, grammar or fluency (unless the job's stated requirements, as given to you, name a language skill), appearance, voice, background or setting, age, gender, race, ethnicity, nationality, religion, disability, health, family or marital status, pregnancy, name, photo.
Where another rule in these instructions is stricter than this one, the stricter rule applies.`;

/**
 * The CV scorer's employment-gap rule (#71, Waleed's decision, 25 Nov 2026).
 * It replaces the old "unexplained multi-year gap" example of a concern.
 */
export const EMPLOYMENT_GAP_RULE =
  "Employment gaps must never reduce a candidate's score. The AI may mention a gap as a neutral observation but must not speculate about its cause or treat it as evidence of lower competence.";

/**
 * And where a gap may never appear (#71 follow-up): not in the CV card's
 * concerns ("Risks / points to verify") and not in its missing requirements.
 * A gap is neither a risk to check nor a requirement the CV failed to show.
 */
export const EMPLOYMENT_GAP_NOT_LISTED =
  "Never list an employment gap in concerns or in missing_requirements: a gap is not a risk to verify and not a missing requirement.";
