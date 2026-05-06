/**
 * Sanitise raw server-action / Supabase / Postgres errors into
 * human-readable strings safe to surface in toasts and inline alerts.
 *
 * Goal: never show a Postgres code or stack trace to an admin user.
 * Translate the common cases to actionable copy; for everything else,
 * fall back to the supplied default.
 */

export function friendlyError(
  err: unknown,
  fallback = "Something went wrong",
): string {
  if (!err) return fallback;
  const message = err instanceof Error ? err.message : String(err);
  if (!message) return fallback;
  const lower = message.toLowerCase();

  // ── Postgres SQLSTATE classes ──────────────────────────────
  if (lower.includes("23503") || lower.includes("foreign key")) {
    return "This record is referenced elsewhere. Remove related records first.";
  }
  if (lower.includes("23505") || lower.includes("duplicate key") || lower.includes("unique")) {
    return "A record with this value already exists.";
  }
  if (lower.includes("23502") || lower.includes("not-null") || lower.includes("not null")) {
    return "A required field is missing.";
  }
  if (lower.includes("22001") || lower.includes("value too long")) {
    return "One of the fields is too long.";
  }

  // ── Auth / authorisation ───────────────────────────────────
  if (lower.includes("forbidden") || lower.includes("not authorised") || lower.includes("not authorized")) {
    return "You don't have permission to do this.";
  }
  if (lower.includes("not authenticated") || lower.includes("jwt") || lower.includes("session")) {
    return "Your session expired. Sign in again to continue.";
  }

  // ── Network / Supabase fetch ───────────────────────────────
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Network error. Check your connection and try again.";
  }

  // Strip technical prefixes ("Error:", "PGRST123:", etc.) and pass
  // shorter human-looking messages through as-is.
  const cleaned = message
    .replace(/^Error:\s*/i, "")
    .replace(/^[A-Z_0-9]+:\s*/i, "")
    .trim();

  if (cleaned.length === 0 || cleaned.length > 140) return fallback;
  return cleaned;
}
