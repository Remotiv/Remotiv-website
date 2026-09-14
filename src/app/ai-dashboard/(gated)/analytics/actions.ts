"use server";

import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  getJobScope,
  isEmptyScope,
  scopedApplicationIds,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { createServiceClient } from "@/lib/supabase/server";
import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
  type AnalyticsResult,
  type FunnelStage,
  type Insight,
  type JobHealthRow,
  type SourceRow,
} from "./types";

// NB: a "use server" module may only export async functions — every shape and
// constant lives in ./types.ts.

/**
 * Analytics, computed entirely server-side.
 *
 * ── Every figure is an aggregate ─────────────────────────────
 *
 * Nothing here is derived from a page of rows. Counts come back through
 * `count: "exact", head: true` (the number arrives in Content-Range, no rows
 * transferred); the two queries that genuinely need rows — stage history for
 * durations, and scores for the agreement split — are RANGE-PAGED to
 * completion, because PostgREST silently truncates at 1000 and a truncated
 * average is a wrong number rather than a missing one.
 *
 * ── Scoping ──────────────────────────────────────────────────
 *
 * Company first, then the caller's job scope through getJobScope/scopeJobIds —
 * the same resolver the applicants list and the auto-shortlist estimate use, not
 * a second one. A hiring manager's analytics cover only the jobs they are on.
 * An empty scope returns the empty result rather than falling through to an
 * unscoped query.
 */

const PAGE = 1000;

/** One application row, loaded once and shared by every builder on the page. */
type AppRow = {
  id: string;
  job_id: string | null;
  source_detail: string | null;
  pipeline_stage: string | null;
  /** When they applied — the start of time-to-hire, and the job table's age. */
  created_at: string;
};

/** One stage transition. Loaded once; the funnel and time-to-hire share it. */
type HistoryRow = { application_id: string; to_stage: string; created_at: string };

/**
 * Every application in scope and period, range-paged.
 *
 * Loaded ONCE. The funnel, the sources breakdown and the job table all need the
 * same rows, and reading them repeatedly would multiply the largest scan on the
 * page for no gain.
 */
async function loadApplications(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  jobIds: string[] | null,
  since: string | null,
): Promise<AppRow[]> {
  const rows: AppRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("job_applications")
      .select("id, job_id, source_detail, pipeline_stage, created_at")
      .eq("company_id_snapshot", companyId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (jobIds) q = q.in("job_id", jobIds);
    if (since) q = q.gte("created_at", since);
    const { data, error } = await q;
    if (error) {
      throw new Error(`[analytics] applications failed at rows ${from}-${from + PAGE - 1}`, {
        cause: error,
      });
    }
    const batch = (data ?? []) as AppRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/** Split an id list for `.in()`, which travels in the URL. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Stage order for the funnel. `rejected` is deliberately not a funnel step. */
const FUNNEL_ORDER = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
] as const;

/**
 * ── One definition of "reached shortlist" ────────────────────
 *
 * This page used to carry two. The funnel counted furthest-stage ≥ shortlisted,
 * while the source breakdown and the job table counted current stage in
 * {shortlisted…hired} OR a non-null `shortlist_flagged_at`. So the same
 * candidate could be shortlisted in one card and not in the next.
 *
 * The funnel's definition wins, and `shortlist_flagged_at` is deliberately not
 * part of it: that column is the AUTO-shortlist flag — the system's suggestion
 * that somebody take a look — and counting a suggestion as a decision would
 * report a shortlist rate for candidates no human has shortlisted.
 */
const SHORTLISTED_AT = FUNNEL_ORDER.indexOf("shortlisted");

function reachedShortlist(furthest: Map<string, number>, id: string): boolean {
  return (furthest.get(id) ?? 0) >= SHORTLISTED_AT;
}

const STAGE_LABEL: Record<string, string> = {
  applied: "Applied",
  screening: "Screening",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
};

function sinceIso(range: AnalyticsRange): string | null {
  const days = ANALYTICS_RANGES[range];
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const EMPTY: AnalyticsResult = {
  hasAnyData: false,
  insights: [],
  stats: [],
  funnel: [],
  bottleneckStage: null,
  sources: [],
  anyTaggedSource: false,
  agreement: null,
  jobs: [],
};

/**
 * ── Why the paged reads throw ────────────────────────────────
 *
 * The three loops above used to `break` on error and carry on with the pages
 * they already had. Every figure on this page is an aggregate over those rows —
 * the source breakdown, the funnel, the score-agreement chart — so a short read
 * did not produce a broken page. It produced a complete-looking one whose every
 * number was computed over a truncated dataset.
 *
 * The platform analytics page was fixed on the argument that a figure which
 * does not reconcile discredits every other figure beside it. That argument is
 * stronger here, not weaker: this is the page customers actually see.
 */
export async function fetchAnalytics(range: AnalyticsRange = "90d"): Promise<AnalyticsResult> {
  const ctx = await getCompanyContext();
  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return EMPTY;

  const service = createServiceClient();
  const jobIds = scopeJobIds(scope);
  /*
   * application_stage_history has no job_id, so hiring-team scoping cannot be a
   * column filter there — it has to travel through the application ids the
   * caller may see. Null means unrestricted (owner/admin); an array is the
   * allow-list. Same helper the Messages page uses for the same reason.
   */
  const scopedApps = await scopedApplicationIds(ctx, scope);
  // Throws, like the paged reads in this file. Every figure on this page is an
  // aggregate over the allowed set, so an allow-list we could not read makes
  // all of them wrong in the same invisible way a truncated page did.
  if (!scopedApps.ok) {
    throw new Error("[analytics] application allow-list unavailable");
  }
  const appIds = scopedApps.value;
  const since = sinceIso(range);

  /** Every applicants query starts here, so scoping cannot be forgotten once. */
  const applicants = () => {
    let q = service
      .from("job_applications")
      .select("id", { count: "exact", head: true })
      .eq("company_id_snapshot", ctx.companyId);
    if (jobIds) q = q.in("job_id", jobIds);
    if (since) q = q.gte("created_at", since);
    return q;
  };

  const { count: totalApplicants } = await applicants();
  if (!totalApplicants) return EMPTY;

  const applications = await loadApplications(service, ctx.companyId, jobIds, since);

  /*
   * The two shared reads. Stage history decides how far every applicant got;
   * the score map decides every average score on the page. Both used to be
   * loaded inside the builders that needed them — history once, scores three
   * times — which is how the page ended up with two shortlist definitions and
   * an N+1 over jobs. Loaded here, every card answers from the same rows.
   */
  const [history, scores] = await Promise.all([
    loadStageHistory(service, ctx.companyId, appIds, since),
    scoreMap(
      service,
      ctx.companyId,
      applications.map((a) => a.id),
    ),
  ]);
  const furthest = furthestStage(applications, history);

  const funnel = buildFunnel(applications, history, furthest);
  const sources = buildSources(applications, furthest, scores);

  const [agreement, jobs, interview] = await Promise.all([
    buildAgreement(service, ctx.companyId, jobIds),
    buildJobHealth(service, ctx.companyId, jobIds, applications, furthest, scores),
    interviewCompletion(service, ctx.companyId, jobIds, since),
  ]);

  const bottleneck = pickBottleneck(funnel);
  const shortlistRate = rateOf(funnel, "shortlisted", totalApplicants);
  const hired = funnel.find((f) => f.stage === "hired");
  const offer = funnel.find((f) => f.stage === "offer");

  const hireDays = timeToHire(applications, history);

  const stats = [
    {
      key: "Time to hire",
      /*
       * APPLY → HIRE, from timeToHire below.
       *
       * This used to read `hired.avgDays`, which is the funnel's wait AT the
       * hired stage — the gap between being marked hired and whatever happened
       * next. That is not time to hire, and it is not even a duration anyone
       * wants: on this workspace one applicant was marked hired and moved again
       * six seconds later, so the card read a confident "0d". The old comment
       * here claimed it showed an em-dash because nobody was hired. It had
       * stopped being true, and nothing caught it because the wrong number and
       * the honest empty state look identical until someone reaches the stage.
       */
      value: hireDays === null ? null : String(Math.round(hireDays)),
      unit: "d",
      emptyLabel: "No hires yet",
      goodDirection: "down" as const,
    },
    {
      key: "In play",
      value: String(inPlay(funnel)),
      unit: "",
      emptyLabel: null,
      goodDirection: "up" as const,
    },
    {
      key: "Interview completion",
      value: interview.invited > 0 ? String(interview.completionPct) : null,
      unit: "%",
      emptyLabel: "No interviews sent",
      goodDirection: "up" as const,
    },
    {
      key: "Shortlist rate",
      value: shortlistRate === null ? null : String(shortlistRate),
      unit: "%",
      emptyLabel: "Nobody shortlisted yet",
      goodDirection: "up" as const,
    },
    {
      key: "Offer → hire",
      value:
        offer && offer.count > 0 && hired
          ? String(Math.round((hired.count / offer.count) * 100))
          : null,
      unit: "%",
      emptyLabel: "No offers yet",
      goodDirection: "up" as const,
    },
    {
      key: "AI agreement",
      /*
       * Only once somebody has actually reviewed a score. A null agreement
       * means nothing is scored; `reviewed === 0` means plenty is scored and
       * nobody has looked — two different absences, two different notes, and
       * neither of them a percentage.
       */
      value: agreement && agreement.reviewed > 0 ? String(agreement.agreedPct) : null,
      unit: "%",
      emptyLabel: agreement ? "No recruiter adjustments yet" : "Nothing scored yet",
      goodDirection: "up" as const,
    },
  ];

  return {
    hasAnyData: true,
    insights: buildInsights({
      totalApplicants,
      funnel,
      bottleneck,
      sources,
      interview,
      jobs,
    }),
    stats,
    funnel,
    bottleneckStage: bottleneck?.stage ?? null,
    sources,
    anyTaggedSource: sources.some((s) => s.key !== "direct"),
    agreement,
    jobs,
  };
}

// ── Funnel ───────────────────────────────────────────────────

/**
 * Every stage transition in scope and period, range-paged.
 *
 * Ordered by application then time so consecutive rows for one applicant are
 * adjacent and a wait is a subtraction. Loaded once: the funnel's durations,
 * the furthest-stage map and time-to-hire all read these same rows.
 */
async function loadStageHistory(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  appIds: string[] | null,
  since: string | null,
): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  /*
   * One drain per id chunk for a scoped caller, one unfiltered drain otherwise.
   * `appIds ?? []` would be WRONG here — an empty .in() matches nothing, so an
   * owner (null = unrestricted) would get an empty funnel.
   */
  for (const ids of appIds ? chunk(appIds, 200) : [null]) {
    for (let from = 0; ; from += PAGE) {
      let q = service
        .from("application_stage_history")
        .select("application_id, to_stage, created_at")
        .eq("company_id", companyId)
        .order("application_id", { ascending: true })
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (ids) q = q.in("application_id", ids);
      if (since) q = q.gte("created_at", since);
      const { data, error } = await q;
      if (error) {
        throw new Error(`[analytics] stage history failed at rows ${from}-${from + PAGE - 1}`, {
          cause: error,
        });
      }
      const batch = (data ?? []) as HistoryRow[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  }
  // Chunked reads arrive per-chunk, so re-sort before any scan relies on rows
  // for one application being contiguous and in time order.
  rows.sort(
    (a, b) =>
      a.application_id.localeCompare(b.application_id) || a.created_at.localeCompare(b.created_at),
  );
  return rows;
}

/**
 * How far each application actually got, as an index into FUNNEL_ORDER.
 *
 * Computed ONCE and handed to the funnel, the source breakdown and the job
 * table, so "reached shortlist" cannot mean three things on one page.
 */
function furthestStage(applications: AppRow[], history: HistoryRow[]): Map<string, number> {
  /*
   * ── Counts come from APPLICATIONS, not transitions ──
   *
   * /api/apply writes no stage-history row — the only writer is the manual
   * stage change in applicants/actions.ts. So an applicant who has sat at
   * Applied since the day they applied has NO history at all, and counting
   * transitions made them invisible: the funnel read 1/1/1 against 68 real
   * applicants. It was answering "who moved" under a heading that says "who
   * applied".
   *
   * Each application's furthest stage is therefore the later of its CURRENT
   * pipeline_stage and the highest stage it has a history row for; a stage's
   * count is everyone whose furthest is at or past it. Applied is consequently
   * every application in the period — exactly what the applicants list shows.
   *
   * `rejected` is excluded from the current-stage half deliberately: it is not
   * a funnel stage, and it sits LAST in PIPELINE_STAGES, so treating it as a
   * position would count every rejected applicant as having reached Hired. How
   * far a rejected applicant actually got is only knowable from their history,
   * which the second half covers.
   */
  const furthest = new Map<string, number>();
  for (const app of applications) {
    const current = FUNNEL_ORDER.indexOf(
      (app.pipeline_stage ?? "applied") as (typeof FUNNEL_ORDER)[number],
    );
    // -1 is 'rejected' or an unknown value. Everyone applied, so floor at 0.
    furthest.set(app.id, current >= 0 ? current : 0);
  }
  for (const row of history) {
    const at = FUNNEL_ORDER.indexOf(row.to_stage as (typeof FUNNEL_ORDER)[number]);
    if (at < 0) continue;
    const seen = furthest.get(row.application_id);
    // History for an application outside this period or scope is ignored —
    // `furthest` only holds keys for applications we actually counted.
    if (seen === undefined) continue;
    if (at > seen) furthest.set(row.application_id, at);
  }
  return furthest;
}

/**
 * Stage counts and average wait.
 *
 * COUNTS come from the furthest-stage map. DURATIONS come from the history: the
 * wait at a stage is the gap between its own transition and the next one for
 * the same application, which cannot be expressed as a PostgREST aggregate
 * (they are disabled here anyway).
 */
function buildFunnel(
  applications: AppRow[],
  history: HistoryRow[],
  furthest: Map<string, number>,
): FunnelStage[] {
  const waits = new Map<string, number[]>();
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i];
    const b = history[i + 1];
    if (a.application_id !== b.application_id) continue;
    const days = (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) / 86_400_000;
    if (!Number.isFinite(days) || days < 0) continue;
    const list = waits.get(a.to_stage) ?? [];
    list.push(days);
    waits.set(a.to_stage, list);
  }

  const reached = applications.map((a) => furthest.get(a.id) ?? 0);
  const counts = FUNNEL_ORDER.map((_s, i) => reached.filter((v) => v >= i).length);

  return FUNNEL_ORDER.map((stage, i) => {
    const list = waits.get(stage) ?? [];
    const avg = list.length > 0 ? list.reduce((s, v) => s + v, 0) / list.length : null;
    return {
      stage,
      label: STAGE_LABEL[stage],
      count: counts[i],
      // Rounded to one decimal, matching the design's "6.2d".
      avgDays: avg === null ? null : Math.round(avg * 10) / 10,
      reached: counts[i] > 0,
    };
  });
}

/**
 * Mean days from applying to being marked hired.
 *
 * The hire DATE is only knowable from stage history — an application sitting at
 * pipeline_stage 'hired' with no transition row has no recorded moment it was
 * hired, so it is excluded rather than dated from something else. First 'hired'
 * row per application wins: a candidate moved out of Hired and back in was
 * hired once, on the earlier date.
 */
function timeToHire(applications: AppRow[], history: HistoryRow[]): number | null {
  const appliedAt = new Map(applications.map((a) => [a.id, a.created_at]));
  const counted = new Set<string>();
  const days: number[] = [];

  for (const row of history) {
    if (row.to_stage !== "hired" || counted.has(row.application_id)) continue;
    const from = appliedAt.get(row.application_id);
    if (from === undefined) continue;
    counted.add(row.application_id);
    const d = (new Date(row.created_at).getTime() - new Date(from).getTime()) / 86_400_000;
    if (Number.isFinite(d) && d >= 0) days.push(d);
  }

  return days.length > 0 ? days.reduce((s, v) => s + v, 0) / days.length : null;
}

/**
 * Which stage is the bottleneck — computed, never hardcoded.
 *
 * A stage qualifies when its average wait is the highest AND is more than
 * 1.8× the median of the stages that have any wait at all. The multiple is what
 * stops a flat funnel from nominating a winner: if every stage sits around three
 * days, none of them is a bottleneck and the note is dropped rather than
 * inventing one.
 *
 * Stages nobody has reached are excluded — they have no wait, not a short one.
 */
function pickBottleneck(funnel: FunnelStage[]): FunnelStage | null {
  const measured = funnel.filter((f) => f.reached && f.avgDays !== null);
  if (measured.length < 3) return null;

  const sorted = [...measured].sort((a, b) => (b.avgDays ?? 0) - (a.avgDays ?? 0));
  const worst = sorted[0];

  const days = measured.map((f) => f.avgDays ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 === 0 ? (days[mid - 1] + days[mid]) / 2 : days[mid];

  if (median <= 0) return null;
  return (worst.avgDays ?? 0) > median * 1.8 ? worst : null;
}

/** Everyone past Applied who has not been hired or rejected. */
function inPlay(funnel: FunnelStage[]): number {
  const at = (s: string) => funnel.find((f) => f.stage === s)?.count ?? 0;
  return Math.max(0, at("screening") - at("hired"));
}

function rateOf(funnel: FunnelStage[], stage: string, total: number): number | null {
  const reached = funnel.find((f) => f.stage === stage)?.count ?? 0;
  if (total <= 0 || reached === 0) return null;
  return Math.round((reached / total) * 100);
}

// ── Interview completion ─────────────────────────────────────

async function interviewCompletion(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  jobIds: string[] | null,
  since: string | null,
): Promise<{ invited: number; submitted: number; completionPct: number }> {
  const one = async (statuses: string[]) => {
    let q = service
      .from("interview_sessions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .in("status", statuses);
    if (jobIds) q = q.in("job_id", jobIds);
    if (since) q = q.gte("created_at", since);
    const { count } = await q;
    return count ?? 0;
  };

  // "Invited" excludes cancelled: a superseded invite was never a real ask, and
  // counting it would depress completion for something nobody failed to do.
  const invited = await one(["invited", "started", "submitted", "expired"]);
  const submitted = await one(["submitted"]);

  return {
    invited,
    submitted,
    completionPct: invited > 0 ? Math.round((submitted / invited) * 100) : 0,
  };
}

// ── Sources ──────────────────────────────────────────────────

/**
 * Where applicants came from, per source_detail.
 *
 * `source_detail`, NOT `source`: that column means job_application|manual_upload
 * and answers a different question entirely.
 *
 * Folds the shared rows in memory. Three numbers per source — volume, shortlist
 * rate and average AI score — all need per-application values, so grouping what
 * is already loaded beats issuing 3×N aggregates for an unknown N of sources.
 */
function buildSources(
  rows: AppRow[],
  furthest: Map<string, number>,
  scores: Map<string, number>,
): SourceRow[] {
  if (rows.length === 0) return [];

  const buckets = new Map<
    string,
    { apps: number; short: number; scoreSum: number; scoreN: number }
  >();

  for (const r of rows) {
    const key = sourceKey(r.source_detail);
    const b = buckets.get(key) ?? { apps: 0, short: 0, scoreSum: 0, scoreN: 0 };
    b.apps++;
    if (reachedShortlist(furthest, r.id)) b.short++;
    const s = scores.get(r.id);
    if (typeof s === "number") {
      b.scoreSum += s;
      b.scoreN++;
    }
    buckets.set(key, b);
  }

  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: SOURCE_LABELS[key] ?? key,
      /** True for a domain we do not recognise — rendered in mono, never bucketed. */
      unknown: !(key in SOURCE_LABELS),
      applications: b.apps,
      shortlistPct: b.apps > 0 ? Math.round((b.short / b.apps) * 100) : 0,
      avgScore: b.scoreN > 0 ? Math.round(b.scoreSum / b.scoreN) : null,
    }))
    .sort((a, b) => b.applications - a.applications)
    .slice(0, 8);
}

/**
 * Referrer → canonical source key.
 *
 * ── Why this table exists ────────────────────────────────────
 *
 * SOURCE_LABELS keys on a BRAND ("linkedin"). What actually lands in
 * `source_detail` is a host ("linkedin.com") or an Android package
 * ("com.linkedin.android"), so the lookup below never matched: every real
 * referrer fell through to `unknown: true` and rendered as raw mono text, and
 * LinkedIn arrived split three ways — linkedin.com, com.linkedin.android and
 * lnkd.in — that were never added together.
 *
 * Exact hosts only, deliberately. Substring-matching a brand out of a hostname
 * would fold linkedin.com.phishing.example into LinkedIn, and an attacker-set
 * referrer is not something to be clever with. Anything unlisted keeps its raw
 * host and stays flagged unknown, which is the honest rendering.
 */
const SOURCE_ALIASES: Record<string, string> = {
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "com.linkedin.android": "linkedin",
  "facebook.com": "facebook",
  "m.facebook.com": "facebook",
  "l.facebook.com": "facebook",
  "com.facebook.katana": "facebook",
  "instagram.com": "instagram",
  "l.instagram.com": "instagram",
  "com.instagram.android": "instagram",
  "x.com": "x",
  "twitter.com": "x",
  "t.co": "x",
  "whatsapp.com": "whatsapp",
  "web.whatsapp.com": "whatsapp",
  "com.whatsapp": "whatsapp",
  "t.me": "telegram",
  "telegram.org": "telegram",
  "org.telegram.messenger": "telegram",
  "youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "reddit.com": "reddit",
  "old.reddit.com": "reddit",
  "google.com": "google",
  "news.google.com": "google",
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "search.brave.com": "brave",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "indeed.com": "indeed",
  "glassdoor.com": "glassdoor",
  "mail.google.com": "email",
  "outlook.live.com": "email",
  "outlook.office.com": "email",
};

/** Normalise one stored referrer to the key the label table is written in. */
function sourceKey(raw: string | null): string {
  const host = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  // No detail means nothing tagged it — that is Direct, and saying so is the
  // honest reading rather than dropping the row.
  if (!host) return "direct";
  return SOURCE_ALIASES[host] ?? host;
}

const SOURCE_LABELS: Record<string, string> = {
  direct: "Direct",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  x: "X",
  email: "Email",
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  brave: "Brave Search",
  chatgpt: "ChatGPT",
  search: "Search",
  indeed: "Indeed",
  glassdoor: "Glassdoor",
  telegram: "Telegram",
  youtube: "YouTube",
  reddit: "Reddit",
  job_board: "Job board",
};

/**
 * application_id → shown score. Chunked; the .in() list travels in the URL.
 *
 * ── Throws, for the reason b79e0d4 gives ─────────────────────
 *
 * This read used to discard its error: `const { data } = await q`, then
 * `data ?? []`. A failed chunk contributed no scores, so every application in
 * it looked UNSCORED — and this map is the input to every average score on the
 * page, the per-source rings and the job table alike. The averages stayed
 * plausible and said nothing about being computed over a subset.
 *
 * That is the same defect "The page customers see was the one still lying"
 * (b79e0d4) fixed for the three range-paged reads above; this chunked one was
 * missed because it fails differently — it does not stop short, it quietly
 * thins the corpus. Same consequence, so the same answer: throw, and let the
 * client keep the previous range on screen rather than render a wrong number.
 */
async function scoreMap(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await service
      .from("application_scores")
      .select("application_id, overall_score, human_adjusted_score")
      .eq("company_id", companyId)
      .eq("status", "scored")
      .in("application_id", ids.slice(i, i + 200));
    if (error) {
      throw new Error(`[analytics] scores failed at rows ${i}-${i + 199}`, { cause: error });
    }
    for (const r of (data ?? []) as {
      application_id: string;
      overall_score: number | null;
      human_adjusted_score: number | null;
    }[]) {
      const shown = r.human_adjusted_score ?? r.overall_score;
      if (typeof shown === "number") out.set(r.application_id, shown);
    }
  }
  return out;
}

// ── AI / human agreement ─────────────────────────────────────

/**
 * How often a reviewer changed a score, and which way.
 *
 * Deliberately NOT called accuracy: an override is signal about where the model
 * reads candidates high or low, not an error to be counted against it.
 *
 * ── The denominator is REVIEWED rows, not scored rows ────────
 *
 * This used to count a null `human_adjusted_score` as agreement, which put
 * "nobody has opened this candidate yet" and "a human read the score and agreed
 * with it" in the same bucket. With nothing reviewed, every scored row landed in
 * that bucket and the card rendered a full green bar reading "100% accepted
 * unchanged" — the most confident number on the page, produced by nobody having
 * clicked anything.
 *
 * A human has touched a row only when `adjusted_at` is set, so that is the
 * denominator. `reviewed === 0` returns the counts with no percentages and the
 * card says so, the same restraint the rest of the page already shows for a
 * stage nobody has reached.
 */
async function buildAgreement(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  jobIds: string[] | null,
): Promise<AnalyticsResult["agreement"]> {
  const rows: {
    overall_score: number | null;
    human_adjusted_score: number | null;
    adjusted_at: string | null;
  }[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("application_scores")
      .select("overall_score, human_adjusted_score, adjusted_at")
      .eq("company_id", companyId)
      .eq("status", "scored")
      .range(from, from + PAGE - 1);
    if (jobIds) q = q.in("job_id", jobIds);
    const { data, error } = await q;
    if (error) {
      throw new Error(
        `[analytics] AI/human score agreement failed at rows ${from}-${from + PAGE - 1}`,
        {
          cause: error,
        },
      );
    }
    const batch = (data ?? []) as typeof rows;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  // Null means nothing is scored at all, which is a different absence from
  // "scored, nobody reviewed it" and gets its own note on the card.
  if (rows.length === 0) return null;

  let reviewed = 0;
  let agreed = 0;
  let up = 0;
  let delta = 0;
  let overridden = 0;

  for (const r of rows) {
    if (!r.adjusted_at) continue;
    reviewed++;
    const ai = r.overall_score;
    const human = r.human_adjusted_score;
    // Reviewed and left alone, or reviewed and set to the same number: both are
    // a person agreeing. Only a different number is an override.
    if (typeof human !== "number" || typeof ai !== "number" || human === ai) {
      agreed++;
      continue;
    }
    overridden++;
    delta += human - ai;
    if (human > ai) up++;
  }

  if (reviewed === 0) {
    return {
      scored: rows.length,
      reviewed: 0,
      agreedPct: 0,
      upPct: 0,
      downPct: 0,
      avgChange: null,
    };
  }

  const agreedPct = Math.round((agreed / reviewed) * 100);
  const upPct = Math.round((up / reviewed) * 100);
  return {
    scored: rows.length,
    reviewed,
    agreedPct,
    upPct,
    // The remainder, so three independently rounded shares cannot sum to 101
    // and overflow the stacked bar.
    downPct: 100 - agreedPct - upPct,
    avgChange: overridden > 0 ? Math.round((delta / overridden) * 10) / 10 : null,
  };
}

// ── Job health ───────────────────────────────────────────────

/**
 * Per-role volume, score and shortlist rate.
 *
 * Groups the applications already loaded rather than issuing one query per job.
 * The old shape was an N+1 — a job query, then an application read and a score
 * read for every row — and the per-job read was capped at PAGE with no paging,
 * so a role with more than a thousand applicants was silently truncated on a
 * page whose entire argument is that truncated aggregates are wrong numbers.
 */
async function buildJobHealth(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  jobIds: string[] | null,
  applications: AppRow[],
  furthest: Map<string, number>,
  scores: Map<string, number>,
): Promise<JobHealthRow[]> {
  let jq = service
    .from("jobs")
    .select("id, title")
    .eq("company_id", companyId)
    .is("archived_at", null)
    .limit(50);
  if (jobIds) jq = jq.in("id", jobIds);
  const { data: jobRows } = await jq;
  const list = (jobRows ?? []) as { id: string; title: string | null }[];
  if (list.length === 0) return [];

  const byJob = new Map<string, AppRow[]>();
  for (const app of applications) {
    if (!app.job_id) continue;
    const bucket = byJob.get(app.job_id);
    if (bucket) bucket.push(app);
    else byJob.set(app.job_id, [app]);
  }

  const rows: JobHealthRow[] = [];
  for (const job of list) {
    const apps = byJob.get(job.id);
    if (!apps || apps.length === 0) continue;

    const scored = apps.map((a) => scores.get(a.id)).filter((s): s is number => s !== undefined);
    const avgScore =
      scored.length > 0 ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length) : null;

    const short = apps.filter((a) => reachedShortlist(furthest, a.id)).length;
    const oldest = apps.reduce(
      (min, a) => (a.created_at < min ? a.created_at : min),
      apps[0].created_at,
    );
    const oldestDays = Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000);
    const shortlistPct = Math.round((short / apps.length) * 100);

    rows.push({
      jobId: job.id,
      title: (job.title ?? "").trim() || "Untitled role",
      applications: apps.length,
      avgScore,
      shortlistPct,
      oldestDays,
      /*
       * Flagged when a role is absorbing volume without producing candidates,
       * or when someone has been waiting three weeks. Computed, so zero rows
       * flag when nothing qualifies.
       */
      needsLook:
        (apps.length >= 20 && (avgScore ?? 100) < 60 && shortlistPct < 10) || oldestDays > 21,
    });
  }

  return rows.sort((a, b) => b.applications - a.applications).slice(0, 8);
}

// ── Insights ─────────────────────────────────────────────────

/**
 * Three observations, generated from thresholds against real figures.
 *
 * NOT templated: each rule tests a live number, and a rule whose condition does
 * not hold produces nothing rather than a softened sentence. Fewer than three
 * qualifying rules therefore renders fewer than three rows — the page shows what
 * there is.
 *
 * Every insight carries a deep link. An observation a recruiter cannot act on
 * does not belong on this strip, so a rule without a destination is not a rule.
 */
function buildInsights(input: {
  totalApplicants: number;
  funnel: FunnelStage[];
  bottleneck: FunnelStage | null;
  sources: SourceRow[];
  interview: { invited: number; submitted: number; completionPct: number };
  jobs: JobHealthRow[];
}): Insight[] {
  const out: Insight[] = [];

  // 1. Volume without quality on one role — the most common real problem.
  const heavy = input.jobs.find((j) => j.applications >= 40 && (j.avgScore ?? 100) < 65);
  if (heavy) {
    out.push({
      tone: "warn",
      before: "",
      figure: `${heavy.applications} applied`,
      after: ` to ${heavy.title} and the average score is ${heavy.avgScore}.`,
      cta: "Review the requirements",
      href: `/ai-dashboard/jobs?job=${heavy.jobId}`,
    });
  }

  // 2. Interview completion below 75% — invites going unanswered.
  if (input.interview.invited >= 5 && input.interview.completionPct < 75) {
    const outstanding = input.interview.invited - input.interview.submitted;
    out.push({
      tone: "warn",
      before: "",
      figure: `${100 - input.interview.completionPct}%`,
      after: ` of invited candidates haven't finished their interview — ${outstanding} ${
        outstanding === 1 ? "is" : "are"
      } outstanding.`,
      cta: "See who",
      href: "/ai-dashboard/interviews",
    });
  }

  // 3. A source beating the median shortlist rate by more than 2×.
  const rated = input.sources.filter((s) => s.applications >= 5);
  if (rated.length >= 2) {
    const rates = rated.map((s) => s.shortlistPct).sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    const median = rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];
    const best = [...rated].sort((a, b) => b.shortlistPct - a.shortlistPct)[0];
    if (median > 0 && best.shortlistPct > median * 2) {
      const multiple = Math.round((best.shortlistPct / median) * 10) / 10;
      out.push({
        tone: "good",
        before: `${best.label} applicants reach shortlist `,
        figure: `${multiple}× more often`,
        after: " than the typical source.",
        cta: "Post there next",
        href: "/ai-dashboard/jobs",
      });
    }
  }

  // 4. The bottleneck, when one was computed.
  if (out.length < 3 && input.bottleneck) {
    out.push({
      tone: "warn",
      before: `Candidates wait longest at ${input.bottleneck.label} — `,
      figure: `${input.bottleneck.avgDays} days`,
      after: " on average, more than any other stage.",
      cta: "See the stage",
      href: "/ai-dashboard/applicants",
    });
  }

  return out.slice(0, 3);
}
