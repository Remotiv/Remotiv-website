import { toWhatsAppDigits } from "@/lib/normalize";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Has this WhatsApp recipient opted out, under either identifier Meta uses?
 *
 * ── Why a phone lookup alone is not enough ───────────────────
 *
 * The webhook records a STOP under whichever identifier the message arrived
 * with: the phone, Meta's business-scoped user id (BSUID), or both. A candidate
 * who has adopted a WhatsApp username stops sending their phone at all, so their
 * STOP is stored under the BSUID with no phone. The dispatcher only ever holds
 * the phone on the application, so a phone-only check can never find that row,
 * and the candidate who said stop kept receiving messages.
 *
 * The link between the two already exists and nothing new is created for it:
 * whatsapp_inbound records the phone and the BSUID side by side whenever Meta
 * sends both, which it still does for nearly everyone. So the rule is:
 *
 *   opted out  if  an opt-out row has phone = the normalised digits
 *              or  an opt-out row has a bsuid that whatsapp_inbound has seen
 *                  arrive alongside those same normalised digits
 *
 * ── What it cannot do ────────────────────────────────────────
 *
 * A candidate whose BSUID has never arrived alongside their phone cannot be
 * linked by any code here. Meta's send response returns a message id, not a
 * BSUID, so the only source of the pairing is an inbound message. That gap
 * closes only when they message us while Meta still sends both identifiers.
 *
 * ── Fails closed ─────────────────────────────────────────────
 *
 * Any lookup that errors returns `lookup_failed`, never `clear`. Not knowing
 * whether someone said stop is not permission to message them. The caller
 * skips the send; the email invitation does not depend on this and has already
 * gone. The raw database error is logged here and returned to nobody.
 */

type Service = ReturnType<typeof createServiceClient>;

export type WhatsAppOptOutStatus =
  | { status: "clear" }
  | { status: "opted_out"; matchedBy: "phone" | "bsuid" }
  | { status: "lookup_failed"; source: OptOutLookup };

/** Which read failed. A category for logs and tests, never shown raw. */
export type OptOutLookup = "opt_outs_by_phone" | "inbound_bsuids" | "opt_outs_by_bsuid";

/**
 * The stored spellings of one normalised number that toWhatsAppDigits accepts.
 *
 * whatsapp_inbound.from_phone holds Meta's sender id as delivered, which is
 * normally these same twelve digits. The other spellings are asked for so that
 * a row written in a different format is not missed; every row returned is then
 * confirmed with toWhatsAppDigits, so matching stays exactly as strict as the
 * normaliser and no wider.
 */
export function storedPhoneForms(digits: string): string[] {
  const national = digits.slice(2);
  return [digits, `+${digits}`, `00${digits}`, `0${national}`];
}

function logFailure(source: OptOutLookup, message: string | undefined): void {
  console.error(
    `[whatsapp][opt-out] ${source} lookup failed, treating recipient as opted out: ${message ?? "unknown error"}`,
  );
}

/**
 * The opt-out status for one recipient, given the normalised digits the
 * dispatcher addresses them by.
 */
export async function isWhatsAppOptedOut(
  service: Service,
  digits: string,
): Promise<WhatsAppOptOutStatus> {
  // A. The phone itself.
  const byPhone = await service.from("whatsapp_opt_outs").select("id").eq("phone", digits).limit(1);
  if (byPhone.error) {
    logFailure("opt_outs_by_phone", byPhone.error.message);
    return { status: "lookup_failed", source: "opt_outs_by_phone" };
  }
  if ((byPhone.data ?? []).length > 0) return { status: "opted_out", matchedBy: "phone" };

  // B. Every BSUID ever seen arriving with this phone.
  const inbound = await service
    .from("whatsapp_inbound")
    .select("from_phone, bsuid")
    .in("from_phone", storedPhoneForms(digits))
    .not("bsuid", "is", null);
  if (inbound.error) {
    logFailure("inbound_bsuids", inbound.error.message);
    return { status: "lookup_failed", source: "inbound_bsuids" };
  }
  const bsuids = [
    ...new Set(
      ((inbound.data ?? []) as { from_phone: string | null; bsuid: string | null }[])
        .filter((row) => row.bsuid && toWhatsAppDigits(row.from_phone) === digits)
        .map((row) => row.bsuid as string),
    ),
  ];
  if (bsuids.length === 0) return { status: "clear" };

  const byBsuid = await service.from("whatsapp_opt_outs").select("id").in("bsuid", bsuids).limit(1);
  if (byBsuid.error) {
    logFailure("opt_outs_by_bsuid", byBsuid.error.message);
    return { status: "lookup_failed", source: "opt_outs_by_bsuid" };
  }
  if ((byBsuid.data ?? []).length > 0) return { status: "opted_out", matchedBy: "bsuid" };

  return { status: "clear" };
}
