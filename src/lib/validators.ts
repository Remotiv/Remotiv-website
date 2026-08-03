/**
 * Shared input validators for server actions and API routes.
 *
 * These exist to replace per-file ad-hoc checks (see the `isValidEmail`
 * that lived inline in src/app/admin/clients/actions.ts and the dozen
 * `value || null` patterns scattered across actions). One source of truth
 * makes it impossible to skip a check by copy-pasting a stale snippet.
 *
 * Lives in src/lib, NOT src/app/admin/lib, where it started. Pure string
 * predicates with no data path — but 14 non-admin files were importing them
 * from the admin tree, including /api/apply, the public contact form and the
 * company product's team invite. That is the product-separation rule broken 14
 * times over, and the direction of the dependency was backwards: the shared
 * layer must not live inside one of the products that consumes it.
 */

/**
 * Email validation — strict but practical. Accepts standard email shapes;
 * rejects whitespace, missing '@', missing TLD. Hard cap at 254 chars (RFC).
 *
 * Kept deliberately simple: we don't try to be RFC-5322-perfect, since real
 * Postgres / Supabase / SES will reject anything weirder than this anyway.
 */
export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Trim a string and return null if empty after trim. Use for OPTIONAL
 * text inputs that should never store " " (whitespace-only). Replaces
 * the `value?.trim() || null` pattern.
 */
export function trimToNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Trim a string for REQUIRED text inputs. Returns null if empty —
 * caller is expected to error out on null. Aliased separately from
 * trimToNull so the call-site reads as "this field is required".
 */
export function trimRequired(value: string | null | undefined): string | null {
  return trimToNull(value);
}
