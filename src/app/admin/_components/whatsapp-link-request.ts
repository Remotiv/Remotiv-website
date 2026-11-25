import type { ApplicationWhatsAppLink } from "@/app/admin/applications/actions";
import { CHAT_LINK_UNAVAILABLE } from "@/lib/whatsapp/consent";

/**
 * Ask for one application's WhatsApp link and hand the answer to `apply`,
 * unless the returned cancel ran first (#67). The drawer's effect returns that
 * cancel as its cleanup, so an answer that arrives after the drawer moved to
 * another applicant, or closed, is dropped: a slow answer for one candidate
 * can never put a link on another candidate's drawer.
 *
 * A failed request is no link, never a stale one.
 */
export function requestWhatsAppLink(
  load: (applicationId: string) => Promise<ApplicationWhatsAppLink>,
  applicationId: string,
  apply: (answer: ApplicationWhatsAppLink) => void,
): () => void {
  let cancelled = false;
  load(applicationId).then(
    (answer) => {
      if (!cancelled) apply(answer);
    },
    () => {
      if (!cancelled) apply({ ok: false, label: CHAT_LINK_UNAVAILABLE.check_failed });
    },
  );
  return () => {
    cancelled = true;
  };
}
