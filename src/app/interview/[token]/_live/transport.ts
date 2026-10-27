import type { JoinTicket } from "@/lib/interviews/live-provider/types";
import type { Clock } from "./clock";
import type { MockVoiceLoader } from "./mock-lines";
import { type MockStepsLoader, MockVoxAgent } from "./mock-voxagent";

/**
 * The live conversation, as the candidate screen sees it (AVI commit 10).
 *
 * The screen talks to a VoxAgentTransport and nothing else: it never opens a
 * socket, never sends stop_listening, and never decides when the candidate
 * has finished speaking. There is no "Done speaking" button (D6).
 *
 * ── End of turn stays behind this line ───────────────────────
 *
 * Who detects the end of the candidate's turn is not confirmed yet. Today
 * only "server" is accepted: the transport streams the microphone and
 * follows the server's speaking / listening / processing messages. A ticket
 * asking for "client" is refused here (TransportUnavailableError), and no
 * browser voice detection exists until the provider confirms it is ours.
 * When it does, it is added inside a transport, and the screen is unchanged.
 *
 * ── Two transports ───────────────────────────────────────────
 *
 * MockVoxAgent (mock-voxagent.ts) plays a scripted interview through the
 * real audio output, so the whole screen runs and is tested today. The real
 * VoxAgent transport (WebSocket, PCM s16le 16 kHz up and 24 kHz down, the
 * JSON messages, stop_listening and end_session) is a later swap behind this
 * interface.
 */

export type AgentState = "speaking" | "listening" | "thinking";

export type TransportEvent =
  /** The conversation has started: zero on the clock the video pieces use. */
  | { type: "started" }
  | { type: "agent"; state: AgentState }
  /** What the interviewer is saying, for the caption. */
  | { type: "agent_text"; text: string }
  /** The interviewer was cut off: her queued audio has been dropped. */
  | { type: "interrupted" }
  /** The provider's session_complete. The screen shows it; it decides no outcome. */
  | { type: "ended"; endReason: string | null; graceful: boolean | null }
  /** The connection closed without an end. */
  | { type: "dropped" }
  | { type: "error"; code: string };

/** Where the interviewer's voice goes. The screen makes one (audio-out.ts); tests fake it. */
export interface AudioOut {
  play(samples: Int16Array, sampleRate: number): void;
  /** Drop everything queued, at once: the interviewer was cut off. */
  flush(): void;
}

export interface VoxAgentTransport {
  connect(opts: { mic: MediaStream | null; audioOut: AudioOut }): Promise<void>;
  subscribe(listener: (event: TransportEvent) => void): () => void;
  /** The candidate pressed End: the provider is asked to end (end_session). */
  end(): void;
  /** Leave without asking: the page is going away. */
  close(): void;
}

export class TransportUnavailableError extends Error {
  readonly code: "turn_detection" | "provider";
  constructor(code: TransportUnavailableError["code"]) {
    super(`transport unavailable: ${code}`);
    this.name = "TransportUnavailableError";
    this.code = code;
  }
}

export function createTransport(
  ticket: JoinTicket,
  opts: {
    interviewerName: string;
    clock?: Clock;
    mockVoice?: MockVoiceLoader;
    mockSteps?: MockStepsLoader;
  },
): VoxAgentTransport {
  if (ticket.turnDetection !== "server") throw new TransportUnavailableError("turn_detection");
  if (ticket.mode === "mock") {
    return new MockVoxAgent(ticket.script, {
      interviewerName: opts.interviewerName,
      clock: opts.clock,
      voice: opts.mockVoice,
      steps: opts.mockSteps,
    });
  }
  throw new TransportUnavailableError("provider");
}
