"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  canAccessJob,
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import { removeSessionObjects } from "@/lib/interviews/purge";
import { listInterviewSessions, readNotes } from "@/lib/interviews/review";
import type {
  InterviewListResult,
  InterviewNote,
  InterviewTab,
} from "@/lib/interviews/review-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in lib/interviews/review-types.ts.

/** Five minutes. Long enough to watch a two-minute answer, short enough that a
 *  copied URL is worthless by the time it is pasted anywhere. */
const PLAYBACK_TTL_SECONDS = 5 * 60;

type PlaybackResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

type NotesResult =
  | { ok: true; notes: InterviewNote[] }
  | { ok: false; error: string };

/** Same message for not-found and not-yours, as everywhere else in the product. */
const NOT_YOURS = "That interview isn't in your workspace.";

/** Longest a note can be. Generous — this is where a reviewer argues a case. */
const NOTE_MAX = 4000;

/**
 * The one gate every interview read and write goes through.
 *
 * Company FIRST, then the hiring team, then — and only then — the work. It is
 * a single function so playback and the three note actions cannot drift: a new
 * action that forgets a check is a new function, not a missing line here.
 */
async function gateSession(sessionId: string): Promise<
  | {
      ok: true;
      ctx: Awaited<ReturnType<typeof getCompanyContext>>;
      session: { id: string; job_id: string | null; application_id: string | null };
    }
  | { ok: false; error: string }
> {
  if (!sessionId) return { ok: false, error: "Bad request." };

  let ctx: Awaited<ReturnType<typeof getCompanyContext>>;
  try {
    ctx = await getCompanyContext();
  } catch {
    return { ok: false, error: "Sign in to your workspace first." };
  }

  const service = createServiceClient();
  const { data } = await service
    .from("interview_sessions")
    .select("id, job_id, application_id")
    .eq("id", sessionId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  const session = data as {
    id: string;
    job_id: string | null;
    application_id: string | null;
  } | null;
  if (!session) return { ok: false, error: NOT_YOURS };

  const scope = await getJobScope(ctx);
  if (isEmptyScope(scope)) return { ok: false, error: NOT_YOURS };
  const allowed = scopeJobIds(scope);
  if (allowed && (!session.job_id || !allowed.includes(session.job_id))) {
    return { ok: false, error: NOT_YOURS };
  }

  return { ok: true, ctx, session };
}

/**
 * Mint a signed playback URL for ONE answer.
 *
 * ── The audited pattern, matching the CV routes ──────────────
 *
 * Same four steps as /api/cv/company-application/[id]: resolve the viewer,
 * gate ownership BEFORE signing, sign with a bounded TTL, then write
 * signed_url_logs fire-and-forget so a logging failure cannot block a
 * legitimate grant. Deliberately the same shape (user_id / candidate_id /
 * source_table / was_admin) so interview views and CV views can be read from
 * one table, with source_table telling them apart.
 *
 * A server action rather than a route because the URL is consumed by a
 * <video src> inside the page — there is no window.open to lose to a popup
 * blocker, which is the only reason the CV path is a route.
 *
 * The client sends an ANSWER id and a SESSION id. Neither is trusted: the
 * session is re-read against the company and the hiring team, and the answer
 * must belong to that session. There is no id here a caller could swap for
 * another company's object, and the storage path is derived from the row
 * server-side and never returned.
 */
export async function getAnswerPlaybackUrl(
  sessionId: string,
  answerId: string,
): Promise<PlaybackResult> {
  if (!answerId) return { ok: false, error: "Bad request." };

  // ── 1. Company + hiring team ──
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;
  const service = createServiceClient();

  // ── 2. The answer must belong to that session ──
  const { data: answerRow } = await service
    .from("interview_answers")
    .select("id, video_path, recorded_at")
    .eq("id", answerId)
    .eq("session_id", session.id)
    .maybeSingle();

  const answer = answerRow as {
    video_path: string | null;
    recorded_at: string | null;
  } | null;
  if (!answer) return { ok: false, error: NOT_YOURS };

  if (!answer.video_path) {
    // Recorded-then-purged reads differently from never-recorded, and the
    // page renders each differently, so they are told apart here too.
    return {
      ok: false,
      error: answer.recorded_at
        ? "This recording was deleted after six months."
        : "This question hasn't been answered yet.",
    };
  }

  // ── 3. Sign ──
  const { data: signed, error: signErr } = await service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(answer.video_path, PLAYBACK_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    console.error("[interview] playback sign failed:", signErr?.message);
    return { ok: false, error: "Couldn't load that recording. Try again." };
  }

  // ── 4. Audit, fire-and-forget ──
  service
    .from("signed_url_logs")
    .insert({
      user_id: ctx.user.id,
      // The APPLICATION id, matching the CV routes: the column identifies the
      // candidate whose media was opened, not the individual file.
      candidate_id: session.application_id,
      source_table: "interview_answers",
      was_admin: false,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  return { ok: true, url: signed.signedUrl };
}

/** Re-query the list when a filter, tab, search or page changes. */
export async function fetchInterviewList(opts: {
  status?: InterviewTab;
  jobId?: string | null;
  query?: string;
  page?: number;
}): Promise<InterviewListResult> {
  const ctx = await getCompanyContext();
  return listInterviewSessions(ctx, opts);
}

// ── Reviewer notes ───────────────────────────────────────────
//
// A THREAD, not one editable blob. Two reviewers watching the same interview
// each add a note; neither overwrites the other, and the order they arrived in
// is part of what the record says.
//
// Every role may write. Hiring managers are the people most likely to be
// watching, and a review surface that let them read but not respond would push
// the conversation into Slack where it stops being part of the record.
//
// Every action re-gates through gateSession, so company and hiring-team
// scoping is identical on read and write.

/**
 * Add a note.
 *
 * author_name is SNAPSHOTTED, the same way changed_by_name and
 * invited_by_name are: it records who said this at the time. Someone who
 * later changes their display name, or leaves the company, does not
 * retroactively re-attribute a note they wrote six months ago.
 */
export async function addInterviewNote(
  sessionId: string,
  body: string,
): Promise<NotesResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "Write something first." };
  if (trimmed.length > NOTE_MAX) {
    return { ok: false, error: `Notes are limited to ${NOTE_MAX} characters.` };
  }

  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  if (!ctx.memberId) {
    return { ok: false, error: "Your membership isn't active on this workspace." };
  }

  const service = createServiceClient();
  const { error } = await service.from("interview_notes").insert({
    session_id: session.id,
    company_id: ctx.companyId,
    member_id: ctx.memberId,
    author_name: ctx.memberName,
    body: trimmed,
  });

  if (error) {
    console.error("[interview] note insert failed:", error.message);
    return { ok: false, error: "Couldn't save that note. Please try again." };
  }

  return { ok: true, notes: await readNotes(service, ctx.companyId, session.id) };
}

/**
 * Edit your OWN note.
 *
 * The `member_id` predicate is on the UPDATE itself, not a read-then-write:
 * two statements would leave a window where a note changed hands between the
 * check and the write. A note belonging to someone else simply matches no row.
 */
export async function updateInterviewNote(
  sessionId: string,
  noteId: string,
  body: string,
): Promise<NotesResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "A note can't be empty." };
  if (trimmed.length > NOTE_MAX) {
    return { ok: false, error: `Notes are limited to ${NOTE_MAX} characters.` };
  }

  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;
  if (!ctx.memberId) return { ok: false, error: NOT_YOURS };

  const service = createServiceClient();
  const { data, error } = await service
    .from("interview_notes")
    .update({ body: trimmed, updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId)
    // Own notes only. Editing a colleague's words would make attribution a lie.
    .eq("member_id", ctx.memberId)
    .select("id");

  if (error) {
    console.error("[interview] note update failed:", error.message);
    return { ok: false, error: "Couldn't save that edit. Please try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "You can only edit your own notes." };
  }

  return { ok: true, notes: await readNotes(service, ctx.companyId, session.id) };
}

/**
 * Delete your OWN note.
 *
 * Same single-statement ownership predicate as the edit. See the report for
 * why this exists at all and why I would time-limit it.
 */
export async function deleteInterviewNote(
  sessionId: string,
  noteId: string,
): Promise<NotesResult> {
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;
  if (!ctx.memberId) return { ok: false, error: NOT_YOURS };

  const service = createServiceClient();
  const { data, error } = await service
    .from("interview_notes")
    .delete()
    .eq("id", noteId)
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId)
    .eq("member_id", ctx.memberId)
    .select("id");

  if (error) {
    console.error("[interview] note delete failed:", error.message);
    return { ok: false, error: "Couldn't delete that note. Please try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "You can only delete your own notes." };
  }

  return { ok: true, notes: await readNotes(service, ctx.companyId, session.id) };
}

// ── Archive and delete ───────────────────────────────────────
//
// TWO DIFFERENT THINGS, and the UI has to keep them apart:
//
//   CANCEL   stops an invited candidate from recording. It changes what the
//            candidate can do, and it is the wrong tool for a finished
//            interview. Lives on the applicant drawer, where invites are sent.
//   ARCHIVE  hides a finished interview from the reviewer's list. It changes
//            nothing the candidate sees, and is fully reversible.
//
// Archive is a timestamp rather than a status so restore has nothing to
// remember — the row's status was never touched, so putting it back is just
// nulling the column. Same reasoning as job archiving.

type SessionMutation = { ok: true } | { ok: false; error: string };

/** Archive or restore. Anyone who can see the interview can do either. */
export async function setInterviewArchived(
  sessionId: string,
  archived: boolean,
): Promise<SessionMutation> {
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  const { error } = await createServiceClient()
    .from("interview_sessions")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", session.id)
    .eq("company_id", ctx.companyId);

  if (error) {
    console.error("[interview] archive toggle failed:", error.message);
    return { ok: false, error: "Couldn't update that interview. Try again." };
  }

  revalidatePath("/ai-dashboard/interviews");
  return { ok: true };
}

/**
 * Delete permanently, media first.
 *
 * ── Order is the whole design ────────────────────────────────
 *
 * Storage, THEN the row. video_path is the only record of where an object
 * lives, so deleting the row first strands every file with nothing pointing at
 * it — the same reasoning the retention purge is built on, and the reason this
 * calls that job's own removeSessionObjects rather than a second copy of it.
 *
 * If storage removal is incomplete the row is LEFT ALONE and the failure is
 * reported, so the operator can retry. A partially-deleted interview that
 * still has its row is recoverable; one that lost its row is not.
 *
 * Answers and notes go with the session by FK cascade — nothing here deletes
 * them individually, so a future child table is covered by the schema rather
 * than by remembering to add a line.
 */
export async function deleteInterview(
  sessionId: string,
): Promise<SessionMutation> {
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  /*
   * Deleting is narrower than seeing. gateSession already proved company and
   * hiring-team membership for a scoped role; canAccessJob is re-run because
   * it is the exact predicate asked for — owner/admin pass on role, everyone
   * else must be on THIS job's team — and because the check belongs next to
   * the destructive act, not three calls upstream.
   */
  if (!(await canAccessJob(ctx, session.job_id ?? ""))) {
    return {
      ok: false,
      error: "Only an owner, admin, or someone on this job's hiring team can delete an interview.",
    };
  }

  const service = createServiceClient();

  // ── 1. Media first ──
  let sweep: Awaited<ReturnType<typeof removeSessionObjects>>;
  try {
    sweep = await removeSessionObjects(service, session.id);
  } catch (err) {
    console.error("[interview] delete: storage list failed:", err);
    return {
      ok: false,
      error: "Couldn't reach the recording storage. Nothing was deleted — please try again.",
    };
  }

  if (!sweep.complete) {
    const left = sweep.present.length - sweep.removed.size;
    console.error(
      `[interview] delete ${session.id}: ${left} object(s) survived: ${sweep.error ?? "no error reported"}`,
    );
    return {
      ok: false,
      error: `${left} recording${left === 1 ? "" : "s"} couldn't be deleted, so nothing was removed. Please try again.`,
    };
  }

  // ── 2. Only now the row ──
  const { error } = await service
    .from("interview_sessions")
    .delete()
    .eq("id", session.id)
    .eq("company_id", ctx.companyId);

  if (error) {
    // The media is already gone. Say so plainly rather than implying the
    // interview is intact — a retry will find an empty folder and succeed.
    console.error("[interview] delete: row delete failed:", error.message);
    return {
      ok: false,
      error: "The recordings were deleted but the interview record wasn't. Please try again.",
    };
  }

  revalidatePath("/ai-dashboard/interviews");
  return { ok: true };
}

// ── Human score adjustment ───────────────────────────────────
//
// Mirrors the CV scorer's adjustScore/revertScore exactly: guarded, ownership
// checked, all five audit columns written or nulled TOGETHER.
//
// The AI's own score is never touched. It stays in `score` / `overall_score`
// and the correction lands in the human_* columns beside it, so the review
// page can show both — the comparison is the value, and a silent overwrite
// would destroy the only record of what the model actually said.
//
// A re-score cannot clobber a correction either: writeAnswerScore strips the
// human_* columns from its payload rather than reading and merging them.

/** Whole numbers only — a fractional human judgement is false precision. */
function validScore(score: number): boolean {
  return (
    Number.isFinite(score) && Number.isInteger(score) && score >= 0 && score <= 100
  );
}

const SCORE_FEEDBACK_MAX = 2000;

/** Adjust ONE answer's score. */
export async function adjustAnswerScore(
  sessionId: string,
  answerId: string,
  score: number,
  feedback?: string,
): Promise<SessionMutation> {
  if (!validScore(score)) {
    return { ok: false, error: "Score must be a whole number from 0 to 100." };
  }

  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  const { data, error } = await createServiceClient()
    .from("interview_answer_scores")
    .update({
      human_adjusted_score: score,
      human_feedback: (feedback ?? "").trim().slice(0, SCORE_FEEDBACK_MAX) || null,
      adjusted_by: ctx.user.id,
      // Cached, not looked up later: audit history must keep saying who made
      // the call even after they leave the company.
      adjusted_by_name: ctx.memberName,
      adjusted_at: new Date().toISOString(),
    })
    .eq("answer_id", answerId)
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId)
    .select("answer_id");

  if (error) {
    console.error("[interview] answer adjust failed:", error.message);
    return { ok: false, error: "Couldn't save that adjustment. Try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "That answer hasn't been scored yet." };
  }

  revalidatePath(`/ai-dashboard/interviews/${session.id}`);
  return { ok: true };
}

/**
 * Drop a correction and fall back to the model's own score.
 *
 * Nulls all five columns together — a half-cleared row (a score with no
 * author, or an author with no score) would read as corrupt.
 */
export async function revertAnswerScore(
  sessionId: string,
  answerId: string,
): Promise<SessionMutation> {
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  const { error } = await createServiceClient()
    .from("interview_answer_scores")
    .update({
      human_adjusted_score: null,
      human_feedback: null,
      adjusted_by: null,
      adjusted_by_name: null,
      adjusted_at: null,
    })
    .eq("answer_id", answerId)
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId);

  if (error) {
    console.error("[interview] answer revert failed:", error.message);
    return { ok: false, error: "Couldn't revert that. Try again." };
  }

  revalidatePath(`/ai-dashboard/interviews/${session.id}`);
  return { ok: true };
}

/** Adjust the SESSION's overall score. Same discipline, different table. */
export async function adjustSessionScore(
  sessionId: string,
  score: number,
  feedback?: string,
): Promise<SessionMutation> {
  if (!validScore(score)) {
    return { ok: false, error: "Score must be a whole number from 0 to 100." };
  }

  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  const { data, error } = await createServiceClient()
    .from("interview_session_scores")
    .update({
      human_adjusted_score: score,
      human_feedback: (feedback ?? "").trim().slice(0, SCORE_FEEDBACK_MAX) || null,
      adjusted_by: ctx.user.id,
      adjusted_by_name: ctx.memberName,
      adjusted_at: new Date().toISOString(),
    })
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId)
    .select("session_id");

  if (error) {
    console.error("[interview] session adjust failed:", error.message);
    return { ok: false, error: "Couldn't save that adjustment. Try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "This interview hasn't been scored yet." };
  }

  revalidatePath(`/ai-dashboard/interviews/${session.id}`);
  revalidatePath("/ai-dashboard/interviews");
  return { ok: true };
}

export async function revertSessionScore(
  sessionId: string,
): Promise<SessionMutation> {
  const gate = await gateSession(sessionId);
  if (!gate.ok) return gate;
  const { ctx, session } = gate;

  const { error } = await createServiceClient()
    .from("interview_session_scores")
    .update({
      human_adjusted_score: null,
      human_feedback: null,
      adjusted_by: null,
      adjusted_by_name: null,
      adjusted_at: null,
    })
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId);

  if (error) {
    console.error("[interview] session revert failed:", error.message);
    return { ok: false, error: "Couldn't revert that. Try again." };
  }

  revalidatePath(`/ai-dashboard/interviews/${session.id}`);
  revalidatePath("/ai-dashboard/interviews");
  return { ok: true };
}
