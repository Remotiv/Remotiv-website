import "server-only";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import {
  canAccessJob,
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { plainDashes, plainDashesOrNull } from "@/app/ai-dashboard/lib/plain-dashes";
import { scoringEnabled } from "@/lib/ai/interview-scoring";
import { readInterviewKind } from "@/lib/interviews/types";
import { pageAll } from "@/lib/supabase/paging";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { retentionPassed } from "./async-score-purge";
import { readScoringSnapshot, resolveQuestionMeta } from "./question-meta";
import { findQuoteStart } from "./quote-timestamps";
import { resolveCandidate } from "./review-candidate";
import type {
  AnswerScoreView,
  InterviewAnswerView,
  InterviewListResult,
  InterviewNote,
  InterviewRow,
  InterviewScore,
  InterviewSessionDetail,
  InterviewStatus,
  InterviewTab,
  ScoreAdjustment,
  ScoredEvidence,
  ScoreStatus,
  SessionCriterion,
  TranscriptState,
} from "./review-types";
import { ANSWERS_SHOWN } from "./review-types";
import { readScorecardFacts, scorecardRecoveryEligibility } from "./scorecard";
import type { TranscriptSegment } from "./transcribe";

/**
 * Reviewer-side reads for interviews.
 *
 * ── What never leaves the server ─────────────────────────────
 *
 * `video_path` and `token_hash`. A path is a key into a private bucket, so a
 * reviewer page holding one turns a dashboard session into a probe against
 * every object in it. Playback goes through a server action that re-resolves
 * the session and mints a short signed URL — see (gated)/interviews/actions.ts.
 *
 * And past a session's delete_after, the AI's written explanations and the
 * candidate's quotes in its scores, even before the purge has cleared them
 * (async-score-purge.ts). The numbers, the verdict and the reviewers' notes
 * are still sent.
 *
 * ── Scoping ──────────────────────────────────────────────────
 *
 * Company FIRST, then the hiring team. A recruiter scoped to two jobs sees
 * interviews for those two jobs and nothing else, exactly as the applicant
 * list behaves. Both filters are applied server-side in the query; nothing
 * relies on the client asking for the right thing.
 */

const PAGE_SIZE = 20;

/** The statuses the UI groups by, derived rather than trusted from the row. */
export function deriveStatus(stored: string | null, expiresAt: string | null): InterviewStatus {
  // A restarted first attempt (F10). The list shows its restart instead and
  // never this row; anywhere one is shown alone, it is not a pending invite.
  if (stored === "abandoned") return "cancelled";
  if (stored === "cancelled") return "cancelled";
  if (stored === "submitted") return "submitted";
  if (stored === "expired") return "expired";
  // A status nothing here recognises, NULL included, is unknown (#47), and it
  // is decided BEFORE the deadline: a passed deadline must not relabel it as
  // expired, and running out of statuses must never read as invited.
  if (stored !== "invited" && stored !== "started") return "unknown";
  // A session nothing has swept is still expired once its deadline passes.
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return "expired";
  return stored === "started" ? "started" : "invited";
}

function snapshotLength(snapshot: unknown): number | null {
  return Array.isArray(snapshot) ? snapshot.length : null;
}

type SessionRow = {
  id: string;
  application_id: string | null;
  job_id: string | null;
  kind: string;
  status: string;
  started_at: string | null;
  submitted_at: string | null;
  expires_at: string | null;
  delete_after: string | null;
  invited_by_name: string | null;
  questions_snapshot: unknown;
  /** Reviewer-only marking scheme (migration 028). Selected by the detail read, never sent to a candidate. */
  scoring_snapshot?: unknown;
  archived_at: string | null;
  created_at: string;
  /** Read by the list only: a restart's first attempt (migration 020). */
  previous_attempt_id?: string | null;
};

/** Everything a list row needs; `questions_snapshot` only on the visible page's read. */
const LIST_COLUMNS =
  "id, application_id, job_id, kind, status, started_at, submitted_at, expires_at, delete_after, invited_by_name, questions_snapshot, archived_at, created_at, previous_attempt_id";

/** The statuses a session can be stored with; anything else derives to `unknown`. */
const STORED_STATUSES = "(invited,started,submitted,expired,cancelled,abandoned)";

/** PostgREST's "Requested range not satisfiable": the page has outrun the rows. */
const RANGE_NOT_SATISFIABLE = "PGRST103";

/**
 * A query builder the list narrows step by step. Typed loosely on purpose:
 * each step is one PostgREST filter, and the list composes them per tab.
 */
type Builder = any;

/**
 * deriveStatus, as filters (#41). The five tabs and `unknown` partition the
 * stored statuses exactly as deriveStatus does, so the counts still sum to
 * `all` as an identity: an invited or started session whose deadline has
 * passed is expired whatever the column says (expires_at is NOT NULL), and a
 * status nothing here recognises is unknown before any deadline is looked at.
 * `abandoned` never reaches these: it is a restarted first attempt, dropped
 * from the list before any tab (see listInterviewSessions).
 */
function statusFilter(q: Builder, status: InterviewStatus, nowIso: string): Builder {
  switch (status) {
    case "submitted":
      return q.eq("status", "submitted");
    case "cancelled":
      // Abandoned too: only one no restart points to survives the list's
      // scope, and deriveStatus reads it as cancelled.
      return q.or("status.eq.cancelled,status.eq.abandoned");
    case "expired":
      return q.or(`status.eq.expired,and(status.in.(invited,started),expires_at.lt.${nowIso})`);
    case "started":
      return q.eq("status", "started").gte("expires_at", nowIso);
    case "invited":
      return q.eq("status", "invited").gte("expires_at", nowIso);
    case "unknown":
      // NULL included, as deriveStatus reads it (#47): SQL's NOT IN alone
      // would drop a NULL status silently.
      return q.or(`status.is.null,status.not.in.${STORED_STATUSES}`);
  }
}

/**
 * One page of interviews, plus the aggregate counts the tabs and hero read.
 *
 * In SQL (#41). This used to read EVERY session the company had, in pages of
 * 1,000 one after another, each row with its questions snapshot, on every tab
 * click, and derive, count, filter and page in JavaScript: linear in the
 * company's interviews. Now, with no search:
 *   - the restart chain: exactly the first attempts a restart points to are
 *     dropped, as before. Migration 053 makes every such first attempt
 *     `abandoned` (a restart may only follow an abandoned first attempt, and
 *     abandoned is terminal), so the filter is `status <> 'abandoned'`, plus,
 *     added back, any abandoned session NO restart points to: 053 requires a
 *     recorded restart decision for `abandoned`, not that attempt 2 exists, so
 *     such a row is possible, and deriveStatus lists it as cancelled. Both
 *     sets are read once (they are few: live first attempts a person chose to
 *     restart), the restarts also for the hero's "sent this week" (a chain was
 *     sent when its first attempt was);
 *   - the tab counts are head counts, one wave, with deriveStatus as filters;
 *   - the visible page is one ranged read with an exact count, and only it
 *     carries the questions snapshots;
 *   - the job filter's options and "open roles" are one read of the scoped
 *     jobs with their session counts embedded.
 * Every read is on the company and, for a scoped member, on their jobs, as
 * before. A search still reads the whole scoped set (listBySearch): it matches
 * on names, which live on the applications.
 */
export async function listInterviewSessions(
  ctx: CompanyContext,
  opts: {
    status?: InterviewTab;
    jobId?: string | null;
    query?: string;
    page?: number;
  } = {},
): Promise<Read<InterviewListResult>> {
  if ((opts.query ?? "").trim()) return listBySearch(ctx, opts);

  const applied = {
    status: opts.status ?? "all",
    jobId: opts.jobId ?? null,
    query: opts.query ?? "",
  } as const;
  const empty: InterviewListResult = {
    applied,
    rows: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    counts: {
      all: 0,
      submitted: 0,
      started: 0,
      invited: 0,
      expired: 0,
      cancelled: 0,
      unknown: 0,
      archived: 0,
    },
    jobs: [],
    sentThisWeek: 0,
    openRoles: 0,
  };

  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return answered(empty);
  const allowedJobIds = scopeJobIds(scope);
  const service = createServiceClient();
  const nowIso = new Date().toISOString();
  const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  /* The restarts (attempt 2), with when their first attempt was sent. */
  type RestartRow = {
    id: string;
    archived_at: string | null;
    previous_attempt_id: string;
    first: { status: string; created_at: string } | null;
  };
  let restarts: RestartRow[];
  let abandonedIds: string[];
  try {
    const restartRead = pageAll<RestartRow>(
      (from, to) => {
        let q = service
          .from("interview_sessions")
          .select(
            "id, archived_at, previous_attempt_id, first:interview_sessions!previous_attempt_id(status, created_at)",
          )
          .eq("company_id", ctx.companyId)
          .not("previous_attempt_id", "is", null)
          .order("id")
          .range(from, to);
        if (allowedJobIds) q = q.in("job_id", allowedJobIds);
        return q;
      },
      { scope: "interviews", label: "restarts" },
    );
    const abandonedRead = pageAll<{ id: string }>(
      (from, to) => {
        let q = service
          .from("interview_sessions")
          .select("id")
          .eq("company_id", ctx.companyId)
          .eq("status", "abandoned")
          .order("id")
          .range(from, to);
        if (allowedJobIds) q = q.in("job_id", allowedJobIds);
        return q;
      },
      { scope: "interviews", label: "abandoned" },
    );
    [restarts, abandonedIds] = await Promise.all([
      restartRead,
      abandonedRead.then((rows) => rows.map((r) => r.id)),
    ]);
  } catch (err) {
    console.error("[interviews] restart read failed:", err);
    return unavailable();
  }
  // Abandoned, but no restart points to it: listed, as cancelled (deriveStatus).
  const superseded = new Set(restarts.map((r) => r.previous_attempt_id));
  const lonely = abandonedIds.filter((id) => !superseded.has(id));
  const keep = `status.is.null,status.neq.abandoned${lonely.length ? `,id.in.(${lonely.join(",")})` : ""}`;
  // A restart whose first attempt is not abandoned: the invariant says none.
  const strayFirsts = restarts
    .filter((r) => r.first?.status !== "abandoned")
    .map((r) => r.previous_attempt_id);

  /** The scoped list: this company, the member's jobs, no restarted first attempt. */
  const scoped = (q: Builder): Builder => {
    // Superseded first attempts out; a NULL status kept (SQL's <> alone would
    // drop it, and deriveStatus shows it as unknown); a lonely abandoned kept.
    let out = q.eq("company_id", ctx.companyId).or(keep);
    if (allowedJobIds) out = out.in("job_id", allowedJobIds);
    if (strayFirsts.length) out = out.not("id", "in", `(${strayFirsts.join(",")})`);
    return out;
  };
  const head = (narrow: (q: Builder) => Builder) =>
    narrow(scoped(service.from("interview_sessions").select("id", { count: "exact", head: true })));
  const live = (q: Builder) => q.is("archived_at", null);

  const wantArchived = opts.status === "archived";
  const tabFilter = (q: Builder): Builder => {
    let out = wantArchived ? q.not("archived_at", "is", null) : live(q);
    if (opts.status && opts.status !== "all" && opts.status !== "archived") {
      out = statusFilter(out, opts.status, nowIso);
    }
    if (opts.jobId) out = out.eq("job_id", opts.jobId);
    return out;
  };
  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * PAGE_SIZE;

  const STATUSES = ["submitted", "started", "invited", "expired", "cancelled", "unknown"] as const;
  const [allCount, archivedCount, weekCount, statusCounts, pageRead, jobsRead] = await Promise.all([
    head(live),
    head((q) => q.not("archived_at", "is", null)),
    // Sent this week, first attempts and plain sessions; restarts are added below.
    head((q) => live(q).is("previous_attempt_id", null).gte("created_at", weekAgoIso)),
    Promise.all(STATUSES.map((st) => head((q) => statusFilter(live(q), st, nowIso)))),
    tabFilter(scoped(service.from("interview_sessions").select(LIST_COLUMNS, { count: "exact" })))
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(start, start + PAGE_SIZE - 1),
    (() => {
      let q = service
        .from("jobs")
        .select("id, title, sessions:interview_sessions(count), live:interview_sessions(count)")
        .eq("company_id", ctx.companyId)
        .eq("sessions.company_id", ctx.companyId)
        .or(keep, { referencedTable: "sessions" })
        .eq("live.company_id", ctx.companyId)
        .or(keep, { referencedTable: "live" })
        .is("live.archived_at", null);
      if (strayFirsts.length) {
        q = q
          .not("sessions.id", "in", `(${strayFirsts.join(",")})`)
          .not("live.id", "in", `(${strayFirsts.join(",")})`);
      }
      return allowedJobIds ? q.in("id", allowedJobIds) : q;
    })(),
  ]);

  const failed = [allCount, archivedCount, weekCount, ...statusCounts, jobsRead].find(
    (r) => r.error,
  );
  if (failed) {
    console.error("[interviews] list read failed:", failed.error);
    return unavailable();
  }
  let pageSessions: SessionRow[] = [];
  let total: number;
  if (pageRead.error) {
    if (pageRead.error.code !== RANGE_NOT_SATISFIABLE) {
      console.error("[interviews] page read failed:", pageRead.error);
      return unavailable();
    }
    // A page past the end: no rows, and the true total for the pager.
    const recount = await tabFilter(
      scoped(service.from("interview_sessions").select("id", { count: "exact", head: true })),
    );
    if (recount.error) return unavailable();
    total = recount.count ?? 0;
  } else {
    pageSessions = (pageRead.data ?? []) as SessionRow[];
    total = pageRead.count ?? 0;
  }

  type JobCounts = {
    id: string;
    title: string | null;
    sessions: { count: number }[];
    live: { count: number }[];
  };
  const jobRows = ((jobsRead.data ?? []) as JobCounts[]).filter(
    (j) => (j.sessions?.[0]?.count ?? 0) > 0,
  );
  const jobs = new Map(jobRows.map((j) => [j.id, (j.title ?? "").trim() || "Untitled role"]));

  /** The head count read for one status, through statusFilter (above). */
  const countOf = (st: (typeof STATUSES)[number]) => statusCounts[STATUSES.indexOf(st)].count ?? 0;
  const counts = {
    all: allCount.count ?? 0,
    submitted: countOf("submitted"),
    started: countOf("started"),
    invited: countOf("invited"),
    expired: countOf("expired"),
    cancelled: countOf("cancelled"),
    unknown: countOf("unknown"),
    archived: archivedCount.count ?? 0,
  };
  if (counts.all + counts.archived === 0) return answered(empty);

  const sentThisWeek =
    (weekCount.count ?? 0) +
    restarts.filter(
      (r) =>
        r.archived_at === null &&
        r.first?.status === "abandoned" &&
        r.first.created_at >= weekAgoIso,
    ).length;

  const sliced = pageSessions.map((s) => toListRow(s, NAME_PENDING, jobs));
  const rows = await withPageDetail(service, ctx.companyId, sliced, pageSessions, null);

  return answered({
    applied,
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
    jobs: [...jobs.entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    sentThisWeek,
    openRoles: jobRows.filter((j) => (j.live?.[0]?.count ?? 0) > 0).length,
  });
}

/**
 * One page of interviews, plus the aggregate counts the tabs and hero read.
 *
 * Aggregates are counted over the WHOLE scoped set, not the rendered page —
 * a tab that said "4" because four happened to be on screen would be wrong
 * the moment someone paged.
 *
 * ── Why this returns a Read ──────────────────────────────────
 *
 * Every figure here is `array.length` over a range-paged fetch. The loop used
 * to `break` on a failed page, so a failure after the first thousand rows
 * returned a SHORT array — and nothing downstream can tell a short read from a
 * small company. The page then rendered a smaller, entirely plausible,
 * internally consistent set of numbers with nothing to invite a second look.
 *
 * A partially populated result carrying an `incomplete` flag was the other
 * option and is worse: a flag is something the next person rendering this
 * object has to remember to check, and a failed read must not be renderable as
 * if it had worked. The failure arm of `Read` carries no value at all, so
 * there is nothing to render by mistake.
 */
async function listBySearch(
  ctx: CompanyContext,
  opts: {
    status?: InterviewTab;
    jobId?: string | null;
    query?: string;
    page?: number;
  } = {},
): Promise<Read<InterviewListResult>> {
  /*
   * The filter, resolved once and sent back with the answer.
   *
   * Resolved HERE rather than read off `opts` by the client, so what travels
   * back is what the rows and counts below were actually computed under — a
   * default that changed on this side would otherwise relabel a result it no
   * longer describes. See InterviewListResult.applied.
   */
  const applied = {
    status: opts.status ?? "all",
    jobId: opts.jobId ?? null,
    query: opts.query ?? "",
  } as const;

  const empty: InterviewListResult = {
    applied,
    rows: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    counts: {
      all: 0,
      submitted: 0,
      started: 0,
      invited: 0,
      expired: 0,
      cancelled: 0,
      unknown: 0,
      archived: 0,
    },
    jobs: [],
    sentThisWeek: 0,
    openRoles: 0,
  };

  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return answered(empty);
  const allowedJobIds = scopeJobIds(scope);

  const service = createServiceClient();

  /*
   * Every session for the company, scoped. Read in full rather than paged in
   * SQL because status is DERIVED (an unswept session past its deadline is
   * expired) — filtering and counting on the stored column would put rows in
   * the wrong tab. Bounded by range-paging; a company with more than a few
   * thousand interviews would want a status-sweep job before this is the
   * bottleneck.
   *
   * pageAll THROWS on a failed page, which is the behaviour this read wants and
   * the reason the hand-rolled loop is gone. The throw is caught here, at the
   * one frame that knows what failed and what the caller is owed.
   */
  let sessions: SessionRow[];
  try {
    sessions = await pageAll<SessionRow>(
      (from, to) => {
        let q = service
          .from("interview_sessions")
          .select(
            "id, application_id, job_id, kind, status, started_at, submitted_at, expires_at, delete_after, invited_by_name, questions_snapshot, archived_at, created_at, previous_attempt_id",
          )
          .eq("company_id", ctx.companyId)
          .order("created_at", { ascending: false })
          .range(from, to);
        if (allowedJobIds) q = q.in("job_id", allowedJobIds);
        return q;
      },
      { scope: "interviews", label: "sessions" },
    );
  } catch (err) {
    console.error("[interviews] session read failed:", err);
    return unavailable();
  }

  /*
   * ── One interview per restart (F10 C6d) ──
   *
   * A restarted AI Video Interview is one interview: its restart (attempt 2)
   * stands for it, and the first attempt it points back to is dropped here,
   * from the whole scoped read, before any row, count, tab filter or page is
   * built. So the first attempt stays hidden whichever tab or page its restart
   * lands on; it is reached only from the review page's audit link. Grouped by
   * the restart's own link, never by application: ordinary re-sends are
   * separate first attempts and stay separate rows, as before. A restart keeps
   * its first attempt's job (053), so this never reveals or hides another
   * job's session; it only drops one that is in the scoped read already.
   *
   * The chain was sent when its first attempt was: a restart is not a new send.
   */
  const restarted = new Set(sessions.map((s) => s.previous_attempt_id).filter(Boolean));
  const firstSentAt = new Map(
    sessions.filter((s) => restarted.has(s.id)).map((s) => [s.id, s.created_at]),
  );
  sessions = sessions.filter((s) => !restarted.has(s.id));
  const chainSentAt = new Map(
    sessions.map((s) => [
      s.id,
      (s.previous_attempt_id && firstSentAt.get(s.previous_attempt_id)) || s.created_at,
    ]),
  );
  if (sessions.length === 0) return answered(empty);

  /*
   * ── Candidate names: the page's, unless a search needs them all ──
   *
   * Search matches on name and email, so a query reads every row's. Without
   * one, nothing before the page slice looks at a name, so only the page's
   * applications are read (below): one request whatever the company's size.
   */
  const q = (opts.query ?? "").trim().toLowerCase();
  const jobIds = [...new Set(sessions.map((s) => s.job_id).filter(Boolean))] as string[];

  const [searchApps, jobs] = await Promise.all([
    q
      ? fetchApplications(
          service,
          ctx.companyId,
          applicationIdsOf(sessions.map((s) => s.application_id)),
        )
      : null,
    fetchJobs(service, ctx.companyId, jobIds),
  ]);
  // A search over names that could not be read would silently miss matches.
  if (searchApps && !searchApps.ok) return unavailable();

  /*
   * Every scoped session becomes a row, for the counts, tabs, filters and
   * search. Answer counts and scores are filled in after the page slice
   * (withPageDetail): nothing before it reads them, so they are read for the
   * visible rows only, one request each whatever the company's size.
   */
  const rows: InterviewRow[] = sessions.map((s) =>
    // Without a search the name is filled in after the page slice.
    toListRow(s, searchApps ? candidateOf(s.application_id, searchApps) : NAME_PENDING, jobs),
  );

  /*
   * ── Aggregates over the whole scoped set, ARCHIVE EXCLUDED ──
   *
   * Archiving hides a row from the working list, so it has to hide it from the
   * numbers too — a tab reading 4 above a list of 3 is the bug this project has
   * already had once. `archived` is counted separately and is the only tab that
   * shows those rows.
   *
   * The five status buckets below are EXHAUSTIVE over `deriveStatus`, which is
   * total over the five InterviewStatus values. So they sum to `all` as an
   * identity, not as a property of today's data — and that is the point of
   * charting `cancelled` rather than dropping it: while it was missing, the sum
   * was short by exactly the cancelled count and nothing said so.
   */
  const live = rows.filter((r) => r.archivedAt === null);
  const counts = {
    all: live.length,
    submitted: live.filter((r) => r.status === "submitted").length,
    started: live.filter((r) => r.status === "started").length,
    invited: live.filter((r) => r.status === "invited").length,
    expired: live.filter((r) => r.status === "expired").length,
    cancelled: live.filter((r) => r.status === "cancelled").length,
    unknown: live.filter((r) => r.status === "unknown").length,
    archived: rows.length - live.length,
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sentThisWeek = live.filter(
    (r) => new Date(chainSentAt.get(r.id) ?? r.sentAt).getTime() >= weekAgo,
  ).length;

  const jobList = [...jobs.entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // ── Filter, then page ──
  const wantArchived = opts.status === "archived";
  const filtered = rows.filter((r) => {
    // Archived rows appear ONLY under their own tab, never in All or a status
    // tab — that is what "hidden from the list" has to mean to be useful.
    if (wantArchived !== (r.archivedAt !== null)) return false;
    if (
      opts.status &&
      opts.status !== "all" &&
      opts.status !== "archived" &&
      r.status !== opts.status
    ) {
      return false;
    }
    if (opts.jobId && r.jobId !== opts.jobId) return false;
    if (q && !`${r.candidateName} ${r.candidateEmail} ${r.jobTitle}`.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });

  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * PAGE_SIZE;
  const sliced = filtered.slice(start, start + PAGE_SIZE);
  const pageIds = new Set(sliced.map((r) => r.id));
  const pageRows = await withPageDetail(
    service,
    ctx.companyId,
    sliced,
    sessions.filter((s) => pageIds.has(s.id)),
    searchApps,
  );

  return answered({
    applied,
    rows: pageRows,
    total: filtered.length,
    page,
    pageSize: PAGE_SIZE,
    counts,
    jobs: jobList,
    sentThisWeek,
    openRoles: new Set(live.map((r) => r.jobId).filter(Boolean)).size,
  });
}

/** One list row from a session, before the page's detail is filled in. */
function toListRow(
  s: SessionRow,
  who: { name: string; email: string; link: InterviewRow["candidateLink"] },
  jobs: Map<string, string>,
): InterviewRow {
  return {
    id: s.id,
    applicationId: s.application_id,
    jobId: s.job_id,
    candidateName: who.name,
    candidateEmail: who.email,
    candidateLink: who.link,
    jobTitle: (s.job_id ? jobs.get(s.job_id) : null) ?? "This role",
    kind: readInterviewKind(s.kind, s.id),
    status: deriveStatus(s.status, s.expires_at),
    // Filled in for the visible rows by withPageDetail; never returned as is.
    progress: null,
    totalQuestions: null,
    submittedAt: s.submitted_at,
    startedAt: s.started_at,
    expiresAt: s.expires_at,
    sentAt: s.created_at,
    invitedByName: s.invited_by_name,
    score: null,
    scoreUnavailable: false,
    archivedAt: s.archived_at,
  };
}

/**
 * The visible rows' detail: names (unless a search already read them), answer
 * counts and scores, each ONE request for the page whatever the company's
 * size (#20). `pageSessions` carries each row's questions snapshot.
 */
async function withPageDetail(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  sliced: InterviewRow[],
  pageSessions: SessionRow[],
  searchApps: Read<AppNames> | null,
): Promise<InterviewRow[]> {
  const pageIds = sliced.map((r) => r.id);
  const nowMs = Date.now();
  const [pageApps, answers, scores] = await Promise.all([
    searchApps
      ? null
      : fetchApplications(service, companyId, applicationIdsOf(sliced.map((r) => r.applicationId))),
    fetchAnswerStats(service, pageIds),
    fetchSessionScores(
      service,
      companyId,
      pageIds,
      new Set(pageSessions.filter((s) => retentionPassed(s.delete_after, nowMs)).map((s) => s.id)),
    ),
  ]);
  const snapshotOf = new Map(pageSessions.map((s) => [s.id, s.questions_snapshot]));

  return sliced.map((r) => {
    const named = pageApps ? candidateOf(r.applicationId, pageApps) : null;
    const stats = answers.ok ? answers.value.get(r.id) : undefined;
    /* The snapshot is the better denominator and does not depend on the answer
       read, so it survives that read failing. Only when there is no snapshot
       does the count become unknown rather than zero. */
    const total = snapshotLength(snapshotOf.get(r.id)) ?? (answers.ok ? (stats?.total ?? 0) : null);
    return {
      ...r,
      ...(named
        ? { candidateName: named.name, candidateEmail: named.email, candidateLink: named.link }
        : {}),
      /* Null when the answer read failed — see InterviewRow.progress. Purged
         is a PRESENTATION state, not a status: the interview is still
         submitted, its media has simply passed the retention date. Derived
         from rows that were recorded but no longer hold a path. */
      progress: answers.ok
        ? {
            answered: stats?.answered ?? 0,
            purged: Boolean(stats && stats.answered > 0 && stats.withVideo === 0),
          }
        : null,
      totalQuestions: total,
      score: scores.ok ? (scores.value.get(r.id) ?? null) : null,
      scoreUnavailable: !scores.ok,
    };
  });
}

type AppNames = Map<
  string,
  { first_name: string | null; last_name: string | null; email: string | null }
>;

/** Distinct, non-null application ids. */
function applicationIdsOf(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter(Boolean))] as string[];
}

/** Stands in for a name until the page slice reads it; never returned. */
const NAME_PENDING = { name: "", email: "", link: "linked" } as const;

/**
 * Who a row is with. A failed name read says so ("Name unavailable") rather
 * than falling through to resolveCandidate, which would read a missing row as
 * "Applicant deleted".
 */
function candidateOf(applicationId: string | null, apps: Read<AppNames>) {
  if (applicationId && !apps.ok) {
    return { name: "Name unavailable", email: "", link: "unavailable" as const };
  }
  return resolveCandidate(
    applicationId,
    apps.ok && applicationId ? apps.value.get(applicationId) : undefined,
  );
}

/** Name requests in flight at once, the same bound the worker runs jobs at. */
const NAME_READ_CONCURRENCY = 4;

/**
 * Names for the given applications, a hundred ids per request, at most
 * NAME_READ_CONCURRENCY requests at once. One failed request fails the whole
 * read, and no further request starts after it: a map that is right for some
 * rows and silently empty for others cannot be told apart from rows whose
 * applicant was deleted.
 */
async function fetchApplications(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  ids: string[],
): Promise<Read<AppNames>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const out: AppNames = new Map();
  let next = 0;
  let failed = false;

  const lane = async () => {
    while (!failed && next < chunks.length) {
      const chunk = chunks[next++];
      const { data, error } = await service
        .from("job_applications")
        .select("id, first_name, last_name, email")
        // The company gate is re-applied here, not inherited from the session
        // row: an application that moved companies must not surface a name.
        .eq("company_id_snapshot", companyId)
        .in("id", chunk);
      if (error) {
        console.error("[interviews] applicant name read failed:", error);
        failed = true;
        return;
      }
      for (const r of (data ?? []) as {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }[]) {
        out.set(r.id, r);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_READ_CONCURRENCY, chunks.length) }, lane));
  return failed ? unavailable() : answered(out);
}

async function fetchJobs(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  ids: string[],
) {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await service
      .from("jobs")
      .select("id, title")
      .eq("company_id", companyId)
      .in("id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as { id: string; title: string | null }[]) {
      out.set(r.id, (r.title ?? "").trim() || "Untitled role");
    }
  }
  return out;
}

/**
 * answered / total / how many still hold a video, per session.
 *
 * ── Why a failed chunk fails the whole map ───────────────────
 *
 * The sessions are read a hundred at a time, so a failure part-way through
 * leaves a map that is CORRECT for the sessions it reached and silently empty
 * for the rest — and `map.get(id)` cannot tell "this session has no answers"
 * from "this session was in the chunk that failed". Returning the partial map
 * would put "0/5" on an arbitrary suffix of the list, which is exactly the lie
 * this is here to remove. Unknown is unknown for every row or for none.
 *
 * This failing does NOT fail the list. The counts, the statuses and the row
 * identities come from the session read and are still right, and a reviewer can
 * still open an interview — so one column says it does not know and the rest of
 * the page stands.
 */
async function fetchAnswerStats(
  service: ReturnType<typeof createServiceClient>,
  sessionIds: string[],
): Promise<Read<Map<string, { answered: number; total: number; withVideo: number }>>> {
  const out = new Map<string, { answered: number; total: number; withVideo: number }>();
  for (let i = 0; i < sessionIds.length; i += 100) {
    const chunk = sessionIds.slice(i, i + 100);
    let rows: { session_id: string; video_path: string | null }[];
    try {
      // Paged, ordered by id: a hundred sessions can hold more answers than one
      // response's row limit (1,000), which would otherwise cut the count silently.
      rows = await pageAll<{ session_id: string; video_path: string | null }>(
        (from, to) =>
          service
            .from("interview_answers")
            .select("session_id, video_path")
            .in("session_id", chunk)
            .order("id")
            .range(from, to),
        { scope: "interviews", label: "answer stats" },
      );
    } catch (err) {
      console.error("[interviews] answer stats read failed:", err);
      return unavailable();
    }
    for (const r of rows) {
      const cur = out.get(r.session_id) ?? { answered: 0, total: 0, withVideo: 0 };
      cur.answered += 1;
      cur.total += 1;
      if (r.video_path) cur.withVideo += 1;
      out.set(r.session_id, cur);
    }
  }
  return answered(out);
}

/**
 * One session, for the review page.
 *
 * Returns null for anything outside the caller's company OR outside their
 * hiring-team scope — the two are indistinguishable to the caller on purpose,
 * so a 404 cannot be used to confirm that some other team's session exists.
 */
export async function loadInterviewSession(
  ctx: CompanyContext,
  sessionId: string,
): Promise<InterviewSessionDetail | null> {
  if (!sessionId) return null;

  const service = createServiceClient();
  const { data } = await service
    .from("interview_sessions")
    .select(
      "id, application_id, job_id, kind, status, started_at, submitted_at, expires_at, delete_after, invited_by_name, questions_snapshot, scoring_snapshot, archived_at, created_at",
    )
    .eq("id", sessionId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  const row = data as SessionRow | null;
  if (!row) return null;

  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return null;
  const allowed = scopeJobIds(scope);
  if (allowed && (!row.job_id || !allowed.includes(row.job_id))) return null;

  /*
   * ── Wave 1 (#41): every read that needs only the session row ──
   *
   * Names, the job, the pipeline stage, the answers, the job's questions, the
   * session score, the delete permission and the notes used to wait for each
   * other in turn; none needs another's answer. All keep their own company
   * filter, and all run only after the session read and the job-scope check
   * above. Wave 2 below is the two reads that do need wave 1's answers.
   */
  const evidenceDeleted = retentionPassed(row.delete_after, Date.now());
  const [apps, jobs, { data: appRow }, answersRead, { data: qRows }, scoreRead, canDelete, notes] =
    await Promise.all([
      fetchApplications(service, ctx.companyId, row.application_id ? [row.application_id] : []),
      fetchJobs(service, ctx.companyId, row.job_id ? [row.job_id] : []),
      row.application_id
        ? service
            .from("job_applications")
            .select("pipeline_stage")
            .eq("id", row.application_id)
            .eq("company_id_snapshot", ctx.companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // video_path is selected so `hasVideo` can be derived, and is NOT
      // returned. The exact count comes with the same rows (#46): the page
      // says when it is not showing them all.
      service
        .from("interview_answers")
        .select(
          "id, position, question_text, video_path, duration_seconds, transcript, transcript_segments, transcript_status, transcript_error, recorded_at",
          { count: "exact" },
        )
        .eq("session_id", row.id)
        .order("position", { ascending: true })
        .limit(ANSWERS_SHOWN),
      row.job_id
        ? service
            .from("interview_questions")
            .select("id, position, question, competency, rubric, weight")
            .eq("job_id", row.job_id)
            .eq("company_id", ctx.companyId)
            .limit(50)
        : Promise.resolve({ data: [] }),
      fetchSessionScores(
        service,
        ctx.companyId,
        [row.id],
        new Set(evidenceDeleted ? [row.id] : []),
      ),
      canAccessJob(ctx, row.job_id ?? ""),
      /*
       * Notes SURVIVE the purge. They are a reviewer's own words about a
       * candidate, not the candidate's media — the six-month promise covers
       * the recording, and deleting the reasoning behind a hiring decision
       * along with it would erase the audit trail the recording existed to
       * support.
       */
      readNotes(service, ctx.companyId, row.id),
    ]);
  const who = candidateOf(row.application_id, apps);

  // A failed answers read throws, so the review is reported unavailable (the
  // error boundary) instead of showing an interview with no answers.
  const { data: answerRows, error: answersError, count: answersCount } = answersRead;
  if (answersError) {
    throw new Error(`[review] answers read failed: ${answersError.code ?? "error"}`);
  }
  // A failed score read throws too: read as "no score", it would offer
  // "Score interview" on an interview that may already be scored.
  if (!scoreRead.ok) throw new Error("[review] session score read failed");

  const answers: InterviewAnswerView[] = (
    (answerRows ?? []) as {
      id: string;
      position: number;
      question_text: string | null;
      video_path: string | null;
      duration_seconds: number | null;
      transcript: string | null;
      transcript_segments: unknown;
      transcript_status: string | null;
      transcript_error: string | null;
      recorded_at: string | null;
    }[]
  ).map((a) => ({
    id: a.id,
    position: a.position,
    hasSegments: Array.isArray(a.transcript_segments) && a.transcript_segments.length > 0,
    score: null,
    questionText: (a.question_text ?? "").trim() || `Question ${a.position}`,
    competency: null,
    durationSeconds: a.duration_seconds,
    /* The purge nulls video_path and transcript but KEEPS the row, so a row
       that was recorded and no longer has a path is expired media rather than
       a missing answer. That distinction is the whole of the purged state. */
    hasVideo: Boolean(a.video_path),
    purged: Boolean(a.recorded_at) && !a.video_path,
    transcript: a.transcript,
    transcriptState: normaliseTranscript(a.transcript_status, a.transcript),
    transcriptError: a.transcript_error,
    recordedAt: a.recorded_at,
  }));

  /*
   * Per-answer scores, with every evidence quote resolved to a timestamp.
   *
   * Resolution happens HERE, server-side, because the segments are the raw
   * material and there is no reason to ship them to the browser — a quote and
   * a number of seconds is all the seek button needs.
   */
  const segmentsById = new Map<string, TranscriptSegment[]>();
  for (const a of (answerRows ?? []) as {
    id: string;
    transcript_segments: unknown;
  }[]) {
    if (Array.isArray(a.transcript_segments)) {
      segmentsById.set(a.id, a.transcript_segments as TranscriptSegment[]);
    }
  }

  const status = deriveStatus(row.status, row.expires_at);
  const totalQuestions = snapshotLength(row.questions_snapshot) ?? answers.length;
  const kind = readInterviewKind(row.kind, row.id);

  /*
   * Criteria quotes are PLACED here, not in fetchSessionScores.
   *
   * Placement needs the answers' segments, which only this detail path loads
   * — the list would have to fetch them for a seek button it never renders.
   * So the score arrives with nulls and gets its offsets filled in against
   * the segments already in hand.
   */
  const score = withPlacedCriteria(
    scoreRead.value.get(row.id) ?? null,
    answers.map((a) => ({ id: a.id, segments: segmentsById.get(a.id) ?? null })),
  );

  /*
   * ── Wave 2: the two reads that need wave 1's answers ──
   *
   * The answer scores need the answers' ids and segments. "Score interview"
   * is offered only to a submitted async interview with no scorecard row at
   * all; its two extra reads (pending transcripts, live job) are made only
   * when the cheap facts already allow it, so the common case - a scored
   * interview - costs nothing here.
   */
  const [answerScores, facts] = await Promise.all([
    fetchAnswerScores(
      service,
      ctx.companyId,
      row.id,
      answers.map((a) => a.id),
      segmentsById,
      evidenceDeleted,
    ),
    kind === "async" && status === "submitted" && score === null
      ? readScorecardFacts(service, row.id)
      : Promise.resolve({ pendingTranscripts: 0, liveJob: false }),
  ]);
  for (const a of answers) a.score = answerScores.get(a.id) ?? null;

  /*
   * Competency lives on the QUESTION, never on the answer, and is reviewer-only
   * — the candidate payload deliberately withholds it. Resolved through the
   * SAME rule the scorer uses (lib/interviews/question-meta.ts): the frozen
   * scoring_snapshot when the session has one, else the live row with the same
   * question id, else none. Never the row now at the same position - a label
   * that says "Collaboration" over an answer scored with no rubric would be
   * the lie the scorer just refused to tell.
   */
  {
    const live = (qRows ?? []) as {
      id: string;
      position: number;
      question: string | null;
      competency: string | null;
      rubric: string | null;
      weight: number | null;
    }[];
    const snapshotQuestions = Array.isArray(row.questions_snapshot)
      ? (row.questions_snapshot as { id?: string; position?: number; question?: string | null }[])
      : [];
    const scoring = readScoringSnapshot(row.scoring_snapshot);
    for (const a of answers) {
      a.competency = resolveQuestionMeta(
        { position: a.position, question_text: a.questionText },
        snapshotQuestions,
        scoring.length > 0 ? scoring : null,
        live,
      ).competency;
    }
  }

  const canScore = scorecardRecoveryEligibility({
    kind,
    status,
    scoringEnabled: scoringEnabled(),
    hasScoreRow: score !== null,
    pendingTranscripts: facts.pendingTranscripts,
    liveJob: facts.liveJob,
  }).ok;

  return {
    id: row.id,
    applicationId: row.application_id,
    jobId: row.job_id,
    candidateName: who.name,
    candidateEmail: who.email,
    candidateLink: who.link,
    jobTitle: (row.job_id ? jobs.get(row.job_id) : null) ?? "This role",
    stage: (appRow as { pipeline_stage: string | null } | null)?.pipeline_stage ?? "applied",
    kind,
    status,
    answers,
    answersTotal: typeof answersCount === "number" ? answersCount : null,
    totalQuestions,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    sentAt: row.created_at,
    deleteAfter: row.delete_after,
    invitedByName: row.invited_by_name,
    archivedAt: row.archived_at,
    score,
    canDelete,
    canScore,
    purged: answers.length > 0 && answers.every((a) => a.purged),
    evidenceDeleted,
    notes,
    // Null for a context without a member row (shouldn't happen inside the
    // gated segment); an empty string simply matches no note's author.
    viewerMemberId: ctx.memberId ?? "",
  };
}

/** A correction, or null. Null-safe on every column so a half-written row
 *  (a score with no author) reads as absent rather than as corrupt. */
function toAdjustment(
  score: number | null,
  byName: string | null,
  at: string | null,
  feedback: string | null,
  aiScore: number | null,
): ScoreAdjustment | null {
  if (score === null || !at) return null;
  return {
    by: (byName ?? "").trim() || "A teammate",
    at,
    feedback: (feedback ?? "").trim() || null,
    aiScore,
  };
}

/**
 * Per-answer scores for one session, quotes already resolved to timestamps.
 *
 * Read for exactly the answers shown (#46), so a score always belongs to an
 * answer on the page; an unordered cap could return scores for answers not
 * shown and miss the ones that are.
 */
async function fetchAnswerScores(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  sessionId: string,
  answerIds: string[],
  segments: Map<string, TranscriptSegment[]>,
  /** Past delete_after: the explanations and quotes are not sent. */
  wordsDeleted: boolean,
): Promise<Map<string, AnswerScoreView>> {
  const out = new Map<string, AnswerScoreView>();
  if (answerIds.length === 0) return out;
  const { data } = await service
    .from("interview_answer_scores")
    .select(
      // `evidence` is deliberately NOT selected: since v2 it is the union of
      // strengths and concerns, written for audit only. Reading it back would
      // duplicate every quote the two lists already carry.
      "answer_id, status, score, human_adjusted_score, human_feedback, adjusted_by_name, adjusted_at, confidence, reasoning, strengths, concerns, missing, error",
    )
    .eq("company_id", companyId)
    .eq("session_id", sessionId)
    .in("answer_id", answerIds);

  for (const r of (data ?? []) as {
    answer_id: string;
    status: string | null;
    score: number | null;
    human_adjusted_score: number | null;
    human_feedback: string | null;
    adjusted_by_name: string | null;
    adjusted_at: string | null;
    confidence: string | null;
    reasoning: string | null;
    strengths: unknown;
    concerns: unknown;
    missing: unknown;
    error: string | null;
  }[]) {
    const segs = segments.get(r.answer_id) ?? null;

    /*
     * A claim and its quote arrive in the SAME object. There is nothing to
     * join, which is the point: v1 stored them in separate arrays and paired
     * them by string-matching a strength against an evidence claim, prose the
     * model was never required to write identically. It never matched once,
     * so every quote and every seek button silently vanished.
     *
     * A bare string is a v1 row. It renders as a claim with no quote and no
     * button rather than being paired with a neighbouring span — an
     * unevidenced claim is honest, a mispaired one is not. Re-scoring such a
     * row under v2 is what restores its evidence.
     */
    const pair = (items: unknown): ScoredEvidence[] => {
      if (!Array.isArray(items)) return [];
      const out: ScoredEvidence[] = [];
      for (const item of items) {
        if (typeof item === "string") {
          const claim = plainDashes(item.trim());
          if (claim) out.push({ claim, quote: "", startSeconds: null });
          continue;
        }
        if (!item || typeof item !== "object") continue;
        const e = item as { claim?: unknown; quote?: unknown };
        const claim = typeof e.claim === "string" ? plainDashes(e.claim.trim()) : "";
        if (!claim) continue;
        const quote = typeof e.quote === "string" ? e.quote.trim() : "";
        out.push({
          claim,
          quote,
          startSeconds: quote ? findQuoteStart(quote, segs) : null,
        });
      }
      return out;
    };

    const status: ScoreStatus =
      r.status === "scored" ||
      r.status === "failed" ||
      r.status === "skipped" ||
      r.status === "norubric"
        ? r.status
        : "pending";

    out.set(r.answer_id, {
      status,
      aiScore: r.score,
      shownScore: r.human_adjusted_score ?? r.score,
      confidence: r.confidence,
      reasoning: wordsDeleted ? null : plainDashesOrNull(r.reasoning),
      strengths: wordsDeleted ? [] : pair(r.strengths),
      concerns: wordsDeleted ? [] : pair(r.concerns),
      missing:
        !wordsDeleted && Array.isArray(r.missing)
          ? (r.missing as unknown[])
              .filter((x): x is string => typeof x === "string")
              .map(plainDashes)
          : [],
      adjustment: toAdjustment(
        r.human_adjusted_score,
        r.adjusted_by_name,
        r.adjusted_at,
        r.human_feedback,
        r.score,
      ),
      error: r.error,
    });
  }
  return out;
}

/**
 * The AI score per session, when one exists.
 *
 * Company-gated on its own column rather than trusting the session join — the
 * scores table carries company_id for exactly this reason.
 *
 * A failed read is unavailable, for every session asked about: read as an
 * empty map it would show "Not scored" on interviews that have a score.
 */
async function fetchSessionScores(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  sessionIds: string[],
  /** Sessions past delete_after: their summary and criterion quotes are not sent. */
  wordsDeleted: ReadonlySet<string>,
): Promise<Read<Map<string, InterviewScore>>> {
  const out = new Map<string, InterviewScore>();
  for (let i = 0; i < sessionIds.length; i += 100) {
    const { data, error } = await service
      .from("interview_session_scores")
      .select(
        "session_id, status, overall_score, human_adjusted_score, human_feedback, adjusted_by_name, adjusted_at, verdict, summary, confidence, criteria, error, scored_at, created_at",
      )
      .eq("company_id", companyId)
      .in("session_id", sessionIds.slice(i, i + 100));
    if (error) {
      console.error("[interviews] session score read failed:", error.code ?? "error");
      return unavailable();
    }

    for (const r of (data ?? []) as {
      session_id: string;
      status: string | null;
      overall_score: number | null;
      human_adjusted_score: number | null;
      human_feedback: string | null;
      adjusted_by_name: string | null;
      adjusted_at: string | null;
      verdict: string | null;
      summary: string | null;
      confidence: string | null;
      criteria: unknown;
      error: string | null;
      scored_at: string | null;
      created_at: string | null;
    }[]) {
      const status =
        r.status === "scored" || r.status === "failed" || r.status === "skipped"
          ? r.status
          : "pending";
      const deleted = wordsDeleted.has(r.session_id);
      out.set(r.session_id, {
        status,
        overall: r.overall_score,
        humanScore: r.human_adjusted_score,
        verdict: plainDashesOrNull(r.verdict),
        summary: deleted ? null : plainDashesOrNull(r.summary),
        confidence: r.confidence,
        criteria: normaliseCriteria(r.criteria).map((c) => (deleted ? { ...c, quote: "" } : c)),
        error: r.error,
        scoredAt: r.scored_at,
        firstWrittenAt: r.created_at,
        adjustment: toAdjustment(
          r.human_adjusted_score,
          r.adjusted_by_name,
          r.adjusted_at,
          r.human_feedback,
          r.overall_score,
        ),
      });
    }
  }
  return answered(out);
}

/** The note thread for one session. Oldest first — it reads as a conversation. */
/**
 * Shape the stored criteria jsonb, without placing the quotes yet.
 *
 * Placement needs the answers' transcript segments, which the LIST does not
 * load — so a row starts with `answerId`/`startSeconds` null and the detail
 * view fills them in via placeCriterionQuote. The list only ever shows the
 * item and its status, so it never pays for segments it will not use.
 *
 * A non-array, a missing column or a row scored under an older prompt version
 * all collapse to []. That is deliberate and is the same value a job with no
 * criteria stores: both mean "nothing to show", and the UI renders nothing for
 * either. There is no distinction here worth inventing.
 */
function normaliseCriteria(raw: unknown): SessionCriterion[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionCriterion[] = [];
  for (const entry of raw) {
    const e = entry as { item?: unknown; status?: unknown; quote?: unknown };
    const item = typeof e?.item === "string" ? e.item.trim() : "";
    if (!item) continue;
    out.push({
      item,
      status: e.status === "evidenced" ? "evidenced" : "not_found",
      quote: typeof e.quote === "string" ? e.quote.trim() : "",
      answerId: null,
      startSeconds: null,
    });
  }
  return out;
}

/**
 * Locate a criterion's quote inside one of the answers, so it can seek.
 *
 * ── Why this has to probe ────────────────────────────────────
 *
 * Per-answer evidence knows which recording it belongs to, so it calls
 * findQuoteStart once. A criterion does not: it was verified against every
 * transcript JOINED, so nothing in the stored row says which answer the span
 * came from. The span itself is contiguous, though, so in practice it lies
 * inside exactly one answer — probing each answer's segments in turn and taking
 * the first hit recovers both the answer and the offset.
 *
 * Returns nulls when no answer matches, which is a real outcome rather than a
 * bug: a quote that genuinely straddles the join between two answers belongs to
 * neither segment list, and a segment-less answer (transcribed before segments
 * were stored) cannot place anything. The UI then shows the quote without a
 * seek button — the same thing it already does for a v1 answer.
 */
function placeCriterionQuote(
  quote: string,
  answers: { id: string; segments: TranscriptSegment[] | null }[],
): { answerId: string | null; startSeconds: number | null } {
  if (!quote.trim()) return { answerId: null, startSeconds: null };
  for (const answer of answers) {
    const at = findQuoteStart(quote, answer.segments);
    if (at !== null) return { answerId: answer.id, startSeconds: at };
  }
  return { answerId: null, startSeconds: null };
}

/**
 * Fill in each criterion's answer and offset, leaving everything else alone.
 *
 * Returns the score object unchanged when there is nothing to place — no score,
 * no criteria, or criteria with no quotes — so the common case allocates
 * nothing and the empty-list path stays exactly as it was.
 */
function withPlacedCriteria(
  score: InterviewScore | null,
  answers: { id: string; segments: TranscriptSegment[] | null }[],
): InterviewScore | null {
  if (!score || score.criteria.length === 0) return score;
  return {
    ...score,
    criteria: score.criteria.map((c) =>
      c.quote ? { ...c, ...placeCriterionQuote(c.quote, answers) } : c,
    ),
  };
}

export async function readNotes(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  sessionId: string,
): Promise<InterviewNote[]> {
  const { data } = await service
    .from("interview_notes")
    .select("id, body, author_name, member_id, created_at, updated_at")
    // company_id is denormalised onto the row precisely so this gate does not
    // have to join back through the session.
    .eq("company_id", companyId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(200);

  return (
    (data ?? []) as {
      id: string;
      body: string;
      author_name: string | null;
      member_id: string;
      created_at: string;
      updated_at: string | null;
    }[]
  ).map((n) => ({
    id: n.id,
    body: n.body,
    authorName: (n.author_name ?? "").trim() || "A teammate",
    memberId: n.member_id,
    createdAt: n.created_at,
    // Only surfaced when it differs from created_at — see the client.
    updatedAt: n.updated_at,
  }));
}

/**
 * `skipped` is in the column's vocabulary but nothing writes it yet; it is
 * mapped rather than ignored so it renders as a state instead of falling
 * through to "pending" and implying work still queued.
 */
function normaliseTranscript(status: string | null, transcript: string | null): TranscriptState {
  if (status === "done") return transcript?.trim() ? "done" : "empty";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "pending";
}
