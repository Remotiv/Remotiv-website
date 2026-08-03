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
}

export async function getInitialJobs(): Promise<Job[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("jobs")
    .select(LIST_SELECT)
    .eq("status", "open")
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    // Don't crash the page render on a transient Supabase error — fall back
    // to an empty initial list and let the client refetch on mount take over.
    return [];
  }

  return (data ?? []) as unknown as Job[];
}

export async function getJobById(id: string): Promise<Job | null> {
  // Reject non-UUID input before any DB work — see UUID_REGEX above.
  if (!id || !UUID_REGEX.test(id)) return null;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .eq("status", "open")
    .maybeSingle();

  if (error) return null;
  return (data as Job | null) ?? null;
}

export async function getJobBySlug(slug: string): Promise<Job | null> {
  // Mirror of getJobById, matching on the human-readable slug instead of the
  // UUID. Same status gate + null-on-miss behaviour.
  if (!slug || slug.trim().length === 0) return null;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("slug", slug)
    .eq("status", "open")
    .maybeSingle();

  if (error) return null;
  return (data as Job | null) ?? null;
}
