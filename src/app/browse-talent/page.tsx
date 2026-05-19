import { createClient, createServiceClient } from "@/lib/supabase/server";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

const VALID_ROLES = [
  "All",
  "Engineer",
  "SDR",
  "CS",
  "Design",
  "Data",
  "DevOps",
  "QA",
  "Marketing",
  "Ops",
  "Finance",
] as const;
type RoleFilter = (typeof VALID_ROLES)[number];

const isFreeViewer = (tier: string): boolean => tier === "free";

function escapeIlike(s: string): string {
  // Strip PostgREST-special chars that break .or() string parsing
  const cleaned = s.replace(/[,()'"]/g, "");
  // Escape Postgres ILIKE wildcards (% and _) and the escape character (\).
  return cleaned.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export default async function BrowseTalentPage({
  searchParams,
}: {
  searchParams: Promise<{
    role?: string;
    q?: string;
    sort?: string;
    page?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;

  const roleParam = params.role ?? "All";
  const role: RoleFilter = (VALID_ROLES as readonly string[]).includes(roleParam)
    ? (roleParam as RoleFilter)
    : "All";
  const q = (params.q ?? "").trim().slice(0, 100);
  const sort: "match" | "name" = params.sort === "name" ? "name" : "match";
  const pageRaw = Number(params.page ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const isSavedView = params.view === "saved";

  // Auth-aware client (reads cookies) for user + subscription lookup; service
  // client bypasses RLS for the public talent fetch.
  const auth = await createClient();
  const supabase = createServiceClient();

  const { data: { user } } = await auth.auth.getUser();
  const userId = user?.id ?? "";

  let tier: "free" | "subscriber" = "free";
  let creditsRemaining = 0;
  if (user && userId) {
    const { data: sub } = await auth
      .from("subscriptions")
      .select("tier, credits_remaining")
      .eq("user_id", userId)
      .maybeSingle();
    if (sub?.tier === "starter" || sub?.tier === "pro") {
      tier = "subscriber";
      creditsRemaining = sub.credits_remaining ?? 0;
    }
  }

  // Phase B security: free tier is locked to page 1. Without this, free users could
  // bypass the 15-row cap by passing ?page=2, ?page=3 etc. and scrape the full pool.
  // Subscribers see full pagination; free users locked to page 1.
  const effectivePage = isFreeViewer(tier) ? 1 : page;
  const PAGE_SIZE = isFreeViewer(tier) ? 15 : 30;
  const from = (effectivePage - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Phase B-4: saved profiles filter — fetch user's saved candidate IDs
  const savedIdsArr: string[] = [];
  const savedIdsSet = new Set<string>();
  if (user) {
    const { data: savedRows } = await supabase
      .from("saved_profiles")
      .select("candidate_id")
      .eq("user_id", user.id);
    if (savedRows) {
      for (const r of savedRows as Array<{ candidate_id: string }>) {
        savedIdsArr.push(r.candidate_id);
        savedIdsSet.add(r.candidate_id);
      }
    }
  }

  // Short-circuit: saved view with zero saves → render empty state
  const shouldReturnEmpty = isSavedView && savedIdsSet.size === 0;

  let rows: TalentRow[] = [];
  let totalCount = 0;
  let totalPages = 1;

  if (!shouldReturnEmpty) {
    let talentQuery = supabase
      .from("talent_profiles")
      .select(
        "id, first_name, last_name, email, phone, cv_url, job_title, role_category, years_experience, industry, degree, institution, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, linkedin_url, github_url, experience, approved_at, created_at",
      )
      .not("approved_at", "is", null);

    let countQuery = supabase
      .from("talent_profiles")
      .select("id", { count: "exact", head: true })
      .not("approved_at", "is", null);

    if (isSavedView) {
      // Free tier: cap saved view to 15 IDs server-side (defense in depth)
      const allIds = Array.from(savedIdsSet);
      const inList = isFreeViewer(tier) ? allIds.slice(0, 15) : allIds;
      talentQuery = talentQuery.in("id", inList);
      countQuery = countQuery.in("id", inList);
    }

    if (role !== "All") {
      talentQuery = talentQuery.eq("role_category", role);
      countQuery = countQuery.eq("role_category", role);
    }

    if (q !== "") {
      const safeQ = escapeIlike(q);
      const orFilter = `first_name.ilike.%${safeQ}%,last_name.ilike.%${safeQ}%,job_title.ilike.%${safeQ}%`;
      talentQuery = talentQuery.or(orFilter);
      countQuery = countQuery.or(orFilter);
    }

    if (sort === "name") {
      talentQuery = talentQuery.order("first_name", { ascending: true });
    } else {
      talentQuery = talentQuery.order("created_at", { ascending: false });
    }

    talentQuery = talentQuery.range(from, to);

    try {
      const [talentResult, countResult] = await Promise.all([talentQuery, countQuery]);
      if (talentResult.error) throw talentResult.error;
      if (countResult.error) throw countResult.error;
      rows = (talentResult.data ?? []) as TalentRow[];
      totalCount = countResult.count ?? 0;
      // Free tier always sees only page 1 — never expose pagination affordance to them
      totalPages = isFreeViewer(tier) ? 1 : Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    } catch (err) {
      console.error("Browse talent query failed:", err);
      // rows/totalCount/totalPages keep their defaults — empty state renders gracefully
    }
  }

  // Fetch user's unlock_events for visibility check.
  // Free users get empty set (they see no unlocks even if rows exist —
  // Phase B-3 Q7 Option B: subscription gates visibility).
  let unlockedIds: Set<string> = new Set();
  if (tier === "subscriber" && user?.id) {
    const candidateIds = rows.map((r) => r.id);
    if (candidateIds.length > 0) {
      const { data: unlockRows } = await auth
        .from("unlock_events")
        .select("candidate_id")
        .eq("user_id", user.id)
        .in("candidate_id", candidateIds);
      if (unlockRows) {
        unlockedIds = new Set(unlockRows.map((u) => u.candidate_id as string));
      }
    }
  }

  // Issue #15: redact contact info embedded in freeform text fields.
  // Without this, a candidate could write "email me at foo@x.com" in their
  // summary or experience and leak contact info to non-unlocked viewers.
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  // B2: hardened phone redaction. Catches international, US, and Pakistani formats.
  // Structure: optional "+" country code (1-3 digits), then area code (2-4 digits)
  // with optional parens, then 1-4 more digit groups separated by space/dot/hyphen
  // or no separator. The digit-count guard inside the replace callback gates
  // matches to the E.164 valid range (7-15 digits) so short year/score tokens
  // don't get redacted. Fail-safe direction: better a false positive than a leak.
  const phoneRegex =
    /(?:\+\d{1,3}[\s.\-]?)?\(?\d{2,4}\)?(?:[\s.\-]?\d{2,4}){1,4}/g;
  const redactContactInfo = (text: string | null | undefined): string | null => {
    if (!text) return text ?? null;
    return text
      .replace(emailRegex, "[contact hidden]")
      .replace(phoneRegex, (match) => {
        const digitCount = (match.match(/\d/g) ?? []).length;
        if (digitCount < 7 || digitCount > 15) return match;
        return "[contact hidden]";
      });
  };

  // Per-row stripping based on unlock state.
  // - Free tier: all rows stripped (4 contact fields nulled + freeform redacted).
  // - Subscriber tier: only rows in unlockedIds keep their contact fields.
  //   github_url is never stripped (Q11: public/social signal).
  const realProfiles: TalentRow[] = rows.map((row) => {
    const isUnlocked = tier === "subscriber" && unlockedIds.has(row.id);
    if (isUnlocked) {
      return row;
    }
    return {
      ...row,
      email: null,
      phone: null,
      cv_url: null,
      linkedin_url: null,
      summary: redactContactInfo(row.summary),
      experience: Array.isArray(row.experience)
        ? row.experience.map((exp) => ({
            ...exp,
            title: exp.title != null ? (redactContactInfo(exp.title) ?? undefined) : exp.title,
            company: exp.company != null ? (redactContactInfo(exp.company) ?? undefined) : exp.company,
          }))
        : row.experience,
    };
  });

  return (
    <BrowseClient
      realProfiles={realProfiles}
      tier={tier}
      currentPage={page}
      totalPages={totalPages}
      totalCount={totalCount}
      pageSize={PAGE_SIZE}
      activeRole={role}
      activeQuery={q}
      activeSort={sort}
      unlockedIds={Array.from(unlockedIds)}
      creditsRemaining={creditsRemaining}
      isSavedView={isSavedView}
      savedIds={savedIdsArr}
    />
  );
}
