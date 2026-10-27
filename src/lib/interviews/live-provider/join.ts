import { randomUUID } from "node:crypto";
import {
  type CreateSessionInput,
  type JoinTicket,
  MOCK_SCRIPT_IDS,
  type MockScriptId,
} from "./types";

/**
 * Creating the provider session a candidate joins (AVI commit 10), on the
 * server: the provider's API key never leaves it, and the browser gets only
 * the JoinTicket.
 *
 * Only the mock exists. The real VoxAgent client is a later swap behind
 * LiveJoinProvider: it calls create-session with the key, and returns the
 * ws_url and ws_token it is given as the ticket.
 */

/** Every slot is in use: "Please try again shortly", and nothing is used up (B3). */
export class ProviderBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds = 60) {
    super("provider at capacity");
    this.name = "ProviderBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface LiveJoinProvider {
  readonly name: string;
  createSession(
    input: CreateSessionInput,
  ): Promise<{ providerSessionId: string; join: JoinTicket }>;
  /** Give back a session that lost the claim (two starts at once), so it holds no slot. */
  cancelSession(providerSessionId: string): Promise<void>;
}

const INPUT_KEYS = new Set([
  "remotiv_session_id",
  "interviewer_name",
  "interview_minutes",
  "questions",
  "candidate_first_name",
  "cv_text",
]);
const QUESTION_KEYS = new Set(["position", "text"]);

export function isMockScriptId(value: unknown): value is MockScriptId {
  return (MOCK_SCRIPT_IDS as readonly unknown[]).includes(value);
}

/**
 * The mock's server half: checks the input as strictly as fake-provider.ts
 * (a key outside CreateSessionInput is refused, so the rubric cannot slip
 * through), then hands out a ticket for a scripted interview. "busy" plays
 * the provider being at capacity.
 */
export function createMockJoinProvider(
  script: MockScriptId | "busy" = "completed",
): LiveJoinProvider {
  return {
    name: "mock",
    async createSession(input) {
      for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new Error(`mock provider: unexpected input key ${key}`);
      }
      for (const q of input.questions) {
        for (const key of Object.keys(q)) {
          if (!QUESTION_KEYS.has(key))
            throw new Error(`mock provider: unexpected question key ${key}`);
        }
      }
      if (script === "busy") throw new ProviderBusyError(30);
      return {
        providerSessionId: `mock-${randomUUID()}`,
        join: { mode: "mock", script, turnDetection: "server" },
      };
    },
    async cancelSession() {
      // Nothing is held: the mock runs in the browser.
    },
  };
}
