/**
 * AI Matching engine — Stage 1 (Postgres pre-filter) + Stage 2 (Claude Haiku
 * ranking). Exported as discrete steps so the route handler can compose them
 * with rate-limiting + caching.
 *
 * Tables (see migrations 008-010):
 *   - talent_profiles.search_vector  (trigger-maintained tsvector)
 *   - ai_search_log                  (rate-limit counter — 3/day anon+free)
 *   - ai_match_cache                 (9h ranked-result cache by normalized query)
 */

import { createServiceClient } from "@/lib/supabase/server";
import { getAnthropic, AI_MATCHING_MODEL } from "@/lib/anthropic";

// ── Types ────────────────────────────────────────────────────

export interface MatchResult {
  candidate_id: string;
  match_percent: number;
  why: string;
}

export interface CandidateRow {
  id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  role_category: string | null;
  skills: string[];
  city: string | null;
  country: string | null;
  years_experience: number | null;
  summary: string | null;
  availability: string | null;
  work_type: string | null;
  // Contact fields — fetched so the route can conditionally include them per
  // (subscriber + unlocked). NEVER sent to Claude (see candidateSummaryForPrompt).
  email: string | null;
  phone: string | null;
  cv_url: string | null;
  github_url: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  status: string;
  salary_min: number | null;
  salary_max: number | null;
}

export type Tier = "anonymous" | "free" | "subscriber";

export interface TierInfo {
  tier: Tier;
  creditsRemaining: number;
}

// ── Constants ────────────────────────────────────────────────

const DAILY_LIMIT = 3;
const PREFILTER_LIMIT = 40;
const CACHE_TTL_HOURS = 9;
const TOP_N = 10;
const CLAUDE_MAX_TOKENS = 2048;
const PROMPT_SKILLS_LIMIT = 12;
const PROMPT_SUMMARY_LIMIT = 320;
const WHY_MAX_LEN = 280;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "who", "has", "have", "are", "you",
  "your", "our", "from", "that", "this", "plus", "want", "need",
  "experience", "exp", "years", "year", "yrs", "based", "available",
  "looking", "should", "must", "able", "good", "great",
]);

// ── 1. normalizeQuery ────────────────────────────────────────

export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

// ── 2. getTier ───────────────────────────────────────────────

export async function getTier(userId: string | null): Promise<TierInfo> {
  if (!userId) return { tier: "anonymous", creditsRemaining: 0 };

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("subscriptions")
    .select("tier, credits_remaining")
    .eq("user_id", userId)
    .maybeSingle();

  const sub = data as { tier?: string; credits_remaining?: number } | null;
  if (sub?.tier === "starter" || sub?.tier === "pro") {
    return { tier: "subscriber", creditsRemaining: sub.credits_remaining ?? 0 };
  }
  return { tier: "free", creditsRemaining: 0 };
}

// ── 3. checkRateLimit ────────────────────────────────────────

function midnightUtcIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function checkRateLimit(params: {
  userId: string | null;
  ip: string;
  tier: Tier;
}): Promise<{ allowed: boolean; used: number; limit: number }> {
  if (params.tier === "subscriber") {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY };
  }

  const supabase = createServiceClient();
  const since = midnightUtcIso();

  let query = supabase
    .from("ai_search_log")
    .select("id", { count: "exact", head: true })
    .gte("searched_at", since);

  if (params.userId) {
    query = query.eq("user_id", params.userId);
  } else {
    query = query.eq("ip_address", params.ip);
  }

  const { count, error } = await query;
  if (error) {
    console.error("[ai-matching] rate-limit count failed:", error);
    // Fail open — better to allow a few extra searches than to lock everyone
    // out on a transient DB error.
    return { allowed: true, used: 0, limit: DAILY_LIMIT };
  }

  const used = count ?? 0;
  return { allowed: used < DAILY_LIMIT, used, limit: DAILY_LIMIT };
}

// ── 4. logSearch ─────────────────────────────────────────────

export async function logSearch(params: {
  userId: string | null;
  ip: string;
  query: string;
}): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("ai_search_log").insert({
    user_id: params.userId,
    ip_address: params.userId ? null : params.ip,
    query: params.query,
  });
  if (error) console.error("[ai-matching] logSearch failed:", error);
}

// ── 5. getCached / 6. setCached ──────────────────────────────

export async function getCached(cacheKey: string): Promise<MatchResult[] | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("ai_match_cache")
    .select("result, expires_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { result: unknown; expires_at: string };
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  if (!Array.isArray(row.result)) return null;
  return row.result as MatchResult[];
}

export async function setCached(
  cacheKey: string,
  query: string,
  result: MatchResult[],
): Promise<void> {
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 3600_000).toISOString();
  const { error } = await supabase.from("ai_match_cache").upsert(
    {
      cache_key: cacheKey,
      query,
      result,
      expires_at: expiresAt,
    },
    { onConflict: "cache_key" },
  );
  if (error) console.error("[ai-matching] setCached failed:", error);
}

// ── 7. prefilterCandidates ───────────────────────────────────

export const CANDIDATE_COLUMNS =
  "id, first_name, last_name, email, phone, cv_url, job_title, role_category, skills, city, country, years_experience, summary, availability, work_type, github_url, linkedin_url, avatar_url, status, salary_min, salary_max";

export async function prefilterCandidates(
  query: string,
  limit: number = PREFILTER_LIMIT,
): Promise<CandidateRow[]> {
  const supabase = createServiceClient();
  const normalized = normalizeQuery(query);

  // Build an OR-joined tsquery from meaningful tokens (>2 chars, alpha-numeric).
  // websearch AND-joins which is too strict for natural-language hiring prompts.
  const tokens = normalized
    .replace(/[^a-z0-9\s.+#]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  if (tokens.length > 0) {
    const orQuery = tokens.join(" | ");
    const { data: ftData, error: ftError } = await supabase
      .from("talent_profiles")
      .select(CANDIDATE_COLUMNS)
      .not("approved_at", "is", null)
      .not("status", "in", "(paused,archived)")
      .textSearch("search_vector", orQuery, { type: "plain", config: "english" })
      .limit(limit);

    if (ftError) {
      console.error("[ai-matching] prefilter full-text failed:", ftError);
    }
    const ftRows = (ftData ?? []) as CandidateRow[];
    if (ftRows.length > 0) return ftRows;
  }

  // Fallback: per-token OR ILIKE on job_title / role_category
  const safeTokens = tokens.slice(0, 6).map((t) => t.replace(/[%_\\]/g, ""));
  if (safeTokens.length === 0) {
    // last resort: return most recent approved profiles so the page is never empty
    const { data } = await supabase
      .from("talent_profiles")
      .select(CANDIDATE_COLUMNS)
      .not("approved_at", "is", null)
      .not("status", "in", "(paused,archived)")
      .order("approved_at", { ascending: false })
      .limit(limit);
    return (data ?? []) as CandidateRow[];
  }

  const orFilter = safeTokens
    .flatMap((t) => [`job_title.ilike.%${t}%`, `role_category.ilike.%${t}%`])
    .join(",");
  const { data: fbData, error: fbError } = await supabase
    .from("talent_profiles")
    .select(CANDIDATE_COLUMNS)
    .not("approved_at", "is", null)
    .not("status", "in", "(paused,archived)")
    .or(orFilter)
    .limit(limit);

  if (fbError) {
    console.error("[ai-matching] prefilter fallback failed:", fbError);
    return [];
  }
  return (fbData ?? []) as CandidateRow[];
}

// ── 8. rankWithClaude ────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function parseMatchJson(raw: string): MatchResult[] | null {
  const stripped = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return null;
    const out: MatchResult[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.candidate_id === "string" ? r.candidate_id : null;
      const pct =
        typeof r.match_percent === "number"
          ? Math.max(0, Math.min(100, Math.round(r.match_percent)))
          : null;
      const why = typeof r.why === "string" ? r.why.slice(0, WHY_MAX_LEN) : "";
      if (!id || pct == null) continue;
      out.push({ candidate_id: id, match_percent: pct, why });
    }
    return out;
  } catch {
    return null;
  }
}

function candidateSummaryForPrompt(c: CandidateRow): string {
  const name = `${c.first_name}${c.last_name ? " " + c.last_name : ""}`.trim();
  const skills = c.skills?.length ? c.skills.slice(0, PROMPT_SKILLS_LIMIT).join(", ") : "—";
  const loc = [c.city, c.country].filter(Boolean).join(", ") || "—";
  const exp = c.years_experience != null ? `${c.years_experience} yrs` : "—";
  const role = c.job_title || c.role_category || "—";
  const summary = (c.summary || "").slice(0, PROMPT_SUMMARY_LIMIT).replace(/\s+/g, " ");
  return `id: ${c.id}\nname: ${name}\nrole: ${role}\nlocation: ${loc}\nexperience: ${exp}\nskills: ${skills}\nsummary: ${summary || "—"}`;
}

export async function rankWithClaude(
  query: string,
  candidates: CandidateRow[],
): Promise<MatchResult[]> {
  if (candidates.length === 0) return [];

  const candidateBlocks = candidates
    .map((c, i) => `Candidate #${i + 1}\n${candidateSummaryForPrompt(c)}`)
    .join("\n\n");

  const systemPrompt =
    "You are a technical recruiter. Rank candidates by fit to the hiring query. " +
    "Return ONLY valid JSON — no prose, no markdown, no code fences. " +
    `Output: a JSON array of up to ${TOP_N} objects, sorted by match_percent descending. ` +
    'Each object must be: {"candidate_id": "<uuid copied exactly from the candidate>", "match_percent": <integer 0-100>, "why": "<one short sentence on the fit>"}. ' +
    "Only include candidates who genuinely fit the query — fewer than 10 is fine. " +
    "If no candidates fit, return [].";

  const userMessage = `Hiring query:\n${query}\n\nCandidates:\n${candidateBlocks}`;

  try {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: AI_MATCHING_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    const text = block && block.type === "text" ? block.text : "";

    const parsed = parseMatchJson(text);
    if (!parsed) {
      // Source fix for C1: return [] on Claude parse-fail rather than fabricated
      // zero-scored cards. The route surfaces an EmptyState rather than a wall
      // of "0% AI MATCH" cards that look broken. Logged for diagnostics.
      console.error("[ai-matching] Claude returned non-JSON. Returning empty.", text.slice(0, 200));
      return [];
    }

    // Filter to ids that actually exist in our candidate set (guard against
    // hallucinated uuids), preserve Claude's order, cap at TOP_N.
    const validIds = new Set(candidates.map((c) => c.id));
    return parsed.filter((m) => validIds.has(m.candidate_id)).slice(0, TOP_N);
  } catch (e) {
    // Same C1 source fix on auth/network/SDK throws. Caller sees [] →
    // EmptyState. The error log gives ops a signal something's wrong.
    console.error("[ai-matching] Claude call threw. Returning empty.", e);
    return [];
  }
}
