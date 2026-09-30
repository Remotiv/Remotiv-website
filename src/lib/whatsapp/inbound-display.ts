/**
 * How a row of `whatsapp_inbound` reads on screen.
 *
 * Shared, not duplicated, because two surfaces render the same rows now: the
 * admin inbox at /admin/whatsapp and the applicant drawer's Communication tab.
 * A second copy would drift, and a candidate's voice note reading "Voice note"
 * in one place and as a blank line in the other is exactly the drift that
 * matters — one of those two is a message, the other looks like a bug.
 */

/**
 * What a message with no body actually was.
 *
 * A voice note or an uncaptioned image stores `body: null`, and the media id
 * sits in `raw` with nothing fetching it. Rendering that as an empty row makes
 * a real message look like a delivery failure, so every bodiless row says what
 * arrived instead.
 */
const MEDIA_LABEL: Record<string, string> = {
  image: "Photo",
  audio: "Voice note",
  voice: "Voice note",
  video: "Video",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
};

export function placeholderFor(messageType: string): { label: string; note: string } {
  const media = MEDIA_LABEL[messageType];
  if (media) {
    return { label: media, note: "Not downloaded — only the message record is stored." };
  }
  return { label: "No text content", note: `Arrived as "${messageType}".` };
}

/**
 * Message types that announce a changed WhatsApp identifier rather than
 * carrying something a person typed.
 *
 * `user_id_update` is the webhook-field path, which Meta does not offer on
 * v26.0 — it stays here because the branch that writes it still exists, and a
 * row appearing under it must not be dressed as a message either.
 */
const IDENTIFIER_CHANGE_TYPES: ReadonlyArray<string> = ["system", "user_id_update"];

export function isIdentifierChange(messageType: string): boolean {
  return IDENTIFIER_CHANGE_TYPES.includes(messageType);
}
