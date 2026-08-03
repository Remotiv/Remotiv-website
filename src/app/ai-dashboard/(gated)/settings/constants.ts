/**
 * Shared between the settings server actions and the logo upload route.
 *
 * A plain module, NOT "use server": such a module may only export async
 * functions, and both consumers need these as values.
 */

/**
 * Bucket for company logos. NEW, and deliberately not one of the existing two.
 *
 *   cvs           private, read through signed URLs and an audit log. A logo is
 *                 public brand artwork; putting it here would mean either
 *                 signing every render of a public page or loosening the bucket
 *                 that holds candidate CVs. Neither is acceptable.
 *   talent_photos public, but it is the TALENT namespace — individual people's
 *                 photos, with their own retention and deletion story tied to a
 *                 person's right to erasure. A company's brand asset has a
 *                 different owner, a different lifecycle and a different legal
 *                 basis; sharing a bucket makes per-bucket policy impossible to
 *                 reason about later.
 *
 * Public-read is correct here: the logo appears on every public job post, so
 * signed URLs would add a round trip and an expiry to something that is, by
 * definition, not a secret.
 */
export const COMPANY_LOGO_BUCKET = "company-logos";

/** Matches the copy in the UI: "PNG or JPG, up to 5MB." */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Allowed types, checked against the SNIFFED bytes rather than the browser's
 * Content-Type — a client can claim anything, and this bucket is public.
 */
export const LOGO_MIME_TYPES = ["image/png", "image/jpeg"] as const;

/**
 * Magic-number prefixes for the two accepted formats.
 *
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *
 * Extension and Content-Type are both attacker-controlled. Sniffing the header
 * is what stops an HTML or SVG payload being served from a public bucket on our
 * own origin, which is a stored-XSS vector rather than a mere content-type bug.
 */
export function sniffLogoMime(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}
