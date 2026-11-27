import type { CompanyJobInput } from "@/app/ai-dashboard/lib/job-types";

/**
 * The job wizard's draft button label (#62). It always saves the job On hold;
 * on a job that is Published as saved, that takes it off the job board, so
 * the label says so. A new job, and an On hold or Closed one, keep the plain
 * label.
 */
export const SAVE_DRAFT_LABEL = "Save draft";
export const SAVE_AS_DRAFT_LABEL = "Save as draft";
export const UNPUBLISH_AND_SAVE_AS_DRAFT_LABEL = "Unpublish and save as draft";

export function draftButtonLabel(
  isEdit: boolean,
  savedStatus: CompanyJobInput["status"] | undefined,
): string {
  if (!isEdit) return SAVE_DRAFT_LABEL;
  return savedStatus === "open" ? UNPUBLISH_AND_SAVE_AS_DRAFT_LABEL : SAVE_AS_DRAFT_LABEL;
}
