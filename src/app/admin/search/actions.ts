"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";

export type SearchSource = "application" | "talent";

export type SearchHit = {
  id: string;
  source: SearchSource;
  name: string;
  email: string | null;
  phone: string | null;
  job_role: string | null;
  status: string | null;
  created_at: string;
  matchedKeywords: string[];
  matchCount: number;
  // For UI rendering of small snippets
  headline: string | null;
};

export type SearchResults = {
  query: string;
  keywords: string[];
  applications: SearchHit[];
  talent: SearchHit[];
};

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "were",
  "have", "has", "had", "you", "your", "but", "not", "any", "all", "can",
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOP_WORDS.has(s))
    .slice(0, 12); // cap at 12 keywords to keep queries sane
}

function escapeIlike(value: string): string {
  // Two passes:
  //   1. Strip OR-string metacharacters (commas, parens) that PostgREST
  //      itself parses — replace with spaces so the keyword still tokenises.
  //   2. Escape ILIKE wildcards (% _ \) so an admin typing "100%" matches
  //      literally instead of glob-matching every row.
  return value
    .replace(/[,()]/g, " ")
    .replace(/[\\%_]/g, "\\$&")
    .trim();
}

function countMatches(text: string | null | undefined, keywords: string[]): {
  count: number; matched: string[];
} {
  if (!text) return { count: 0, matched: [] };
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const k of keywords) {
    if (lower.includes(k)) matched.push(k);
  }
  return { count: matched.length, matched };
}

/**
 * Score a talent profile across plain text fields + the skills array.
 * Each keyword is checked against:
 *   - the joined text blob (name, email, job_title, summary, city, etc.)
 *   - any individual skill via case-insensitive substring match
 * Returns total unique keyword matches and the list of matched keywords.
 */
function scoreTalent(
  blob: string,
  skills: string[],
  keywords: string[],
): { count: number; matched: string[] } {
  const lowerBlob = blob.toLowerCase();
  const lowerSkills = skills.map((s) => s.toLowerCase());
  const matched = new Set<string>();
  for (const k of keywords) {
    if (lowerBlob.includes(k)) {
      matched.add(k);
      continue;
    }
    if (lowerSkills.some((s) => s.includes(k))) {
      matched.add(k);
    }
  }
  return { count: matched.size, matched: [...matched] };
}

export async function searchCandidates(query: string): Promise<SearchResults> {
  await requireAdmin();

  const trimmed = query.trim();
  const keywords = extractKeywords(trimmed);

  if (keywords.length === 0) {
    return { query: trimmed, keywords: [], applications: [], talent: [] };
  }

  const supabase = createServiceClient();

  // ── Applications search ─────────────────────────────────────
  // Build OR filter across each keyword × each searchable column.
  const APP_COLS = ["first_name", "last_name", "email", "cv_text", "notes"] as const;
  const appOr = keywords.flatMap((k) =>
    APP_COLS.map((c) => `${c}.ilike.%${escapeIlike(k)}%`),
  ).join(",");

  const appQuery = supabase
    .from("job_applications")
    .select("*, jobs(title)")
    // Global admin search returns full applicant rows — company-owned
    // applications are excluded outright.
    .is("company_id_snapshot", null)
    .or(appOr)
    .order("created_at", { ascending: false })
    .limit(200);

  // ── Talent profiles search ──────────────────────────────────
  // We pull a slice of recent talent_profiles rows and rank in JS so we can
  // walk the skills array element-by-element with substring matching rather
  // than relying on Postgres array-contains semantics (which only matches
  // exact tokens, not partial words).
  const talentQuery = supabase
    .from("talent_profiles")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  const [appRes, talentRes] = await Promise.all([appQuery, talentQuery]);

  const apps = (appRes.data ?? []) as Array<Record<string, unknown>>;
  const talents = (talentRes.data ?? []) as Array<Record<string, unknown>>;

  // ── Score & shape applications ──────────────────────────────
  const applications: SearchHit[] = apps.map((a) => {
    const fn = (a.first_name as string) ?? "";
    const ln = (a.last_name as string) ?? "";
    const blob = [
      fn,
      ln,
      (a.email as string) ?? "",
      (a.cv_text as string) ?? "",
      (a.notes as string) ?? "",
    ].join(" ");
    const { count, matched } = countMatches(blob, keywords);
    const hit: SearchHit = {
      id: a.id as string,
      source: "application",
      name: `${fn} ${ln}`.trim() || "Unnamed",
      email: (a.email as string | null) ?? null,
      phone: (a.phone as string | null) ?? null,
      job_role: (a.jobs as { title?: string } | null)?.title ?? null,
      status: (a.status as string | null) ?? null,
      created_at: a.created_at as string,
      matchedKeywords: matched,
      matchCount: count,
      headline: null,
    };
    return hit;
  }).filter((h) => h.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount);

  // ── Score & shape talent profiles ───────────────────────────
  const talent: SearchHit[] = talents.map((p) => {
    const fn = (p.first_name as string) ?? "";
    const ln = (p.last_name as string) ?? "";
    const fullName = `${fn} ${ln}`.trim();
    const skills = Array.isArray(p.skills) ? (p.skills as string[]) : [];
    const blob = [
      fullName,
      (p.email as string) ?? "",
      (p.job_title as string) ?? "",
      (p.summary as string) ?? "",
      (p.city as string) ?? "",
      (p.country as string) ?? "",
    ].join(" ");
    const { count, matched } = scoreTalent(blob, skills, keywords);
    const hit: SearchHit = {
      id: p.id as string,
      source: "talent",
      name: fullName || "Unnamed",
      email: (p.email as string | null) ?? null,
      phone: (p.phone as string | null) ?? null,
      job_role: (p.job_title as string | null) ?? null,
      status: (p.status as string | null) ?? null,
      created_at: (p.created_at as string) ?? "",
      matchedKeywords: matched,
      matchCount: count,
      headline: (p.summary as string | null) ?? null,
    };
    return hit;
  }).filter((h) => h.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount);

  return {
    query: trimmed,
    keywords,
    applications,
    talent,
  };
}
