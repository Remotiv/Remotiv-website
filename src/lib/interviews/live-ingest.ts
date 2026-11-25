import "server-only";
import { createHash } from "node:crypto";
import { retentionPassed } from "@/lib/interviews/async-score-purge";
import {
  type FrozenLiveQuestionSet,
  type LiveQuestionSource,
  readFrozenQuestionSet,
} from "@/lib/interviews/frozen-questions";
import { stampLiveEnded } from "@/lib/interviews/live-events";
import {
  type ExportStatusCode,
  FOLLOW_UP_INDEX_MAX,
  type Interruption,
  type LiveTurn,
  type ParsedExport,
  type TurnAudio,
} from "@/lib/interviews/live-provider/types";
import type { TranscriptionRequest } from "@/lib/interviews/live-transcribe";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import {
  DEFAULT_SESSION_SECONDS,
  MAX_FOLLOW_UPS_PER_BASE_QUESTION,
  MAX_SESSION_SECONDS,
  readLiveSettings,
} from "@/lib/interviews/types";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Save an AI Video Interview's parsed export (live-provider/parse-export.ts):
 * its turns into interview_turns, with their audio in storage, and the facts
 * and outcome into interview_sessions.live_outcome (migration 041).
 *
 * ── The frozen questions are the source of truth ─────────────
 *
 * Every turn must name a position of the session's frozen set
 * (frozen-questions.ts). A base question not asked as frozen (an unexpected
 * phrase before it, or altered wording) is flagged on its question
 * (wording_check), not refused: what the candidate was asked is kept as
 * spoken, and the question is held from scoring until a person checks the
 * recording (F12, 23 Oct 2026). classifyAsked sets aside only the approved
 * harmless differences.
 *
 * ── Order, and what each step guarantees ─────────────────────
 *
 *   1. Every check, and the whole outcome, is worked out before anything is
 *      written. A refused export writes nothing.
 *   2. Each turn's audio is fetched from the provider and checked (present,
 *      non-empty, an accepted type, inside the size cap) before any upload.
 *   3. Audio is uploaded to {sessionId}/t{sequence}.{exportHash16}.{ext}. The
 *      export's hash is in the FILE NAME, so two different exports can never
 *      write the same file, and a retry of the same export writes the same
 *      paths with the same bytes. Not a {exportHash16}/ subfolder: migration
 *      021's media_path check is {sessionId}/t{sequence}.*, and the purge lists
 *      a session's folder without descending into subfolders.
 *   4. EVERY turn in ONE insert statement: Postgres applies all of it or none
 *      of it, rows answering rows in the same statement included, and the
 *      unique keys on (session, sequence) and (session, provider turn id) make
 *      it the one place a race is decided. Row ids are derived from (session,
 *      provider turn id). Before the outcome is written, the stored turns must
 *      be this export's (same rows, hashes and paths); a save that lost, or
 *      found another export's turns, is refused, and its uploaded files are
 *      referenced by nothing: the orphan sweep (purge.ts) removes them after
 *      its 24-hour grace.
 *   5. live_outcome, once: a conditional update that lands only while it is
 *      still null. A second save of the same export finds it and returns it; a
 *      different export for the same session is refused, never written over.
 *      A crash between 4 and 5 leaves turns without an outcome; saving the
 *      export again finds the turns already there and writes the outcome.
 *
 * ── Facts and outcome (decision D2, 19 Oct 2026) ─────────────
 *
 * Per question, kept separately: answered (the candidate spoke on it: any
 * captured speech, of any length; "Yes, three years" counts), skipped (asked,
 * nothing captured) or not_reached (never asked). An answer is saved
 * `confirmed: false`: only the transcript can tell real words from a cough,
 * and confirmAnswer below is where the transcription commit settles it.
 * Follow-ups per question; procedural turns (silence reminders, marked
 * repeats, offers to skip) never count, and a marked repeat adds no question.
 *
 * A marked repeat that does not ask the frozen question as agreed (an
 * unexpected phrase before it, or altered wording) is kept, flagged on its
 * question (repeat_check) and holds that question from scoring until a person
 * checks the recording (decision, 23 Oct 2026). It never refuses the export.
 * The outcome comes from HOW the interview ended, never from how many
 * questions were asked (D2, revised 22 Oct 2026):
 *
 *   completed           the provider reports a normal close by Sarah
 *                       ("completed"), however many were answered; no
 *                       restart. If she closed before asking every question
 *                       it is still completed, flagged closed_early and held
 *                       from ranking (held_from_ranking)
 *   technical_failure   provider_error with an answer lost: some candidate
 *                       transcript not done (failed, even if a person left
 *                       it out); a restart is allowed regardless of attempt
 *   partial             a CONFIRMED candidate exit (CONFIRMED_EXIT_CODES)
 *                       with 4-7 of 8 answered
 *   abandoned           a confirmed exit with 0-3 of 8 answered; a restart
 *                       is allowed once (first attempt only)
 *   ending_unconfirmed  everything else, flagged for a person: the candidate
 *                       left while D10 is unconfirmed, or after answering
 *                       every question; a time limit; an unknown or missing
 *                       status; provider_error with every answer usable; the
 *                       provider's "disconnected" (F15b: terminal, never
 *                       completed, its own end_check reason).
 *                       Scored like partial, never ranked against completed,
 *                       never treated as abandonment; the restart is a
 *                       person's decision (restart_allowed null,
 *                       restart_needs_person true)
 *
 * "Every answer usable": every candidate turn's audio is stored (the save
 * refuses an export without it), every candidate transcript is done, the
 * outcome is final, and no interruption's candidate speech is missing from
 * the export (F15): speech that was never exported is never counted as
 * captured.
 *
 * Nothing here is a score. For the scoring commit: not_reached gets no score
 * (not zero), skipped gets that question's lowest score, a partial interview
 * is never ranked against completed ones, and an answer on a
 * timing_suspect turn is NOT scored automatically until it is checked
 * against the audio.
 *
 * Completed needs the provider's end_reason "completed" AND completed_gracefully
 * true (parse-export.ts, F15); both are kept on the outcome for reviewers.
 *
 * ── Interruptions (F15, 26 Oct 2026) ─────────────────────────
 *
 * The parser places each interruption line (parse-export.ts); the outcome
 * keeps them all. One that could not be placed cleanly (`ambiguity`), or whose
 * candidate speech is not in the export, is flagged on its question
 * (interruption_check) and in interruption_check_turns, and needs a person.
 * A marked repeat right after an interruption line is checked with the line
 * in front of it, so "Let me just finish the question." then the frozen
 * question is a known lead-in, and any other line is an unexpected lead-in
 * (F11), held for a person.
 *
 * ── Timing ───────────────────────────────────────────────────
 *
 * A candidate turn that starts before the interviewer turn before it has
 * ended is only expected when that interviewer turn is marked interrupted.
 * Without the mark the turn is listed in timing_suspect_turns and its offsets
 * should not be trusted (for example to seek the video); nothing is refused.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Interviewer text, follow-up reasons, file names. Logs carry ids and counts.
 */

type Service = ReturnType<typeof createServiceClient>;

/**
 * 7: follow_up_check and follow_up_check_turns (#48, 25 Nov).
 * 8: time_limit_check and time_limit_check_turns (#50); import_failure (#51).
 * 9: order_check and order_check_turns (#15); moved_on_after, not_answered_turns,
 *    repeat_offer_turns and offer_reply_turns (#16, F15c). 26 Nov.
 */
export const LIVE_OUTCOME_VERSION = 9;
/** One turn's audio, at most: Whisper's limit, and far above a spoken turn. */
export const MAX_TURN_AUDIO_BYTES = 25 * 1024 * 1024;

/** The audio types the interview bucket accepts (migration 041), by file extension. */
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  webm: "audio/webm",
  mp3: "audio/mpeg",
};
const ACCEPTED_AUDIO: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/mpeg",
]);

export type QuestionStatus = "answered" | "skipped" | "not_reached";
export type LiveOutcomeCode =
  | "completed"
  | "partial"
  | "abandoned"
  | "technical_failure"
  | "ending_unconfirmed";

/**
 * End statuses the provider has CONFIRMED (decision D10) to mean the candidate
 * chose to leave. Empty until Arham confirms them: until then a candidate exit
 * is ending_unconfirmed, never partial or abandoned. Partial and abandoned
 * switch on per status by adding it here.
 */
export const CONFIRMED_EXIT_CODES: ReadonlySet<ExportStatusCode> = new Set<ExportStatusCode>();

/** Why an ending needs a person. */
export type EndCheckReason =
  /** Completed, but Sarah closed before asking every question. */
  | "closed_early"
  /** The provider says the candidate ended it; not a confirmed exit yet (D10). */
  | "exit_unconfirmed"
  /** A confirmed exit, but after answering every question. */
  | "left_after_last_answer"
  /** A time limit, an unknown or a missing end status. */
  | "ending_unknown"
  /** The provider reports the connection dropped (F15b): terminal, never completed. */
  | "disconnected"
  /** provider_error, but every answer was saved. */
  | "provider_error_saved";

export type EndCheck = { reason: EndCheckReason; never_asked: number };

/**
 * Why a marked repeat of a question needs a person (decision, 23 Oct 2026).
 * Either holds the question from scoring until a person resolves it.
 */
export type RepeatCheck =
  /** An unknown phrase, then the frozen question exactly. */
  | "unexpected_lead_in"
  /** Anything else: changed, shortened or extended wording, a long lead-in, or no question. */
  | "altered_wording";

/**
 * Why the FIRST asking of a question (its base_question turn) needs a person
 * (F12, 23 Oct 2026). Either holds the question from scoring until a person
 * resolves it (resolve_wording_check), independently of every other check.
 */
export type WordingCheck =
  /** An unknown phrase, then the frozen question exactly. */
  | "unexpected_lead_in"
  /** Anything else: changed, shortened or extended wording, a long lead-in, or no question. */
  | "altered_wording"
  /**
   * LEGACY, never written since outcome v7: the follow-up limit was briefly a
   * wording check value. It is its own check now (FollowUpCheck), so that a
   * question held for both reasons shows both and needs both decisions. Kept
   * so that any outcome saved in between still reads and renders.
   */
  | "follow_up_over_limit";

/**
 * Why a question's follow-ups need a person (#48, 25 Nov): more than the
 * session's frozen limit (0 for Recruiter-Defined, 2 for AI-Guided). Every
 * turn is kept, audio included; the question is held from scoring until a
 * person resolves it (resolve_follow_up_check), independently of every other
 * check: one decision never clears another.
 */
export type FollowUpCheck = "over_limit";

/**
 * Why a question needs a person because of the time limit (#50, 25 Nov):
 *
 *   after_limit       a turn of it starts after the session's frozen length
 *                     (max_session_seconds), or starts before it and ends
 *                     after it (spans the deadline), measured from the conversation's
 *                     start on Remotiv's own server-recorded clock
 *                     (interview_sessions.started_at) where there is one, the
 *                     provider's otherwise.
 *   clocks_disagree   the provider's start and Remotiv's are more than
 *                     CLOCK_TOLERANCE_MS apart, and on either clock a turn of
 *                     the question would be after the limit: neither is
 *                     trusted, a person decides.
 *
 * Every turn is kept, audio included; the question is held from scoring until
 * a person resolves it (resolve_time_limit_check, migration 078),
 * independently of every other check.
 */
export type TimeLimitCheck = "after_limit" | "clocks_disagree";

/**
 * Why a question needs a person because of the order it was asked in (#15,
 * Waleed's decision 26 Nov: flag and hold, never refuse). The frozen
 * question set's positions are the agreed order: Q1, its follow-ups, then Q2.
 *
 *   asked_twice          a second, unmarked base_question for a position
 *                        already asked (a marked repeat is not one)
 *   out_of_order         asked before a question with an earlier position
 *                        that was asked later: both questions are held
 *   follow_up_elsewhere  a follow-up on a question other than the one being
 *                        asked: both questions are held
 *   answer_elsewhere     a candidate answer for a question other than the one
 *                        being asked (an answer after Sarah moved on): both
 *   skipped_question     a question passed over in the middle: never asked,
 *                        and no not_answered for it, before a later one was
 *                        asked. That question and the one asked after it
 *   answer_before_not_answered
 *                        candidate speech on the question BEFORE Sarah's
 *                        not_answered for it: the speech is kept and counted
 *                        as the answer, and the question waits for a person
 *                        rather than being scored as skipped
 *
 * Every turn is kept, audio included, and nothing is refused. The question is
 * held from scoring until a person resolves it (resolve_order_check,
 * migration 081), independently of every other check. Questions never reached
 * at the end are not an order problem.
 */
export type OrderCheck =
  | "asked_twice"
  | "out_of_order"
  | "skipped_question"
  | "answer_before_not_answered"
  | "follow_up_elsewhere"
  | "answer_elsewhere";

/** The reason shown when one question has more than one: the first that applies. */
const ORDER_RANK: Record<OrderCheck, number> = {
  asked_twice: 0,
  out_of_order: 1,
  skipped_question: 2,
  answer_before_not_answered: 3,
  follow_up_elsewhere: 4,
  answer_elsewhere: 5,
};

/** How far apart the provider's conversation start and Remotiv's may be before neither is trusted. */
export const CLOCK_TOLERANCE_MS = 10_000;

/** The session's frozen length and Remotiv's own start, for the time-limit check. */
export type ExportTiming = {
  /** live_settings.max_session_seconds, in milliseconds. */
  limitMs: number;
  /** interview_sessions.started_at, written by the start route with the server's clock. */
  ourStartedAtMs: number | null;
};

/**
 * Why an interruption on a question needs a person (F15, 26 Oct 2026).
 * Flagged for review; it does not hold the question from scoring.
 */
export type InterruptionCheck =
  /** The interruption line could not be placed cleanly (Interruption.ambiguity). */
  | "ambiguous"
  /** What the candidate said while cutting in is not in the export. */
  | "speech_missing";

export type LiveQuestionFacts = {
  position: number;
  source: LiveQuestionSource;
  status: QuestionStatus;
  /**
   * For an answered question: false until the transcript confirms real words
   * (confirmAnswer). Null for skipped and not_reached.
   */
  confirmed: boolean | null;
  follow_ups: number;
  /** Marked repeats of the question (procedural): never follow-ups, never extra questions. */
  repeats: number;
  /** The candidate's speech on this question, all turns. */
  answer_ms: number;
  /**
   * The base question was not asked as frozen: null when it was, or when it
   * was never asked. Holds the question from scoring until resolved
   * (resolve_wording_check), independently of the timing, repeat and style
   * checks. Absent on an outcome saved before version 4: read as null.
   */
  wording_check: WordingCheck | null;
  /**
   * A candidate turn of this question is timing_suspect: its offsets are not
   * trusted. For the scoring commit: not scored automatically until checked
   * against the audio.
   */
  needs_check: boolean;
  /**
   * A marked repeat of this question needs a person: null when every repeat
   * asked it as agreed. Holds the question from scoring until resolved
   * (resolve_repeat_check), independently of the timing and style checks.
   * Absent on an outcome saved before version 3: read as null.
   */
  repeat_check: RepeatCheck | null;
  /**
   * An interruption on this question needs a person: null when there was none
   * or it placed cleanly with the candidate's speech exported. Absent on an
   * outcome saved before version 5: read as null.
   */
  interruption_check: InterruptionCheck | null;
  /**
   * More follow-ups than the session allows. Holds the question from scoring
   * until resolved (resolve_follow_up_check). Absent before outcome v7: null.
   */
  follow_up_check?: FollowUpCheck | null;
  /**
   * A turn after the time limit, or clocks that disagree near it. Holds the
   * question until resolved (resolve_time_limit_check). Absent before v8: null.
   */
  time_limit_check?: TimeLimitCheck | null;
  /**
   * Asked out of the frozen order, twice, or with a follow-up or an answer
   * out of place (#15). Holds the question until resolved
   * (resolve_order_check). Absent before v9: null.
   */
  order_check?: OrderCheck | null;
  /**
   * The sequence of Sarah's last not_answered turn on this question (F15c):
   * only candidate turns after it count as its answer. Null when there was
   * none. Absent before v9: null.
   */
  moved_on_after?: number | null;
};

export type LiveOutcome = {
  v: typeof LIVE_OUTCOME_VERSION;
  saved_at: string;
  export_hash: string;
  provider_session_id: string;
  provider_status: string | null;
  provider_status_code: ExportStatusCode;
  /** The provider's end_reason, as sent. Absent before version 5. */
  provider_end_reason: string | null;
  /** The provider's completed_gracefully, as sent; null when absent. Absent before version 5. */
  completed_gracefully: boolean | null;
  /**
   * Every candidate turn's audio stored and transcript done, no interruption's
   * candidate speech missing, and the outcome final.
   */
  answers_usable: boolean;
  turn_count: number;
  questions: LiveQuestionFacts[];
  timing_suspect: boolean;
  /** Sequences of candidate turns whose offsets should not be trusted. */
  timing_suspect_turns: number[];
  /**
   * Sequences of base_question turns that did not ask their question as
   * frozen, and of follow-ups past the session's follow-up limit.
   */
  wording_check_turns: number[];
  /** Sequences of follow-ups past the session's limit. Absent before outcome v7. */
  follow_up_check_turns?: number[];
  /** Sequences of turns placed after the limit, or near it on disagreeing clocks. Absent before v8. */
  time_limit_check_turns?: number[];
  /** Sequences of the turns that broke the frozen order (#15). Absent before v9. */
  order_check_turns?: number[];
  /** Sequences of interviewer not_answered turns (F15c), kept for the record. Absent before v9. */
  not_answered_turns?: number[];
  /** Sequences of interviewer repeat_offer turns (F15c), kept for the record. Absent before v9. */
  repeat_offer_turns?: number[];
  /**
   * Sequences of candidate turns that reply to a repeat_offer (F15c): kept,
   * transcribed, never an answer, never counted or scored. Absent before v9.
   */
  offer_reply_turns?: number[];
  /** Sequences of marked repeats that did not ask their question as agreed. */
  repeat_check_turns: number[];
  /** Every interruption line, placed (parse-export.ts). Absent before version 5. */
  interruptions: Interruption[];
  /** Sequences of interruption lines that need a person. Absent before version 5. */
  interruption_check_turns: number[];
  /**
   * Sequences of candidate turns that are interruption speech (turn_type
   * "interruption", F15b): kept with their audio and transcribed, shown on the
   * review page, never an answer, never counted, never scored. Absent before
   * version 6: read as none.
   */
  interruption_speech_turns: number[];
  outcome: LiveOutcomeCode;
  /** Why the ending needs a person, or null when it does not. */
  end_check: EndCheck | null;
  /** Completed with questions never asked: never ranked with fully completed interviews. */
  held_from_ranking: boolean;
  /** ending_unconfirmed: the restart is a person's decision, never automatic. */
  restart_needs_person: boolean;
  /**
   * False while any candidate turn is not yet transcribed and settled
   * (live-transcribe.ts). A non-final outcome is NOT DECIDED: restart
   * eligibility is null and nothing may be scored from it.
   */
  final: boolean;
  /** Null while the outcome is not final: not decided yet. */
  restart_allowed: boolean | null;
  /**
   * A person must look: the ending needs a check, a question needs_check
   * (timing suspect), a repeat_check or a wording_check, an interruption
   * needs a check, or a candidate turn's transcription failed for good. See
   * needsReview().
   */
  needs_review: boolean;
  /** Sequences of candidate turns whose transcription failed after every retry. */
  transcription_failed_turns: number[];
  /** Bumped on every settle; the compare-and-set that keeps a stale settle from writing. */
  settle_rev: number;
  answered_count: number;
  skipped_count: number;
  not_reached_count: number;
  total: number;
  completion_percent: number;
  /**
   * Set only on the technical failure recorded for an export refused as
   * broken (#51, live-import.ts): why (a reason code, never the provider's
   * text) and where the raw export is kept as evidence. A later good export of
   * the same session replaces this outcome; nothing else ever does.
   */
  import_failure?: ImportFailure;
  /** The failure's time, top level so the replacing write can match it exactly. */
  import_failed_at?: string;
};

/** Why an export was refused as broken, and its evidence (#51). */
export type ImportFailure = {
  code: string;
  /** The COMPLETE raw export, in the session's private folder; null when it was not kept. */
  evidence_path: string | null;
  /**
   * Why no evidence was kept, as a reason code; null when it was. Never a
   * partial copy: an export is kept whole or not at all.
   */
  evidence_not_retained: EvidenceNotRetained | null;
  at: string;
};

/**
 * Why a refused export's evidence was not kept (#51): too large for the cap,
 * the upload failed, or the export could not even be turned into text.
 */
export type EvidenceNotRetained = "too_large" | "storage_failed" | "unserialisable";

/** Whether a stored outcome is the record of a refused export, not of an interview. */
export function isImportFailure(outcome: unknown): outcome is LiveOutcome & {
  import_failure: ImportFailure;
  import_failed_at: string;
} {
  const o = outcome as Partial<LiveOutcome> | null;
  return Boolean(o?.import_failure) && typeof o?.import_failed_at === "string";
}

type OutcomeFields = Pick<
  LiveOutcome,
  | "outcome"
  | "end_check"
  | "held_from_ranking"
  | "restart_needs_person"
  | "final"
  | "restart_allowed"
  | "answered_count"
  | "skipped_count"
  | "not_reached_count"
  | "total"
  | "completion_percent"
>;

/**
 * The outcome of how the interview ended and the questions' statuses
 * (decision D2, revised): see the table at the top. `final` says whether every
 * answer is settled; until it is, restart eligibility is null. `answersUsable`
 * is only ever true for a final outcome. `completedGracefully` is the
 * provider's completed_gracefully: a "completed" status with questions never
 * asked is Completed only when Sarah closed the interview normally (true);
 * otherwise a person confirms the ending (#50, 25 Nov). Pure.
 */
export function outcomeFrom(
  questions: readonly Pick<LiveQuestionFacts, "status">[],
  providerStatus: ExportStatusCode,
  attempt: number,
  final: boolean,
  answersUsable: boolean,
  exitCodes: ReadonlySet<ExportStatusCode> = CONFIRMED_EXIT_CODES,
  completedGracefully: boolean | null = true,
): OutcomeFields {
  const total = questions.length;
  const answered = questions.filter((q) => q.status === "answered").length;
  const skipped = questions.filter((q) => q.status === "skipped").length;
  const notReached = questions.filter((q) => q.status === "not_reached").length;
  const { outcome, endCheck } = endingOf(
    providerStatus,
    answered,
    total,
    notReached,
    final && answersUsable,
    exitCodes,
    completedGracefully,
  );
  return {
    outcome,
    end_check: endCheck,
    held_from_ranking: outcome === "completed" && notReached > 0,
    restart_needs_person: final && outcome === "ending_unconfirmed",
    final,
    restart_allowed: restartAllowed(outcome, final, attempt),
    answered_count: answered,
    skipped_count: skipped,
    not_reached_count: notReached,
    total,
    completion_percent: total === 0 ? 0 : Math.round((answered / total) * 100),
  };
}

function endingOf(
  status: ExportStatusCode,
  answered: number,
  total: number,
  notReached: number,
  usable: boolean,
  exitCodes: ReadonlySet<ExportStatusCode>,
  completedGracefully: boolean | null,
): { outcome: LiveOutcomeCode; endCheck: EndCheck | null } {
  const check = (reason: EndCheckReason) => ({ reason, never_asked: notReached });
  if (status === "completed") {
    // Questions never asked and no normal close (a hard stop at the limit, a
    // time-out): never Completed. A person confirms how it ended.
    if (notReached > 0 && completedGracefully !== true) {
      return { outcome: "ending_unconfirmed", endCheck: check("closed_early") };
    }
    return { outcome: "completed", endCheck: notReached > 0 ? check("closed_early") : null };
  }
  if (status === "provider_error") {
    return usable
      ? { outcome: "ending_unconfirmed", endCheck: check("provider_error_saved") }
      : { outcome: "technical_failure", endCheck: null };
  }
  // The provider's confirmed word for a dropped connection: an ending, but never a completed one.
  if (status === "disconnected") {
    return { outcome: "ending_unconfirmed", endCheck: check("disconnected") };
  }
  if (exitCodes.has(status)) {
    if (answered === total) {
      return { outcome: "ending_unconfirmed", endCheck: check("left_after_last_answer") };
    }
    return { outcome: answered >= Math.ceil(total / 2) ? "partial" : "abandoned", endCheck: null };
  }
  if (status === "candidate_ended") {
    return { outcome: "ending_unconfirmed", endCheck: check("exit_unconfirmed") };
  }
  return { outcome: "ending_unconfirmed", endCheck: check("ending_unknown") };
}

/** Null until final, and null for ending_unconfirmed: that restart is a person's decision. */
function restartAllowed(outcome: LiveOutcomeCode, final: boolean, attempt: number): boolean | null {
  if (!final || outcome === "ending_unconfirmed") return null;
  if (outcome === "technical_failure") return true;
  return outcome === "abandoned" && attempt === 1;
}

/**
 * Whether the session needs a person: the ending needs a check, any question
 * needs_check or has a repeat_check, a wording_check or a follow_up_check, any interruption line
 * needs a check, or any turn failed transcription. The
 * per-question flags, the failed list and the end check stay as they are; this
 * is the session-level summary of all of them.
 */
export function needsReview(
  questions: readonly (Pick<LiveQuestionFacts, "needs_check"> &
    Partial<
      Pick<
        LiveQuestionFacts,
        "repeat_check" | "wording_check" | "follow_up_check" | "time_limit_check" | "order_check"
      >
    >)[],
  failedTurns: readonly number[],
  endCheck: EndCheck | null,
  interruptionCheckTurns: readonly number[] = [],
): boolean {
  return (
    endCheck !== null ||
    failedTurns.length > 0 ||
    interruptionCheckTurns.length > 0 ||
    questions.some(
      (q) =>
        q.needs_check ||
        (q.repeat_check ?? null) !== null ||
        (q.wording_check ?? null) !== null ||
        (q.follow_up_check ?? null) !== null ||
        (q.time_limit_check ?? null) !== null ||
        (q.order_check ?? null) !== null,
    )
  );
}

/** Whether an outcome may be acted on: restart, ranking, scoring. Only a final one. */
export function isOutcomeDecided(outcome: Pick<LiveOutcome, "final"> | null): boolean {
  return outcome?.final === true;
}

/**
 * One question's answer settled by its transcript: real words confirm it;
 * none (silence, a cough, noise) downgrade it to skipped, and the counts and
 * the outcome are worked out again. `final` is left as it is: the settle in
 * live-transcribe.ts decides it from every turn. Pure.
 */
export function confirmAnswer(
  outcome: LiveOutcome,
  position: number,
  hasRealWords: boolean,
  attempt: number,
): LiveOutcome {
  const questions = outcome.questions.map((q) => {
    if (q.position !== position || q.status !== "answered") return q;
    return hasRealWords
      ? { ...q, confirmed: true }
      : { ...q, status: "skipped" as const, confirmed: null };
  });
  const fields = outcomeFrom(
    questions,
    outcome.provider_status_code,
    attempt,
    outcome.final,
    outcome.answers_usable,
    CONFIRMED_EXIT_CODES,
    outcome.completed_gracefully,
  );
  return {
    ...outcome,
    questions,
    needs_review: needsReview(
      questions,
      outcome.transcription_failed_turns,
      fields.end_check,
      outcome.interruption_check_turns ?? [],
    ),
    ...fields,
  };
}

/** Whether an interruption's candidate speech is missing from the export: then no answer set is whole. */
export function interruptionSpeechMissing(
  interruptions: readonly Pick<Interruption, "candidate_speech_exported">[] | undefined,
): boolean {
  return (interruptions ?? []).some((i) => !i.candidate_speech_exported);
}

/** What an interruption line still needs from a person, or null. */
export function interruptionCheckOf(
  i: Pick<Interruption, "ambiguity" | "candidate_speech_exported">,
): InterruptionCheck | null {
  if (i.ambiguity !== null) return "ambiguous";
  return i.candidate_speech_exported ? null : "speech_missing";
}

/**
 * The words a repeat may say before the question without a flag, case and
 * punctuation aside. Anything else before it is an unexpected lead-in, which
 * is flagged and held for a person (classifyRepeat): it may be a hint.
 *
 * "Let me just finish the question." is what Sarah says when the candidate
 * cuts in before she has finished asking (D9, 22 Oct 2026); she then asks the
 * question again in full. Like every lead-in here it only introduces the
 * frozen wording: the turn is a procedural repeat, never a follow-up or a
 * hint, and never a scoring entry.
 */
export const REPEAT_LEAD_INS = [
  "Let me repeat the question.",
  "Sure, here it is again.",
  "Of course.",
  "Let me just finish the question.",
] as const;

function normaliseWording(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The longest unknown lead-in, in words, still read as a lead-in to the
 * frozen question. Longer is not a lead-in but altered wording: a hint or an
 * explanation in front of the question. Both are held for a person; only the
 * review text differs.
 */
export const MAX_UNEXPECTED_LEAD_IN_WORDS = 12;

export type RepeatWording = "exact" | "known_lead_in" | RepeatCheck;

/**
 * How a marked repeat asked its question, case, punctuation and spacing aside:
 *
 *   exact               the frozen question, alone
 *   known_lead_in       one of REPEAT_LEAD_INS, then the frozen question
 *   unexpected_lead_in  any other phrase of at most MAX_UNEXPECTED_LEAD_IN_WORDS
 *                       words, then the frozen question
 *   altered_wording     anything else: the question changed, shortened or
 *                       followed by more, a longer lead-in, or no question
 *
 * The frozen wording after the lead-in is always checked. Pure.
 */
export function classifyRepeat(frozenText: string, spoken: string): RepeatWording {
  const q = normaliseWording(frozenText);
  const r = normaliseWording(spoken);
  if (!q) return "altered_wording";
  if (r === q) return "exact";
  if (!r.endsWith(` ${q}`)) return "altered_wording";
  const lead = r.slice(0, r.length - q.length).trim();
  if (REPEAT_LEAD_INS.some((l) => normaliseWording(l) === lead)) return "known_lead_in";
  return lead.split(" ").length <= MAX_UNEXPECTED_LEAD_IN_WORDS
    ? "unexpected_lead_in"
    : "altered_wording";
}

/**
 * Whether a marked repeat asks the frozen question as agreed, needing no
 * person: alone, or after one of REPEAT_LEAD_INS.
 */
export function repeatMatchesQuestion(frozenText: string, spoken: string): boolean {
  const wording = classifyRepeat(frozenText, spoken);
  return wording === "exact" || wording === "known_lead_in";
}

/* ── the first asking (F12, 23 Oct 2026) ──────────────────────── */

/**
 * Words allowed before a base question without a flag. Empty by decision
 * (F12): any phrase before the frozen question is held for a person. The
 * opening greeting included, until the provider sends it as its own
 * procedural turn.
 */
export const BASE_QUESTION_TRANSITIONS: readonly string[] = [];

/**
 * The approved contractions, read the same way on both sides: "what're" and
 * "what are" compare equal. Both texts are expanded with this one map, so an
 * ambiguous form ("you'd") can never make two different texts equal.
 */
export const CONTRACTIONS: Readonly<Record<string, string>> = {
  "aren't": "are not",
  "can't": "cannot",
  "couldn't": "could not",
  "didn't": "did not",
  "doesn't": "does not",
  "don't": "do not",
  "hadn't": "had not",
  "hasn't": "has not",
  "haven't": "have not",
  "he's": "he is",
  "how's": "how is",
  "i'd": "i would",
  "i'll": "i will",
  "i'm": "i am",
  "i've": "i have",
  "isn't": "is not",
  "it's": "it is",
  "let's": "let us",
  "she's": "she is",
  "shouldn't": "should not",
  "that's": "that is",
  "there's": "there is",
  "they'd": "they would",
  "they'll": "they will",
  "they're": "they are",
  "they've": "they have",
  "wasn't": "was not",
  "we'd": "we would",
  "we'll": "we will",
  "we're": "we are",
  "we've": "we have",
  "weren't": "were not",
  "what'd": "what did",
  "what're": "what are",
  "what's": "what is",
  "when's": "when is",
  "where's": "where is",
  "who's": "who is",
  "why's": "why is",
  "won't": "will not",
  "wouldn't": "would not",
  "you'd": "you would",
  "you'll": "you will",
  "you're": "you are",
  "you've": "you have",
};

/** Filler sounds set aside when they stand alone as a word. */
export const FILLER_SOUNDS: ReadonlySet<string> = new Set(["um", "uh", "er", "erm"]);

/** Lowercase words, accents, apostrophes and punctuation aside, contractions expanded, fillers dropped. */
function askedWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .flatMap((w) => {
      const word = w.replace(/^'+|'+$/g, "");
      return (CONTRACTIONS[word] ?? word.replace(/'/g, "")).split(" ");
    })
    .filter((w) => w !== "" && !FILLER_SOUNDS.has(w));
}

export type AskedWording =
  | "exact"
  | "agreed_transition"
  // How the question was worded; the follow-up limit is checked separately.
  | Exclude<WordingCheck, "follow_up_over_limit">;

/**
 * How a base question was first asked, against its frozen text:
 *
 *   exact               the frozen question, once the approved harmless
 *                       differences are set aside: case, punctuation and
 *                       spacing, CONTRACTIONS, FILLER_SOUNDS standing alone,
 *                       and the candidate's first name standing alone at the
 *                       very start or the very end (strict match)
 *   agreed_transition   one of BASE_QUESTION_TRANSITIONS (none yet), then it
 *   unexpected_lead_in  any other phrase of at most MAX_UNEXPECTED_LEAD_IN_WORDS
 *                       words, then the frozen question
 *   altered_wording     anything else: the question changed, shortened or
 *                       followed by more, a longer lead-in, or no question
 *
 * `firstName` is used for this comparison only. Pure.
 */
export function classifyAsked(
  frozenText: string,
  spoken: string,
  firstName: string | null = null,
): AskedWording {
  const q = askedWords(frozenText);
  if (q.length === 0) return "altered_wording";
  const r = askedWords(spoken);
  // The name may be set aside at the very start, the very end, or both, never
  // elsewhere. Each is only an option: the spoken text as it is stays one too,
  // so a question that itself begins or ends with the same word still matches.
  const name = askedWords(firstName ?? "");
  const named = (w: readonly string[], i: number) =>
    name.length > 0 && w.length > name.length && name.every((n, k) => w[i + k] === n);
  const options = [r];
  if (named(r, 0)) options.push(r.slice(name.length));
  for (const o of [...options]) {
    if (named(o, o.length - name.length)) options.push(o.slice(0, o.length - name.length));
  }
  return options.map((o) => askedAs(q, o)).sort((x, y) => ASKED_RANK[x] - ASKED_RANK[y])[0];
}

/** Most lenient first: of the name options, the one closest to the frozen question decides. */
const ASKED_RANK: Record<AskedWording, number> = {
  exact: 0,
  agreed_transition: 1,
  unexpected_lead_in: 2,
  altered_wording: 3,
};

function askedAs(q: readonly string[], r: readonly string[]): AskedWording {
  const qs = q.join(" ");
  const rs = r.join(" ");
  if (rs === qs) return "exact";
  if (!rs.endsWith(` ${qs}`)) return "altered_wording";
  const lead = rs.slice(0, rs.length - qs.length).trim();
  if (BASE_QUESTION_TRANSITIONS.some((l) => askedWords(l).join(" ") === lead)) {
    return "agreed_transition";
  }
  return lead.split(" ").length <= MAX_UNEXPECTED_LEAD_IN_WORDS
    ? "unexpected_lead_in"
    : "altered_wording";
}

/** Altered wording outranks an unexpected lead-in when one question has both. */
function worseRepeatCheck(a: RepeatCheck | null, b: RepeatCheck): RepeatCheck {
  return a === "altered_wording" || b === "altered_wording"
    ? "altered_wording"
    : "unexpected_lead_in";
}

export type LiveIngestErrorCode =
  | "session_not_found"
  | "not_live"
  | "not_frozen"
  | "wrong_session"
  | "unknown_question_position"
  | "too_many_follow_ups"
  | "missing_audio"
  | "bad_audio"
  | "already_saved"
  | "different_export"
  | "storage_error"
  | "past_retention"
  | "db_error";

/** The export cannot be saved. Ids, positions and sequences only in the message. */
export class LiveIngestError extends Error {
  readonly code: LiveIngestErrorCode;
  constructor(code: LiveIngestErrorCode, detail: string) {
    super(`live ingest: ${code}: ${detail}`);
    this.name = "LiveIngestError";
    this.code = code;
  }
}

/* ── the facts, worked out before anything is written ─────────── */

/**
 * The facts and the outcome of a parsed export against the session's frozen
 * questions. Pure; throws LiveIngestError on anything that cannot be saved.
 * `candidateFirstName` is only compared (classifyAsked), never kept.
 * `followUpLimit` is the session's frozen max_follow_ups_per_base_question
 * (0 for Recruiter-Defined, 2 for AI-Guided): a follow-up past it holds its
 * question for a person (follow_up_check over_limit), never refuses the
 * interview and is never scored silently. Only more follow-ups on one question
 * than FOLLOW_UP_INDEX_MAX, or two with the same index, is broken data.
 */
export function assessLiveExport(
  parsed: ParsedExport,
  frozen: FrozenLiveQuestionSet,
  attempt: number,
  candidateFirstName: string | null = null,
  followUpLimit: number = MAX_FOLLOW_UPS_PER_BASE_QUESTION,
  timing: ExportTiming | null = null,
): Omit<LiveOutcome, "saved_at" | "export_hash"> {
  const byPosition = new Map(frozen.questions.map((q) => [q.position, q]));
  const turns = [...parsed.turns].sort((a, b) => a.sequence - b.sequence);
  const byId = new Map(turns.map((t) => [t.provider_turn_id, t]));

  for (const t of turns) {
    if (t.question_position !== null && !byPosition.has(t.question_position)) {
      throw new LiveIngestError(
        "unknown_question_position",
        `turn ${t.sequence} names position ${t.question_position}`,
      );
    }
  }

  /** The question a turn belongs to: its own position, or the one of the turn it answers. */
  const positionOf = (t: LiveTurn): number | null =>
    t.question_position ??
    (t.responds_to_provider_turn_id
      ? (byId.get(t.responds_to_provider_turn_id)?.question_position ?? null)
      : null);

  // An overlap is expected only after an interviewer turn marked interrupted.
  const suspect: number[] = [];
  let lastInterviewer: LiveTurn | null = null;
  for (const t of turns) {
    if (t.speaker === "interviewer") {
      lastInterviewer = t;
      continue;
    }
    // Interruption speech overlaps the interviewer by its nature, and is never an answer.
    if (t.candidate_interruption) continue;
    if (
      lastInterviewer &&
      !lastInterviewer.interrupted &&
      lastInterviewer.offset_ms + lastInterviewer.duration_ms > t.offset_ms
    ) {
      suspect.push(t.sequence);
    }
  }
  const suspectSet = new Set(suspect);

  // An interruption that needs a person, by question and by line.
  const interruptions = parsed.interruptions.map((i) => ({ ...i }));
  const interruptionCheckTurns: number[] = [];
  const interruptionByPosition = new Map<number, InterruptionCheck>();
  for (const i of interruptions) {
    const check = interruptionCheckOf(i);
    if (check === null) continue;
    interruptionCheckTurns.push(i.line_sequence);
    if (i.position === null) continue;
    // Ambiguous outranks speech missing: an ambiguous one cannot say what was lost.
    if (interruptionByPosition.get(i.position) !== "ambiguous") {
      interruptionByPosition.set(i.position, check);
    }
  }

  // The time limit (#50): which questions have a turn after it, on which clock.
  const timeLimitByPosition = new Map<number, TimeLimitCheck>();
  const timeLimitTurns: number[] = [];
  if (timing) {
    const providerStart = Date.parse(parsed.started_at);
    const ours = timing.ourStartedAtMs;
    const disagree =
      ours !== null &&
      Number.isFinite(providerStart) &&
      Math.abs(providerStart - ours) > CLOCK_TOLERANCE_MS;
    for (const t of turns) {
      const position = positionOf(t);
      if (position === null) continue;
      // Late on a clock when the turn starts after the limit, or starts before
      // it and is still going when it is reached (spans the deadline).
      const late = (startMs: number) =>
        startMs > timing.limitMs || startMs + t.duration_ms > timing.limitMs;
      const onProvider = late(t.offset_ms);
      const onOurs =
        ours !== null && Number.isFinite(providerStart)
          ? late(providerStart + t.offset_ms - ours)
          : null;
      let check: TimeLimitCheck | null = null;
      if (disagree) check = onProvider || onOurs ? "clocks_disagree" : null;
      else check = (onOurs ?? onProvider) ? "after_limit" : null;
      if (check === null) continue;
      timeLimitTurns.push(t.sequence);
      // A turn that is after the limit outranks one only near it.
      if (timeLimitByPosition.get(position) !== "after_limit")
        timeLimitByPosition.set(position, check);
    }
  }

  // F15c: a candidate reply to an offer to repeat is kept, never an answer.
  const offerReplies = new Set(
    turns
      .filter(
        (t) =>
          t.speaker === "candidate" &&
          t.responds_to_provider_turn_id !== null &&
          byId.get(t.responds_to_provider_turn_id)?.repeat_offer === true,
      )
      .map((t) => t.sequence),
  );

  // The order (#15), on the FROZEN positions: Q1, its follow-ups, then Q2.
  const rank = new Map(
    [...frozen.questions]
      .map((q) => q.position)
      .sort((a, b) => a - b)
      .map((p, i) => [p, i]),
  );
  const orderByPosition = new Map<number, OrderCheck>();
  const orderTurns = new Set<number>();
  const flagOrder = (position: number, check: OrderCheck, sequence: number) => {
    const was = orderByPosition.get(position);
    if (was === undefined || ORDER_RANK[check] < ORDER_RANK[was]) {
      orderByPosition.set(position, check);
    }
    orderTurns.add(sequence);
  };
  const askedInOrder: number[] = [];
  // Questions Sarah said she moved on from (not_answered), so far.
  const movedOn = new Set<number>();
  // A question passed over is reported once, with the question asked after it.
  const passedOver = new Set<number>();
  let current: number | null = null;
  for (const t of turns) {
    if (t.not_answered && t.question_position !== null) movedOn.add(t.question_position);
    if (t.speaker === "interviewer" && t.kind === "base_question") {
      const p = t.question_position as number;
      // Skipped in the middle: an earlier question never asked, and no
      // not_answered for it. Questions never reached at the end are not this.
      for (const x of rank.keys()) {
        if ((rank.get(x) ?? 0) >= (rank.get(p) ?? 0)) continue;
        if (askedInOrder.includes(x) || movedOn.has(x) || passedOver.has(x)) continue;
        passedOver.add(x);
        flagOrder(x, "skipped_question", t.sequence);
        flagOrder(p, "skipped_question", t.sequence);
      }
      if (askedInOrder.includes(p)) {
        flagOrder(p, "asked_twice", t.sequence);
      } else {
        const later = askedInOrder.filter((x) => (rank.get(x) ?? 0) > (rank.get(p) ?? 0));
        if (later.length > 0) {
          flagOrder(p, "out_of_order", t.sequence);
          for (const x of later) flagOrder(x, "out_of_order", t.sequence);
        }
        askedInOrder.push(p);
      }
      current = p;
    } else if (t.speaker === "interviewer" && t.kind === "follow_up") {
      const p = t.question_position as number;
      if (p !== current) {
        flagOrder(p, "follow_up_elsewhere", t.sequence);
        if (current !== null) flagOrder(current, "follow_up_elsewhere", t.sequence);
      }
    } else if (
      t.speaker === "candidate" &&
      !t.candidate_interruption &&
      !offerReplies.has(t.sequence)
    ) {
      const p = positionOf(t);
      if (p !== null && current !== null && p !== current) {
        flagOrder(p, "answer_elsewhere", t.sequence);
        flagOrder(current, "answer_elsewhere", t.sequence);
      }
    }
  }

  const questions: LiveQuestionFacts[] = [];
  const wordingCheckTurns: number[] = [];
  const followUpCheckTurns: number[] = [];
  const repeatCheckTurns: number[] = [];
  for (const q of frozen.questions) {
    // A marked repeat stays a procedural repeat whatever it said. One that did
    // not ask the frozen question as agreed is flagged on its question, which
    // is then held from scoring until a person checks the recording.
    let repeatCheck: RepeatCheck | null = null;
    for (const [i, t] of turns.entries()) {
      if (!t.repeat || t.question_position !== q.position) continue;
      // Right after an interruption line, the line is read as the repeat's lead-in.
      const before = turns[i - 1];
      const spoken = before?.interruption_line
        ? `${before.text ?? ""} ${t.text ?? ""}`
        : (t.text ?? "");
      const wording = classifyRepeat(q.text, spoken);
      if (wording === "exact" || wording === "known_lead_in") continue;
      repeatCheck = worseRepeatCheck(repeatCheck, wording);
      repeatCheckTurns.push(t.sequence);
    }
    const asked = turns.filter(
      (t) => t.kind === "base_question" && t.question_position === q.position,
    );
    // An unmarked second base_question is kept and held (order_check
    // asked_twice, #15). Procedural turns (reminders, marked repeats, offers
    // to repeat, not_answered) are never follow-ups.
    const followUps = turns.filter(
      (t) => t.kind === "follow_up" && t.question_position === q.position,
    );
    const indexes = new Set(followUps.map((t) => t.follow_up_index));
    // Broken data only: more than the schema keeps on one question (076), or
    // two with the same index. More than this session allows is kept and held.
    if (followUps.length > FOLLOW_UP_INDEX_MAX || indexes.size !== followUps.length) {
      throw new LiveIngestError(
        "too_many_follow_ups",
        `position ${q.position} has ${followUps.length} follow-ups`,
      );
    }
    const overLimit = followUps.filter((t) => (t.follow_up_index ?? 0) > followUpLimit);
    // Sarah moved on without an answer (F15c): only speech after her last
    // not_answered on this question is its answer.
    const movedOnAfter =
      turns.filter((t) => t.not_answered && t.question_position === q.position).at(-1)?.sequence ??
      null;
    // Interruption speech (F15b) and replies to an offer to repeat (F15c) are
    // kept but are never the answer: not counted, timed or scored.
    const onQuestion = turns.filter(
      (t) =>
        t.speaker === "candidate" &&
        !t.candidate_interruption &&
        !offerReplies.has(t.sequence) &&
        positionOf(t) === q.position,
    );
    // Speech BEFORE Sarah's not_answered: kept, counted as the answer, and
    // the question held for a person (#15), never scored as skipped.
    const before =
      movedOnAfter === null
        ? []
        : onQuestion.filter((t) => t.sequence < movedOnAfter && t.duration_ms > 0);
    if (before.length > 0) flagOrder(q.position, "answer_before_not_answered", before[0].sequence);
    const countAfter = before.length > 0 ? null : movedOnAfter;
    const spoken = onQuestion.filter((t) => countAfter === null || t.sequence > countAfter);
    // Any captured speech is an answer, however short; the parser has already
    // refused a turn with no duration and the save refuses one with no audio.
    const answerMs = spoken.reduce((sum, t) => sum + t.duration_ms, 0);
    const answered = spoken.some((t) => t.duration_ms > 0);
    // The first asking: held for a person unless it is the frozen question,
    // harmless differences aside. Never asked: nothing to check.
    const wording =
      asked.length > 0 ? classifyAsked(q.text, asked[0].text ?? "", candidateFirstName) : null;
    const wordingCheck =
      wording === "unexpected_lead_in" || wording === "altered_wording" ? wording : null;
    if (wordingCheck !== null) wordingCheckTurns.push(asked[0].sequence);
    // Its own check, beside the wording one: both can hold the same question.
    const followUpCheck: FollowUpCheck | null = overLimit.length > 0 ? "over_limit" : null;
    for (const t of overLimit) followUpCheckTurns.push(t.sequence);
    questions.push({
      position: q.position,
      source: q.source,
      status: asked.length === 0 ? "not_reached" : answered ? "answered" : "skipped",
      confirmed: asked.length > 0 && answered ? false : null,
      follow_ups: followUps.length,
      repeats: turns.filter(
        (t) => t.kind === "procedural" && t.repeat && t.question_position === q.position,
      ).length,
      answer_ms: answerMs,
      needs_check: spoken.some((t) => suspectSet.has(t.sequence)),
      repeat_check: repeatCheck,
      wording_check: wordingCheck,
      interruption_check: interruptionByPosition.get(q.position) ?? null,
      follow_up_check: followUpCheck,
      time_limit_check: timeLimitByPosition.get(q.position) ?? null,
      order_check: orderByPosition.get(q.position) ?? null,
      moved_on_after: countAfter,
    });
  }

  // Final only when there is nothing to transcribe; otherwise live-transcribe
  // settles it once every candidate turn is done. With no candidate turn there
  // is no answer to lose, and every turn's audio is stored by the save.
  const final = !turns.some((t) => t.speaker === "candidate");
  const usable = final && !interruptionSpeechMissing(interruptions);
  const fields = outcomeFrom(
    questions,
    parsed.status.code,
    attempt,
    final,
    usable,
    CONFIRMED_EXIT_CODES,
    parsed.status.completed_gracefully,
  );

  return {
    v: LIVE_OUTCOME_VERSION,
    provider_session_id: parsed.provider_session_id,
    provider_status: parsed.status.provider_status,
    provider_status_code: parsed.status.code,
    provider_end_reason: parsed.status.end_reason,
    completed_gracefully: parsed.status.completed_gracefully,
    answers_usable: usable,
    turn_count: turns.length,
    questions,
    timing_suspect: suspect.length > 0,
    timing_suspect_turns: suspect,
    wording_check_turns: wordingCheckTurns.sort((a, b) => a - b),
    follow_up_check_turns: followUpCheckTurns.sort((a, b) => a - b),
    time_limit_check_turns: timeLimitTurns.sort((a, b) => a - b),
    order_check_turns: [...orderTurns].sort((a, b) => a - b),
    not_answered_turns: turns.filter((t) => t.not_answered).map((t) => t.sequence),
    repeat_offer_turns: turns.filter((t) => t.repeat_offer).map((t) => t.sequence),
    offer_reply_turns: [...offerReplies].sort((a, b) => a - b),
    repeat_check_turns: repeatCheckTurns.sort((a, b) => a - b),
    interruptions,
    interruption_check_turns: interruptionCheckTurns.sort((a, b) => a - b),
    interruption_speech_turns: turns.filter((t) => t.candidate_interruption).map((t) => t.sequence),
    needs_review: needsReview(questions, [], fields.end_check, interruptionCheckTurns),
    transcription_failed_turns: [],
    settle_rev: 0,
    ...fields,
  };
}

/* ── saving ───────────────────────────────────────────────────── */

export type IngestDeps = {
  service: Service;
  /** The provider's fetchAudio, bound to this session's provider id. */
  fetchAudio: (fileName: string) => Promise<TurnAudio>;
  now: () => number;
  /** Queues the candidate turns' transcription (B2). Default: the job queue. */
  requestTranscription?: (service: Service, sessionId: string) => Promise<TranscriptionRequest>;
};

/** Whether every pending candidate turn has a transcription job; false means save again. */
export type TranscriptionQueued = { transcriptionQueued: boolean };

/**
 * What a save did. `notFinal`: the export is a snapshot of an interview still
 * in progress, and nothing was read or written (see saveLiveExport).
 * `restarted`: the session is a restarted first attempt (status 'abandoned',
 * F10); its outcome is kept as it was, no transcription is asked for, and the
 * save is done, never to be retried. `saved` there says whether this call
 * stored the export's turns, for audit.
 */
export type IngestResult =
  | ({
      outcome: LiveOutcome;
      saved: boolean;
      notFinal?: undefined;
      restarted?: undefined;
    } & TranscriptionQueued)
  | { outcome: null; saved: false; notFinal: true; retryable: true; restarted?: undefined }
  | { outcome: LiveOutcome | null; saved: boolean; restarted: true; notFinal?: undefined };

/** A save for a restarted first attempt: done, nothing more asked for. Counts only in the log. */
function restartedSave(
  sessionId: string,
  outcome: LiveOutcome | null,
  turnsStored: number,
): IngestResult {
  console.log(
    `[live-ingest] session ${sessionId}: restarted; outcome kept, ${turnsStored} turns stored for audit, no transcription`,
  );
  return { outcome, saved: turnsStored > 0, restarted: true };
}

const queueTranscription = async (
  service: Service,
  sessionId: string,
): Promise<TranscriptionRequest> => {
  const [{ enqueue }, { queueLiveTranscription }] = await Promise.all([
    import("@/lib/jobs-queue"),
    import("@/lib/interviews/live-transcribe"),
  ]);
  return queueLiveTranscription(service, sessionId, enqueue as never);
};

/**
 * Queue the saved export's transcription, after everything is saved and
 * outside it: a failure here never undoes the save, and is never read as done.
 * The turns stay pending; saving the export again asks again, and the job ids
 * (live-transcribe.ts) make that safe however often it happens.
 */
async function requestTranscriptionAfterSave(
  deps: IngestDeps,
  sessionId: string,
): Promise<TranscriptionQueued> {
  try {
    const r = await (deps.requestTranscription ?? queueTranscription)(deps.service, sessionId);
    if (r.failed === 0) return { transcriptionQueued: true };
    console.error(
      `[live-ingest] session ${sessionId}: transcription not queued for ${r.failed} turn(s) (queued ${r.queued}, already ${r.alreadyQueued}); save the export again`,
    );
  } catch {
    console.error(
      `[live-ingest] session ${sessionId}: transcription could not be queued; save the export again`,
    );
  }
  return { transcriptionQueued: false };
}

/**
 * The provider's words for an interview that has not ended (F15b). Matched on
 * `status` and `end_reason` alike, case and spaces aside. Only words the
 * provider has sent are listed: nothing is guessed.
 */
export const NOT_FINAL_WORDS: readonly string[] = ["in_progress"];

/** True when either the provider's status or its end_reason says the interview is still running. */
export function isNotFinalExport(status: ParsedExport["status"]): boolean {
  return [status.provider_status, status.end_reason].some(
    (word) => word !== null && NOT_FINAL_WORDS.includes(word.trim().toLowerCase()),
  );
}

export type SessionRow = {
  id: string;
  kind: string;
  status: string;
  company_id: string | null;
  application_id: string | null;
  attempt: number | null;
  provider_session_id: string | null;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
  live_outcome: unknown;
  delete_after: string | null;
  /** Written by the start route with the server's clock: Remotiv's own start. */
  started_at: string | null;
};

const SESSION_COLUMNS =
  "id, kind, status, company_id, application_id, attempt, provider_session_id, live_settings, questions_snapshot, scoring_snapshot, live_outcome, delete_after, started_at";

/**
 * The session's frozen length and Remotiv's own start, for the time-limit
 * check (#50). A row whose settings cannot be read is checked against the
 * default 30 minutes, the only length before settings v4.
 */
function exportTiming(row: SessionRow): ExportTiming {
  const seconds =
    readLiveSettings(row.live_settings, row.id)?.max_session_seconds ?? DEFAULT_SESSION_SECONDS;
  const started = row.started_at ? Date.parse(row.started_at) : Number.NaN;
  return {
    limitMs: Math.min(seconds, MAX_SESSION_SECONDS) * 1000,
    ourStartedAtMs: Number.isFinite(started) ? started : null,
  };
}

/** A stable uuid for one provider turn of one session, so a re-save finds the same row. */
export function turnRowId(sessionId: string, providerTurnId: string): string {
  const h = createHash("sha256").update(`live-turn:${sessionId}:${providerTurnId}`).digest("hex");
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The export's fingerprint: everything Remotiv keeps from it, in a fixed order. */
export function exportHash(parsed: ParsedExport): string {
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

type StoredAudio = { path: string; mime: string; bytes: Uint8Array; sha256: string };

/**
 * {sessionId}/t{sequence}.{exportHash16}.{ext}: one export's files never meet
 * another's. Sixteen hex characters (64 bits) of the hash. Migration 021's
 * check, media_path like {sessionId}/t{sequence}.%, accepts any suffix after
 * the dot, so the length needs no migration.
 */
export function audioPath(sessionId: string, sequence: number, hash: string, ext: string): string {
  return `${sessionId}/t${sequence}.${hash.slice(0, 16)}.${ext}`;
}

type StoredTurn = { id: string; sequence: number; media_sha256: string; media_path: string | null };

/** Whether the stored turns are exactly these rows: same ids, sequences, audio hashes and paths. */
function turnsAreThese(have: readonly StoredTurn[], rows: readonly ReturnType<typeof turnRow>[]) {
  const want = new Map(rows.map((r) => [r.id, r]));
  return (
    have.length === rows.length &&
    have.every((h) => {
      const r = want.get(h.id);
      return (
        r?.sequence === h.sequence &&
        r.media_sha256 === h.media_sha256 &&
        r.media_path === h.media_path
      );
    })
  );
}

async function readTurns(service: Service, sessionId: string): Promise<StoredTurn[]> {
  const { data, error } = await service
    .from("interview_turns")
    .select("id, sequence, media_sha256, media_path")
    .eq("session_id", sessionId);
  if (error) throw new LiveIngestError("db_error", "turn read");
  return (data ?? []) as StoredTurn[];
}

/** A turn's audio, fetched and checked; nothing is stored yet. */
async function checkedAudio(
  deps: IngestDeps,
  sessionId: string,
  hash: string,
  turn: LiveTurn,
): Promise<StoredAudio> {
  const name = turn.audio_file_name;
  if (!name) throw new LiveIngestError("missing_audio", `turn ${turn.sequence} names no audio`);
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();
  let audio: TurnAudio;
  try {
    audio = await deps.fetchAudio(name);
  } catch {
    throw new LiveIngestError("missing_audio", `turn ${turn.sequence}: the provider gave no audio`);
  }
  const mime = (audio.mime_type ?? AUDIO_TYPES[ext] ?? "").split(";")[0].trim().toLowerCase();
  if (!ext || !ACCEPTED_AUDIO.has(mime)) {
    throw new LiveIngestError("bad_audio", `turn ${turn.sequence}: not an accepted audio type`);
  }
  if (audio.bytes.byteLength === 0 || audio.bytes.byteLength > MAX_TURN_AUDIO_BYTES) {
    throw new LiveIngestError(
      "bad_audio",
      `turn ${turn.sequence}: ${audio.bytes.byteLength} bytes`,
    );
  }
  return {
    path: audioPath(sessionId, turn.sequence, hash, ext),
    mime,
    bytes: audio.bytes,
    sha256: createHash("sha256").update(audio.bytes).digest("hex"),
  };
}

function turnRow(sessionId: string, turn: LiveTurn, audio: StoredAudio) {
  return {
    id: turnRowId(sessionId, turn.provider_turn_id),
    session_id: sessionId,
    session_kind: "live",
    provider_turn_id: turn.provider_turn_id,
    sequence: turn.sequence,
    speaker: turn.speaker,
    kind: turn.kind,
    question_position: turn.question_position,
    follow_up_index: turn.follow_up_index,
    follow_up_reason: turn.follow_up_reason,
    responds_to_turn_id: turn.responds_to_provider_turn_id
      ? turnRowId(sessionId, turn.responds_to_provider_turn_id)
      : null,
    text: turn.speaker === "interviewer" ? turn.text : null,
    // Candidate words come from Remotiv's transcription of the turn's audio.
    transcript_status: turn.speaker === "candidate" ? "pending" : null,
    media_path: audio.path,
    media_mime_type: audio.mime,
    media_bytes: audio.bytes.byteLength,
    media_sha256: audio.sha256,
    offset_ms: turn.offset_ms,
    duration_ms: turn.duration_ms,
    interrupted: turn.interrupted,
    audio_stopped_ms: turn.audio_stopped_ms,
    started_at: turn.started_at,
    ended_at: turn.ended_at,
  };
}

export async function readSession(service: Service, sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new LiveIngestError("db_error", "session read");
  return data as SessionRow | null;
}

/**
 * The candidate's first name, for classifyAsked only: never stored, never
 * logged. Read within the session's own company. Any failure reads as no
 * name, which can only flag MORE questions for a person, never fewer.
 */
async function candidateFirstName(service: Service, row: SessionRow): Promise<string | null> {
  if (!row.application_id || !row.company_id) return null;
  const { data, error } = await service
    .from("job_applications")
    .select("first_name")
    .eq("id", row.application_id)
    .eq("company_id_snapshot", row.company_id)
    .maybeSingle();
  if (error) {
    console.warn(`[live-ingest] session ${row.id}: first name unread; no name is set aside`);
    return null;
  }
  const name = (data as { first_name: string | null } | null)?.first_name?.trim();
  return name || null;
}

/** The stored outcome when it is this export's; refuses another export's. */
function storedFor(row: SessionRow, hash: string): LiveOutcome | null {
  const stored = row.live_outcome as LiveOutcome | null;
  // A refused export's technical failure is not an interview: a good export replaces it.
  if (!stored || isImportFailure(stored)) return null;
  if (stored.export_hash !== hash) {
    throw new LiveIngestError("already_saved", "the session holds another export");
  }
  return stored;
}

/**
 * Save one parsed export for one session. Idempotent; all-or-nothing for the turns.
 *
 * ── Not final: nothing happens, try again later (F15b) ───────
 *
 * An export whose status or end_reason says the interview is still running
 * (isNotFinalExport) is a snapshot, not the session's record. Saving it would
 * write turns and an outcome once, and the real, final export could then
 * never be saved (it would be another export's). So it is checked FIRST,
 * before anything is written or stamped (no audio, no turns, no outcome, no
 * live_ended_at), and answers
 * { notFinal: true, retryable: true, saved: false, outcome: null }.
 * The one thing read is the session: a restarted first attempt (status
 * 'abandoned', F10) is done whatever the export says, so it answers
 * `restarted`, never retry later. A failed read answers retry later, as before.
 *
 * ── Transcription, queued once saved (B2) ────────────────────
 *
 * A final export, saved now or saved before (the same export), asks for its
 * candidate turns' transcription: one job per pending turn, never two, and
 * never a Whisper call here. A not-final export, or one refused, asks for
 * nothing. `transcriptionQueued: false` means a job could not be created: the
 * save stands, the turns stay pending, and saving the export again queues the
 * rest.
 *
 * REQUIREMENT for any caller that fetches and saves exports (none exists yet):
 * notFinal means RETRY LATER, and so does transcriptionQueued: false. Fetch the export again after a delay and save
 * that. Never mark the session processed, and never mark it permanently
 * failed, on a notFinal answer (live-ingest-f15b.test.ts pins this).
 */
export async function saveLiveExport(
  sessionId: string,
  parsed: ParsedExport,
  deps: IngestDeps,
): Promise<IngestResult> {
  if (isNotFinalExport(parsed.status)) {
    const current = await readSession(deps.service, sessionId).catch(() => null);
    if (current?.kind === "live" && current.status === "abandoned") {
      return restartedSave(sessionId, (current.live_outcome as LiveOutcome | null) ?? null, 0);
    }
    console.log(`[live-ingest] session ${sessionId}: export not final yet; nothing saved`);
    return { outcome: null, saved: false, notFinal: true, retryable: true };
  }
  const row = await readSession(deps.service, sessionId);
  if (!row) throw new LiveIngestError("session_not_found", sessionId);
  if (row.kind !== "live") throw new LiveIngestError("not_live", sessionId);
  // Past retention, or the application being deleted (B7): no audio is stored for it now.
  if (retentionPassed(row.delete_after, deps.now())) {
    throw new LiveIngestError("past_retention", sessionId);
  }
  const frozen = readFrozenQuestionSet(row);
  if (!frozen) throw new LiveIngestError("not_frozen", sessionId);
  if (row.provider_session_id && row.provider_session_id !== parsed.provider_session_id) {
    throw new LiveIngestError("wrong_session", "the export is another provider session's");
  }

  // A restarted first attempt with an outcome (F10): nothing new is written, whichever export this is.
  if (row.status === "abandoned" && row.live_outcome) {
    return restartedSave(sessionId, row.live_outcome as LiveOutcome, 0);
  }

  const hash = exportHash(parsed);
  const already = storedFor(row, hash);
  if (already) {
    return {
      outcome: already,
      saved: false,
      ...(await requestTranscriptionAfterSave(deps, sessionId)),
    };
  }

  // 1. Every check and the whole outcome before any write.
  const facts = assessLiveExport(
    parsed,
    frozen,
    row.attempt ?? 1,
    await candidateFirstName(deps.service, row),
    // The frozen limit; a row whose settings cannot be read keeps the old 2.
    readLiveSettings(row.live_settings, row.id)?.max_follow_ups_per_base_question ??
      MAX_FOLLOW_UPS_PER_BASE_QUESTION,
    exportTiming(row),
  );
  const turns = [...parsed.turns].sort((a, b) => a.sequence - b.sequence);

  // 2. Every turn's audio, fetched and checked before any upload.
  const audio: StoredAudio[] = [];
  for (const t of turns) audio.push(await checkedAudio(deps, sessionId, hash, t));
  const rows = turns.map((t, i) => turnRow(sessionId, t, audio[i]));

  // A save of this export may already have landed its turns (and stopped
  // before the outcome). Anything else in the table is another export's.
  let have = await readTurns(deps.service, sessionId);
  let inserted = 0;
  if (have.length === 0) {
    // 3. Audio, at this export's own paths; a retry writes the same bytes again.
    for (const a of audio) {
      const { error } = await deps.service.storage
        .from(INTERVIEW_BUCKET)
        .upload(a.path, a.bytes, { contentType: a.mime, upsert: true });
      if (error) throw new LiveIngestError("storage_error", "audio upload");
    }
    // 4. Every turn in one statement: all of it or none of it. The unique keys
    //    decide a race; the loser reads what won below.
    const { error } = await deps.service.from("interview_turns").insert(rows);
    if (error && error.code !== "23505") throw new LiveIngestError("db_error", "turn insert");
    have = error ? await readTurns(deps.service, sessionId) : rows;
    // A unique-key refusal with nothing stored is this export clashing with
    // itself, not a race lost to another save.
    if (have.length === 0) throw new LiveIngestError("db_error", "turn insert");
    if (!error) inserted = rows.length;
  }
  if (!turnsAreThese(have, rows)) {
    if (row.status === "abandoned") return restartedSave(sessionId, null, inserted);
    throw new LiveIngestError("different_export", "the session holds another export's turns");
  }
  // A restarted first attempt with no outcome: its turns are kept for audit, and nothing else.
  if (row.status === "abandoned") return restartedSave(sessionId, null, inserted);

  // 5. The outcome, once.
  const outcome: LiveOutcome = {
    ...facts,
    saved_at: new Date(deps.now()).toISOString(),
    export_hash: hash,
  };
  // Never onto a restarted attempt, even one restarted since the read above.
  // Onto an empty outcome, or onto exactly the refused export's failure read
  // above (#51): a good export replaces it once, and never another outcome.
  const failure = isImportFailure(row.live_outcome) ? row.live_outcome.import_failed_at : null;
  const write = deps.service
    .from("interview_sessions")
    .update({ live_outcome: outcome })
    .eq("id", sessionId)
    .eq("kind", "live");
  const { data: landed, error: oErr } = await (failure === null
    ? write.is("live_outcome", null)
    : write.eq("live_outcome->>import_failed_at", failure)
  )
    .neq("status", "abandoned")
    .select("id");
  if (oErr) throw new LiveIngestError("db_error", "outcome write");
  if (((landed ?? []) as unknown[]).length === 0) {
    const now = await readSession(deps.service, sessionId);
    if (now?.status === "abandoned") {
      return restartedSave(sessionId, (now.live_outcome as LiveOutcome | null) ?? null, inserted);
    }
    const theirs = now ? storedFor(now, hash) : null;
    if (theirs) {
      return {
        outcome: theirs,
        saved: false,
        ...(await requestTranscriptionAfterSave(deps, sessionId)),
      };
    }
    throw new LiveIngestError("db_error", "the outcome did not land");
  }
  // 6. The provider's export is its own record that the conversation is over:
  //    the interview's end, for video (live-events.ts), if nothing stamped it yet.
  await stampLiveEnded(deps.service, sessionId, deps.now);
  console.log(
    `[live-ingest] session ${sessionId}: ${rows.length} turns, outcome ${outcome.outcome}, answered ${outcome.answered_count}/${outcome.total}, timing suspect ${outcome.timing_suspect_turns.length}, wording checks ${outcome.wording_check_turns.length}, interruption checks ${outcome.interruption_check_turns.length}`,
  );
  return { outcome, saved: true, ...(await requestTranscriptionAfterSave(deps, sessionId)) };
}
