import { providerEndDetail } from "@/lib/interviews/live-event-codes";
import type { ConsentAnswer, StartAnswer } from "./live-server";
import type { AgentState, TransportEvent } from "./transport";

/**
 * The live screen's state, as a pure reducer: every transition is tested
 * without a browser (machine.test.ts), and the component only renders it.
 *
 *   welcome -> consent -> check -> connecting -> interview -> saving -> done
 *
 * plus busy (try again shortly; nothing used up) and blocked (a phone, an
 * unsupported browser, another tab, closed, already started, locked).
 *
 * The ending shown is what the screen saw. It is the candidate's message,
 * never an outcome: Completed is decided from the provider's export alone.
 */

export type Screen =
  | "welcome"
  | "consent"
  | "check"
  | "connecting"
  | "interview"
  | "saving"
  | "done"
  | "busy"
  | "blocked";

export type Ending =
  | "completed"
  | "candidate_ended"
  | "timed_out"
  | "provider_error"
  | "connection_lost"
  | "other";

/** What actually ended the conversation, as the transport reported it. Shown in the demo only. */
export type EndCause =
  | { kind: "session_complete"; endReason: string | null; graceful: boolean | null }
  | { kind: "dropped" }
  | { kind: "error"; code: string }
  | { kind: "no_answer_to_end" };

export type Blocked =
  | "phone"
  | "unsupported"
  | "duplicate"
  | "superseded"
  | "locked"
  | "closed"
  | "already_started"
  | "unavailable";

export type LiveState = {
  screen: Screen;
  agent: AgentState | null;
  /** What the interviewer is saying, for the caption. */
  caption: string | null;
  ending: Ending | null;
  endCause: EndCause | null;
  endPressed: boolean;
  confirmingEnd: boolean;
  savingConsent: boolean;
  consentFailed: boolean;
  starting: boolean;
  timeUp: boolean;
  interruptions: number;
  blocked: Blocked | null;
};

export type LiveAction =
  | { t: "begin" }
  | { t: "consent_saving" }
  | { t: "consent_result"; answer: ConsentAnswer }
  | { t: "start" }
  | { t: "start_result"; answer: StartAnswer }
  | { t: "transport"; event: TransportEvent }
  | { t: "transport_failed" }
  | { t: "end_requested" }
  | { t: "end_cancelled" }
  | { t: "end_confirmed" }
  /** End was pressed and the provider never answered: shown as the candidate's end. */
  | { t: "end_timeout" }
  | { t: "time_up" }
  | { t: "video_saved" }
  | { t: "block"; blocked: Blocked }
  | { t: "unblock" };

export const INITIAL: LiveState = {
  screen: "welcome",
  agent: null,
  caption: null,
  ending: null,
  endCause: null,
  endPressed: false,
  confirmingEnd: false,
  savingConsent: false,
  consentFailed: false,
  starting: false,
  timeUp: false,
  interruptions: 0,
  blocked: null,
};

/** The provider's end_reason and completed_gracefully, as the message shown. */
export function endingFrom(endReason: string | null, graceful: boolean | null): Ending {
  switch (providerEndDetail(endReason, graceful)) {
    case "completed":
      return "completed";
    case "candidate_left":
      return "candidate_ended";
    case "timed_out":
      return "timed_out";
    default:
      return "other";
  }
}

const block = (s: LiveState, blocked: Blocked): LiveState => ({
  ...s,
  screen: "blocked",
  blocked,
  starting: false,
});

/** The conversation is over: from now on the video is saved, then the ending shown. */
const over = (s: LiveState, ending: Ending, endCause: EndCause): LiveState =>
  s.ending
    ? s
    : {
        ...s,
        screen: "saving",
        ending,
        endCause,
        agent: null,
        confirmingEnd: false,
        starting: false,
      };

export function liveReducer(s: LiveState, a: LiveAction): LiveState {
  switch (a.t) {
    case "begin":
      return s.screen === "welcome" ? { ...s, screen: "consent" } : s;
    case "consent_saving":
      return { ...s, savingConsent: true, consentFailed: false };
    case "consent_result":
      if (a.answer === "saved") return { ...s, savingConsent: false, screen: "check" };
      if (a.answer === "locked") return block({ ...s, savingConsent: false }, "locked");
      if (a.answer === "closed") return block({ ...s, savingConsent: false }, "closed");
      return { ...s, savingConsent: false, consentFailed: true };
    case "start":
      return s.screen === "check" || s.screen === "busy"
        ? { ...s, screen: "connecting", starting: true }
        : s;
    case "start_result": {
      const r = a.answer;
      if (r.ok) return s;
      if (r.reason === "busy" || r.reason === "unavailable") {
        return { ...s, screen: "busy", starting: false };
      }
      if (r.reason === "consent_required") return { ...s, screen: "consent", starting: false };
      return block(s, r.reason);
    }
    case "transport": {
      const e = a.event;
      if (s.ending) return s;
      switch (e.type) {
        case "started":
          return { ...s, screen: "interview", starting: false };
        case "agent":
          return { ...s, agent: e.state };
        case "agent_text":
          return { ...s, caption: e.text };
        case "interrupted":
          return { ...s, interruptions: s.interruptions + 1 };
        case "ended":
          return over(s, endingFrom(e.endReason, e.graceful), {
            kind: "session_complete",
            endReason: e.endReason,
            graceful: e.graceful,
          });
        case "dropped":
          return over(s, "connection_lost", { kind: "dropped" });
        case "error":
          return over(s, "provider_error", { kind: "error", code: e.code });
      }
      return s;
    }
    case "transport_failed":
      return s.screen === "connecting" ? block(s, "unavailable") : s;
    case "end_requested":
      return s.screen === "interview" ? { ...s, confirmingEnd: true } : s;
    case "end_cancelled":
      return { ...s, confirmingEnd: false };
    case "end_confirmed":
      return s.screen === "interview"
        ? { ...s, confirmingEnd: false, endPressed: true, agent: "thinking" }
        : s;
    case "end_timeout":
      return s.endPressed ? over(s, "candidate_ended", { kind: "no_answer_to_end" }) : s;
    case "time_up":
      return { ...s, timeUp: true };
    case "video_saved":
      return s.screen === "saving" ? { ...s, screen: "done" } : s;
    case "block":
      return block(s, a.blocked);
    case "unblock":
      return s.blocked === "duplicate" ? { ...s, screen: "welcome", blocked: null } : s;
  }
}
