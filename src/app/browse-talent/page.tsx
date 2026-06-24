import type { Metadata } from "next";
import { canonicalUrl } from "@/lib/seo";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

// Phase 6 C1: route-specific metadata. Overrides the root layout's marketing
// title for this list-view page. Indexable (`?q=…` filter URLs are legitimate
// landing pages — no noindex). Canonical path is relative; Next.js resolves
// it against `metadataBase` (set in src/app/layout.tsx).
export const metadata: Metadata = {
  title: "Browse Talent — Remotiv",
  description:
    "Browse vetted senior engineers, sales talent, and operators. Filter by role, skill, and location. Hire top remote talent in hours, not weeks.",
  alternates: {
    canonical: "/browse-talent",
  },
  openGraph: {
    title: "Browse Talent — Remotiv",
    description:
      "Browse vetted senior engineers, sales talent, and operators. Filter by role, skill, and location.",
    url: "/browse-talent",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Browse Talent — Remotiv",
    description:
      "Browse vetted senior engineers, sales talent, and operators. Hire top remote talent in hours.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

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
    // Phase 6 deep-link: ?id=<uuid> auto-opens that candidate's profile modal.
    // The candidate is fetched separately and passed as deepLinkedCard so it
    // does NOT widen the visible grid past the free-tier 15-row cap.
    id?: string;
    claimed?: string;
  }>;
}) {
  const params = await searchParams;
  // Validate uuid shape (defense against arbitrary strings hitting the DB).
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const deepLinkId = params.id && UUID_REGEX.test(params.id) ? params.id : null;

  const roleParam = params.role ?? "All";
  const role: RoleFilter = (VALID_ROLES as readonly string[]).includes(roleParam)
    ? (roleParam as RoleFilter)
    : "All";
  const q = (params.q ?? "").trim().slice(0, 100);
  const sort: "match" | "name" = params.sort === "name" ? "name" : "match";
  const claimedOnly = params.claimed === "true";
  const pageRaw = Number(params.page ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const isSavedView = params.view === "saved";

  // Service client is sync (no I/O), so we instantiate it first and build the
  // URL-derived count query upfront. That query then fires in parallel with
  // the auth-aware client init + getUser + sub/saved — saves one round-trip
  // on the critical path for non-saved view.
  const supabase = createServiceClient();

  // Phase 7 perf: count's filters depend only on URL params (claimedOnly,
  // role, q) for non-saved view — no need to wait on auth/sub/saved before
  // firing it. Saved view's count needs .in("id", inList) from savedIdsSet
  // and is mutated + fired below once the saved query resolves.
  let countQuery = supabase
    .from("talent_profiles")
    .select("id", { count: "exact", head: true })
    .not("approved_at", "is", null)
    .eq("is_paused", false)
    .eq("is_archived", false);
  if (claimedOnly) {
    countQuery = countQuery.not("user_id", "is", null);
  }
  if (role !== "All") {
    countQuery = countQuery.eq("role_category", role);
  }
  if (q !== "") {
    const safeQ = escapeIlike(q);
    const orFilter = `first_name.ilike.%${safeQ}%,last_name.ilike.%${safeQ}%,job_title.ilike.%${safeQ}%`;
    countQuery = countQuery.or(orFilter);
  }
  // Promise.resolve on a Supabase thenable invokes its .then() under the
  // hood, which kicks off the HTTP request immediately. The returned promise
  // resolves to the same {data, error, count} shape an inline await would
  // produce — we keep it for the Promise.all below where the talent list is
  // awaited.
  const earlyCountPromise = !isSavedView ? Promise.resolve(countQuery) : null;

  // Auth-aware client (reads cookies) for user + subscription lookup. While
  // we await it, earlyCountPromise is already in flight against PostgREST.
  const auth = await createClient();

  const { data: { user } } = await auth.auth.getUser();
  const userId = user?.id ?? "";

  let tier: "free" | "subscriber" = "free";
  let creditsRemaining = 0;
  // Phase 4 A1: subscriptions + saved_profiles run in parallel — both depend
  // only on user.id, neither blocks the other. Saves one DB round-trip in the
  // critical path. Anonymous viewers skip both queries entirely.
  const savedIdsArr: string[] = [];
  const savedIdsSet = new Set<string>();
  if (user && userId) {
    const [subResult, savedResult] = await Promise.all([
      auth
        .from("subscriptions")
        .select("tier, credits_remaining")
        .eq("user_id", userId)
        .maybeSingle(),
      // Phase 4 EDIT 7: defensive .limit(500) — without a cap, a user with
      // tens of thousands of saves would hand a giant array back to the page.
      supabase
        .from("saved_profiles")
        .select("candidate_id")
        .eq("user_id", userId)
        .limit(500),
    ]);
    const sub = subResult.data;
    if (sub?.tier === "starter" || sub?.tier === "pro") {
      tier = "subscriber";
      creditsRemaining = sub.credits_remaining ?? 0;
    }
    const savedRows = savedResult.data ?? [];
    for (const r of savedRows as Array<{ candidate_id: string }>) {
      savedIdsArr.push(r.candidate_id);
      savedIdsSet.add(r.candidate_id);
    }
  }

  // Phase B security: free tier is locked to page 1. Without this, free users could
  // bypass the 15-row cap by passing ?page=2, ?page=3 etc. and scrape the full pool.
  // Subscribers see full pagination; free users locked to page 1.
  const effectivePage = isFreeViewer(tier) ? 1 : page;
  const PAGE_SIZE = isFreeViewer(tier) ? 15 : 30;
  const from = (effectivePage - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Phase 4 A1: savedIdsArr / savedIdsSet are populated in the Promise.all
  // above (alongside the subscriptions fetch) — no separate round-trip here.

  // Short-circuit: saved view with zero saves → render empty state
  const shouldReturnEmpty = isSavedView && savedIdsSet.size === 0;

  let rows: TalentRow[] = [];
  let totalCount = 0;
  let totalPages = 1;

  if (!shouldReturnEmpty) {
    // Phase 4 Lean Projection: list query selects ONLY columns CardItem
    // renders + columns rowToCard derives from. Modal-only fields (summary
    // remains for CardItem.bio; experience, degree, institution moved to
    // fetchProfileDetail). `industry` dropped — mapped but never displayed.
    let talentQuery = supabase
      .from("talent_profiles")
      .select(
        "id, first_name, last_name, email, phone, cv_url, cv_path, job_title, role_category, years_experience, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, photo_path, linkedin_url, github_url, user_id, approved_at, created_at",
      )
      .not("approved_at", "is", null)
      .eq("is_paused", false)
      .eq("is_archived", false);

    if (claimedOnly) {
      talentQuery = talentQuery.not("user_id", "is", null);
    }

    if (isSavedView) {
      // Free tier: cap saved view to 15 IDs server-side (defense in depth)
      const allIds = Array.from(savedIdsSet);
      const inList = isFreeViewer(tier) ? allIds.slice(0, 15) : allIds;
      talentQuery = talentQuery.in("id", inList);
      countQuery = countQuery.in("id", inList);
    }

    if (role !== "All") {
      talentQuery = talentQuery.eq("role_category", role);
    }

    if (q !== "") {
      const safeQ = escapeIlike(q);
      const orFilter = `first_name.ilike.%${safeQ}%,last_name.ilike.%${safeQ}%,job_title.ilike.%${safeQ}%`;
      talentQuery = talentQuery.or(orFilter);
    }

    if (sort === "name") {
      talentQuery = talentQuery.order("first_name", { ascending: true });
    } else {
      talentQuery = talentQuery.order("created_at", { ascending: false });
    }

    talentQuery = talentQuery.range(from, to);

    try {
      const [talentResult, countResult] = await Promise.all([
        talentQuery,
        // Non-saved view: count is already in flight via earlyCountPromise
        // upstream — we just await its result here. Saved view: countQuery
        // has had .in("id", inList) attached above and fires when awaited.
        earlyCountPromise ?? countQuery,
      ]);
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

  // Phase 6 deep-link: if ?id=<uuid> was provided and the candidate is NOT in
  // the current paginated list, fetch that single row separately. Kept out of
  // `rows` so the visible grid stays capped at PAGE_SIZE (defense vs scrape
  // bypass) — passed to BrowseClient as `deepLinkedCard` and rendered only
  // inside the auto-opened modal.
  let deepLinkedRow: TalentRow | null = null;
  if (deepLinkId && !rows.some((r) => r.id === deepLinkId)) {
    const { data } = await supabase
      .from("talent_profiles")
      .select(
        "id, first_name, last_name, email, phone, cv_url, cv_path, job_title, role_category, years_experience, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, photo_path, linkedin_url, github_url, user_id, approved_at, created_at",
      )
      .eq("id", deepLinkId)
      .not("approved_at", "is", null)
      .eq("is_paused", false)
      .eq("is_archived", false)
      .maybeSingle();
    deepLinkedRow = (data ?? null) as TalentRow | null;
  }

  // Fetch user's unlock_events for visibility check.
  // Free users get empty set (they see no unlocks even if rows exist —
  // Phase B-3 Q7 Option B: subscription gates visibility).
  let unlockedIds: Set<string> = new Set();
  if (tier === "subscriber" && user?.id) {
    // Include the deep-linked id so its unlock state is reflected in the modal.
    const candidateIds = rows.map((r) => r.id);
    if (deepLinkedRow && !candidateIds.includes(deepLinkedRow.id)) {
      candidateIds.push(deepLinkedRow.id);
    }
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
  const stripIfLocked = (row: TalentRow): TalentRow => {
    const isUnlocked = tier === "subscriber" && unlockedIds.has(row.id);
    if (isUnlocked) return row;
    return {
      ...row,
      email: null,
      phone: null,
      cv_url: null,
      cv_path: null,
      linkedin_url: null,
      summary: redactContactInfo(row.summary),
    };
  };
  const realProfiles: TalentRow[] = rows.map(stripIfLocked);
  const deepLinkedCard: TalentRow | null = deepLinkedRow
    ? stripIfLocked(deepLinkedRow)
    : null;

  return (
    <>
      {/* Phase 6 C2: BreadcrumbList JSON-LD for search engines. Two-level
          breadcrumb (Home → Browse Talent). ItemList of candidates is
          deliberately omitted: candidate previews could leak PII if indexed,
          and the public list is paginated paywall content. */}
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw script content
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Home",
                // Phase 6 M2: was a hardcoded production-domain string — now
                // sourced from src/lib/seo.ts so it can't drift from
                // metadataBase.
                item: canonicalUrl("/"),
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Browse Talent",
                item: canonicalUrl("/browse-talent"),
              },
            ],
          }),
        }}
      />
      {/* div, not <main> — BrowseClient renders its own <main> internally;
          this only provides the skip-link target. */}
      <div id="main">
        <BrowseClient
          realProfiles={realProfiles}
          tier={tier}
          currentPage={Math.min(page, totalPages)}
          totalPages={totalPages}
          totalCount={totalCount}
          pageSize={PAGE_SIZE}
          activeRole={role}
          activeQuery={q}
          activeSort={sort}
          claimedOnly={claimedOnly}
          unlockedIds={Array.from(unlockedIds)}
          creditsRemaining={creditsRemaining}
          isSavedView={isSavedView}
          savedIds={savedIdsArr}
          initialOpenId={deepLinkId}
          deepLinkedCard={deepLinkedCard}
        />
      </div>
    </>
  );
}
