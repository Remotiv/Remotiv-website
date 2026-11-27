/**
 * Whether the job save accepts the AI Video Interview's own question list
 * (CompanyJobInput.live_interview_questions, interview_kind 'live', 082).
 *
 * ON since #58 commit 6, which ships the wizard step that edits that list
 * (step 6). It was off through commit 5 so that no live row could be created
 * before every reader and the save path told the two lists apart (commits
 * 3+4 and 5, in production first: the 082 deploy rule). Turning it off again
 * makes any save carrying a live list refuse before anything is written.
 */
export const LIVE_QUESTION_LIST_SAVE_ENABLED = true;

/** The refusal while it is off. */
export const LIVE_QUESTION_LIST_NOT_YET =
  "AI Video Interview questions can't be saved yet. Nothing was saved.";

/**
 * The save warnings when replace_interview_questions fails. The job's other
 * fields saved first; the function's one transaction kept both lists as they
 * were. An edit keeps its previous questions; a new job had none to keep.
 */
export const QUESTIONS_NOT_UPDATED =
  "The role saved, but its interview questions were not updated. Your previous questions are kept.";
export const QUESTIONS_NOT_SAVED =
  "The role saved, but its interview questions were not saved. Open the job to add them.";

/**
 * The same failure on a save that would have left the job Published (#61): a
 * job never stays live with missing or old questions, so it is set back to
 * On hold in the same request, and the message says so.
 */
export const PUBLISHED_QUESTIONS_NOT_SAVED =
  "The role saved as On hold, but its interview questions were not saved. Open the job to add them, then publish.";
/**
 * A new job meant to be Published: saved On hold with its questions, but the
 * final step that publishes it failed (#61, publish last). It stays On hold.
 */
export const NEW_JOB_NOT_PUBLISHED =
  "The role saved as On hold with its interview questions, but it could not be published. Open the job and publish it again.";
export const PUBLISHED_QUESTIONS_NOT_UPDATED =
  "The role saved, but its interview questions were not updated. Your previous questions are kept, and the job is now On hold.";

/**
 * With AI Video Interview on, the job must hold 4 to 8 live questions
 * (MIN_JOB_QUESTIONS..MAX_JOB_QUESTIONS, the range the live invite accepts).
 * Off, any number is kept, none included.
 */
export const LIVE_QUESTION_COUNT_REFUSAL =
  "AI Video Interview needs 4 to 8 questions. Add them on the AI Video Interview step, or turn AI Video Interview off to save without them.";
