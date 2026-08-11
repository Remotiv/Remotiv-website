"use server";

import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { sanitiseSearchTerm } from "@/app/ai-dashboard/lib/search-query";
import {
  EMPTY_RESULTS,
  GROUP_LIMIT,
  MIN_QUERY_LENGTH,
  type SearchGroup,
  type SearchHit,
  type SearchResults,
} from "@/app/ai-dashboard/lib/search-types";
import { PIPELINE_STAGE_LABELS } from "@/app/ai-dashboard/lib/applicant-types";
import { createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Types and constants live in lib/search-types.

/**
 * Workspace search, from the topbar.
 *
 * ══ SCOPING IS THE WHOLE POINT OF THIS FILE ═══════════════════
 *
 * A search is more dangerous than the lists it searches. Each list narrows to
 * one kind of thing and the recruiter already knows which job they opened; a
 * search box reaches EVERYTHING at once, from every page, on two keystrokes.
 * If it leaks, it leaks the entire company in a form designed to be skimmed.
 *
 * So it reuses the exact resolver the lists use — getJobScope / isEmptyScope /
 * scopeJobIds from lib/job-scope.ts — rather than reimplementing the rule:
 *
 *   1. getCompanyContext() establishes the TENANT. Every query below also
 *      carries an explicit company filter; job scoping narrows within a
 *      tenant and is never mistaken for the tenant boundary.
 *   2. getJobScope(ctx) returns {scoped:false} for owner/admin, or the exact
 *      job ids a recruiter/hiring manager is on.
 *   3. isEmptyScope short-circuits to no results. A scoped member with no
 *      assignments must never reach a query at all — `.in("job_id", [])` is
 *      the shape that has historically been mistaken for "no filter".
 *   4. Applicants and jobs both narrow on that id list. A hiring manager
 *      searching a name that exists on another team's job gets nothing back,
 *      because the row never enters the result set — it is not filtered out
 *      afterwards, which is the version that leaks the moment someone edits
 *      the rendering.
 *
 * Writing a second resolver here would have been the obvious mistake: it would
 * pass review, agree with the pages on the day it shipped, and drift the first
 * time the rule changed in one place.
 *
 * ── Team members are deliberately NOT job-scoped ──
 *
 * Confirmed against the Team page, which selects company_members by
 * company_id and status alone with no scope filter — every member of a company
 * can already see every colleague, their email and their role. Job scoping
 * governs CANDIDATE data; colleagues are not candidates. Scoping them here
 * would make search disagree with the page it links to, which is its own kind
 * of bug, and would hide nothing that isn't one click away.
 *
 * ── Interviews are reached THROUGH their applicant ──
 *
 * Agreed, and worth stating why rather than just doing it: an interview has no
 * searchable text of its own. Everything you would type to find one — a name,
 * an email — lives on the application. A separate "Interviews" group would
 * therefore repeat the same names in a second list and make the reader choose
 * between two rows for one person. Instead an applicant who has a session
 * carries a link to it, so the interview is one click from the row you already
 * recognised.
 */
export async function searchWorkspace(rawQuery: string): Promise<SearchResults> {
  const ctx = await getCompanyContext();

  const trimmed = (rawQuery ?? "").trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return EMPTY_RESULTS;

  // Bounded before it reaches a query string: a multi-kilobyte "search" is not
  // a search, and it would be pasted into three `.or()` filters.
  const term = sanitiseSearchTerm(trimmed).slice(0, 80).trim();
  if (term.length < MIN_QUERY_LENGTH) return EMPTY_RESULTS;

  const service = createServiceClient();
  const scope = await getJobScope(ctx);

  /*
   * A scoped member with no assignments sees nothing — but team members are
   * company-wide, so the search still runs for them rather than returning a
   * blank box that looks broken.
   */
  const blind = isEmptyScope(scope);
  const allowedJobIds = scopeJobIds(scope);

  // Every query is capped. This runs on a keystroke, so an unbounded select
  // here is a self-inflicted load test on a page nobody is watching.
  const FETCH = GROUP_LIMIT * 4;

  const [applicants, jobs, members] = await Promise.all([
    (async () => {
      if (blind) return [];
      let q = service
        .from("job_applications")
        .select("id, first_name, last_name, email, job_id, job_title_snapshot, pipeline_stage, created_at")
        // TENANT boundary. Never replaced by the job filter below.
        .eq("company_id_snapshot", ctx.companyId);
      if (allowedJobIds) q = q.in("job_id", allowedJobIds);
      const { data } = await q
        .or(
          `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`,
        )
        .order("created_at", { ascending: false })
        .limit(FETCH);
      return (data ?? []) as ApplicantRow[];
    })(),

    (async () => {
      if (blind) return [];
      let q = service
        .from("jobs")
        .select("id, title, status, location, work_type, created_at")
        .eq("company_id", ctx.companyId);
      // Scoped members search only the jobs they are on — the same id list the
      // Jobs list narrows to.
      if (allowedJobIds) q = q.in("id", allowedJobIds);
      const { data } = await q
        .ilike("title", `%${term}%`)
        .order("created_at", { ascending: false })
        .limit(FETCH);
      return (data ?? []) as JobRow[];
    })(),

    (async () => {
      const { data } = await service
        .from("company_members")
        .select("id, name, email, role, status")
        .eq("company_id", ctx.companyId)
        .neq("status", "removed")
        .or(`name.ilike.%${term}%,email.ilike.%${term}%`)
        .limit(FETCH);
      return (data ?? []) as MemberRow[];
    })(),
  ]);

  /*
   * Interview sessions for the applicants that MATCHED — never a search of its
   * own, and never a wider read: the ids come from rows already proven to be
   * inside the scope above, so this cannot widen what the viewer can see.
   */
  const sessionByApplication = new Map<string, string>();
  const matchedIds = applicants.map((a) => a.id).slice(0, FETCH);
  if (matchedIds.length > 0) {
    const { data } = await service
      .from("interview_sessions")
      .select("id, application_id")
      .eq("company_id", ctx.companyId)
      .in("application_id", matchedIds)
      .order("created_at", { ascending: false })
      .limit(FETCH);
    for (const row of (data ?? []) as { id: string; application_id: string | null }[]) {
      if (row.application_id && !sessionByApplication.has(row.application_id)) {
        sessionByApplication.set(row.application_id, row.id);
      }
    }
  }

  const needle = term.toLowerCase();
  const groups: SearchGroup[] = [];

  const applicantHits = applicants
    .map((r): [number, SearchHit] => {
      const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
      const sessionId = sessionByApplication.get(r.id) ?? null;
      return [
        Math.max(matchScore(name, needle), matchScore(r.email ?? "", needle)),
        {
          kind: "applicant",
          id: r.id,
          title: name || r.email || "Unnamed applicant",
          subtitle: r.email ?? "No email",
          href: `/ai-dashboard/applicants?q=${encodeURIComponent(trimmed)}`,
          badge:
            PIPELINE_STAGE_LABELS[
              (r.pipeline_stage ?? "applied") as keyof typeof PIPELINE_STAGE_LABELS
            ] ?? null,
          interviewHref: sessionId ? `/ai-dashboard/interviews/${sessionId}` : null,
        },
      ];
    })
    .sort((a, b) => b[0] - a[0]);

  const jobHits = jobs
    .map((r): [number, SearchHit] => [
      matchScore(r.title ?? "", needle),
      {
        kind: "job",
        id: r.id,
        title: r.title ?? "Untitled role",
        subtitle: [r.location, r.work_type].filter(Boolean).join(" · ") || "No location",
        href: `/ai-dashboard/jobs?q=${encodeURIComponent(trimmed)}`,
        badge: r.status ?? null,
        interviewHref: null,
      },
    ])
    .sort((a, b) => b[0] - a[0]);

  const memberHits = members
    .map((r): [number, SearchHit] => [
      Math.max(matchScore(r.name ?? "", needle), matchScore(r.email ?? "", needle)),
      {
        kind: "member",
        id: r.id,
        title: r.name || r.email || "Teammate",
        subtitle: r.email ?? "",
        href: `/ai-dashboard/team?q=${encodeURIComponent(trimmed)}`,
        badge: r.role ?? null,
        interviewHref: null,
      },
    ])
    .sort((a, b) => b[0] - a[0]);

  const push = (
    kind: SearchHit["kind"],
    label: string,
    scored: [number, SearchHit][],
    allHref: string,
  ) => {
    if (scored.length === 0) return;
    groups.push({
      kind,
      label,
      hits: scored.slice(0, GROUP_LIMIT).map(([, hit]) => hit),
      more: scored.length > GROUP_LIMIT,
      allHref,
    });
  };

  const q = encodeURIComponent(trimmed);
  push("applicant", "Applicants", applicantHits, `/ai-dashboard/applicants?q=${q}`);
  push("job", "Jobs", jobHits, `/ai-dashboard/jobs?q=${q}`);
  push("member", "Team", memberHits, `/ai-dashboard/team?q=${q}`);

  /*
   * ── Ranking ──
   *
   * Within a group: exact match (3) > starts-with (2) > contains (1), then the
   * order the query returned them, which is newest first.
   *
   * Across groups: by the group's BEST hit, so typing a job title exactly does
   * not bury it under three applicants who happen to contain the same letters.
   * Ties keep Applicants > Jobs > Team, because the case this box exists for is
   * "I remember a name but not the job" — so when nothing distinguishes them,
   * people are what the searcher meant.
   */
  const ORDER: Record<SearchHit["kind"], number> = { applicant: 0, job: 1, member: 2 };
  const best = new Map<SearchHit["kind"], number>([
    ["applicant", applicantHits[0]?.[0] ?? 0],
    ["job", jobHits[0]?.[0] ?? 0],
    ["member", memberHits[0]?.[0] ?? 0],
  ]);
  groups.sort(
    (a, b) =>
      (best.get(b.kind) ?? 0) - (best.get(a.kind) ?? 0) ||
      ORDER[a.kind] - ORDER[b.kind],
  );

  return {
    query: trimmed,
    groups,
    total: groups.reduce((sum, g) => sum + g.hits.length, 0),
  };
}

// ── Local shapes ─────────────────────────────────────────────

type ApplicantRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  pipeline_stage: string | null;
  created_at: string | null;
};

type JobRow = {
  id: string;
  title: string | null;
  status: string | null;
  location: string | null;
  work_type: string | null;
  created_at: string | null;
};

type MemberRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
};

/** 3 exact · 2 prefix · 1 contains · 0 no match. */
function matchScore(value: string, needle: string): number {
  const v = value.trim().toLowerCase();
  if (!v || !needle) return 0;
  if (v === needle) return 3;
  if (v.startsWith(needle)) return 2;
  return v.includes(needle) ? 1 : 0;
}
