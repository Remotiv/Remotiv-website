/**
 * Which version of the privacy notice an applicant was shown.
 *
 * The apply form links to /privacy; this is the date at the top of that page
 * (LAST_UPDATED in src/app/privacy/page.tsx) as an ISO date. /api/apply writes
 * it to job_applications.privacy_notice_version on insert, from this constant
 * and never from the client. A test pins it to LAST_UPDATED, so updating the
 * page without updating this fails. Rows from before versions were recorded
 * are NULL and stay NULL.
 *
 * 2026-11-06: the notice gained section 3's paragraph on the by-hand clearing
 * of message records after a company deletes an application (#72A). The
 * column records WHICH TEXT an applicant was shown, so it moves with the page;
 * leaving it at the old date would make it a false record of what someone
 * consented to. Safe to move: this value is written once at insert and read
 * nowhere, so nobody is re-prompted and no interview in progress is affected.
 * INTERVIEW_CONSENT_VERSION and LIVE_INTERVIEW_CONSENT_VERSION are separate
 * and untouched.
 *
 * 2026-11-10: section 1's "CVs and interview recordings" item changed from
 * "each view generates a short-lived link" to "served through the dashboard
 * for that one view only" (#99: the company CV route streams the document and
 * mints no signed URL). Same rule, same safety: written once at insert, read
 * nowhere.
 *
 * 2026-11-17: the notice now lists what it left out and says what really
 * removes it (#91). Section 1 gained the interview notes, final-interview
 * ratings and staff comments, team notifications, WhatsApp replies and what
 * Remotiv records when it puts someone forward to a client; its field list
 * says "where you give them" for city, country and experience. Section 3 says
 * the CV purge also deletes the AI's written assessment, verdict and CV quotes
 * and keeps the scores, keeps talent-search match explanations, and opens with
 * "no expiry date" instead of "until you ask us to remove it". Section 8 says
 * unsubscribe records are kept. Same rule, same safety: written once at
 * insert, read nowhere.
 *
 * 2026-11-25: WhatsApp is opt-in (#67). Section 1 says the apply form's
 * WhatsApp box is recorded with its time and that no tick means email only;
 * the Meta items say WhatsApp is used only for someone who asked for it, and
 * that STOP ends it. Same rule, same safety: written once at insert, read
 * nowhere.
 */
export const PRIVACY_NOTICE_VERSION = "2026-11-25";
