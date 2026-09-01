// Server-side helpers for the /jobs page.
//
// LIST_SELECT — the lean column projection used by the card-grid query. Skips
// `description` (potentially KB-sized free text) since the list view only
// shows title/company/location/tags. /api/jobs/route.ts imports this same
// constant so both surfaces stay in sync.
//
// getInitialJobs() — runs server-side from src/app/jobs/page.tsx with NO
// filters, returns the top-100-most-recent OPEN jobs (matches /api/jobs's
// default branch). Falls back to [] on Supabase error so the client gets
// the "Couldn't load positions. Retry" UX.
//
// getJobById() — server-side helper used by /api/jobs/route.ts when a
// `?id=<uuid>` query param is present. Fetches the FULL row (including
// description) for the detail panel. The client island can't import this
// directly (createServiceClient pulls server-only `next/headers`), so the
// client hits the API route which delegates here.

import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";

export const LIST_SELECT =
  "id,title,company,company_rating,location,salary_min,salary_max,salary_currency,contract_type,work_type,category,experience_level,language,positions,status,created_at,slug,display_order,client_id,created_by,company_id";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// NumericMode + resolveNumericMode live in lib/screening.ts, which has no
// runtime imports — this module pulls in next/headers via getInitialJobs, so a
// client component cannot import a VALUE from here. Re-exported so server-side
// callers keep a single import site and there is one implementation of the rule.
export { resolveNumericMode, type NumericMode } from "@/lib/screening";
// The re-export above does not bind the name in this module's own scope, and
// ScreeningQuestion below references it. Type-only, so nothing is emitted.
import type { NumericMode } from "@/lib/screening";

export type ScreeningQuestion = {
  id: string;
  question: string; // <= 200 chars
  type: "yesno" | "numeric" | "multiple";
  // "Yes"/"No" for yesno · numeric-as-string for numeric · the ideal option
  // INDEX as a string ("0","1",…) for multiple. One consistent string type that
  // round-trips through the jsonb column unchanged.
  ideal: string;
  options: string[]; // [] unless type === "multiple"
  essential: boolean;
  /**
   * Numeric questions only. OPTIONAL, and that is the whole compatibility
   * story: every question already stored in jobs.screening_questions predates
   * this field, so an absent value has to mean something sensible — see
   * resolveNumericMode.
   */
  numeric_mode?: NumericMode;
};


// Frozen-at-apply-time snapshot of one screening answer, scored server-side in
// /api/apply and stored in job_applications.screening_answers (jsonb). The
// admin applications view reads this for display (no re-scoring).
export type ScreeningAnswerSnapshot = {
  question_id: string;
  question: string;
  type: "yesno" | "numeric" | "multiple";
  essential: boolean;
  ideal: string;
  answer: string;
  answer_label?: string;
  ideal_label?: string;
  matched: boolean;
  /**
   * False when the question was collected but never tested (numeric_mode
   * "none"). ABSENT on every snapshot written before this existed, and absent
   * means scored — so old rows read exactly as they always did.
   *
   * `matched` still has to carry a boolean, and for an unscored answer it is
   * written FALSE rather than true: anything reading only `matched` then
   * under-claims rather than over-claims, which is the safer direction when a
   * hiring decision is downstream. Readers that understand this field must
   * check it FIRST and ignore `matched` entirely when it is false — "wasn't a
   * test" is not the same as "failed the test".
   */
  scored?: boolean;
  /**
   * Which direction this numeric answer was tested in, frozen alongside the
   * rest of the snapshot so a display can name the operator without consulting
   * the job — whose question may since have been re-pointed or re-typed.
   *
   * Numeric answers only, and ABSENT on every snapshot written before the modes
   * existed. Absent is not ambiguous: until then `/api/apply`'s sole numeric
   * branch was `a >= ideal`, so a snapshot without this field was scored as a
   * minimum as a matter of historical fact, not assumption.
   */
  numeric_mode?: NumericMode;
};

export interface Job {
  id: string;
  title: string;
  company: string;
  company_rating: number;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  positions: number;
  slug: string | null;
  /** Optional because list-view queries omit them for payload size. The detail
   *  panel (getJobById / getJobBySlug) populates description + the two bullet
   *  lists. */
  description?: string | null;
  responsibilities: string | null;
  requirements: string | null;
  screening_questions: ScreeningQuestion[];
  display_order: number | null;
  // Ownership. Exactly one of these two tenant columns is set, or neither:
  //   company_id non-null → AI-product job (companies / /ai-dashboard)
  //   client_id  non-null → client-portal job (clients / /client)
  //   both null           → Remotiv-owned
  // created_by = the acting user who created the job. All three are
  // system-stamped, not user-editable form fields.
  client_id: string | null;
  company_id: string | null;
  created_by: string | null;
  status: string;
  created_at: string;
  /**
   * Public URL of the owning company's logo, or null.
   *
   * DERIVED, not a column — attachCompanyLogos fills it after the row query.
   * Null for Remotiv-owned jobs (company_id null), which keep the letter mark,
   * and for companies that have not uploaded one.
   */
  company_logo_url?: string | null;
}

/**
 * Bucket holding company logos. Public-read, so a plain public URL is correct
 * and no signing is involved.
 *
 * The name is duplicated from the settings segment's constants module rather
 * than imported: that module lives inside the ai-dashboard product, and lib/
 * must not depend on one of the products that consumes it. Worth consolidating
 * into a shared constants module the next time either side is touched.
 */
const COMPANY_LOGO_BUCKET = "company-logos";

/**
 * Attach each company-owned job's logo URL, without a per-row join.
 *
 * /jobs is the hottest page on the site and LIST_SELECT deliberately avoids
 * embeds for payload size, so this resolves the logos in ONE extra query keyed
 * on the DISTINCT company ids in the batch — at most a handful for a page of
 * 100 jobs, and an indexed primary-key lookup at that. A PostgREST embed would
 * ship the company row per job; a denormalised jobs.company_logo_path column
 * would remove the query but needs a migration, a backfill, and two write paths
 * kept in step forever, and goes stale silently when one is missed.
 *
 * Never throws: a logo is decoration, and a storage or companies-table blip
 * must not take down the jobs list. On failure every row simply gets null and
 * falls back to the letter mark.
 */
export async function attachCompanyLogos<T extends { company_id: string | null }>(
  rows: T[],
): Promise<(T & { company_logo_url: string | null })[]> {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean))] as string[];
  if (ids.length === 0) {
    return rows.map((r) => ({ ...r, company_logo_url: null }));
  }

  const supabase = createServiceClient();
  const byId = new Map<string, string>();

  try {
    const { data } = await supabase
      .from("companies")
      .select("id, logo_path")
      .in("id", ids);

    for (const row of (data ?? []) as { id: string; logo_path: string | null }[]) {
      const path = (row.logo_path ?? "").trim();
      if (!path) continue;
      const url = supabase.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(path)
        .data.publicUrl;
      if (url) byId.set(row.id, url);
    }
  } catch {
    // Fall through with an empty map — every card shows its letter.
  }

  return rows.map((r) => ({
    ...r,
    company_logo_url: (r.company_id && byId.get(r.company_id)) || null,
  }));
}

/**
 * The single source of truth for "is this job publicly visible":
 *
 *   status = 'open' AND archived_at IS NULL
 *
 * Archived is a separate axis from status on purpose: archived jobs are kept
 * for the company's records and are never public — a role withdrawn from the
 * site entirely, whatever its status. Admin, ai-dashboard, and other
 * company-facing surfaces deliberately do NOT use this helper: they
 * legitimately list closed and archived jobs.
 *
 * `T` is deliberately UNCONSTRAINED. Any structural constraint naming the
 * builder's `eq`/`is` methods (generic `T extends { eq(...): T }` or a
 * non-generic recursive interface) makes tsc instantiate supabase-js's
 * conditional builder types against the parsed LIST_SELECT projection and
 * fail with TS2589 "excessively deep". So the narrowing happens inside the
 * body via a minimal interface instead — safe because both methods return
 * `this` at runtime, so the output really is the caller's builder.
 */
type VisibilityFilterable = {
  eq(column: string, value: string): VisibilityFilterable;
  is(column: string, value: null): VisibilityFilterable;
};

export function publiclyVisible<T>(query: T): T {
  const filterable = query as VisibilityFilterable;
  return filterable.eq("status", "open").is("archived_at", null) as T;
}

export async function getInitialJobs(): Promise<Job[]> {
  const supabase = createServiceClient();

  const { data, error } = await publiclyVisible(
    supabase.from("jobs").select(LIST_SELECT),
  )
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    // Don't crash the page render on a transient Supabase error — fall back
    // to an empty initial list and let the client refetch on mount take over.
    return [];
  }

  return attachCompanyLogos((data ?? []) as unknown as Job[]);
}

/**
 * One publicly visible job by id, or the fact that we could not look.
 *
 * `Read<Job | null>` rather than `Job | null`: `if (error || !data) return null`
 * gave a database failure and a deleted job the same answer, and every caller
 * turned that into a 404. A live job told the reader it did not exist.
 */
export async function getJobById(id: string): Promise<Read<Job | null>> {
  // Reject non-UUID input before any DB work — see UUID_REGEX above. This is
  // an ANSWER: no such job can exist, and no query was needed to know it.
  if (!id || !UUID_REGEX.test(id)) return answered(null);

  const supabase = createServiceClient();

  const { data, error } = await publiclyVisible(
    supabase.from("jobs").select("*").eq("id", id),
  ).maybeSingle();

  if (error) {
    console.error("[jobs] getJobById failed:", error.message);
    return unavailable();
  }
  if (!data) return answered(null);

  const [job] = await attachCompanyLogos([data as Job]);
  return answered(job ?? null);
}

/**
 * Mirror of getJobById, matching on the human-readable slug instead of the
 * UUID. Same status gate, and the same three-state answer.
 */
export async function getJobBySlug(slug: string): Promise<Read<Job | null>> {
  if (!slug || slug.trim().length === 0) return answered(null);

  const supabase = createServiceClient();

  const { data, error } = await publiclyVisible(
    supabase.from("jobs").select("*").eq("slug", slug),
  ).maybeSingle();

  if (error) {
    console.error("[jobs] getJobBySlug failed:", error.message);
    return unavailable();
  }
  if (!data) return answered(null);

  const [job] = await attachCompanyLogos([data as Job]);
  return answered(job ?? null);
}
