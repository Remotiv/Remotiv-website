import { MAX_FOLLOW_UPS_PER_BASE_QUESTION } from "@/lib/interviews/types";
import type {
  ExportStatus,
  ExportStatusCode,
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
 *                              and procedural as they are; acknowledgment ->
 *                              procedural; answer -> null (candidate turns
 *                              carry no kind, as interview_turns requires)
 *   question_id (integer)   -> question_position, checked against the
 *                              position base_question_id points to
 *   sequence                -> his number when every turn has one, else the
 *                              array order
 *   offset_ms, audio_duration_ms (or the _seconds pair) -> offset_ms, duration_ms
 *   started_at + offset     -> each turn's started_at and ended_at. His per-turn
 *                              "timestamp" is not used: it is the start of an
 *                              interviewer turn but the end of a candidate one.
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
  | "unknown_responds_to";

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

const STATUS_CODES: Readonly<Record<string, ExportStatusCode>> = {
  completed: "completed",
  complete: "completed",
  finished: "completed",
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
};
const CANDIDATE_TYPES: ReadonlySet<string> = new Set(["answer"]);

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

function parseStatus(raw: unknown): ExportStatus {
  const provider_status = nonEmpty(raw);
  if (provider_status === null) return { code: "unknown", provider_status: null };
  return { code: STATUS_CODES[provider_status.trim().toLowerCase()] ?? "unknown", provider_status };
}

function parseQuestions(raw: unknown): ParsedExport["questions"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new LiveExportError("bad_questions", "questions is not an array");
  return raw.map((q, i) => {
    const position = isObj(q) ? finite(q.position) : null;
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
      followUpReason = nonEmpty(t.follow_up_reason);
      if (followUpReason === null) {
        throw new LiveExportError("bad_follow_up", "a follow-up needs a reason", i);
      }
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
      started_at: startedTurn,
      ended_at: plusMs(startedTurn, durationMs),
      audio_file_name: nonEmpty(
        speaker === "interviewer" ? t.interviewer_audio_file : t.audio_file,
      ),
    };
  });
  turns.sort((a, b) => a.sequence - b.sequence);

  const overlaps: TurnOverlap[] = [];
  let lastInterviewer: LiveTurn | null = null;
  for (const turn of turns) {
    if (turn.speaker === "interviewer") {
      lastInterviewer = turn;
      continue;
    }
    if (!lastInterviewer) continue;
    const overlap = lastInterviewer.offset_ms + lastInterviewer.duration_ms - turn.offset_ms;
    if (overlap > 0) overlaps.push({ sequence: turn.sequence, overlap_ms: overlap });
  }

  const endedAt = nonEmpty(raw.ended_at);
  return {
    provider_session_id: providerSessionId,
    status: parseStatus(raw.status),
    interviewer_name: nonEmpty(raw.interviewer_name),
    started_at: startedAt,
    ended_at: endedAt !== null && Number.isFinite(Date.parse(endedAt)) ? endedAt : null,
    duration_ms: millis(raw, "duration_ms", "duration_seconds"),
    questions,
    turns,
    warnings: {
      overlaps: {
        count: overlaps.length,
        max_ms: overlaps.reduce((m, o) => Math.max(m, o.overlap_ms), 0),
        turns: overlaps,
      },
    },
  };
}
