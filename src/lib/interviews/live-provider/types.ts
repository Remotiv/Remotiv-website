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

/**
 * The scripted interviews MockVoxAgent can play (AVI commit 10). The texts
 * are made up and live with the mock in the candidate screen; only the id
 * crosses from the server.
 */
export const MOCK_SCRIPT_IDS = [
  "completed",
  "interruption",
  "candidate_ends",
  "timed_out",
  "provider_error",
  "connection_lost",
] as const;
export type MockScriptId = (typeof MOCK_SCRIPT_IDS)[number];

/**
 * What the candidate's browser is given to join the conversation: the
 * short-lived connection details and nothing else. Never the provider's API
 * key, never the provider session id, never anything about the questions.
 *
 * `turnDetection` says who decides the candidate has finished speaking. Only
 * "server" is implemented: the browser does no end-of-turn detection of its
 * own until the provider confirms whose job it is, and a ticket asking for
 * "client" is refused by the screen.
 */
export type JoinTicket =
  | { mode: "mock"; script: MockScriptId; turnDetection: "server" | "client" }
  | {
      mode: "voxagent";
      wsUrl: string;
      wsToken: string;
      upstreamHz: 16000;
      downstreamHz: 24000;
      turnDetection: "server" | "client";
    };

/**
 * How the session ended, as the provider reported it. Submitted or abandoned
 * is decided elsewhere. "disconnected" (F15b, 27 Oct 2026) is the provider's
 * confirmed word for a connection that dropped: a terminal ending, never
 * completed, and always for a person to review.
 */
export const EXPORT_STATUS_CODES = [
  "completed",
  "candidate_ended",
  "timed_out",
  "provider_error",
  "disconnected",
  "unknown",
] as const;
export type ExportStatusCode = (typeof EXPORT_STATUS_CODES)[number];
export type ExportStatus = {
  code: ExportStatusCode;
  /** The provider's own word, kept for the record. Null when it sent none. */
  provider_status: string | null;
  /** The provider's end_reason, kept for the record. Null when it sent none. */
  end_reason: string | null;
  /** The provider's completed_gracefully. Null when it sent none, or not true or false. */
  completed_gracefully: boolean | null;
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
  /**
   * Interviewer turns only: the candidate cut the interviewer off. The only
   * case in which a candidate turn may start before the interviewer turn
   * before it has ended (rule agreed with the provider, 19 Oct 2026).
   */
  interrupted: boolean;
  /** For an interrupted turn: where on the session clock the interviewer's audio stopped. */
  audio_stopped_ms: number | null;
  /**
   * A marked repeat of a question already asked (after an interruption, a
   * silence, or on request). Always a procedural turn at the question's
   * position: never a second main question, never a follow-up.
   */
  repeat: boolean;
  /**
   * The interviewer's line after the candidate cut in (turn_type
   * "user_interrupted", for example "Let me just finish the question."). A
   * procedural turn; what it tells about the interruption is in
   * ParsedExport.interruptions.
   */
  interruption_line: boolean;
  /**
   * Candidate turns only: what the candidate said while cutting in (turn_type
   * "interruption", F15b, 27 Oct 2026). Kept, with its audio, and transcribed
   * like every candidate turn; never an answer, never counted, never scored.
   */
  candidate_interruption: boolean;
  /** Session start plus offset_ms, then plus duration_ms: one clock for every turn. */
  started_at: string;
  ended_at: string;
  audio_file_name: string | null;
};

/** A candidate turn that starts before the interviewer turn before it has finished, with no interruption marked. */
export type TurnOverlap = { sequence: number; overlap_ms: number };

/** Why an interruption line could not be placed with confidence. */
export type InterruptionAmbiguity =
  /** No interviewer turn comes before the line. */
  | "no_turn_before"
  /** The interviewer turn before it is itself an interruption line. */
  | "after_another_line"
  /** The line does not start while the interviewer turn before it is playing. */
  | "starts_outside_turn"
  /** The provider's own stop time for that turn is after the line starts. */
  | "stop_after_line";

/**
 * One interruption line, and what it says about the turn it cut off. Every
 * turn's offsets and audio stay exactly as the provider sent them: the stop
 * time is kept here, never written over a turn's duration.
 */
export type Interruption = {
  line_sequence: number;
  /** The interviewer turn the candidate cut off; null when there is none before the line. */
  interrupted_sequence: number | null;
  /** The question it happened on: the cut-off turn's, else the repeat's after the line. */
  position: number | null;
  /** Where the interviewer's audio stopped, on the session clock. Null when ambiguous. */
  stopped_ms: number | null;
  /** "provider": its own audio_stopped_ms; "line_start": where the line starts. */
  stop_source: "provider" | "line_start" | null;
  ambiguity: InterruptionAmbiguity | null;
  /**
   * A candidate turn holds what the candidate said while cutting in. False
   * when the export has none: that speech is not captured, and never counted
   * as if it were.
   */
  candidate_speech_exported: boolean;
};

export type ParsedExport = {
  provider_session_id: string;
  status: ExportStatus;
  interviewer_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  questions: readonly (ProviderQuestion & { provider_question_id: string | null })[];
  turns: readonly LiveTurn[];
  interruptions: readonly Interruption[];
  warnings: {
    overlaps: { count: number; max_ms: number; turns: readonly TurnOverlap[] };
  };
};

/** One turn's audio, as the provider hands it over. */
export type TurnAudio = { bytes: Uint8Array; mime_type: string | null };

export interface LiveInterviewProvider {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  deleteSession(providerSessionId: string): Promise<void>;
  /** The audio of one turn of the session, by the file name the export gives it. */
  fetchAudio(providerSessionId: string, fileName: string): Promise<TurnAudio>;
  /** The provider's export, narrowed and checked. Throws LiveExportError on broken input. */
  parseExport(raw: unknown): ParsedExport;
}
