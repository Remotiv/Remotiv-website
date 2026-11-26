/**
 * Whether the job save accepts the AI Video Interview's own question list
 * (CompanyJobInput.live_interview_questions, interview_kind 'live', 082).
 *
 * OFF until #58 commit 6 ships the wizard step that edits that list. Every
 * reader and the save path already tell the two lists apart (commits 3+4, 5),
 * but no screen sends a live list yet, so a request that carries one is
 * hand-built or premature: the save refuses it before anything is written,
 * and no live row can be created through the job actions.
 *
 * Commit 6 turns this on in the same commit as the step that sends the list,
 * after the readers and the save path are in production (the 082 deploy rule).
 */
export const LIVE_QUESTION_LIST_SAVE_ENABLED = false;

/** The refusal while it is off. */
export const LIVE_QUESTION_LIST_NOT_YET =
  "AI Video Interview questions can't be saved yet. Nothing was saved.";

/** The save warning when replace_interview_questions fails: the job's other fields saved first. */
export const QUESTIONS_NOT_UPDATED =
  "The role saved, but its interview questions were not updated. Your previous questions are kept.";
