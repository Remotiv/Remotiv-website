/**
 * Shared normalization helpers used by every registration API
 * (`/api/talent`, `/api/apply`, `/api/hire-remote-profiles`,
 * `/api/check-duplicate`).
 *
 * Each pipeline writes to its own table and runs its own duplicate check.
 * These helpers exist so the comparison key — and the value persisted —
 * is consistent across pipelines, removing the casing / formatting drift
 * that previously let the same person register multiple times within a
 * single pipeline (e.g. "John@gmail.com" vs "john@gmail.com").
 */

export function normalizeEmail(email: string): string {
  return (email ?? "").toLowerCase().trim();
}

/**
 * Strip formatting and common Pakistani country-code prefixes so different
 * representations of the same number collapse to the same 10-digit local
 * form (e.g. "0300-1234567", "+92 300 1234567", "0092 300 1234567",
 * "923001234567" all become "3001234567").
 */
export function normalizePhone(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0092")) return digits.slice(4);
  if (digits.startsWith("92") && digits.length >= 12) return digits.slice(2);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Produce wa.me-ready digits for a Pakistani phone number: full international
 * form, NO leading "+", spaces, or dashes (e.g. "923306472177"). Returns null
 * when the input is missing or its country can't be determined safely — the
 * caller is expected to disable the WhatsApp action in that case.
 *
 * This is the OPPOSITE of normalizePhone above (which strips the country code
 * to a 10-digit local key for duplicate detection). Don't confuse the two:
 * wa.me needs the country code present, dedupe needs it absent.
 *
 * Pakistan-only acceptance — anything that doesn't match a known PK shape
 * (intl 0092…, intl 92…, or local 0…) returns null rather than guessing.
 */
export function toWhatsAppDigits(phone: string | null | undefined): string | null {
  if (!phone || !phone.trim()) return null;
  const d = phone.replace(/\D/g, "");
  let intl: string | null = null;
  if (d.startsWith("0092") && d.length === 14) {
    intl = `92${d.slice(4)}`;
  } else if (d.startsWith("92") && d.length === 12) {
    intl = d;
  } else if (d.startsWith("0") && d.length === 11) {
    intl = `92${d.slice(1)}`;
  }
  if (intl === null || intl.length !== 12) return null;
  return intl;
}
