import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import {
  canAccessJob,
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import type {
  CandidateLink,
  InterviewAnswerView,
  InterviewNote,
  InterviewListResult,
  InterviewRow,
  InterviewSessionDetail,
  InterviewStatus,
  InterviewTab,
  TranscriptState,
} from "./review-types";

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
 * ── Scoping ──────────────────────────────────────────────────
 *
 * Company FIRST, then the hiring team. A recruiter scoped to two jobs sees
 * interviews for those two jobs and nothing else, exactly as the applicant
 * list behaves. Both filters are applied server-side in the query; nothing
 * relies on the client asking for the right thing.
 */

const PAGE_SIZE = 20;

/** The statuses the UI groups by, derived rather than trusted from the row. */
function deriveStatus(
  stored: string,
  expiresAt: string | null,
): InterviewStatus {
  if (stored === "cancelled") return "cancelled";
  if (stored === "submitted") return "submitted";
  if (stored === "expired") return "expired";
  // A session nothing has swept is still expired once its deadline passes.
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return "expired";
  if (stored === "started") return "started";
  return "invited";
}

function snapshotLength(snapshot: unknown): number | null {
  return Array.isArray(snapshot) ? snapshot.length : null;
}

type AppRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

/**
 * Resolve the candidate, and say WHY when there isn't one.
 *
 * Six of the seven sessions in this workspace carry no application_id at all —
 * they predate sendInterviewInvite, which requires an applicant. Those are
 * genuinely unlinked, not lost, and the row should say so rather than print a
 * placeholder name.
 */
function resolveCandidate(
  applicationId: string | null,
  app: AppRow | undefined,
): { name: string; email: string; link: CandidateLink } {
  if (!applicationId) {
    return { name: "No applicant linked", email: "", link: "unlinked" };
  }
  if (!app) {
    return { name: "Applicant deleted", email: "", link: "deleted" };
  }
  const name = [app.first_name, app.last_name].filter(Boolean).join(" ").trim();
  return {
    name: name || app.email || "Unnamed applicant",
    email: app.email ?? "",
    link: "linked",
  };
}

type SessionRow = {
  id: string;
  application_id: string | null;
  job_id: string | null;
  status: string;
  started_at: string | null;
  submitted_at: string | null;
  expires_at: string | null;
  delete_after: string | null;
  invited_by_name: string | null;
  questions_snapshot: unknown;
  archived_at: string | null;
  created_at: string;
};

/**
 * One page of interviews, plus the aggregate counts the tabs and hero read.
 *
 * Aggregates are counted over the WHOLE scoped set, not the rendered page —
 * a tab that said "4" because four happened to be on screen would be wrong
 * the moment someone paged.
 */
export async function listInterviewSessions(
  ctx: CompanyContext,
  opts: {
    status?: InterviewTab;
    jobId?: string | null;
    query?: string;
    page?: number;
  } = {},
): Promise<InterviewListResult> {
  const empty: InterviewListResult = {
    rows: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    counts: { all: 0, submitted: 0, started: 0, invited: 0, expired: 0, archived: 0 },
    jobs: [],
    sentThisWeek: 0,
    openRoles: 0,
  };

  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return empty;
  const allowedJobIds = scopeJobIds(scope);

  const service = createServiceClient();

  /*
   * Every session for the company, scoped. Read in full rather than paged in
   * SQL because status is DERIVED (an unswept session past its deadline is
   * expired) — filtering and counting on the stored column would put rows in
   * the wrong tab. Bounded by range-paging; a company with more than a few
   * thousand interviews would want a status-sweep job before this is the
   * bottleneck.
   */
  const sessions: SessionRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("interview_sessions")
      .select(
        "id, application_id, job_id, status, started_at, submitted_at, expires_at, delete_after, invited_by_name, questions_snapshot, archived_at, created_at",
      )
      .eq("company_id", ctx.companyId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (allowedJobIds) q = q.in("job_id", allowedJobIds);

    const { data, error } = await q;
    if (error) break;
    const batch = (data ?? []) as SessionRow[];
    sessions.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (sessions.length === 0) return empty;

  // ── Candidate + job names, one round trip each ──
  const appIds = [...new Set(sessions.map((s) => s.application_id).filter(Boolean))] as string[];
  const jobIds = [...new Set(sessions.map((s) => s.job_id).filter(Boolean))] as string[];

  const [apps, jobs, answers] = await Promise.all([
    fetchApplications(service, ctx.companyId, appIds),
    fetchJobs(service, ctx.companyId, jobIds),
    fetchAnswerStats(service, sessions.map((s) => s.id)),
  ]);

  const rows: InterviewRow[] = sessions.map((s) => {
    const app = s.application_id ? apps.get(s.application_id) : undefined;
    const who = resolveCandidate(s.application_id, app);
    const stats = answers.get(s.id);
    const status = deriveStatus(s.status, s.expires_at);
    const total =
      snapshotLength(s.questions_snapshot) ?? stats?.total ?? 0;
    return {
      id: s.id,
      applicationId: s.application_id,
      jobId: s.job_id,
      candidateName: who.name,
      candidateEmail: who.email,
      candidateLink: who.link,
      jobTitle: (s.job_id ? jobs.get(s.job_id) : null) ?? "This role",
      status,
      answered: stats?.answered ?? 0,
      totalQuestions: total,
      /* Purged is a PRESENTATION state, not a status: the interview is still
         submitted, its media has simply passed the retention date. Derived
         from rows that were recorded but no longer hold a path. */
      purged: Boolean(stats && stats.answered > 0 && stats.withVideo === 0),
      submittedAt: s.submitted_at,
      startedAt: s.started_at,
      expiresAt: s.expires_at,
      sentAt: s.created_at,
      invitedByName: s.invited_by_name,
      archivedAt: s.archived_at,
    };
  });

  /*
   * ── Aggregates over the whole scoped set, ARCHIVE EXCLUDED ──
   *
   * Archiving hides a row from the working list, so it has to hide it from the
   * numbers too — a tab reading 4 above a list of 3 is the bug this project has
   * already had once. `archived` is counted separately and is the only tab that
   * shows those rows.
   */
  const live = rows.filter((r) => r.archivedAt === null);
  const counts = {
    all: live.length,
    submitted: live.filter((r) => r.status === "submitted").length,
    started: live.filter((r) => r.status === "started").length,
    invited: live.filter((r) => r.status === "invited").length,
    expired: live.filter((r) => r.status === "expired").length,
    archived: rows.length - live.length,
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sentThisWeek = live.filter(
    (r) => new Date(r.sentAt).getTime() >= weekAgo,
  ).length;

  const jobList = [...jobs.entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // ── Filter, then page ──
  const q = (opts.query ?? "").trim().toLowerCase();
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
    if (
      q &&
      !`${r.candidateName} ${r.candidateEmail} ${r.jobTitle}`
        .toLowerCase()
        .includes(q)
    ) {
      return false;
    }
    return true;
  });

  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * PAGE_SIZE;

  return {
    rows: filtered.slice(start, start + PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: PAGE_SIZE,
    counts,
    jobs: jobList,
    sentThisWeek,
    openRoles: new Set(live.map((r) => r.jobId).filter(Boolean)).size,
  };
}

async function fetchApplications(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  ids: string[],
) {
  const out = new Map<
    string,
    { first_name: string | null; last_name: string | null; email: string | null }
  >();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await service
      .from("job_applications")
      .select("id, first_name, last_name, email")
      // The company gate is re-applied here, not inherited from the session
      // row — an application that moved companies must not surface a name.
      .eq("company_id_snapshot", companyId)
      .in("id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }[]) {
      out.set(r.id, r);
    }
  }
  return out;
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

/** answered / total / how many still hold a video, per session. */
async function fetchAnswerStats(
  service: ReturnType<typeof createServiceClient>,
  sessionIds: string[],
) {
  const out = new Map<
    string,
    { answered: number; total: number; withVideo: number }
  >();
  for (let i = 0; i < sessionIds.length; i += 100) {
    const { data } = await service
      .from("interview_answers")
      .select("session_id, video_path")
      .in("session_id", sessionIds.slice(i, i + 100));
    for (const r of (data ?? []) as {
      session_id: string;
      video_path: string | null;
    }[]) {
      const cur = out.get(r.session_id) ?? { answered: 0, total: 0, withVideo: 0 };
      cur.answered += 1;
      cur.total += 1;
      if (r.video_path) cur.withVideo += 1;
      out.set(r.session_id, cur);
    }
  }
  return out;
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
      "id, application_id, job_id, status, started_at, submitted_at, expires_at, delete_after, invited_by_name, questions_snapshot, archived_at, created_at",
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

  const [apps, jobs] = await Promise.all([
    fetchApplications(
      service,
      ctx.companyId,
      row.application_id ? [row.application_id] : [],
    ),
    fetchJobs(service, ctx.companyId, row.job_id ? [row.job_id] : []),
  ]);
  const app = row.application_id ? apps.get(row.application_id) : undefined;
  const who = resolveCandidate(row.application_id, app);

  const { data: appRow } = row.application_id
    ? await service
        .from("job_applications")
        .select("pipeline_stage")
        .eq("id", row.application_id)
        .eq("company_id_snapshot", ctx.companyId)
        .maybeSingle()
    : { data: null };

  // video_path is selected so `hasVideo` can be derived, and is NOT returned.
  const { data: answerRows } = await service
    .from("interview_answers")
    .select(
      "id, position, question_text, video_path, duration_seconds, transcript, transcript_status, transcript_error, recorded_at",
    )
    .eq("session_id", row.id)
    .order("position", { ascending: true })
    .limit(50);

  const answers: InterviewAnswerView[] = (
    (answerRows ?? []) as {
      id: string;
      position: number;
      question_text: string | null;
      video_path: string | null;
      duration_seconds: number | null;
      transcript: string | null;
      transcript_status: string | null;
      transcript_error: string | null;
      recorded_at: string | null;
    }[]
  ).map((a) => ({
    id: a.id,
    position: a.position,
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

  // Competency lives on the QUESTION, never on the answer, and is reviewer-only
  // — the candidate payload deliberately withholds it.
  if (row.job_id) {
    const { data: qRows } = await service
      .from("interview_questions")
      .select("position, competency")
      .eq("job_id", row.job_id)
      .eq("company_id", ctx.companyId)
      .limit(50);
    const byPosition = new Map(
      ((qRows ?? []) as { position: number; competency: string | null }[]).map(
        (q) => [q.position, (q.competency ?? "").trim() || null],
      ),
    );
    for (const a of answers) a.competency = byPosition.get(a.position) ?? null;
  }

  const status = deriveStatus(row.status, row.expires_at);
  const totalQuestions =
    snapshotLength(row.questions_snapshot) ?? answers.length;

  return {
    id: row.id,
    applicationId: row.application_id,
    jobId: row.job_id,
    candidateName: who.name,
    candidateEmail: who.email,
    candidateLink: who.link,
    jobTitle: (row.job_id ? jobs.get(row.job_id) : null) ?? "This role",
    stage:
      ((appRow as { pipeline_stage: string | null } | null)?.pipeline_stage ??
        "applied"),
    status,
    answers,
    totalQuestions,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    sentAt: row.created_at,
    deleteAfter: row.delete_after,
    invitedByName: row.invited_by_name,
    archivedAt: row.archived_at,
    canDelete: await canAccessJob(ctx, row.job_id ?? ""),
    purged:
      answers.length > 0 && answers.every((a) => a.purged),
    /*
     * Notes SURVIVE the purge. They are a reviewer's own words about a
     * candidate, not the candidate's media — the six-month promise covers the
     * recording, and deleting the reasoning behind a hiring decision along
     * with it would erase the audit trail the recording existed to support.
     */
    notes: await readNotes(service, ctx.companyId, row.id),
    // Null for a context without a member row (shouldn't happen inside the
    // gated segment); an empty string simply matches no note's author.
    viewerMemberId: ctx.memberId ?? "",
  };
}

/** The note thread for one session. Oldest first — it reads as a conversation. */
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

  return ((data ?? []) as {
    id: string;
    body: string;
    author_name: string | null;
    member_id: string;
    created_at: string;
    updated_at: string | null;
  }[]).map((n) => ({
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
function normaliseTranscript(
  status: string | null,
  transcript: string | null,
): TranscriptState {
  if (status === "done") return transcript?.trim() ? "done" : "empty";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "pending";
}
