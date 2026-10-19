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

/** The fake's bytes for one file name: a minimal WAV-looking header and the name. */
export function fakeAudioBytes(fileName: string): Uint8Array {
  return new TextEncoder().encode(`RIFF\u0000\u0000\u0000\u0000WAVEfmt fake-audio:${fileName}`);
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
