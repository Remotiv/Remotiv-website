import { MAX_FOLLOW_UPS_PER_BASE_QUESTION } from "@/lib/interviews/types";
import type {
  ExportStatus,
  ExportStatusCode,
  Interruption,
  InterruptionAmbiguity,
  LiveSpeaker,
  LiveTurn,
  LiveTurnKind,
  ParsedExport,
  TurnOverlap,
} from "./types";

/**
 * The provider's end-of-session export (format v0: the sample he sent on
 * 16 Oct 2026), narrowed to what Remotiv keeps.
 *
 * ── Built field by field, never spread ───────────────────────
 *
 * The export also carries the CV, the job text, the candidate's first name,
 * a questions_completed count and the provider's own transcript of every
 * candidate turn. None of them is read into the result: it is assembled from
 * named fields only, so a field the provider adds later is dropped too, not
 * carried by accident. Remotiv transcribes the candidate's audio itself;
 * interviewer text is kept, because it is the exact question that was put.
 *
 * ── Mapping ──────────────────────────────────────────────────
 *
 *   role                    -> speaker (interviewer | candidate)
 *   turn_type               -> kind: base_question, follow_up, clarification
 *                              and procedural as they are; acknowledgment,
 *                              greeting and user_interrupted -> procedural;
 *                              answer -> null (candidate turns carry no kind,
 *                              as interview_turns requires)
 *   questions[].position    -> the question's position; when no question has
 *                              one, its place in questions[] (1, 2, ...). A mix
 *                              is refused.
 *   question_id (integer)   -> question_position, checked against the
 *                              position base_question_id points to
 *   sequence                -> his number when every turn has one, else the
 *                              array order
 *   offset_ms, audio_duration_ms (or the _seconds pair) -> offset_ms, duration_ms
 *   started_at + offset     -> each turn's started_at and ended_at. His per-turn
 *                              "timestamp" is not used: it is the start of an
 *                              interviewer turn but the end of a candidate one.
 *   interviewer_audio_file  -> an interviewer turn's audio, else its audio_file
 *   follow_up_reason        -> kept; when absent, FOLLOW_UP_REASON_NOT_GIVEN
 *                              (migration 021 requires a reason on a follow-up)
 *
 * An acknowledgment that answers no turn and comes right before a new base
 * question belongs to the previous answer's question, not the next one: it
 * acknowledges what was just said (F15, 26 Oct 2026).
 *
 * ── How it ended (F15, 26 Oct 2026) ──────────────────────────
 *
 * Completed only when end_reason is "completed" AND completed_gracefully is
 * true. `status` alone never makes an interview completed, and a missing
 * end_reason never falls back to it for that. Any other ending is read from
 * end_reason, else status, as before; when both are sent and disagree, the
 * ending is unknown. Both words and the flag are kept for the record.
 *
 * ── Fail closed ──────────────────────────────────────────────
 *
 * Anything the table would refuse, or that cannot be placed, throws
 * LiveExportError with a code and the turn's index, never its content.
 *
 * ── Overlap, reported not refused ────────────────────────────
 *
 * In the sample every candidate turn starts while the interviewer turn before
 * it is still playing, by 6 to 11 seconds. If that is the candidate's audio
 * starting early, its transcript would carry the interviewer's words. It is
 * returned as a warning per turn until the provider says what the offsets mean.
 *
 * ── Interruptions (agreed with the provider, 19 Oct 2026) ────
 *
 * An interviewer turn the candidate cut off carries `interrupted: true` and,
 * optionally, `audio_stopped_ms` (or `_seconds`): where the interviewer's audio
 * stopped, between the turn's start and end. A candidate turn that starts
 * inside an interrupted turn is the one overlap that is expected, so it is not
 * warned about. `interrupted` on a candidate turn, a stop time on a turn not
 * marked interrupted, or a stop time outside the turn, is refused.
 *
 * The provider also sends the interviewer's line after the cut-in as its own
 * turn, turn_type "user_interrupted" (F15, 26 Oct 2026). It is a procedural
 * turn marked interruption_line, and it places the interruption: when it
 * starts while the interviewer turn before it is playing, that turn is marked
 * interrupted and its audio stopped where the line starts. The turn's own
 * offsets and audio stay as sent: the stop time is kept in `interruptions`,
 * never written over its duration, and the turn's audio_stopped_ms stays
 * what the provider sent. Anything that does not place cleanly is kept and
 * named in the interruption's `ambiguity`. When no candidate turn holds what
 * the candidate said while cutting in, candidate_speech_exported is false.
 *
 * ── Repeats (agreed with the provider, 19 Oct 2026) ──────────
 *
 * The interviewer may repeat a question after an interruption, after a
 * silence, or when asked. A repeat is marked, either as turn_type "repeat" or
 * as a base_question with `is_repeat: true`, and becomes a PROCEDURAL turn at
 * the question's position with `repeat: true`: it adds no main question, no
 * follow-up and no scoring entry. A repeat must name its question. An
 * unmarked second base_question for a position is still a second main
 * question, and live-ingest.ts refuses it.
 */

export type LiveExportErrorCode =
  | "not_an_object"
  | "missing_session_id"
  | "missing_started_at"
  | "missing_turns"
  | "bad_questions"
  | "bad_turn"
  | "duplicate_turn_id"
  | "unknown_speaker"
  | "unknown_turn_type"
  | "bad_sequence"
  | "negative_offset"
  | "bad_duration"
  | "missing_interviewer_text"
  | "bad_follow_up"
  | "bad_question_position"
  | "missing_responds_to"
  | "unknown_responds_to"
  | "bad_interruption"
  | "bad_repeat";

/** A broken export. The message names the rule and the turn's index, never its content. */
export class LiveExportError extends Error {
  readonly code: LiveExportErrorCode;
  readonly turnIndex: number | null;

  constructor(code: LiveExportErrorCode, detail: string, turnIndex: number | null = null) {
    super(`live export: ${code}${turnIndex === null ? "" : ` at turn ${turnIndex}`}: ${detail}`);
    this.name = "LiveExportError";
    this.code = code;
    this.turnIndex = turnIndex;
  }
}

// Only "completed" is a normal close (D2). "complete" and "finished" are not
// listed: unconfirmed words read as unknown until the provider confirms them
// (D10), so they can never make an interview completed.
const STATUS_CODES: Readonly<Record<string, ExportStatusCode>> = {
  completed: "completed",
  candidate_ended: "candidate_ended",
  candidate_left: "candidate_ended",
  time_limit: "timed_out",
  timed_out: "timed_out",
  timeout: "timed_out",
  error: "provider_error",
  provider_error: "provider_error",
};

const INTERVIEWER_KINDS: Readonly<Record<string, LiveTurnKind>> = {
  base_question: "base_question",
  follow_up: "follow_up",
  clarification: "clarification",
  procedural: "procedural",
  acknowledgment: "procedural",
  greeting: "procedural",
  user_interrupted: "procedural",
  repeat: "procedural",
};
const CANDIDATE_TYPES: ReadonlySet<string> = new Set(["answer"]);

/**
 * A follow-up's reason when the provider sends none. Migration 021 requires a
 * reason on every follow-up, so the turn says plainly that there was none.
 */
export const FOLLOW_UP_REASON_NOT_GIVEN = "No reason given by the provider.";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Milliseconds from the _ms field, else from the _seconds one; null when neither is a number. */
function millis(t: Obj, ms: string, seconds: string): number | null {
  const m = finite(t[ms]);
  if (m !== null) return Math.round(m);
  const s = finite(t[seconds]);
  return s === null ? null : Math.round(s * 1000);
}

const codeOf = (word: string | null): ExportStatusCode | null =>
  word === null ? null : (STATUS_CODES[word.trim().toLowerCase()] ?? "unknown");

/** How it ended: see the top. Completed needs end_reason "completed" and completed_gracefully true. */
function parseStatus(raw: Obj): ExportStatus {
  const provider_status = nonEmpty(raw.status);
  const end_reason = nonEmpty(raw.end_reason);
  const completed_gracefully =
    typeof raw.completed_gracefully === "boolean" ? raw.completed_gracefully : null;
  const fromReason = codeOf(end_reason);
  const fromStatus = codeOf(provider_status);
  let code: ExportStatusCode = fromReason ?? fromStatus ?? "unknown";
  if (fromReason !== null && fromStatus !== null && fromReason !== fromStatus) code = "unknown";
  if (code === "completed" && (fromReason !== "completed" || completed_gracefully !== true)) {
    code = "unknown";
  }
  return { code, provider_status, end_reason, completed_gracefully };
}

const hasValue = (v: unknown) => v !== undefined && v !== null;

function parseQuestions(raw: unknown): ParsedExport["questions"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new LiveExportError("bad_questions", "questions is not an array");
  // No position anywhere: the order. One anywhere: every question needs its own,
  // so a mix is refused below.
  const byOrder = !raw.some((q) => isObj(q) && hasValue(q.position));
  return raw.map((q, i) => {
    const position = byOrder ? i + 1 : isObj(q) ? finite(q.position) : null;
    const text = isObj(q) ? nonEmpty(q.text) : null;
    if (position === null || !Number.isInteger(position) || position < 1 || text === null) {
      throw new LiveExportError("bad_questions", `question ${i} needs a position and text`);
    }
    return { position, text, provider_question_id: nonEmpty((q as Obj).id) };
  });
}

/** The sequence for every turn: his numbers when all present, else 1..n. */
function sequences(turns: readonly Obj[]): number[] {
  const given = turns.map((t) => t.sequence);
  if (given.every((s) => s === undefined)) return turns.map((_, i) => i + 1);
  const seen = new Set<number>();
  return given.map((s, i) => {
    if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || seen.has(s)) {
      throw new LiveExportError("bad_sequence", "sequence must be a unique integer from 1", i);
    }
    seen.add(s);
    return s;
  });
}

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** The question a turn belongs to: its own position, or the one of the turn it answers. */
function positionOf(turns: readonly LiveTurn[], t: LiveTurn): number | null {
  if (t.question_position !== null) return t.question_position;
  const answered = turns.find((x) => x.provider_turn_id === t.responds_to_provider_turn_id);
  return answered?.question_position ?? null;
}

function ambiguityOf(line: LiveTurn, before: LiveTurn | undefined): InterruptionAmbiguity | null {
  if (!before) return "no_turn_before";
  if (before.interruption_line) return "after_another_line";
  if (
    line.offset_ms <= before.offset_ms ||
    line.offset_ms >= before.offset_ms + before.duration_ms
  ) {
    return "starts_outside_turn";
  }
  if (before.audio_stopped_ms !== null && before.audio_stopped_ms > line.offset_ms) {
    return "stop_after_line";
  }
  return null;
}

/**
 * What the interruption line at turns[i] says about the interviewer turn
 * before it (see the top). Marks that turn interrupted when the line places
 * cleanly; no offset, duration or audio is changed.
 */
function placeLine(turns: LiveTurn[], i: number): Interruption {
  const line = turns[i];
  const before = turns.slice(0, i).findLast((x) => x.speaker === "interviewer");
  const next = turns[i + 1];
  const ambiguity = ambiguityOf(line, before);
  // Any candidate turn starting between the cut-off turn's start and the line,
  // whatever its sequence, holds what the candidate said while cutting in.
  const from = before?.offset_ms ?? 0;
  const candidateSpeechExported = turns.some(
    (x) => x.speaker === "candidate" && x.offset_ms >= from && x.offset_ms < line.offset_ms,
  );
  const placed = ambiguity === null && before !== undefined;
  if (placed) before.interrupted = true;
  const providerStop = placed ? before.audio_stopped_ms : null;
  return {
    line_sequence: line.sequence,
    interrupted_sequence: before?.sequence ?? null,
    position:
      (before ? positionOf(turns, before) : null) ?? (next?.repeat ? next.question_position : null),
    stopped_ms: placed ? (providerStop ?? line.offset_ms) : null,
    stop_source: placed ? (providerStop !== null ? "provider" : "line_start") : null,
    ambiguity,
    candidate_speech_exported: candidateSpeechExported,
  };
}

/**
 * The provider's export, narrowed and checked. Throws LiveExportError on
 * anything that cannot be recorded as given.
 */
export function parseExport(raw: unknown): ParsedExport {
  if (!isObj(raw)) throw new LiveExportError("not_an_object", "the export is not an object");
  const providerSessionId = nonEmpty(raw.session_id);
  if (providerSessionId === null) {
    throw new LiveExportError("missing_session_id", "session_id is missing or empty");
  }
  const startedAt = nonEmpty(raw.started_at);
  if (startedAt === null || !Number.isFinite(Date.parse(startedAt))) {
    throw new LiveExportError("missing_started_at", "started_at is missing or not a date");
  }
  if (!Array.isArray(raw.turns) || raw.turns.length === 0) {
    throw new LiveExportError("missing_turns", "turns is missing or empty");
  }
  const rawTurns = raw.turns.map((t, i) => {
    if (!isObj(t)) throw new LiveExportError("bad_turn", "turn is not an object", i);
    return t;
  });
  const questions = parseQuestions(raw.questions);
  const positionByQuestionId = new Map(
    questions
      .filter((q) => q.provider_question_id !== null)
      .map((q) => [q.provider_question_id as string, q.position]),
  );

  const ids = new Set<string>();
  rawTurns.forEach((t, i) => {
    const id = nonEmpty(t.turn_id);
    if (id === null) throw new LiveExportError("bad_turn", "turn_id is missing", i);
    if (ids.has(id)) throw new LiveExportError("duplicate_turn_id", "turn_id is used twice", i);
    ids.add(id);
  });

  const seq = sequences(rawTurns);
  const turns: LiveTurn[] = rawTurns.map((t, i) => {
    const providerTurnId = t.turn_id as string;
    const role = t.role;
    if (role !== "interviewer" && role !== "candidate") {
      throw new LiveExportError("unknown_speaker", "role is not interviewer or candidate", i);
    }
    const speaker: LiveSpeaker = role;
    const turnType = nonEmpty(t.turn_type);
    let kind: LiveTurnKind | null = null;
    if (speaker === "interviewer") {
      kind = turnType === null ? null : (INTERVIEWER_KINDS[turnType] ?? null);
      if (kind === null) throw new LiveExportError("unknown_turn_type", "interviewer turn_type", i);
    } else if (turnType === null || !CANDIDATE_TYPES.has(turnType)) {
      throw new LiveExportError("unknown_turn_type", "candidate turn_type", i);
    }
    if (t.is_repeat !== undefined && t.is_repeat !== null && typeof t.is_repeat !== "boolean") {
      throw new LiveExportError("bad_repeat", "is_repeat must be true or false", i);
    }
    if (t.is_repeat === true && turnType !== "base_question") {
      throw new LiveExportError("bad_repeat", "only a base_question is marked is_repeat", i);
    }
    const repeat = turnType === "repeat" || t.is_repeat === true;
    if (repeat) kind = "procedural";

    const offsetMs = millis(t, "offset_ms", "offset_seconds");
    if (offsetMs === null || offsetMs < 0) {
      throw new LiveExportError("negative_offset", "offset is missing or below zero", i);
    }
    const durationMs = millis(t, "audio_duration_ms", "audio_duration_seconds");
    if (durationMs === null || durationMs <= 0) {
      throw new LiveExportError("bad_duration", "duration is missing or not above zero", i);
    }

    let text: string | null = null;
    if (speaker === "interviewer") {
      text = nonEmpty(t.text);
      if (text === null) throw new LiveExportError("missing_interviewer_text", "no text", i);
    }

    let followUpIndex: 1 | 2 | null = null;
    let followUpReason: string | null = null;
    if (kind === "follow_up") {
      const n = t.follow_up_index;
      if ((n !== 1 && n !== 2) || n > MAX_FOLLOW_UPS_PER_BASE_QUESTION) {
        throw new LiveExportError("bad_follow_up", "follow_up_index must be 1 or 2", i);
      }
      followUpIndex = n;
      if (hasValue(t.follow_up_reason) && typeof t.follow_up_reason !== "string") {
        throw new LiveExportError("bad_follow_up", "follow_up_reason is not text", i);
      }
      followUpReason = nonEmpty(t.follow_up_reason) ?? FOLLOW_UP_REASON_NOT_GIVEN;
    } else if (t.follow_up_index != null || t.follow_up_reason != null) {
      throw new LiveExportError("bad_follow_up", "only a follow-up carries an index or reason", i);
    }

    let questionPosition: number | null = null;
    if (t.question_id != null) {
      const p = finite(t.question_id);
      if (p === null || !Number.isInteger(p) || p < 1) {
        throw new LiveExportError("bad_question_position", "question_id is not a position", i);
      }
      questionPosition = p;
    }
    const baseId = nonEmpty(t.base_question_id);
    if (baseId !== null && positionByQuestionId.has(baseId)) {
      const p = positionByQuestionId.get(baseId) as number;
      if (questionPosition !== null && questionPosition !== p) {
        throw new LiveExportError(
          "bad_question_position",
          "question_id disagrees with base_question_id",
          i,
        );
      }
      questionPosition = p;
    }
    if (questionPosition === null && kind !== null && kind !== "procedural") {
      throw new LiveExportError("bad_question_position", "the turn names no question", i);
    }
    if (repeat && questionPosition === null) {
      throw new LiveExportError("bad_repeat", "a repeat names no question", i);
    }

    const respondsTo = nonEmpty(t.responds_to_turn_id);
    if (respondsTo === null) {
      if (speaker === "candidate" || kind === "follow_up" || kind === "clarification") {
        throw new LiveExportError("missing_responds_to", "the turn answers nothing", i);
      }
    } else if (!ids.has(respondsTo) || respondsTo === providerTurnId) {
      throw new LiveExportError(
        "unknown_responds_to",
        "responds_to_turn_id is not another turn",
        i,
      );
    }

    if (
      t.interrupted !== undefined &&
      t.interrupted !== null &&
      typeof t.interrupted !== "boolean"
    ) {
      throw new LiveExportError("bad_interruption", "interrupted must be true or false", i);
    }
    const interrupted = t.interrupted === true;
    if (interrupted && speaker !== "interviewer") {
      throw new LiveExportError("bad_interruption", "only an interviewer turn is interrupted", i);
    }
    const stoppedMs = millis(t, "audio_stopped_ms", "audio_stopped_seconds");
    if (stoppedMs !== null) {
      if (!interrupted) {
        throw new LiveExportError("bad_interruption", "a stop time needs interrupted: true", i);
      }
      if (stoppedMs < offsetMs || stoppedMs > offsetMs + durationMs) {
        throw new LiveExportError("bad_interruption", "the stop time is outside the turn", i);
      }
    }

    const startedTurn = plusMs(startedAt, offsetMs);
    return {
      provider_turn_id: providerTurnId,
      sequence: seq[i],
      speaker,
      kind,
      question_position: questionPosition,
      follow_up_index: followUpIndex,
      follow_up_reason: followUpReason,
      responds_to_provider_turn_id: respondsTo,
      text,
      offset_ms: offsetMs,
      duration_ms: durationMs,
      interrupted,
      audio_stopped_ms: stoppedMs,
      repeat,
      interruption_line: turnType === "user_interrupted",
      started_at: startedTurn,
      ended_at: plusMs(startedTurn, durationMs),
      audio_file_name:
        speaker === "interviewer"
          ? (nonEmpty(t.interviewer_audio_file) ?? nonEmpty(t.audio_file))
          : nonEmpty(t.audio_file),
    };
  });
  const turnTypes = new Map(rawTurns.map((t, i) => [turns[i].provider_turn_id, t.turn_type]));
  turns.sort((a, b) => a.sequence - b.sequence);

  turns.forEach((t, i) => {
    const next = turns[i + 1];
    if (
      turnTypes.get(t.provider_turn_id) !== "acknowledgment" ||
      t.responds_to_provider_turn_id !== null ||
      next?.kind !== "base_question"
    ) {
      return;
    }
    const answer = turns.slice(0, i).findLast((x) => x.speaker === "candidate");
    const position = answer ? positionOf(turns, answer) : null;
    if (position !== null) t.question_position = position;
  });

  const interruptions = turns.flatMap((t, i) => (t.interruption_line ? [placeLine(turns, i)] : []));

  const overlaps: TurnOverlap[] = [];
  let lastInterviewer: LiveTurn | null = null;
  for (const turn of turns) {
    if (turn.speaker === "interviewer") {
      lastInterviewer = turn;
      continue;
    }
    // A marked interruption is the overlap that is expected.
    if (!lastInterviewer || lastInterviewer.interrupted) continue;
    const overlap = lastInterviewer.offset_ms + lastInterviewer.duration_ms - turn.offset_ms;
    if (overlap > 0) overlaps.push({ sequence: turn.sequence, overlap_ms: overlap });
  }

  const endedAt = nonEmpty(raw.ended_at);
  return {
    provider_session_id: providerSessionId,
    status: parseStatus(raw),
    interviewer_name: nonEmpty(raw.interviewer_name),
    started_at: startedAt,
    ended_at: endedAt !== null && Number.isFinite(Date.parse(endedAt)) ? endedAt : null,
    duration_ms: millis(raw, "duration_ms", "duration_seconds"),
    questions,
    turns,
    interruptions,
    warnings: {
      overlaps: {
        count: overlaps.length,
        max_ms: overlaps.reduce((m, o) => Math.max(m, o.overlap_ms), 0),
        turns: overlaps,
      },
    },
  };
}
