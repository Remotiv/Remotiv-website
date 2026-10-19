/**
 * The AI Video Interview provider, as Remotiv's code sees it.
 *
 * The provider runs the live conversation; Remotiv owns the questions, the
 * candidate video, transcription, scoring and retention
 * (AI-VIDEO-INTERVIEW-PHASE-1.md, B1). Its real API is not final, so this is
 * the shape Remotiv codes against, with a fake (fake-provider.ts) behind it
 * until the real client exists.
 *
 * ── What crosses to the provider ─────────────────────────────
 *
 * CreateSessionInput is everything the provider receives, and nothing else:
 * Remotiv's session id, the interviewer's name, the interview length, the
 * frozen questions as position and text only, the candidate's first name and
 * the CV with contact details removed (cv-sanitize.ts), for follow-ups. Never
 * the rubric, competency or weight: an interviewer holding the mark scheme
 * asks for exactly what scores well (the blocking question in the Phase 1
 * doc). buildCreateSessionInput (create-session.ts) is the only way to make
 * one, and it copies position and text field by field.
 *
 * ── What comes back ──────────────────────────────────────────
 *
 * ParsedExport is the provider's end-of-session export narrowed to what
 * Remotiv keeps: the session's status and times, the questions as asked, and
 * one LiveTurn per turn, in the shape of the interview_turns table (migration
 * 021). The CV, the job text, the candidate's name and the provider's
 * transcript of the candidate are never carried: Remotiv transcribes the
 * candidate's audio itself.
 */

/** One frozen question as the provider receives it. Position and text, nothing about marking. */
export type ProviderQuestion = { position: number; text: string };

export type CreateSessionInput = {
  remotiv_session_id: string;
  interviewer_name: string;
  interview_minutes: number;
  questions: readonly ProviderQuestion[];
  candidate_first_name: string | null;
  /** Already sanitised: no email, phone, link or address. For follow-ups only. */
  cv_text: string;
};

export type CreateSessionResult = { providerSessionId: string };

/** How the session ended, as the provider reported it. Submitted or abandoned is decided elsewhere. */
export const EXPORT_STATUS_CODES = [
  "completed",
  "candidate_ended",
  "timed_out",
  "provider_error",
  "unknown",
] as const;
export type ExportStatusCode = (typeof EXPORT_STATUS_CODES)[number];
export type ExportStatus = {
  code: ExportStatusCode;
  /** The provider's own word, kept for the record. Null when it sent none. */
  provider_status: string | null;
};

export type LiveSpeaker = "interviewer" | "candidate";
/** interview_turns.kind: interviewer turns only; null on every candidate turn. */
export type LiveTurnKind = "base_question" | "follow_up" | "clarification" | "procedural";

/**
 * One turn, in interview_turns' column names. Two fields differ from the
 * table on purpose:
 *   - responds_to_provider_turn_id holds the PROVIDER's turn id. The table's
 *     responds_to_turn_id is the id of Remotiv's own row, which only exists
 *     once ingestion has written the turn it points to.
 *   - audio_file_name is the provider's name for the turn's audio. The table
 *     keeps a Remotiv path, type, size and hash, filled when the file lands.
 */
export type LiveTurn = {
  provider_turn_id: string;
  sequence: number;
  speaker: LiveSpeaker;
  kind: LiveTurnKind | null;
  question_position: number | null;
  follow_up_index: 1 | 2 | null;
  follow_up_reason: string | null;
  responds_to_provider_turn_id: string | null;
  /** Interviewer turns: the exact generated text. Candidate turns: always null. */
  text: string | null;
  offset_ms: number;
  duration_ms: number;
  /** Session start plus offset_ms, then plus duration_ms: one clock for every turn. */
  started_at: string;
  ended_at: string;
  audio_file_name: string | null;
};

/** A candidate turn that starts before the interviewer turn before it has finished. */
export type TurnOverlap = { sequence: number; overlap_ms: number };

export type ParsedExport = {
  provider_session_id: string;
  status: ExportStatus;
  interviewer_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  questions: readonly (ProviderQuestion & { provider_question_id: string | null })[];
  turns: readonly LiveTurn[];
  warnings: {
    overlaps: { count: number; max_ms: number; turns: readonly TurnOverlap[] };
  };
};

export interface LiveInterviewProvider {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  deleteSession(providerSessionId: string): Promise<void>;
  /** The provider's export, narrowed and checked. Throws LiveExportError on broken input. */
  parseExport(raw: unknown): ParsedExport;
}
