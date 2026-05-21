import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  type CandidateRow,
  type MatchResult,
  type Tier,
  checkRateLimit,
  getCached,
  getTier,
  logSearch,
  normalizeQuery,
  prefilterCandidates,
  rankWithClaude,
  setCached,
} from "@/lib/ai-matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LEN = 500;

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

// Strip contact fields. Phase 5 will wire per-candidate unlock; for now every
// caller sees the same redacted view.
function stripContact(row: CandidateRow): Omit<CandidateRow, "github_url" | "linkedin_url"> & {
  github_url: null;
  linkedin_url: null;
} {
  return {
    ...row,
    github_url: null,
    linkedin_url: null,
  };
}

function enrichResults(
  matches: MatchResult[],
  candidates: CandidateRow[],
): Array<MatchResult & { profile: ReturnType<typeof stripContact> }> {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: Array<MatchResult & { profile: ReturnType<typeof stripContact> }> = [];
  for (const m of matches) {
    const c = byId.get(m.candidate_id);
    if (!c) continue;
    out.push({ ...m, profile: stripContact(c) });
  }
  return out;
}

export async function POST(request: NextRequest) {
  // Spike-abuse limiter — 30 calls/min/IP on top of the daily counter. Stops
  // someone scripting a tight loop, regardless of tier.
  const rl = rateLimit(request, { bucketKey: "ai-matching" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // Parse + validate body
  let query = "";
  try {
    const body = (await request.json()) as { query?: unknown };
    query = typeof body.query === "string" ? body.query.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!query) {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }
  if (query.length > MAX_QUERY_LEN) {
    return NextResponse.json(
      { error: `Query must be ${MAX_QUERY_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  // Identify the caller (logged-in user vs anonymous IP)
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  const userId = user?.id ?? null;
  const ip = getClientIp(request);

  // Tier (used for cache key + later rate-limit check)
  const tierInfo = await getTier(userId);
  const tier: Tier = tierInfo.tier;

  // Cache lookup FIRST — cache hits cost us nothing (no Claude call), so they
  // should be served even when the user is at their daily limit. Anon + free
  // share a global cache keyed by normalized query; subscribers get per-user
  // cache so personalised ranking doesn't leak between accounts.
  const normalized = normalizeQuery(query);
  const cacheKey = tier === "subscriber" && userId ? `${normalized}:${userId}` : normalized;

  const cached = await getCached(cacheKey);
  if (cached) {
    // Re-fetch fresh profile rows by id so we never return stale name/role data
    // after a candidate edits their profile or is archived. used/limit reported
    // here reflect the current counter — cache hits do not increment it.
    const ids = cached.map((m) => m.candidate_id);
    const cachedLimitView = await checkRateLimit({ userId, ip, tier });
    if (ids.length === 0) {
      return NextResponse.json({
        results: [],
        tier,
        cached: true,
        used: cachedLimitView.used,
        limit: cachedLimitView.limit,
      });
    }
    const supabase = createServiceClient();
    const { data: rows } = await supabase
      .from("talent_profiles")
      .select(
        "id, first_name, last_name, job_title, role_category, skills, city, country, years_experience, summary, availability, work_type, github_url, linkedin_url, avatar_url, status, salary_min, salary_max",
      )
      .in("id", ids)
      .not("approved_at", "is", null);
    const candidates = (rows ?? []) as CandidateRow[];
    return NextResponse.json({
      results: enrichResults(cached, candidates),
      tier,
      cached: true,
      used: cachedLimitView.used,
      limit: cachedLimitView.limit,
    });
  }

  // Daily quota — only checked on cache MISS (fresh searches cost us Claude tokens).
  const limitCheck = await checkRateLimit({ userId, ip, tier });
  if (!limitCheck.allowed) {
    return NextResponse.json(
      {
        error: "rate_limit",
        used: limitCheck.used,
        limit: limitCheck.limit,
        tier,
      },
      { status: 429 },
    );
  }

  // STAGE 1: pre-filter
  const candidates = await prefilterCandidates(query);
  if (candidates.length === 0) {
    // Still log so empty-result searches count against the quota — otherwise a
    // free user could spam nonsense queries to exhaust our Claude budget on
    // the next genuine search.
    await logSearch({ userId, ip, query });
    return NextResponse.json({
      results: [],
      tier,
      cached: false,
      used: limitCheck.used + 1,
      limit: limitCheck.limit,
    });
  }

  // STAGE 2: Claude ranking
  const ranked = await rankWithClaude(query, candidates);

  // Cache + log the fresh search
  await setCached(cacheKey, query, ranked);
  await logSearch({ userId, ip, query });

  return NextResponse.json({
    results: enrichResults(ranked, candidates),
    tier,
    cached: false,
    used: limitCheck.used + 1,
    limit: limitCheck.limit,
  });
}
