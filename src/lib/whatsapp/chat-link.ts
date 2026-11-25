import "server-only";
import { toWhatsAppDigits } from "@/lib/normalize";
import type { createServiceClient } from "@/lib/supabase/server";
import {
  type ChatLinkRefusal,
  hasWhatsAppOptIn,
  type WhatsAppConsentColumns,
} from "@/lib/whatsapp/consent";
import { isWhatsAppOptedOut } from "@/lib/whatsapp/opt-out";

/**
 * The admin drawer's "Message on WhatsApp" link (#67), and the ONLY place in
 * src that builds a wa.me link. A tripwire test holds that.
 *
 * Staff open it on their own phone, so it is not a system send, but the rule
 * is the same one dispatch.ts applies: no tick on the apply form, no WhatsApp,
 * and a STOP always wins over a tick. Built on the server, from the row as it
 * is now, so the browser never holds a link it was not allowed to have.
 *
 * Fails closed: a consent read or a STOP lookup that errors hides the link.
 */

export type ChatLink = { ok: true; href: string } | { ok: false; reason: ChatLinkRefusal };

export type ChatLinkApplication = WhatsAppConsentColumns & {
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
};

export async function whatsAppChatLink(
  service: ReturnType<typeof createServiceClient>,
  app: ChatLinkApplication,
): Promise<ChatLink> {
  if (!hasWhatsAppOptIn(app)) return { ok: false, reason: "no_opt_in" };

  const digits = toWhatsAppDigits(app.phone);
  if (!digits) return { ok: false, reason: "no_number" };

  const optOut = await isWhatsAppOptedOut(service, digits);
  if (optOut.status === "opted_out") return { ok: false, reason: "stopped" };
  if (optOut.status !== "clear") return { ok: false, reason: "check_failed" };

  const name = [app.first_name, app.last_name].filter(Boolean).join(" ").trim() || "there";
  const role = app.job_title?.trim() || "the role";
  const message = `Hi ${name}, this is Remotiv. Congratulations, you've been shortlisted for the ${role} position. We'd love to discuss the next steps with you. When would be a good time for a quick call?`;
  return { ok: true, href: `https://wa.me/${digits}?text=${encodeURIComponent(message)}` };
}
