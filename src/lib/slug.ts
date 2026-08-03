import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * URL-safe slug generation, shared by every table that has a `slug` column.
 *
 * Extracted from the job-slug builder in ai-dashboard/jobs/actions.ts rather
 * than reimplemented for companies. Two reasons it had to move out of there
 * rather than simply be imported:
 *
 *   - `slugify` is synchronous, and a "use server" module may only export async
 *     functions, so it could not be exported at all.
 *   - `buildSlug` IS async and therefore exportable — but exporting it from a
 *     "use server" file compiles it into a client-callable server action,
 *     publishing an unauthenticated endpoint whose whole job is probing which
 *     slugs already exist. Reuse must not cost that.
 *
 * A plain module in src/lib has neither problem, and the dependency points at
 * the shared layer rather than from one product into another.
 */

/** Lowercase, non-alphanumeric runs to single hyphens, no leading/trailing. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A slug not already taken in `table`, probing `base`, `base-2`, `base-3`…
 *
 * The loop is a BACKSTOP, not a guarantee: probe-then-insert is not atomic, so
 * two provisioning requests a millisecond apart can both see a free slug and
 * both try to claim it. Every caller must still catch 23505 on the insert and
 * surface it as a retryable error — that unique constraint is the only real
 * arbiter, and this function exists to make hitting it rare rather than to make
 * it impossible.
 *
 * `fallback` covers a name that slugifies to nothing at all — "!!!" or a purely
 * non-Latin name — which would otherwise produce an empty slug and a URL that
 * silently matches nothing.
 */
export async function uniqueSlug(
  supabase: ReturnType<typeof createServiceClient>,
  options: { table: string; base: string; fallback: string },
): Promise<string> {
  const base = options.base || options.fallback;
  let candidate = base;
  let n = 2;
  for (;;) {
    const { data: clash } = await supabase
      .from(options.table)
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!clash) break;
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}
