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
 */
export const PRIVACY_NOTICE_VERSION = "2026-11-06";
