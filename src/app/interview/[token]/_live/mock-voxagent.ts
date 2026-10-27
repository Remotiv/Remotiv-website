import type { MockScriptId } from "@/lib/interviews/live-provider/types";
import { DOWNSTREAM_HZ, durationOf, synthVoice } from "./audio-io";
import { type Clock, realClock } from "./clock";
import { greetingLine, MOCK_LINES, type MockVoice, type MockVoiceLoader } from "./mock-lines";
import type { AudioOut, TransportEvent, VoxAgentTransport } from "./transport";

/**
 * A scripted stand-in for VoxAgent, in the browser (AVI commit 10). It plays
 * an interview through the screen's real audio output and sends the same
 * events the real transport will, so every screen, the interruption, the
 * video pieces and every ending run today, and in tests without waiting.
 *
 * It does not listen to the microphone and does no voice detection: like the
 * real server, it decides when an answer is over, here by the script's
 * timings (LISTEN_MS). Its voice is a real spoken clip of each line when the
 * caller passes `voice` (the preview does: preview-live/mock-voice.ts), and
 * a tone otherwise. Either way it plays through the screen's audio output,
 * so an interruption's flush is the real one. The demo panel stands in for the server's detector:
 * "cut_in" (the candidate speaks over the interviewer), "answer_done" (the
 * candidate has finished), "repeat" (the candidate asks to hear the question
 * again) and "drop" (the connection closes).
 *
 * The texts are made up. No question, CV or name from a real session is in
 * here: the server sends only the script's id (JoinTicket).
 */

export type MockSignal = "cut_in" | "answer_done" | "repeat" | "drop";

type Step =
  /** `question`: a question put to the candidate (main or follow-up), which "repeat" can ask again. */
  | { say: string; interruptAtMs?: number; question?: true }
  | { listen: number }
  | { think: number }
  | { end: string; graceful: boolean }
  | { drop: true }
  | { error: string };

/** What the interviewer says when cut off before she has finished a question (D9). */
export const FINISH_LINE = MOCK_LINES.finish_line;

/** What the interviewer says before asking a question again on request. */
export const REPEAT_LEAD = MOCK_LINES.repeat_lead;

/** How long the mock waits for an answer before moving on: it cannot hear one end. */
export const LISTEN_MS = 15_000;

/**
 * How far into a question the scripted cut-in comes: early, so the cut is
 * unmistakable. Never later than CUT_IN_LATEST_MS before the question's clip
 * ends, so it always lands while she is still speaking.
 */
export const CUT_IN_MS = 1_200;
const CUT_IN_LATEST_MS = 400;

/** Shown in the demo bar, so a stale page is easy to spot. Bump with any script change. */
export const MOCK_SCRIPT_VERSION = "mock-scripts 4, 27 Oct 2026";

const { q1: Q1, q2: Q2, q3: Q3, follow_up: FOLLOW_UP, closing: CLOSING } = MOCK_LINES;

/** Each script, as the provider would run it. Every one opens the same way. */
export function mockScript(id: MockScriptId, interviewer: string): Step[] {
  const hello: Step = { say: greetingLine(interviewer) };
  const listen: Step = { listen: LISTEN_MS };
  const think: Step = { think: 1000 };
  switch (id) {
    // The whole interview: three questions, a follow-up, an interruption and
    // the question again, then the closing line and a completed end.
    case "completed":
      return [
        hello,
        { say: Q1, question: true },
        listen,
        think,
        { say: FOLLOW_UP, question: true },
        listen,
        think,
        { say: MOCK_LINES.ack_got_it },
        { say: Q2, question: true, interruptAtMs: CUT_IN_MS },
        listen,
        think,
        { say: MOCK_LINES.ack_thanks },
        { say: Q3, question: true },
        listen,
        think,
        { say: CLOSING },
        { end: "completed", graceful: true },
      ];
    case "interruption":
      return [
        hello,
        { say: Q1, question: true, interruptAtMs: CUT_IN_MS },
        listen,
        think,
        { say: CLOSING },
        { end: "completed", graceful: true },
      ];
    case "candidate_ends":
      return [
        hello,
        { say: Q1, question: true },
        { listen: 60_000 },
        think,
        { say: Q2, question: true },
        { listen: 60_000 },
        think,
        { say: CLOSING },
        { end: "completed", graceful: true },
      ];
    case "timed_out":
      return [
        hello,
        { say: Q1, question: true },
        listen,
        think,
        { say: MOCK_LINES.time_limit },
        { end: "timed_out", graceful: false },
      ];
    case "provider_error":
      return [hello, { say: Q1, question: true }, listen, { error: "provider_error" }];
    case "connection_lost":
      return [hello, { say: Q1, question: true }, listen, { drop: true }];
  }
}

export class MockVoxAgent implements VoxAgentTransport {
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly steps: Step[];
  private readonly clock: Clock;
  private readonly timers = new Set<unknown>();
  private readonly loadVoice: MockVoiceLoader | null;
  private voice: MockVoice = new Map();
  private audio: AudioOut | null = null;
  private current: Step | null = null;
  /** The last question put, for "repeat": never a procedural line. */
  private lastQuestion: string | null = null;
  private at = 0;
  private phase: "idle" | "running" | "closed" = "idle";

  constructor(
    script: MockScriptId,
    opts: { interviewerName: string; clock?: Clock; voice?: MockVoiceLoader },
  ) {
    this.steps = mockScript(script, opts.interviewerName);
    this.clock = opts.clock ?? realClock;
    this.loadVoice = opts.voice ?? null;
  }

  async connect(opts: { mic: MediaStream | null; audioOut: AudioOut }): Promise<void> {
    if (this.phase !== "idle") return;
    this.audio = opts.audioOut;
    this.phase = "running";
    // The spoken clips, all before the conversation starts, so no line waits on a fetch.
    if (this.loadVoice) {
      try {
        this.voice = await this.loadVoice();
      } catch {
        this.voice = new Map();
      }
    }
    this.after(400, () => {
      this.emit({ type: "started" });
      this.next();
    });
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  end(): void {
    if (this.phase !== "running") return;
    this.clearTimers();
    this.audio?.flush();
    this.current = null;
    this.emit({ type: "agent", state: "thinking" });
    // The provider ends the session and says so (session_complete).
    this.after(500, () =>
      this.finish({ type: "ended", endReason: "candidate_left", graceful: false }),
    );
  }

  close(): void {
    this.clearTimers();
    this.audio?.flush();
    this.phase = "closed";
  }

  /** The demo panel, standing in for the server's own detection. */
  /** The demo panel's signal. True when it did something; false when it does not apply now. */
  signal(signal: MockSignal): boolean {
    if (this.phase !== "running") return false;
    if (signal === "drop") {
      this.audio?.flush();
      this.finish({ type: "dropped" });
      return true;
    }
    const step = this.current;
    if (!step) return false;
    if (signal === "cut_in") return "say" in step ? this.interrupt(step) : false;
    if (signal === "answer_done") {
      if (!("listen" in step)) return false;
      this.clearTimers();
      this.next();
      return true;
    }
    // Asked to hear it again while listening: the line, the question, then listening again.
    if (!("listen" in step) || !this.lastQuestion) return false;
    this.clearTimers();
    this.steps.splice(
      this.at - 1,
      0,
      { say: REPEAT_LEAD },
      { say: this.lastQuestion, question: true },
    );
    this.at -= 1;
    this.next();
    return true;
  }

  private next(): void {
    if (this.phase !== "running") return;
    const step = this.steps[this.at++];
    this.current = step ?? null;
    if (!step) return;
    if ("say" in step) {
      if (step.question) this.lastQuestion = step.say;
      this.emit({ type: "agent", state: "speaking" });
      this.emit({ type: "agent_text", text: step.say });
      // The spoken clip for these exact words, else the tone placeholder.
      const voice = this.voice.get(step.say) ?? synthVoice(step.say);
      this.audio?.play(voice, DOWNSTREAM_HZ);
      const speakingMs = durationOf(voice, DOWNSTREAM_HZ) * 1000;
      if (step.interruptAtMs !== undefined) {
        const cutAt = Math.min(step.interruptAtMs, speakingMs - CUT_IN_LATEST_MS);
        if (cutAt > 0) this.after(cutAt, () => this.interrupt(step));
      }
      this.after(speakingMs, () => this.next());
    } else if ("listen" in step) {
      this.emit({ type: "agent", state: "listening" });
      this.after(step.listen, () => this.next());
    } else if ("think" in step) {
      this.emit({ type: "agent", state: "thinking" });
      this.after(step.think, () => this.next());
    } else if ("end" in step) {
      this.finish({ type: "ended", endReason: step.end, graceful: step.graceful });
    } else if ("drop" in step) {
      this.finish({ type: "dropped" });
    } else {
      this.finish({ type: "error", code: step.error });
    }
  }

  /** Cut off mid-question: her audio stops at once, then the line and the question again. */
  private interrupt(step: Extract<Step, { say: string }>): boolean {
    // Only the line still being spoken can be cut off.
    if (this.phase !== "running" || this.current !== step) return false;
    this.clearTimers();
    this.audio?.flush();
    this.emit({ type: "interrupted" });
    this.emit({ type: "agent", state: "listening" });
    this.steps.splice(this.at, 0, { say: FINISH_LINE }, { say: step.say, question: step.question });
    this.current = null;
    this.after(900, () => this.next());
    return true;
  }

  private finish(event: TransportEvent): void {
    this.clearTimers();
    this.current = null;
    this.phase = "closed";
    this.emit(event);
  }

  private after(ms: number, fn: () => void): void {
    const id = this.clock.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
  }

  private emit(event: TransportEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}
