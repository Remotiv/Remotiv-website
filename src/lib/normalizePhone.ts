/**
 * Normalise a phone number for duplicate detection.
 *
 * Strips formatting and common country-code prefixes so different
 * representations of the same Pakistani number all collapse to the same
 * 10-digit local form (300xxxxxxx).
 *
 * Examples (all return "3001234567"):
 *   "0300-1234567"     → "3001234567"
 *   "+92 300 1234567"  → "3001234567"
 *   "0092 300 1234567" → "3001234567"
 *   "923001234567"     → "3001234567"
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  // 0092 300 1234567 → 3001234567
  if (digits.startsWith("0092")) return digits.slice(4);
  // 92 300 1234567 → 3001234567 (only when long enough to be a real PK number)
  if (digits.startsWith("92") && digits.length >= 11) return digits.slice(2);
  // 0300 1234567 → 3001234567
  if (digits.startsWith("0") && digits.length === 11) return digits.slice(1);

  return digits;
}
