/**
 * The AI Video Interview's consent screen and its privacy-page section, in
 * one place, and the guard that keeps both off every screen while any fact in
 * them is still a placeholder.
 *
 * ── A separate version from the async interview ──────────────
 *
 * The async consent (consent.ts, "v2") is unchanged. A live session's consent
 * is stored as LIVE_INTERVIEW_CONSENT_VERSION, and creating the provider
 * session requires exactly that version (live-consent-record.ts). Change any
 * word of LIVE_CONSENT and bump the version; a test pins the text to it.
 *
 * ── Placeholders, never invented facts ───────────────────────
 *
 * Facts not yet confirmed are written as [CONFIRM: CAMERA VIDEO] and
 * [CONFIRM: D4 TRANSCRIPTION]. While any remains:
 *
 *   liveConsentScreen()   returns null: the screen has nothing to show
 *   liveConsentReady()    is false: liveInterviewsAvailableFor refuses every
 *                         company, so no live invite is sent, and no consent
 *                         can be recorded (live-consent-record.ts)
 *   livePrivacySection()  returns null: the privacy page renders neither
 *                         section 15 nor its link from section 1
 *
 * PRIVACY_NOTICE_VERSION moves only when section 15 actually goes live.
 *
 * ── Copy ─────────────────────────────────────────────────────
 *
 * Plain English, regular hyphens only. `{company}` is the hiring company's
 * name, filled in by liveConsentScreen. The interview system is Remotiv's
 * own, hosted by RunPod; the text never calls it a partner.
 *
 * Plain module: the candidate screen and the public privacy page import it.
 */

export const LIVE_INTERVIEW_CONSENT_VERSION = "live-v1";

/** A fact not confirmed yet. Matches every placeholder form this text uses. */
export const LIVE_TEXT_PLACEHOLDER = /\[(?:PARTNER [A-Z ]+|CONFIRM: [A-Z0-9 ]+)\]/g;

export type ConsentRow = { lead: string; body: string };

export const LIVE_CONSENT = {
  heading: "Before you start",
  intro: "Please read these. They matter.",
  rows: [
    {
      lead: "Your interviewer is an AI",
      body: "Sarah is an AI interviewer, not a person. She asks the questions out loud and may ask a short follow-up after an answer.",
    },
    {
      lead: "You're being recorded",
      body: "[CONFIRM: CAMERA VIDEO] Your camera video is recorded and stored by Remotiv. The spoken conversation, your voice and Sarah's, is handled by Remotiv's AI interview system, run on servers from RunPod (our cloud computing provider) in the Czech Republic and Iceland. Remotiv keeps a copy of the audio, and {company}'s hiring team can watch and listen to it.",
    },
    {
      lead: "How your answers become text",
      body: "[CONFIRM: D4 TRANSCRIPTION] Remotiv's AI interview system transcribes your answers with its own speech system, which we run ourselves.",
    },
    {
      lead: "Where the questions come from",
      body: "{company} wrote the questions about the role. Remotiv's AI wrote the questions about your CV. So that Sarah can ask relevant follow-up questions, Remotiv's AI interview system receives your first name and your CV with your contact details removed.",
    },
    {
      lead: "A person makes the decision",
      body: "Where AI scoring is turned on, each answer is scored by AI against the question it answers. {company}'s hiring team reviews the conversation and any scores, and a person makes the decision.",
    },
    {
      lead: "Kept for 6 months, then deleted",
      body: "Remotiv schedules the recordings and transcripts for deletion six months after you were invited. The interview server keeps its copy for 30 days, then deletes it automatically.",
    },
    {
      lead: "Answer in your own words",
      body: "Please don't read from a script or an AI tool. The hiring team wants to hear how you think.",
    },
  ] satisfies ConsentRow[],
  smallPrint:
    "Remotiv's AI (Anthropic) writes the CV questions from your CV with your contact details and name removed, and any AI scoring is done by OpenAI or Anthropic. Our privacy policy says what each one receives.",
  checkbox: "I understand that my interviewer is an AI, and I agree to be recorded.",
} as const;

export type PrivacyBlock =
  | { kind: "p"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: { lead: string; text: string }[] };

export const LIVE_PRIVACY_SECTION = {
  id: "ai-video-interviews",
  number: 15,
  title: "AI video interviews",
  /** The sentence section 1 links with, shown only alongside the section itself. */
  linkFromSection1:
    "Some companies invite you to an AI video interview instead. Section 15 explains what is different about it.",
  blocks: [
    {
      kind: "p",
      text: "Some companies invite you to an AI video interview: a spoken conversation with an AI interviewer, Sarah, instead of recorded answers to written questions. Sarah is an AI, not a person.",
    },
    { kind: "h3", text: "What we collect" },
    {
      kind: "p",
      text: "[CONFIRM: CAMERA VIDEO] Your camera video. The audio of each turn of the conversation, yours and Sarah's. A transcript of each of your answers. When each turn started and how long it lasted, and how many follow-up questions were asked. The moment you acknowledged the screen shown before the interview started, and which version of it you saw.",
    },
    { kind: "h3", text: "Who receives what" },
    {
      kind: "ul",
      items: [
        {
          lead: "Remotiv's AI interview system",
          text: "runs the conversation. It receives your voice during the interview, your first name, the questions, and your CV with your email, phone number, links and address removed, so Sarah can ask relevant follow-up questions. [CONFIRM: D4 TRANSCRIPTION] It transcribes your answers with its own speech system, which we run ourselves. The interview server keeps its copy for 30 days, then deletes it automatically.",
        },
        {
          lead: "RunPod",
          text: "our cloud computing provider, hosts Remotiv's AI interview system on its servers in the Czech Republic and Iceland.",
        },
        {
          lead: "Anthropic",
          text: "receives your CV with your contact details and name removed, together with the job description, to write the questions about your CV.",
        },
        {
          lead: "OpenAI or Anthropic",
          text: "where AI scoring is turned on, receive the text of each question, the conversation for that question and a private scoring guide, to score each answer. They do not receive your name or your CV.",
        },
        {
          lead: "Supabase",
          text: "stores everything we keep, in its Tokyo region.",
        },
        {
          lead: "The hiring team",
          text: "of the company that invited you can listen to the conversation, read the transcripts and see any scores.",
        },
      ],
    },
    { kind: "h3", text: "How AI is used" },
    {
      kind: "p",
      text: "Where AI scoring is turned on, each answer is scored against the question it answers, on what you said and the evidence you gave. How you speak is never scored: not hesitation, accent, grammar or fluency. A question you were asked but did not answer gets the lowest score; questions the interview never reached are left out. If the interview ended part-way, any overall score is clearly marked as partial. If it ended very early or because of a technical problem, there is no overall score. A person on the hiring team reviews the interview and makes the decision. AI scores for these interviews are not used to rank or shortlist candidates.",
    },
    { kind: "h3", text: "How long we keep it" },
    {
      kind: "p",
      text: "Remotiv schedules the recordings, the transcripts and Sarah's words for deletion six months after you were invited, along with the short explanations and quotes attached to any scores. We keep the record that the interview happened: the questions asked, when each part took place and for how long, and the scores and counts.",
    },
    { kind: "h3", text: "Where it goes" },
    {
      kind: "p",
      text: "In addition to section 5: the Czech Republic and Iceland, where RunPod hosts Remotiv's AI interview system and the conversation is processed.",
    },
  ] satisfies PrivacyBlock[],
} as const;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Every placeholder still in a piece of text, in order. */
export function placeholdersIn(value: unknown): string[] {
  return strings(value).flatMap((s) => s.match(LIVE_TEXT_PLACEHOLDER) ?? []);
}

/** Whether the consent screen's text is final: no placeholder left. */
export function liveConsentReady(): boolean {
  return placeholdersIn(LIVE_CONSENT).length === 0;
}

/** Whether the privacy section's text is final: no placeholder left. */
export function livePrivacyReady(): boolean {
  return placeholdersIn(LIVE_PRIVACY_SECTION).length === 0;
}

/** The consent screen for one company, or null while any fact in it is a placeholder. */
export function liveConsentScreen(companyName: string): {
  heading: string;
  intro: string;
  rows: ConsentRow[];
  smallPrint: string;
  checkbox: string;
  version: typeof LIVE_INTERVIEW_CONSENT_VERSION;
} | null {
  if (!liveConsentReady()) return null;
  const fill = (s: string) => s.replaceAll("{company}", companyName);
  return {
    heading: LIVE_CONSENT.heading,
    intro: LIVE_CONSENT.intro,
    rows: LIVE_CONSENT.rows.map((r) => ({ lead: r.lead, body: fill(r.body) })),
    smallPrint: LIVE_CONSENT.smallPrint,
    checkbox: LIVE_CONSENT.checkbox,
    version: LIVE_INTERVIEW_CONSENT_VERSION,
  };
}

/** Section 15 of the privacy page, or null while any fact in it is a placeholder. */
export function livePrivacySection(): typeof LIVE_PRIVACY_SECTION | null {
  return livePrivacyReady() ? LIVE_PRIVACY_SECTION : null;
}

/** Whether a stored session row carries consent to THIS live text: a time and version live-v1. */
export function liveConsentGiven(row: {
  consent_at: string | null;
  consent_version: string | null;
}): boolean {
  return row.consent_at !== null && row.consent_version === LIVE_INTERVIEW_CONSENT_VERSION;
}
