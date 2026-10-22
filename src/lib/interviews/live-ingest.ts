import "server-only";
import { createHash } from "node:crypto";
import {
  type FrozenLiveQuestionSet,
  type LiveQuestionSource,
  readFrozenQuestionSet,
} from "@/lib/interviews/frozen-questions";
import type {
  ExportStatusCode,
  LiveTurn,
  ParsedExport,
  TurnAudio,
} from "@/lib/interviews/live-provider/types";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import { MAX_FOLLOW_UPS_PER_BASE_QUESTION } from "@/lib/interviews/types";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Save an AI Video Interview's parsed export (live-provider/parse-export.ts):
 * its turns into interview_turns, with their audio in storage, and the facts
 * and outcome into interview_sessions.live_outcome (migration 041).
 *
 * ── The frozen questions are the source of truth ─────────────
 *
 * Every turn must name a position of the session's frozen set
 * (frozen-questions.ts). A base question whose wording strays far from the
 * frozen text is flagged, not refused: what the candidate was asked is kept
 * as spoken, and the flag lets a reviewer see it.
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
 *                       status; provider_error with every answer usable.
 *                       Scored like partial, never ranked against completed,
 *                       never treated as abandonment; the restart is a
 *                       person's decision (restart_allowed null,
 *                       restart_needs_person true)
 *
 * "Every answer usable": every candidate turn's audio is stored (the save
 * refuses an export without it), every candidate transcript is done, and the
 * outcome is final.
 *
 * Nothing here is a score. For the scoring commit: not_reached gets no score
 * (not zero), skipped gets that question's lowest score, a partial interview
 * is never ranked against completed ones, and an answer on a
 * timing_suspect turn is NOT scored automatically until it is checked
 * against the audio.
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

export const LIVE_OUTCOME_VERSION = 2;
/** A base question keeping less than this share of the frozen question's words is flagged. */
export const WORDING_MIN_COVERAGE = 0.6;
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
  /** provider_error, but every answer was saved. */
  | "provider_error_saved";

export type EndCheck = { reason: EndCheckReason; never_asked: number };

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
  wording_differs: boolean;
  /**
   * A candidate turn of this question is timing_suspect: its offsets are not
   * trusted. For the scoring commit: not scored automatically until checked
   * against the audio.
   */
  needs_check: boolean;
};

export type LiveOutcome = {
  v: typeof LIVE_OUTCOME_VERSION;
  saved_at: string;
  export_hash: string;
  provider_session_id: string;
  provider_status: string | null;
  provider_status_code: ExportStatusCode;
  /** Every candidate turn's audio stored and transcript done, and the outcome final. */
  answers_usable: boolean;
  turn_count: number;
  questions: LiveQuestionFacts[];
  timing_suspect: boolean;
  /** Sequences of candidate turns whose offsets should not be trusted. */
  timing_suspect_turns: number[];
  /** Positions whose spoken wording strays from the frozen text. */
  wording_flags: number[];
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
   * (timing suspect), or a candidate turn's transcription failed for good.
   * See needsReview().
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
};

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
 * is only ever true for a final outcome. Pure.
 */
export function outcomeFrom(
  questions: readonly Pick<LiveQuestionFacts, "status">[],
  providerStatus: ExportStatusCode,
  attempt: number,
  final: boolean,
  answersUsable: boolean,
  exitCodes: ReadonlySet<ExportStatusCode> = CONFIRMED_EXIT_CODES,
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
): { outcome: LiveOutcomeCode; endCheck: EndCheck | null } {
  const check = (reason: EndCheckReason) => ({ reason, never_asked: notReached });
  if (status === "completed") {
    return { outcome: "completed", endCheck: notReached > 0 ? check("closed_early") : null };
  }
  if (status === "provider_error") {
    return usable
      ? { outcome: "ending_unconfirmed", endCheck: check("provider_error_saved") }
      : { outcome: "technical_failure", endCheck: null };
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
 * needs_check, or any turn failed transcription. The per-question flags, the
 * failed list and the end check stay as they are; this is the session-level
 * summary of all three.
 */
export function needsReview(
  questions: readonly Pick<LiveQuestionFacts, "needs_check">[],
  failedTurns: readonly number[],
  endCheck: EndCheck | null,
): boolean {
  return endCheck !== null || failedTurns.length > 0 || questions.some((q) => q.needs_check);
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
  );
  return {
    ...outcome,
    questions,
    needs_review: needsReview(questions, outcome.transcription_failed_turns, fields.end_check),
    ...fields,
  };
}

/**
 * The only words a repeat may say before the question, case and punctuation
 * aside. Anything else (a hint, a rephrase) makes it a different question.
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
 * Whether a marked repeat asks the frozen question as given: the same words
 * once case, punctuation and spacing are set aside, alone or after one of
 * REPEAT_LEAD_INS.
 */
export function repeatMatchesQuestion(frozenText: string, spoken: string): boolean {
  const q = normaliseWording(frozenText);
  const r = normaliseWording(spoken);
  if (!q) return false;
  if (r === q) return true;
  if (!r.endsWith(` ${q}`)) return false;
  const lead = r.slice(0, r.length - q.length).trim();
  return REPEAT_LEAD_INS.some((l) => normaliseWording(l) === lead);
}

export type LiveIngestErrorCode =
  | "session_not_found"
  | "not_live"
  | "not_frozen"
  | "wrong_session"
  | "unknown_question_position"
  | "duplicate_base_question"
  | "repeat_wording"
  | "too_many_follow_ups"
  | "missing_audio"
  | "bad_audio"
  | "already_saved"
  | "different_export"
  | "storage_error"
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

const FILLER: ReadonlySet<string> = new Set(
  "a an the and or of to in on at for with from by as is are was were be it its this that you your me my i we our us tell about walk through describe explain how what why when where which who did do does have has can could would will".split(
    " ",
  ),
);
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));

/** The share of the frozen question's words that the spoken text kept. */
export function wordingCoverage(frozenText: string, spoken: string): number {
  const want = new Set(words(frozenText));
  if (want.size === 0) return 1;
  const said = new Set(words(spoken));
  let kept = 0;
  for (const w of want) if (said.has(w)) kept += 1;
  return kept / want.size;
}

/**
 * The facts and the outcome of a parsed export against the session's frozen
 * questions. Pure; throws LiveIngestError on anything that cannot be saved.
 */
export function assessLiveExport(
  parsed: ParsedExport,
  frozen: FrozenLiveQuestionSet,
  attempt: number,
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
    if (
      lastInterviewer &&
      !lastInterviewer.interrupted &&
      lastInterviewer.offset_ms + lastInterviewer.duration_ms > t.offset_ms
    ) {
      suspect.push(t.sequence);
    }
  }
  const suspectSet = new Set(suspect);

  const questions: LiveQuestionFacts[] = [];
  const wordingFlags: number[] = [];
  for (const q of frozen.questions) {
    // A marked repeat asks the frozen question as given, or it is not a repeat.
    for (const t of turns) {
      if (
        t.repeat &&
        t.question_position === q.position &&
        !repeatMatchesQuestion(q.text, t.text ?? "")
      ) {
        throw new LiveIngestError(
          "repeat_wording",
          `turn ${t.sequence} is marked a repeat of position ${q.position} but asks something else`,
        );
      }
    }
    const asked = turns.filter(
      (t) => t.kind === "base_question" && t.question_position === q.position,
    );
    if (asked.length > 1) {
      throw new LiveIngestError("duplicate_base_question", `position ${q.position} is asked twice`);
    }
    // Procedural turns (reminders, marked repeats, offers to skip) are never
    // follow-ups; an unmarked second base_question above is a second question.
    const followUps = turns.filter(
      (t) => t.kind === "follow_up" && t.question_position === q.position,
    );
    const indexes = new Set(followUps.map((t) => t.follow_up_index));
    if (followUps.length > MAX_FOLLOW_UPS_PER_BASE_QUESTION || indexes.size !== followUps.length) {
      throw new LiveIngestError(
        "too_many_follow_ups",
        `position ${q.position} has ${followUps.length} follow-ups`,
      );
    }
    const spoken = turns.filter((t) => t.speaker === "candidate" && positionOf(t) === q.position);
    // Any captured speech is an answer, however short; the parser has already
    // refused a turn with no duration and the save refuses one with no audio.
    const answerMs = spoken.reduce((sum, t) => sum + t.duration_ms, 0);
    const answered = spoken.some((t) => t.duration_ms > 0);
    const wordingDiffers =
      asked.length === 1 && wordingCoverage(q.text, asked[0].text ?? "") < WORDING_MIN_COVERAGE;
    if (wordingDiffers) wordingFlags.push(q.position);
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
      wording_differs: wordingDiffers,
      needs_check: spoken.some((t) => suspectSet.has(t.sequence)),
    });
  }

  // Final only when there is nothing to transcribe; otherwise live-transcribe
  // settles it once every candidate turn is done. With no candidate turn there
  // is no answer to lose, and every turn's audio is stored by the save.
  const final = !turns.some((t) => t.speaker === "candidate");
  const fields = outcomeFrom(questions, parsed.status.code, attempt, final, final);

  return {
    v: LIVE_OUTCOME_VERSION,
    provider_session_id: parsed.provider_session_id,
    provider_status: parsed.status.provider_status,
    provider_status_code: parsed.status.code,
    answers_usable: final,
    turn_count: turns.length,
    questions,
    timing_suspect: suspect.length > 0,
    timing_suspect_turns: suspect,
    wording_flags: wordingFlags,
    needs_review: needsReview(questions, [], fields.end_check),
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
};

export type IngestResult = { outcome: LiveOutcome; saved: boolean };

type SessionRow = {
  id: string;
  kind: string;
  attempt: number | null;
  provider_session_id: string | null;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
  live_outcome: unknown;
};

const SESSION_COLUMNS =
  "id, kind, attempt, provider_session_id, live_settings, questions_snapshot, scoring_snapshot, live_outcome";

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

async function readSession(service: Service, sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new LiveIngestError("db_error", "session read");
  return data as SessionRow | null;
}

/** The stored outcome when it is this export's; refuses another export's. */
function storedFor(row: SessionRow, hash: string): LiveOutcome | null {
  const stored = row.live_outcome as LiveOutcome | null;
  if (!stored) return null;
  if (stored.export_hash !== hash) {
    throw new LiveIngestError("already_saved", "the session holds another export");
  }
  return stored;
}

/** Save one parsed export for one session. Idempotent; all-or-nothing for the turns. */
export async function saveLiveExport(
  sessionId: string,
  parsed: ParsedExport,
  deps: IngestDeps,
): Promise<IngestResult> {
  const row = await readSession(deps.service, sessionId);
  if (!row) throw new LiveIngestError("session_not_found", sessionId);
  if (row.kind !== "live") throw new LiveIngestError("not_live", sessionId);
  const frozen = readFrozenQuestionSet(row);
  if (!frozen) throw new LiveIngestError("not_frozen", sessionId);
  if (row.provider_session_id && row.provider_session_id !== parsed.provider_session_id) {
    throw new LiveIngestError("wrong_session", "the export is another provider session's");
  }

  const hash = exportHash(parsed);
  const already = storedFor(row, hash);
  if (already) return { outcome: already, saved: false };

  // 1. Every check and the whole outcome before any write.
  const facts = assessLiveExport(parsed, frozen, row.attempt ?? 1);
  const turns = [...parsed.turns].sort((a, b) => a.sequence - b.sequence);

  // 2. Every turn's audio, fetched and checked before any upload.
  const audio: StoredAudio[] = [];
  for (const t of turns) audio.push(await checkedAudio(deps, sessionId, hash, t));
  const rows = turns.map((t, i) => turnRow(sessionId, t, audio[i]));

  // A save of this export may already have landed its turns (and stopped
  // before the outcome). Anything else in the table is another export's.
  let have = await readTurns(deps.service, sessionId);
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
  }
  if (!turnsAreThese(have, rows)) {
    throw new LiveIngestError("different_export", "the session holds another export's turns");
  }

  // 5. The outcome, once.
  const outcome: LiveOutcome = {
    ...facts,
    saved_at: new Date(deps.now()).toISOString(),
    export_hash: hash,
  };
  const { data: landed, error: oErr } = await deps.service
    .from("interview_sessions")
    .update({ live_outcome: outcome })
    .eq("id", sessionId)
    .eq("kind", "live")
    .is("live_outcome", null)
    .select("id");
  if (oErr) throw new LiveIngestError("db_error", "outcome write");
  if (((landed ?? []) as unknown[]).length === 0) {
    const now = await readSession(deps.service, sessionId);
    const theirs = now ? storedFor(now, hash) : null;
    if (theirs) return { outcome: theirs, saved: false };
    throw new LiveIngestError("db_error", "the outcome did not land");
  }
  console.log(
    `[live-ingest] session ${sessionId}: ${rows.length} turns, outcome ${outcome.outcome}, answered ${outcome.answered_count}/${outcome.total}, timing suspect ${outcome.timing_suspect_turns.length}, wording flags ${outcome.wording_flags.length}`,
  );
  return { outcome, saved: true };
}
