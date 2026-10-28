import { parseExport } from "./parse-export";
import type {
  CreateSessionInput,
  CreateSessionResult,
  LiveInterviewProvider,
  TurnAudio,
} from "./types";

/**
 * An in-memory stand-in for the AI Video Interview provider, until its real
 * API is final. No timers and no network: a session is created on the spot,
 * and its export is the sample export handed in, under that session's id.
 *
 * It is strict where the real provider might not be: an input with any key
 * outside CreateSessionInput, at the top or on a question, is refused. That is
 * a second lock on the rubric staying out (create-session.ts is the first),
 * so a caller that builds its own input by hand fails here in tests rather
 * than leaking the mark scheme in production.
 *
 * A deleted session's export is gone, as the provider must keep nothing once
 * Remotiv confirms it has the whole session (Phase 1 doc, B8). So is its audio.
 *
 * Audio: every file name in the sample has bytes, made up and deterministic
 * (a "RIFF....WAVE" header and the file name), so a test can check what was
 * stored against what was handed over. `audioOverrides` replaces or removes
 * (null) a file, to test a missing or empty one.
 */

const INPUT_KEYS: ReadonlySet<string> = new Set([
  "remotiv_session_id",
  "interviewer_name",
  "interview_minutes",
  "questions",
  "candidate_first_name",
  "cv_text",
]);
const QUESTION_KEYS: ReadonlySet<string> = new Set(["position", "text"]);

/** How long the fake's silence lasts. An empty transcript of it is measured silence: a skip. */
export const FAKE_AUDIO_MS = 2_500;

/**
 * The fake's bytes for one file name: a real 16-bit PCM WAV of FAKE_AUDIO_MS of
 * silence (8 kHz, mono), with the name in its own chunk so every file is distinct.
 */
export function fakeAudioBytes(fileName: string): Uint8Array {
  const name = new TextEncoder().encode(`fake-audio:${fileName}`);
  const namePadded = name.length + (name.length % 2);
  const rate = 8_000;
  const dataBytes = Math.round((rate * FAKE_AUDIO_MS) / 1000) * 2;
  const bytes = new Uint8Array(12 + 24 + 8 + namePadded + 8 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, t: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = t.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "name");
  view.setUint32(40, name.length, true);
  bytes.set(name, 44);
  const data = 44 + namePadded;
  tag(data, "data");
  view.setUint32(data + 4, dataBytes, true);
  return bytes;
}

export type FakeLiveProvider = LiveInterviewProvider & {
  /** Every input received, in order, as received. */
  readonly created: readonly CreateSessionInput[];
  /** Every provider session id deleted, in order. */
  readonly deleted: readonly string[];
  /** The export for a live session: a copy of the sample, under that session's id. */
  exportOf(providerSessionId: string): unknown;
  /** Every fetchAudio call, as [providerSessionId, fileName]. */
  readonly audioFetches: readonly [string, string][];
};

function assertOnlyKeys(value: object, allowed: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(value).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new Error(
      `fake provider: ${where} has fields it must never receive: ${extra.join(", ")}`,
    );
  }
}

export function createFakeLiveProvider(
  sampleExport: unknown,
  audioOverrides: Readonly<Record<string, TurnAudio | null>> = {},
): FakeLiveProvider {
  const created: CreateSessionInput[] = [];
  const deleted: string[] = [];
  const audioFetches: [string, string][] = [];
  const live = new Set<string>();

  return {
    created,
    deleted,
    audioFetches,

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
      assertOnlyKeys(input, INPUT_KEYS, "the input");
      for (const q of input.questions) assertOnlyKeys(q, QUESTION_KEYS, `question ${q.position}`);
      created.push(structuredClone(input));
      const providerSessionId = `fake-session-${created.length}`;
      live.add(providerSessionId);
      return { providerSessionId };
    },

    async deleteSession(providerSessionId: string): Promise<void> {
      live.delete(providerSessionId);
      deleted.push(providerSessionId);
    },

    exportOf(providerSessionId: string): unknown {
      if (!live.has(providerSessionId)) {
        throw new Error(`fake provider: no session ${providerSessionId}`);
      }
      const copy = structuredClone(sampleExport) as Record<string, unknown>;
      copy.session_id = providerSessionId;
      return copy;
    },

    async fetchAudio(providerSessionId: string, fileName: string): Promise<TurnAudio> {
      audioFetches.push([providerSessionId, fileName]);
      if (!live.has(providerSessionId)) {
        throw new Error(`fake provider: no session ${providerSessionId}`);
      }
      if (fileName in audioOverrides) {
        const o = audioOverrides[fileName];
        if (o === null) throw new Error(`fake provider: no audio ${fileName}`);
        return { bytes: Uint8Array.from(o.bytes), mime_type: o.mime_type };
      }
      return { bytes: fakeAudioBytes(fileName), mime_type: "audio/wav" };
    },

    parseExport,
  };
}
