/**
 * Every line MockVoxAgent says (AVI commit 10 demo), in one place: the mock
 * scripts read their words from here, and the spoken clips are generated from
 * exactly these texts (dev-assets/mock-voice/generate.mjs), so what the demo
 * says is always what its caption shows.
 *
 * No imports and no app code: the generator reads this file directly with
 * Node's type stripping.
 */

/** The interviewer the clips are spoken for: the demo's name. */
export const MOCK_INTERVIEWER = "Sarah";

export function greetingLine(interviewer: string): string {
  return `Hi, I'm ${interviewer}. Thanks for joining. I'll ask you a few questions about your experience. Take your time with each answer.`;
}

/** Each fixed line by clip id. The id names the clip file; the text is what is said. */
export const MOCK_LINES = {
  greeting: greetingLine(MOCK_INTERVIEWER),
  q1: "To start, tell me about yourself and the work you do day to day.",
  q2: "Next, tell me about a project you're proud of and the part you played in it.",
  q3: "Last question. Tell me about a time you had to learn something new quickly.",
  follow_up: "Thanks. What was one decision in that work you made yourself?",
  ack_got_it: "Got it, thank you.",
  ack_thanks: "Thank you.",
  finish_line: "Let me just finish the question.",
  repeat_lead: "Of course, here it is again.",
  time_limit: "We've reached the time limit for this interview, so I'll stop here. Thank you.",
  closing:
    "That's everything I wanted to ask. Thank you for your time today. The hiring team will review the interview and be in touch.",
} as const;

export type MockLineId = keyof typeof MOCK_LINES;

export function isMockLineId(value: unknown): value is MockLineId {
  return typeof value === "string" && Object.hasOwn(MOCK_LINES, value);
}

/** The interviewer's words, as the mock speaks them: 24 kHz mono s16le, by line text. */
export type MockVoice = ReadonlyMap<string, Int16Array>;
export type MockVoiceLoader = () => Promise<MockVoice>;
