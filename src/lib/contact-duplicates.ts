import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Is this email or phone already a candidate somewhere? The cross-table check
 * behind the admin bulk CV upload: its review step (/api/check-duplicate-bulk)
 * and its per-row submit (/api/batch-candidate-cv) ask the same question the
 * same way.
 */

type Service = ReturnType<typeof createServiceClient>;

/**
 * A value for a term inside PostgREST's `or=( … )`.
 *
 * Inside that grammar a comma, parentheses, a double quote and a backslash are
 * syntax. Double-quoting the value makes the first three data, and inside the
 * quotes `\` escapes `"` and `\`. This is the PostgREST half of the Messages
 * search rule (#73, messages/search-filter.ts, measured on staging); its LIKE
 * half does not apply here, because these terms are `eq`, where `%`, `_` and
 * `*` are ordinary characters.
 *
 * Unquoted, an email such as `a@x.com,id.not.is.null` added a second term that
 * matched every row, and a phone such as `(021) 555 0101` broke the filter.
 */
export function postgrestOrValue(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** `email.eq."…",phone.eq."…"` for whichever is present, or null for neither. */
export function contactOrFilter(contact: { email: string; phone: string }): string | null {
  const parts: string[] = [];
  if (contact.email) parts.push(`email.eq.${postgrestOrValue(contact.email)}`);
  if (contact.phone) parts.push(`phone.eq.${postgrestOrValue(contact.phone)}`);
  return parts.length > 0 ? parts.join(",") : null;
}

export type DuplicateSource = "batch" | "application" | "talent";

export type ContactMatch = {
  source: DuplicateSource;
  id: string;
  first_name: string | null;
  last_name: string | null;
};

/**
 * `ok: false` means the check could not be made, never "no duplicate". A failed
 * read used to read as no match, so a real duplicate went through unflagged.
 */
export type DuplicateLookup = { ok: true; match: ContactMatch | null } | { ok: false };

/**
 * The first match in priority order: a batch candidate, then an application,
 * then a talent profile.
 *
 * The three reads run together; the answer is decided in that order. A match
 * wins even if a LATER table's read failed, because nothing it could have said
 * outranks it. A failed read on an EARLIER table makes the answer unknown: it
 * might have held the match that wins.
 *
 * `applicationScope` is an extra `.or()` on the applications read, applied
 * exactly as the caller passes it (check-duplicate-bulk keeps customers'
 * applicants out of an admin tool with it).
 */
export async function findContactDuplicate(
  supabase: Service,
  contact: { email: string; phone: string },
  options: { applicationScope?: string } = {},
): Promise<DuplicateLookup> {
  const filter = contactOrFilter(contact);
  if (!filter) return { ok: true, match: null };

  const columns = "id, first_name, last_name";
  const applications = supabase.from("job_applications").select(columns).or(filter);
  const reads: [DuplicateSource, PromiseLike<{ data: unknown; error: unknown }>][] = [
    [
      "batch",
      supabase.from("client_batch_candidates").select(columns).or(filter).limit(1).maybeSingle(),
    ],
    [
      "application",
      (options.applicationScope ? applications.or(options.applicationScope) : applications)
        .limit(1)
        .maybeSingle(),
    ],
    ["talent", supabase.from("talent_profiles").select(columns).or(filter).limit(1).maybeSingle()],
  ];
  const answers = await Promise.all(reads.map(([, read]) => read));

  for (let i = 0; i < reads.length; i++) {
    const { data, error } = answers[i];
    if (error) return { ok: false };
    if (data) {
      const row = data as { id: string; first_name: string | null; last_name: string | null };
      return {
        ok: true,
        match: {
          source: reads[i][0],
          id: row.id,
          first_name: row.first_name,
          last_name: row.last_name,
        },
      };
    }
  }
  return { ok: true, match: null };
}
