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

/*
 * ── Saved consent, required on the server ────────────────────
 *
 * An async recording is accepted only once the candidate's agreement to the
 * CURRENT text is saved on their session: consent_at set and consent_version
 * equal to INTERVIEW_CONSENT_VERSION. upload-url (before anything is stored),
 * confirm and submit each refuse otherwise with CONSENT_REQUIRED, and the
 * candidate page answers that by showing the consent screen again, keeping
 * any answer it has not saved yet. A session that agreed to an older version
 * (or before versions were recorded) is asked again; agreeing writes the
 * current time and version.
 */

/** The code upload-url, confirm and submit refuse with when consent is not saved. */
export const CONSENT_REQUIRED = "consent_required";

/** The code the consent route answers with when the agreement could not be saved. */
export const CONSENT_NOT_SAVED = "consent_not_saved";

/** Shown by a page that does not know the code: plain, and true. */
export const CONSENT_REQUIRED_MESSAGE = "Please agree to the interview terms first.";

export const CONSENT_NOT_SAVED_MESSAGE = "We couldn't save your agreement. Please try again.";

/** Whether a session row carries a saved agreement to the current async text. */
export function asyncConsentGiven(row: {
  consent_at: string | null;
  consent_version?: string | null;
}): boolean {
  return row.consent_at !== null && row.consent_version === INTERVIEW_CONSENT_VERSION;
}
