import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const PAGE_SIZE = 12;
const RATE_FILTER_MAX = 200;

// KEEP IN SYNC with ENGLISH_LEVEL_RANK in src/app/hire-remote/_marketplace.tsx
// and the trigger mapping in migration 012.
const ENGLISH_LEVEL_RANK: Record<string, number> = {
  Native: 4,
  Fluent: 3,
  Professional: 2,
  Basic: 1,
};

// Bucket labels use the en-dash (U+2013) — they MUST match the EXP_FILTERS
// array in _marketplace.tsx (which the client sends via the URL).
// `null` upper bound means unbounded (years_experience >= 10).
const EXP_BUCKETS: Record<string, [number, number | null]> = {
  "0–2 yrs": [0, 2],
  "3–5 yrs": [3, 5],
  "6–10 yrs": [6, 10],
  "10+ yrs": [10, null],
};

// Allow-list mirrors src/app/hire-remote/page.tsx — never add email, phone,
// linkedin_url, cv_*, photo_*, or any admin/internal field. These ship to the
// browser as candidate rows.
const SELECT_COLUMNS =
  "id, first_name, last_name, city, country, time_zone, job_titles, bio, hourly_rate, hours_per_week, work_type, availability, available_from_date, languages, email_verified, id_verified, phone_verified, skills, employment_history, education, portfolio";

const MAX_PARAM_LEN = 200;

function clip(raw: string | null): string {
  return (raw ?? "").slice(0, MAX_PARAM_LEN);
}

// .or() uses comma + parens + asterisk as syntax. Strip them so a user-typed
// search input can't break the filter expression.
function sanitiseOrValue(q: string): string {
  return q.replace(/[,()*]/g, "").trim();
}

export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "hire-remote-candidates" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const sp = request.nextUrl.searchParams;

  const role = clip(sp.get("role")) || "All Roles";
  const skills = clip(sp.get("skills")).toLowerCase();

  const rateRaw = Number.parseInt(clip(sp.get("rate")), 10);
  const rate = Number.isFinite(rateRaw)
    ? Math.max(0, Math.min(rateRaw, RATE_FILTER_MAX))
    : RATE_FILTER_MAX;

  const exp = clip(sp.get("exp")) || "Any";
  const avail = clip(sp.get("avail")) || "Any";
  const english = clip(sp.get("english")) || "Any";
  const q = sanitiseOrValue(clip(sp.get("q"))).toLowerCase();

  const pageRaw = Number.parseInt(clip(sp.get("page")), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const supabase = createServiceClient();

  let query = supabase
    .from("hire_remote_profiles")
    .select(SELECT_COLUMNS, { count: "exact" })
    .eq("status", "approved")
    .not("approved_at", "is", null);

  if (role !== "All Roles") {
    const firstWord = role.split(" ")[0]?.toLowerCase() ?? "";
    if (firstWord) {
      query = query.ilike("job_titles", `%${firstWord}%`);
    }
  }

  if (skills) {
    query = query.ilike("skills_text", `%${skills}%`);
  }

  if (rate < RATE_FILTER_MAX) {
    query = query.lte("hourly_rate", rate);
  }

  if (exp !== "Any" && EXP_BUCKETS[exp]) {
    const [lo, hi] = EXP_BUCKETS[exp];
    query = query.gte("years_experience", lo);
    if (hi !== null) {
      query = query.lte("years_experience", hi);
    }
  }

  if (avail === "Available Now") {
    query = query.eq("availability", "Available Now");
  } else if (avail === "Available Later") {
    query = query.neq("availability", "Available Now");
  }

  if (english !== "Any" && ENGLISH_LEVEL_RANK[english] !== undefined) {
    query = query.gte("english_level_rank", ENGLISH_LEVEL_RANK[english]);
  }

  if (q) {
    query = query.or(
      [
        `first_name.ilike.%${q}%`,
        `last_name.ilike.%${q}%`,
        `job_titles.ilike.%${q}%`,
        `bio.ilike.%${q}%`,
        `city.ilike.%${q}%`,
        `country.ilike.%${q}%`,
        `skills_text.ilike.%${q}%`,
      ].join(","),
    );
  }

  const from = (page - 1) * PAGE_SIZE;
  const to = page * PAGE_SIZE - 1;

  const { data, error, count } = await query
    .order("approved_at", { ascending: false })
    .range(from, to);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const total = count ?? 0;

  return NextResponse.json({
    candidates: data ?? [],
    total,
    page,
    hasMore: page * PAGE_SIZE < total,
  });
}
