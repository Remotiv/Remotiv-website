import { CUT_IN_MS, LISTEN_MS, type MockStep } from "../[token]/_live/mock-voxagent";

/**
 * A replay of one real VoxAgent session (Arham's test session) for the live
 * screen demo: Sarah's own recorded turns, in the session JSON's turn order.
 * Pure, so the script is tested without the session folder.
 *
 *   interviewer turn      her recorded clip of that turn, the JSON text as
 *                         the caption (greeting, questions, follow-ups,
 *                         acknowledgments, reminders, the interruption line,
 *                         the repeat)
 *   candidate answer      listening, as in the mock: the 15 s timer or the
 *                         demo's Simulate buttons. Candidate audio is never
 *                         played or served.
 *   candidate interruption  not a step: it becomes the cut-in on the
 *                         question it interrupted, 1.2 s into her clip, and
 *                         the session's own line and repeat clips follow
 *   the end               the session's end_reason and completed_gracefully,
 *                         as sent
 *
 * Only clips named by an interviewer turn's audio_file
 * (interviewer_turn_NNN.wav) are ever part of it.
 */

export type ReplayScript = {
  steps: MockStep[];
  /** Clip ids (audio_file without .wav) of every interviewer turn, in order. */
  clips: string[];
};

const CLIP_ID = /^interviewer_turn_\d{3}$/;
const QUESTION_TYPES = new Set(["base_question", "follow_up", "repeat"]);
/** A short pause between an answer and her next line, as in the mock scripts. */
const THINK_MS = 800;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** "interviewer_turn_007.wav" -> "interviewer_turn_007"; anything else -> null. */
export function clipIdOf(file: unknown): string | null {
  if (typeof file !== "string" || !file.endsWith(".wav")) return null;
  const id = file.slice(0, -4);
  return CLIP_ID.test(id) ? id : null;
}

export function isReplayClipId(value: unknown): value is string {
  return typeof value === "string" && CLIP_ID.test(value);
}

/** The interviewer turns a "user_interrupted" line cut off: the turn it answers, else the one before it. */
function interruptedTurns(turns: Obj[]): Set<string> {
  const ids = new Set<string>();
  turns.forEach((t, i) => {
    if (t.role !== "interviewer" || t.turn_type !== "user_interrupted") return;
    const target = turns.find(
      (x) => x.turn_id === t.responds_to_turn_id && x.role === "interviewer",
    );
    const before = turns.slice(0, i).findLast((x) => x.role === "interviewer");
    const cut = target ?? before;
    if (typeof cut?.turn_id === "string") ids.add(cut.turn_id);
  });
  return ids;
}

/** The replay script of a session JSON, or null when it is not one. */
export function buildReplayScript(session: unknown): ReplayScript | null {
  if (!isObj(session) || !Array.isArray(session.turns)) return null;
  const turns = session.turns.filter(isObj);
  const cut = interruptedTurns(turns);
  const steps: MockStep[] = [];
  const clips: string[] = [];
  for (const t of turns) {
    if (t.role === "interviewer") {
      const clip = clipIdOf(t.audio_file);
      if (!clip || typeof t.text !== "string" || !t.text.trim()) continue;
      clips.push(clip);
      steps.push({
        say: t.text,
        clip,
        ...(QUESTION_TYPES.has(String(t.turn_type)) ? { question: true as const } : {}),
        ...(typeof t.turn_id === "string" && cut.has(t.turn_id)
          ? { interruptAtMs: CUT_IN_MS, cutContinues: true as const }
          : {}),
      });
    } else if (t.role === "candidate" && t.turn_type === "answer") {
      steps.push({ listen: LISTEN_MS }, { think: THINK_MS });
    }
  }
  if (steps.length === 0) return null;
  const endReason =
    typeof session.end_reason === "string"
      ? session.end_reason
      : typeof session.status === "string"
        ? session.status
        : "unknown";
  steps.push({ end: endReason, graceful: session.completed_gracefully === true });
  return { steps, clips };
}

/** A WAV file's format and its PCM samples' bytes, or null when it is not a PCM WAV. */
export function readWav(
  bytes: Uint8Array,
): { format: number; channels: number; rate: number; bits: number; data: Uint8Array } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const name = ascii(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (name === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    }
    if (name === "data") return fmt ? { ...fmt, data: bytes.subarray(body, body + size) } : null;
    at = body + size + (size % 2);
  }
  return null;
}

/** 24 kHz mono 16-bit PCM: what the screen's playback takes as is. */
export function isPlaybackFormat(f: {
  format: number;
  channels: number;
  rate: number;
  bits: number;
}) {
  return f.format === 1 && f.channels === 1 && f.rate === 24_000 && f.bits === 16;
}
