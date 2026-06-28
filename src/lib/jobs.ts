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
  "id,title,company,company_rating,location,salary_min,salary_max,contract_type,work_type,category,experience_level,language,positions,status,created_at,slug";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  status: string;
  created_at: string;
}

export async function getInitialJobs(): Promise<Job[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("jobs")
    .select(LIST_SELECT)
    .eq("status", "open")
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
