/**
 * Which version of the privacy notice an applicant was shown.
 *
 * The apply form links to /privacy; this is the date at the top of that page
 * (LAST_UPDATED in src/app/privacy/page.tsx) as an ISO date. /api/apply writes
 * it to job_applications.privacy_notice_version on insert, from this constant
 * and never from the client. A test pins it to LAST_UPDATED, so updating the
 * page without updating this fails. Rows from before versions were recorded
 * are NULL and stay NULL.
 */
export const PRIVACY_NOTICE_VERSION = "2026-10-25";
