import { escapeHtml } from "./render";

/**
 * The interview reminder's copy.
 *
 * ── Why it lives here and not in templates.ts ────────────────
 *
 * TEMPLATES in templates.ts is keyed by `Exclude<MessageEvent, "manual">`, and
 * `interview_reminder` is deliberately NOT a MessageEvent —
 * message_templates_event_check does not allow it, so a company can neither
 * override this wording nor see it in Settings. Wedging it into that map would
 * mean either widening MESSAGE_EVENTS (breaking template saving) or a partial
 * record with a hole in it. It is a separate function instead, in the same
 * directory, going out through the same deliverEmail path.
 *
 * ── THE MISSING LINK ─────────────────────────────────────────
 *
 * This email cannot contain the interview link, and that is not an oversight.
 *
 * interview_sessions stores only `token_hash` — the raw token exists exactly
 * once, inside the URL of the invitation email, and is never persisted (see
 * lib/interviews/tokens.ts, which explains why, and points at
 * talent_claim_tokens as the counter-example). Nothing server-side can
 * reconstruct it.
 *
 * The two ways to put a working link in here both cost more than they are
 * worth today:
 *   · Mint a fresh token and overwrite token_hash. This INVALIDATES the link
 *     already in the candidate's inbox — including for someone who is
 *     mid-interview with the page open — to save them a scroll.
 *     Actively harmful.
 *   · Store the raw token, or a reversibly-encrypted copy. That is the exact
 *     property tokens.ts refuses, and undoing a deliberate security decision
 *     for a reminder's convenience is the wrong trade.
 *
 * So the copy points at the earlier email by name and says what to look for.
 * The approved WhatsApp `interview_reminder` template has no link parameter
 * either, so both channels say the same thing.
 */
export type InterviewReminderCopy = { subject: string; body: string };

/**
 * Build the reminder, with the deadline already baked in.
 *
 * `deadline` is interpolated HERE rather than passed as a placeholder because
 * Placeholders is a closed four-key set that every template shares, and a fifth
 * key that only one template uses would render as an empty gap in the other
 * seven. It is escaped on the way in; the `{{...}}` tokens are substituted (and
 * escaped) later by renderCopy, exactly as for every other candidate email.
 */
export function interviewReminderCopy(deadline: string): InterviewReminderCopy {
  const when = escapeHtml(deadline);
  return {
    subject: "Your video interview for {{job_title}} closes tomorrow",
    body: [
      "<p>Hi {{candidate_first_name}},</p>",
      `<p>A quick reminder: the video interview <strong>{{company_name}}</strong> asked you to record for <strong>{{job_title}}</strong> closes on <strong>${when}</strong>.</p>`,
      "<p>If you've already started, nothing is lost — every answer you recorded is saved, and you can pick up from the next question. It only counts as finished once you submit.</p>",
      '<p>Your interview link is in the earlier email from us, subject "Your video interview for {{job_title}} at {{company_name}}". Opening that link again takes you back to where you stopped.</p>',
      "<p>Good luck.</p>",
    ].join("\n"),
  };
}

/**
 * The deadline as the invitation email already worded it.
 *
 * The reminder normally reuses the exact string the invite quoted, carried on
 * the job payload, so the two mails and the WhatsApp message cannot disagree
 * about the date. This is the FALLBACK for a job enqueued without one — and it
 * must stay character-identical to the format in sendInterviewInvite.
 *
 * UTC, deliberately: the sender, the candidate and the server are routinely in
 * three different zones, and a date that shifts by one depending on who renders
 * it is worse than one that is consistently the stored instant's UTC date.
 */
export function formatInterviewDeadline(expiresAt: string): string {
  return new Date(expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
