/**
 * Which version of the interview consent text a candidate agreed to.
 *
 * The consent screen (src/app/interview/[token]/_flow.tsx) names who
 * processes the interview. When that sentence changes, the version here moves
 * with it, and the consent endpoint writes the version next to consent_at
 * (interview_sessions.consent_version), so a stored consent can be read back
 * against the words that were on screen. Rows from before versions were
 * recorded are NULL and stay NULL.
 *
 *   v1  "Transcribing is done for us by OpenAI, and any AI scoring by
 *       Anthropic." - before 16 Oct 2026.
 *   v2  "Transcribing is done for us by OpenAI, and any AI scoring by OpenAI
 *       or Anthropic." - commit 74a82d4, 16 Oct 2026.
 *
 * The sentence is kept here as well as in the flow so a test can pin the two
 * together: change the wording, bump the version, or the test fails.
 */
export const INTERVIEW_CONSENT_VERSION = "v2";

/** The processor sentence the current version stands for, as rendered on the consent screen. */
export const INTERVIEW_CONSENT_SENTENCE =
  "Transcribing is done for us by OpenAI, and any AI scoring by OpenAI or Anthropic.";
