import "server-only";

/**
 * WhatsApp is on for the Remotiv AI product only (Waleed, 26 Nov 2026).
 *
 * A company's job (jobs.company_id set, frozen on the application as
 * company_id_snapshot at apply time) is the AI product: the apply-form box,
 * the opt-in and the STOP rules in consent.ts and opt-out.ts apply as before.
 * Remotiv's own board (company_id null: admin-posted and client-portal jobs)
 * and the /admin drawer get no WhatsApp at all while this switch is off. The
 * code stays; the switch turns it back on.
 *
 * Read here and nowhere else. Unset, or anything but "true", is off.
 */
export function whatsAppOnRemotivBoard(): boolean {
  return process.env.WHATSAPP_REMOTIV_BOARD_ENABLED === "true";
}

/** May an application to this job's owner use WhatsApp? A company job always may. */
export function whatsAppAllowedFor(companyId: string | null | undefined): boolean {
  return Boolean(companyId) || whatsAppOnRemotivBoard();
}

/** Shown on the Messages page for a send this switch stopped. Fixed text. */
export const REMOTIV_BOARD_OFF_REASON =
  "Not sent: WhatsApp is only used for Remotiv AI interviews.";
