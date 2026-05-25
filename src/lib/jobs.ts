// Server-side helper for the initial (unfiltered) jobs fetch.
// Mirrors the default branch of src/app/api/jobs/route.ts EXACTLY — same
// table, same filter (status="open"), same ordering, same limit. Used by the
// /jobs server-component page to put the initial card list in the SSR'd HTML
// so the user sees jobs immediately (no client-fetch waterfall).
//
// The /api/jobs route stays the source for FILTER CHANGES (category, exp,
// contract, language) — the client island still calls it on filter change.

import { createServiceClient } from "@/lib/supabase/server";

export interface Job {
  id: string;
  title: string;
  company: string;
  company_rating: number;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  description: string | null;
  status: string;
  created_at: string;
}

export async function getInitialJobs(): Promise<Job[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    // Don't crash the page render on a transient Supabase error — fall back
    // to an empty initial list and let the client refetch on mount take over.
    return [];
  }

  return (data ?? []) as Job[];
}
