import type { CandidateLink } from "./review-types";

/*
 * Who an interview is with, as every review page names them: the interviews
 * list and review (review.ts) and the super admin's live review (F4,
 * live-review.ts). Pure, and kept apart so live-review.ts does not load the
 * whole of review.ts for one function.
 */

export type AppRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

/**
 * Resolve the candidate, and say WHY when there isn't one.
 *
 * Six of the seven sessions in this workspace carry no application_id at all —
 * they predate sendInterviewInvite, which requires an applicant. Those are
 * genuinely unlinked, not lost, and the row should say so rather than print a
 * placeholder name.
 */
export function resolveCandidate(
  applicationId: string | null,
  app: AppRow | undefined,
): { name: string; email: string; link: CandidateLink } {
  if (!applicationId) {
    return { name: "No applicant linked", email: "", link: "unlinked" };
  }
  if (!app) {
    return { name: "Applicant deleted", email: "", link: "deleted" };
  }
  const name = [app.first_name, app.last_name].filter(Boolean).join(" ").trim();
  return {
    name: name || app.email || "Unnamed applicant",
    email: app.email ?? "",
    link: "linked",
  };
}
