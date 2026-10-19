import { parseExport } from "./parse-export";
import type { CreateSessionInput, CreateSessionResult, LiveInterviewProvider } from "./types";

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
 * Remotiv confirms it has the whole session (Phase 1 doc, B8).
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

export type FakeLiveProvider = LiveInterviewProvider & {
  /** Every input received, in order, as received. */
  readonly created: readonly CreateSessionInput[];
  /** Every provider session id deleted, in order. */
  readonly deleted: readonly string[];
  /** The export for a live session: a copy of the sample, under that session's id. */
  exportOf(providerSessionId: string): unknown;
};

function assertOnlyKeys(value: object, allowed: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(value).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new Error(
      `fake provider: ${where} has fields it must never receive: ${extra.join(", ")}`,
    );
  }
}

export function createFakeLiveProvider(sampleExport: unknown): FakeLiveProvider {
  const created: CreateSessionInput[] = [];
  const deleted: string[] = [];
  const live = new Set<string>();

  return {
    created,
    deleted,

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

    parseExport,
  };
}
