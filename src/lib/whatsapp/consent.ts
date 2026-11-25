/**
 * WhatsApp is strictly opt-in (#67, decided 25 Nov 2026).
 *
 * A candidate gets WhatsApp only if they ticked the opt-in box on the apply
 * form. Otherwise email only, with no exceptions: interview invitations and
 * reminders included. The choice is stored on the application with the time it
 * was received (migration 079), and a STOP received on WhatsApp still wins
 * over a tick: that is opt-out.ts, checked after this, never instead of it.
 *
 * Every WhatsApp send goes through sendTarget in dispatch.ts, which asks
 * hasWhatsAppOptIn first. A tripwire test holds sendTemplateMessage to
 * dispatch.ts and every call of it to a function that asks sendTarget first.
 */

/** The apply form's checkbox, word for word. Hyphens only, never a dash. */
export const WHATSAPP_OPT_IN_LABEL =
  "Send me updates about this application on WhatsApp. Reply STOP at any time to stop.";

/** The form field the apply modal posts when the box is ticked, and its value. */
export const WHATSAPP_OPT_IN_FIELD = "whatsapp_opt_in";
export const WHATSAPP_OPT_IN_TICKED = "yes";

/** Shown on the Messages page for a send the rule stopped. Fixed text, never a raw error. */
export const NO_OPT_IN_REASON =
  "Not sent: this candidate didn't opt in to WhatsApp when they applied, so they get email only.";

/** Why the admin drawer shows no WhatsApp link (chat-link.ts). */
export type ChatLinkRefusal = "no_opt_in" | "stopped" | "no_number" | "check_failed";

/** What the drawer shows instead of the link. Hyphens only, never a dash. */
export const CHAT_LINK_UNAVAILABLE: Record<ChatLinkRefusal, string> = {
  no_opt_in: "WhatsApp unavailable: no opt-in",
  stopped: "WhatsApp unavailable: replied STOP",
  no_number: "WhatsApp unavailable: phone number format unclear",
  check_failed: "WhatsApp unavailable: couldn't check opt-in or STOP. Try again.",
};

/**
 * Under the drawer's WhatsApp button. A STOP typed into a chat staff opened
 * on their own phone never reaches the webhook, so nothing records it.
 */
export const CHAT_STOP_NOTE =
  "If they reply STOP in this chat, don't message them again and tell the team.";

export type WhatsAppConsentColumns = {
  whatsapp_opt_in?: boolean | null;
  whatsapp_opt_in_at?: string | null;
};

/**
 * True only for an application that carries a tick AND its time. Anything
 * else (false, null, a missing column, a tick without a time) is no consent.
 */
export function hasWhatsAppOptIn(app: WhatsAppConsentColumns | null | undefined): boolean {
  return (
    app?.whatsapp_opt_in === true &&
    typeof app.whatsapp_opt_in_at === "string" &&
    app.whatsapp_opt_in_at !== ""
  );
}

/**
 * The two columns /api/apply writes, from the posted form.
 *
 * Only the candidate can tick the box, so only the candidate's own form counts:
 * an admin's bulk upload (source manual_upload) is never consent, whatever it
 * posts. The time is the server's, never the client's.
 */
export function optInColumns(
  posted: unknown,
  source: "job_application" | "manual_upload",
  now: Date,
): { whatsapp_opt_in: boolean; whatsapp_opt_in_at: string | null } {
  const ticked = source === "job_application" && posted === WHATSAPP_OPT_IN_TICKED;
  return ticked
    ? { whatsapp_opt_in: true, whatsapp_opt_in_at: now.toISOString() }
    : { whatsapp_opt_in: false, whatsapp_opt_in_at: null };
}
