"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import type {
  AttentionItem,
  RoleCount,
  TopMatch,
  WeekReport,
} from "./types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./types.ts.

type Service = ReturnType<typeof createServiceClient>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PAGE = 1000;

/**
 * Rows shown in the two capped cards.
 *
 * Mirrors the Jobs hero's HERO_ROLE_LIMIT rather than inventing a second
 * number: both are "the few that matter, with the rest accounted for in a
 * line" and they sit two clicks apart in the same product.
 */
const CARD_LIMIT = 4;

/** Stages that count as moving a candidate FORWARD. Rejected is not one. */
const FORWARD_STAGES = new Set([
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
]);

/**
 * Monday 00:00 UTC of the week containing `at`.
 *
 * UTC throughout, because every timestamp this page counts is stored in UTC.
 * Computing week boundaries in the server's local zone would put a Sunday-night
 * application in a different week depending on where the process runs.
 */
function mondayOf(at: Date): Date {
  const d = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const offset = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - offset * DAY_MS);
}

/**
 * The most recent week the report will show: the last COMPLETE Monday–Sunday.
 *
 * Deliberately not the week in progress. A partial week produces a delta
 * against a full one — three days of applications reading as "down from 17" —
 * which is the fabricated comparison this page exists to avoid. Overview
 * already answers what is happening right now.
 */
function latestWeekStart(): Date {
  return new Date(mondayOf(new Date()).getTime() - WEEK_MS);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "28 July – 3 August". */
function fmtRange(start: Date, end: Date): string {
  return `${fmtDay(start)} – ${fmtDay(end)}`;
}

/** Read every row matching a query, 1000 at a time. */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) break;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

type AppRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  /** Embedded live job. Null once the job is deleted. */
  jobs?: { title: string | null } | null;
  pipeline_stage: string | null;
  created_at: string;
};

/**
 * LIVE title first, snapshot as the fallback.
 *
 * job_title_snapshot is only stamped when a job is deleted, so reading it
 * alone grouped every applicant under "Untitled role". Same order the rest of
 * the product uses.
 */
function roleOf(a: AppRow, fallback: string): string {
  return a.jobs?.title?.trim() || (a.job_title_snapshot ?? "").trim() || fallback;
}

type HistRow = {
  application_id: string;
  to_stage: string;
  created_at: string;
};

function nameOf(r: AppRow): string {
  return [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "Applicant";
}

/**
 * Applications still sitting at Applied as at `cutoff`.
 *
 * Reconstructed from stage history rather than read off pipeline_stage: the
 * column holds the stage NOW, so using it would report today's backlog for
 * every week in the archive and make the "up from 38" chip meaningless. The
 * latest history row at or before the cutoff is the stage the candidate was in
 * that week; an application with no history yet has never moved.
 */
function stalledAt(apps: AppRow[], hist: HistRow[], cutoff: Date): number {
  const cut = cutoff.getTime();
  const latest = new Map<string, { at: number; stage: string }>();

  for (const h of hist) {
    const at = new Date(h.created_at).getTime();
    if (Number.isNaN(at) || at > cut) continue;
    const seen = latest.get(h.application_id);
    if (!seen || at >= seen.at) {
      latest.set(h.application_id, { at, stage: h.to_stage });
    }
  }

  let n = 0;
  for (const a of apps) {
    const created = new Date(a.created_at).getTime();
    if (Number.isNaN(created) || created >= cut) continue;
    const last = latest.get(a.id);
    if (!last || last.stage === "applied") n += 1;
  }
  return n;
}

/** Distinct applications moved into one of `stages` inside the window. */
function movedInWindow(
  hist: HistRow[],
  from: Date,
  to: Date,
  stages: Set<string> | string,
): number {
  const lo = from.getTime();
  const hi = to.getTime();
  const ids = new Set<string>();
  for (const h of hist) {
    const at = new Date(h.created_at).getTime();
    if (Number.isNaN(at) || at < lo || at >= hi) continue;
    const hit =
      typeof stages === "string" ? h.to_stage === stages : stages.has(h.to_stage);
    if (hit) ids.add(h.application_id);
  }
  return ids.size;
}

function appliedInWindow(apps: AppRow[], from: Date, to: Date): AppRow[] {
  const lo = from.getTime();
  const hi = to.getTime();
  return apps.filter((a) => {
    const t = new Date(a.created_at).getTime();
    return !Number.isNaN(t) && t >= lo && t < hi;
  });
}

/**
 * The report for one week, plus the comparison figures for the week before it.
 *
 * `offset` counts backwards from the latest complete week: 0 is the most
 * recent, 1 the one before, and so on. The client passes it straight back, so
 * navigation never has to trust a date supplied by the browser.
 *
 * Every role can view — this is the company's own activity, and a hiring
 * manager reading their own week is not a privileged action.
 */
export async function fetchWeekReport(offset: number): Promise<WeekReport> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const step = Math.max(0, Math.trunc(offset ?? 0));
  const start = new Date(latestWeekStart().getTime() - step * WEEK_MS);
  const end = new Date(start.getTime() + WEEK_MS);
  const prevStart = new Date(start.getTime() - WEEK_MS);

  // Everything is derived in memory from two paged reads. Two round trips
  // regardless of how many weeks back the user walks, and both are bounded by
  // the company's own volume rather than the platform's.
  const apps = await pageAll<AppRow>((from, to) =>
    service
      .from("job_applications")
      .select(
        "id, first_name, last_name, job_id, job_title_snapshot, jobs(title), pipeline_stage, created_at",
      )
      .eq("company_id_snapshot", ctx.companyId)
      .lt("created_at", end.toISOString())
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  const hist = await pageAll<HistRow>((from, to) =>
    service
      .from("application_stage_history")
      .select("application_id, to_stage, created_at")
      .eq("company_id", ctx.companyId)
      .lt("created_at", end.toISOString())
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  /**
   * Is there anything before this week?
   *
   * Answered from the earliest application rather than assumed, so Previous
   * stops at real data instead of walking into empty weeks forever. A company
   * with no applications at all has exactly one week to look at.
   */
  const earliest = apps.reduce<number | null>((min, a) => {
    const t = new Date(a.created_at).getTime();
    if (Number.isNaN(t)) return min;
    return min === null || t < min ? t : min;
  }, null);
  const hasPrior = earliest !== null && earliest < start.getTime();

  const thisWeek = appliedInWindow(apps, start, end);
  const lastWeek = appliedInWindow(apps, prevStart, start);

  const applied = thisWeek.length;
  const forward = movedInWindow(hist, start, end, FORWARD_STAGES);
  const rejected = movedInWindow(hist, start, end, "rejected");
  const stalled = stalledAt(apps, hist, end);

  const previous = hasPrior
    ? {
        applied: lastWeek.length,
        forward: movedInWindow(hist, prevStart, start, FORWARD_STAGES),
        rejected: movedInWindow(hist, prevStart, start, "rejected"),
        stalled: stalledAt(apps, hist, start),
      }
    : null;

  const roles = buildRoles(thisWeek, lastWeek, hasPrior);
  const { top, scoredTotal } = await buildTopMatches(service, thisWeek);
  const attention = await buildAttention(service, ctx.companyId, {
    stalled,
    roles,
    hasPrior,
  });

  const endDay = new Date(end.getTime() - DAY_MS);
  const label = step === 0 ? `Last week at ${ctx.company.name}` : `Week of ${fmtDay(start)}`;

  return {
    weekStart: start.toISOString(),
    weekEnd: endDay.toISOString(),
    range: fmtRange(start, endDay),
    label: hasPrior ? label : "Your first week",
    isLatest: step === 0,
    isEarliest: !hasPrior,
    applied,
    forward,
    rejected,
    stalled,
    roles: roles.slice(0, CARD_LIMIT),
    rolesTotal: roles.length,
    // Counted BEFORE the cap. Zero-count roles sort last, so deriving this
    // from the four rendered rows would silently drop the quiet ones the
    // hero sentence exists to mention.
    quietRoles: roles.filter((r) => r.count === 0).length,
    top,
    topTotal: scoredTotal,
    attention,
    previous,
  };
}

/** Per-role counts for the week, each carrying the prior week's figure. */
function buildRoles(
  thisWeek: AppRow[],
  lastWeek: AppRow[],
  hasPrior: boolean,
): RoleCount[] {
  const titleFor = (a: AppRow) => roleOf(a, "Untitled role");
  const key = (a: AppRow) => a.job_id ?? titleFor(a);

  const now = new Map<string, RoleCount>();
  for (const a of thisWeek) {
    const k = key(a);
    const row = now.get(k);
    if (row) row.count += 1;
    else
      now.set(k, { jobId: a.job_id, title: titleFor(a), count: 1, previous: null });
  }

  const before = new Map<string, number>();
  for (const a of lastWeek) {
    const k = key(a);
    before.set(k, (before.get(k) ?? 0) + 1);
    // A role that received applications last week and none this week is a
    // signal, not an absence — it stays on the chart at zero.
    if (!now.has(k)) {
      now.set(k, { jobId: a.job_id, title: titleFor(a), count: 0, previous: null });
    }
  }

  for (const [k, row] of now) {
    row.previous = hasPrior ? (before.get(k) ?? 0) : null;
  }

  // Total order: count, then title, then the grouping key. Two roles with the
  // same name and count would otherwise swap places between renders, and with
  // only four slots shown that is a visible flicker.
  return [...now.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.title.localeCompare(b.title) ||
      (a.jobId ?? a.title).localeCompare(b.jobId ?? b.title),
  );
}

/**
 * Highest-scoring people who applied IN THIS WEEK.
 *
 * Not the all-time leaderboard the Applicants page shows — the whole point of
 * the card is "of the N who applied in this period". A human override wins
 * over the model's score, exactly as it does everywhere else.
 */
async function buildTopMatches(
  service: Service,
  weekApps: AppRow[],
): Promise<{ top: TopMatch[]; scoredTotal: number }> {
  if (weekApps.length === 0) return { top: [], scoredTotal: 0 };

  const byId = new Map(weekApps.map((a) => [a.id, a]));
  const scores = new Map<string, number>();
  const ids = [...byId.keys()];

  // Chunked: a busy week would otherwise overflow the request URL.
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service
      .from("application_scores")
      .select("application_id, overall_score, human_adjusted_score")
      .in("application_id", ids.slice(i, i + 200));
    for (const row of (data ?? []) as {
      application_id: string;
      overall_score: number | null;
      human_adjusted_score: number | null;
    }[]) {
      const score = row.human_adjusted_score ?? row.overall_score;
      if (typeof score === "number") scores.set(row.application_id, score);
    }
  }

  /*
   * Ties break on score, then name, then id — a total order.
   * Without the last two the sort is free to reorder equal scores between
   * renders, and four capped rows would visibly shuffle on every navigation.
   */
  const ranked = [...scores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const an = nameOf(byId.get(a[0]) as AppRow);
      const bn = nameOf(byId.get(b[0]) as AppRow);
      return an.localeCompare(bn) || a[0].localeCompare(b[0]);
    })
    .slice(0, CARD_LIMIT)
    .map(([id, score]) => {
      const app = byId.get(id) as AppRow;
      return {
        applicationId: id,
        name: nameOf(app),
        role: roleOf(app, "—"),
        score: Math.round(score),
      };
    });

  return { top: ranked, scoredTotal: scores.size };
}

/**
 * What built up over the week, framed as accumulation rather than status.
 *
 * Every item is derived; nothing is a placeholder. A week with none of them
 * renders the clean-week state, which should read as success rather than as an
 * empty list.
 */
async function buildAttention(
  service: Service,
  companyId: string,
  input: { stalled: number; roles: RoleCount[]; hasPrior: boolean },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  if (input.stalled > 0) {
    items.push({
      kind: "stalled",
      title: `${input.stalled} applicant${input.stalled === 1 ? "" : "s"} still sitting at Applied`,
      detail:
        input.stalled === 1
          ? "Nobody has moved them on since they applied."
          : "None of them have been moved on since they applied.",
      cta: "Review",
      href: "/ai-dashboard/applicants",
    });
  }

  // Drafts that have been sitting unpublished. Archived jobs are excluded —
  // a draft the company put away is not something that needs attention.
  const staleBefore = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const { data: drafts } = await service
    .from("jobs")
    .select("id, title, created_at")
    .eq("company_id", companyId)
    .eq("status", "on_hold")
    .is("archived_at", null)
    .lt("created_at", staleBefore)
    .order("created_at", { ascending: true })
    .limit(3);

  for (const d of (drafts ?? []) as { id: string; title: string | null; created_at: string }[]) {
    const days = Math.max(
      1,
      Math.round((Date.now() - new Date(d.created_at).getTime()) / DAY_MS),
    );
    items.push({
      kind: "draft",
      title: `${(d.title ?? "Untitled role").trim()} has been a draft for ${days} days`,
      detail: "It collects nothing until you publish it.",
      cta: "Finish",
      href: `/ai-dashboard/jobs/${d.id}/edit`,
    });
  }

  // A role that had applicants last week and none this week. Only meaningful
  // when there IS a prior week to have dropped from.
  if (input.hasPrior) {
    for (const r of input.roles) {
      if (r.count === 0 && (r.previous ?? 0) > 0) {
        items.push({
          kind: "quiet",
          title: `${r.title} received no applicants this week`,
          detail: `It had ${r.previous} the week before. Worth checking the post.`,
          cta: "View",
          href: "/ai-dashboard/jobs",
        });
      }
    }
  }

  return items.slice(0, 5);
}
