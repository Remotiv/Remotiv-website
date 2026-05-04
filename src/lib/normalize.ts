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
