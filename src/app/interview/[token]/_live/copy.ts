import type { MediaFault, Platform } from "../_permissions";
import type { Blocked, EndCause, Ending } from "./machine";

/**
 * Every sentence the live screen shows, in one place. Hyphens only: no em or
 * en dashes anywhere (screens.test.ts reads every string in _live/ to check).
 */

export const WELCOME = {
  heading: "Your AI Video Interview",
  lead: (who: string, company: string) =>
    `A spoken conversation with ${who}, ${company}'s AI interviewer. ${who} asks the questions out loud and may ask a short follow-up after an answer. You answer out loud, in your own words.`,
  facts: (minutes: number, questions: number) => [
    `About ${questions} questions, up to ${minutes} minutes`,
    "On a computer, with a camera and microphone",
    "Headphones help, so your microphone doesn't pick up the interviewer",
    "One go: it can't be paused or started again",
  ],
  button: "Continue",
};

export const CONSENT = {
  privacy: "How Remotiv handles your data",
  button: "Agree and continue",
  saving: "Saving...",
  failed: "We couldn't save your agreement. Please try again.",
  unticked: "Please tick the box to continue.",
};

export const CHECK = {
  heading: "Check your camera and microphone",
  lead: "Both need to work before you start. Nothing is recorded during this check.",
  ask: "Allow camera and microphone",
  asking: "Waiting for your browser...",
  retry: "Try again",
  camera: { ok: "Camera ready", pend: "Camera not checked yet", bad: "Camera not working" },
  mic: {
    ok: "Picking up your voice",
    pend: "Say something to test it",
    bad: "Microphone not working",
  },
  net: {
    ok: "Connection ready",
    pend: "Checking your connection...",
    bad: "Connection too slow right now",
  },
  start: "Start the interview",
  startNote: (who: string) =>
    `When you start, ${who} begins speaking. Your camera and microphone are recorded from then until the end.`,
};

/** What to do about a camera or microphone that didn't start, on a computer. */
export function faultHelp(
  fault: MediaFault,
  platform: Platform,
): { title: string; steps: string[] } {
  if (fault === "missing") {
    return {
      title: "No camera or microphone found.",
      steps: ["Connect one, then press Try again."],
    };
  }
  if (fault === "in-use") {
    return {
      title: "Another app is using your camera.",
      steps: ["Close the other app, for example a video call, then press Try again."],
    };
  }
  if (fault === "unknown") {
    return { title: "Your camera or microphone didn't start.", steps: ["Press Try again."] };
  }
  const steps =
    platform === "desktop-safari"
      ? [
          "Open Safari, then Settings, then Websites.",
          "Set Camera and Microphone to Allow for this site.",
          "Press Try again.",
        ]
      : platform === "desktop-firefox"
        ? [
            "Click the camera icon in the address bar.",
            "Remove the block for the camera and the microphone.",
            "Press Try again.",
          ]
        : [
            "Click the icon to the left of the web address.",
            "Set Camera and Microphone to Allow.",
            "Press Try again.",
          ];
  return { title: "Camera or microphone blocked for this site.", steps };
}

export const CONNECTING = {
  heading: (who: string) => `Connecting you to ${who}...`,
  lead: "This takes a few seconds.",
};

export const INTERVIEW = {
  state: {
    speaking: "Speaking",
    listening: "Listening",
    thinking: "Thinking",
  },
  waiting: "Joining...",
  listeningHint: (who: string) => `Answer out loud. ${who} will continue when you've finished.`,
  captionLabel: (who: string) => `What ${who} is saying`,
  you: "You",
  recording: "Recording",
  timeLeft: "Time left",
  timeUp: (who: string) => `Time is up. ${who} will close the interview.`,
  end: "End interview",
  confirmTitle: "End the interview now?",
  confirmBody: "You can't continue it afterwards.",
  confirmYes: "End interview",
  confirmNo: "Keep going",
  ending: "Ending the interview...",
  leaveWarning: "Your interview is still running. If you leave, it ends.",
};

export const SAVING = {
  heading: "Saving your video",
  lead: "Please keep this page open while your video uploads.",
  progress: (saved: number, total: number) => `${saved} of ${total} parts saved`,
  failed:
    "Part of your video hasn't uploaded yet. We'll keep trying while this page is open, so please check your connection and keep it open.",
  leaveWarning: "Your video is still uploading. If you leave now, part of it may be lost.",
  notSaved: "Some of your video could not be saved. Your answers were still recorded.",
};

export const ENDING: Record<Ending, { heading: string; body: (company: string) => string }> = {
  completed: {
    heading: "That's the end of your interview",
    body: (c) =>
      `Thank you for your time. ${c}'s hiring team will review the interview and be in touch by email.`,
  },
  candidate_ended: {
    heading: "You ended the interview",
    body: (c) =>
      `Thank you. ${c}'s hiring team will see the answers you gave and decide what happens next.`,
  },
  timed_out: {
    heading: "You've reached the time limit",
    body: (c) =>
      `The interview stopped at its time limit. ${c}'s hiring team will see the answers you gave.`,
  },
  provider_error: {
    heading: "The interview stopped because of a problem on our side",
    body: (c) =>
      `Nothing you did caused this. ${c}'s hiring team will see the answers you gave and decide what happens next.`,
  },
  connection_lost: {
    heading: "The connection dropped",
    body: (c) =>
      `The interview can't continue from here. ${c}'s hiring team will see the answers you gave and decide what happens next. If something went wrong, reply to the email invitation and tell them.`,
  },
  other: {
    heading: "The interview has ended",
    body: (c) => `${c}'s hiring team will see the answers you gave and be in touch.`,
  },
};

export const BUSY = {
  heading: "Please try again shortly",
  lead: "We can't start your interview right now. It is still open and nothing has been used up.",
  button: "Try again",
};

export const BLOCKED: Record<Blocked, { heading: string; body: (company: string) => string }> = {
  phone: {
    heading: "Please open this link on a computer",
    body: () =>
      "The AI Video Interview needs a computer with a camera and microphone. This link stays open, so you can use it on your computer before the deadline.",
  },
  unsupported: {
    heading: "This browser can't run the interview",
    body: () => "Open this link in Chrome, Edge, Safari or Firefox on a computer.",
  },
  duplicate: {
    heading: "This interview is open in another tab",
    body: () => "Use one tab only. Close the other tab, or continue here.",
  },
  superseded: {
    heading: "This interview continued in another tab",
    body: () => "You can close this tab.",
  },
  locked: {
    heading: "This interview isn't open yet",
    body: (c) =>
      `${c}'s AI Video Interview can't be started from this link yet. Nothing has been recorded. Reply to the email invitation and ${c}'s team will be in touch.`,
  },
  closed: {
    heading: "This interview is closed",
    body: (c) =>
      `This link can't be used now. Reply to the email invitation and ${c}'s team will be in touch.`,
  },
  already_started: {
    heading: "This interview has already started",
    body: (c) =>
      `It can't be started again from this link. ${c}'s hiring team will see the answers you gave and decide what happens next.`,
  },
  unavailable: {
    heading: "The interview couldn't connect",
    body: (c) =>
      `Nothing you did caused this. ${c}'s hiring team will see what happened and decide what happens next.`,
  },
};

export const DUPLICATE_BUTTON = "Continue in this tab";

/**
 * The demo's note under the ending (preview-live only, never a candidate's
 * screen): which ending this is and what the provider actually sent, so a
 * scripted end can be told from a bug.
 */
export function endingNote(ending: Ending, cause: EndCause | null): string {
  const sent =
    cause === null
      ? "nothing recorded"
      : cause.kind === "session_complete"
        ? `session_complete, end_reason ${JSON.stringify(cause.endReason)}, completed_gracefully ${String(cause.graceful)}`
        : cause.kind === "dropped"
          ? "the connection closed without session_complete"
          : cause.kind === "error"
            ? `error ${JSON.stringify(cause.code)}`
            : "no answer from the provider within 10 seconds of End";
  return `Demo: ending "${ending}". The provider sent: ${sent}.`;
}
