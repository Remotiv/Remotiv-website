import "server-only";
import { getAnthropic } from "@/lib/anthropic";
import { removeCandidateName } from "@/lib/interviews/candidate-name";
import { sanitizeCvForInterview } from "@/lib/interviews/cv-sanitize";
import {
  type FrozenLiveQuestion,
  type FrozenLiveQuestionSet,
  hasFrozenMarker,
  QUESTIONS_FROZEN_KEY,
  type QuestionsFrozenMarker,
  readFrozenQuestionSet,
  snapshotsFor,
} from "@/lib/interviews/frozen-questions";
import { ensureJobQuestionGuide } from "@/lib/interviews/live-guides";
import {
  LIVE_QUESTIONS_PROMPT_VERSION,
  type LiveQuestionsClient,
  writeLiveQuestions,
} from "@/lib/interviews/live-questions";
import { readScoringSnapshot } from "@/lib/interviews/question-meta";
import {
  MAX_JOB_QUESTIONS,
  MIN_JOB_QUESTIONS,
  QUESTION_MIX_POLICY_VERSION,
} from "@/lib/interviews/question-mix";
import { readLiveSettings } from "@/lib/interviews/types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Write and freeze an AI Video Interview's questions, once, before it starts.
 *
 * ── Every job question, word for word (23 Nov, #13) ─────────
 *
 * ALL of the job's authored interview questions, taken from the snapshot the
 * live invite froze, in the recruiter's order (position, then question id for
 * a tie, so two candidates' snapshots always come out in the same order), with
 * their own competency, rubric and weight. They are never rewritten, so every
 * candidate invited under the same questions hears the same text in the same
 * order. Fewer than MIN_JOB_QUESTIONS or more than MAX_JOB_QUESTIONS is
 * refused before any model call, nothing written: never cut, never padded.
 * The count must also equal the one frozen in the mix at invite.
 *
 * The job's live interview_questions rows are never read here: a recruiter's
 * edit after the invite reaches neither this freeze nor a set already frozen.
 *
 * Every question is frozen with a private scoring guide. A job question the
 * recruiter gave no rubric gets the JOB's guide (live-guides.ts): written once
 * for the job and wording, shared by every candidate, frozen here with
 * guide_source 'ai'. A recruiter's rubric is frozen with guide_source
 * 'recruiter'.
 *
 * ── CV slots: ON HOLD, none written ──────────────────────────
 *
 * The mix carries CV_QUESTIONS_PER_INTERVIEW (question-mix.ts), which is 0, so
 * the block marked "CV slots" in prepareLiveQuestions never runs: no CV read,
 * no call to writeLiveQuestions, so no CV or general experience question and
 * no cvSupportsQuestions check. That block, the CV read and live-questions.ts
 * are kept, unchanged, for when CV questions come back; until then they are
 * unreachable. A session invited under the table's split (question-mix-v1,
 * 4 job + 4 CV) is refused, never re-read as all-job.
 *
 * ── Once, and the same set for every caller ──────────────────
 *
 * The freeze is ONE conditional update: the session must still be a live,
 * invited, not-started session with no frozen marker. Two callers at once may
 * both write questions (two model calls), but only one update lands; the
 * other finds the marker on its re-read and returns the set that landed. No
 * caller ever returns a set that is not the one stored.
 *
 * ── Never after the interview has started ────────────────────
 *
 * A frozen set is returned as it is, whatever the session's status. With no
 * frozen set, a session that is not 'invited', or has started_at, is refused:
 * questions are never written for an interview already under way. A marker
 * that cannot be read is refused too, never written over.
 *
 * ── Called at start ──────────────────────────────────────────
 *
 * The start path calls this (startLiveInterview, live-start.ts, step 3): after
 * the start has claimed the session and before it asks the provider for a
 * session, passing its claim, so the freeze lands only while that claim is
 * still on the row. A start the provider then refuses (busy) leaves the set
 * frozen, and the next start reuses it. What is frozen is the invite's own
 * questions_snapshot (applicants/interview-actions.ts), as it stands. Live
 * links stay closed unless LIVE_INTERVIEW_SCREEN_ENABLED is "1" (session.ts,
 * live-screen.ts).
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * The CV, the name, the job text and the questions. One line per outcome with
 * the session id, call count and token totals.
 */

type Service = ReturnType<typeof createServiceClient>;

/** The marker's prompt and model when no question was written by the model. */
const NO_WRITER = "none";

export type PrepareDeps = {
  service: Service;
  client: LiveQuestionsClient;
  now: () => number;
  newId: () => string;
  /**
   * The start claim the caller holds (live-start.ts), as a key in
   * live_settings and its value. Given, the freeze lands only while that
   * claim is still on the row: a start whose claim was taken over after it
   * went stale can never write the questions, or its old claim, over the
   * start that took over.
   */
  claim?: { key: string; value: string };
};

export type PrepareErrorCode =
  | "session_not_found"
  | "not_live"
  | "already_started"
  | "no_question_mix"
  | "question_mix_superseded"
  | "frozen_unreadable"
  | "job_question_unreadable"
  | "too_few_job_questions"
  | "too_many_job_questions"
  | "job_question_count_mismatch"
  | "job_not_found"
  | "application_not_found"
  | "freeze_lost"
  | "guide_failed"
  | "db_error";

/** The session cannot be given frozen questions. Ids only in the message. */
export class PrepareLiveQuestionsError extends Error {
  readonly code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, sessionId: string) {
    super(`prepare live questions: ${code} (session ${sessionId})`);
    this.name = "PrepareLiveQuestionsError";
    this.code = code;
  }
}

export type PrepareOutcome = { set: FrozenLiveQuestionSet; generated: boolean };

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string;
  job_id: string;
  kind: string;
  status: string;
  started_at: string | null;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
};

const SESSION_COLUMNS =
  "id, company_id, application_id, job_id, kind, status, started_at, live_settings, questions_snapshot, scoring_snapshot";

async function readSession(service: Service, sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new PrepareLiveQuestionsError("db_error", sessionId);
  return data as SessionRow | null;
}

/** The stored set, or an error when there is a marker but no readable set. */
function frozenOf(row: SessionRow): FrozenLiveQuestionSet | null {
  const set = readFrozenQuestionSet(row);
  if (!set && hasFrozenMarker(row.live_settings)) {
    throw new PrepareLiveQuestionsError("frozen_unreadable", row.id);
  }
  return set;
}

/** Question ids in a fixed order, independent of locale. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

type InviteQuestions =
  | { ok: true; questions: FrozenLiveQuestion[] }
  | { ok: false; code: "job_question_unreadable" };

/**
 * Every question the live invite froze, in the recruiter's order (position,
 * then id for a tie), renumbered 1..n, with the marking fields frozen beside
 * them. Refused when the snapshot is not a list, or a question has no text or
 * id.
 */
function jobQuestionsFromInvite(row: SessionRow): InviteQuestions {
  const unreadable = { ok: false, code: "job_question_unreadable" } as const;
  if (!Array.isArray(row.questions_snapshot)) return unreadable;
  const entries = row.questions_snapshot as unknown[];
  const asked: Record<string, unknown>[] = [];
  for (const q of entries) {
    if (!q || typeof q !== "object" || typeof (q as { position?: unknown }).position !== "number") {
      return unreadable;
    }
    asked.push(q as Record<string, unknown>);
  }
  asked.sort(
    (a, b) =>
      (a.position as number) - (b.position as number) ||
      compareIds(String(a.id ?? ""), String(b.id ?? "")),
  );
  const marking = readScoringSnapshot(row.scoring_snapshot);
  const out: FrozenLiveQuestion[] = [];
  for (const [i, q] of asked.entries()) {
    const text = typeof q.question === "string" ? q.question.trim() : "";
    const id = typeof q.id === "string" ? q.id : "";
    if (!text || !id) return unreadable;
    // By question id first; position only when the snapshot carries no id match.
    const m =
      marking.find((s) => s.question_id === id) ?? marking.find((s) => s.position === q.position);
    out.push({
      question_id: id,
      position: i + 1,
      text,
      source: "job",
      competency: m?.competency ?? null,
      scoring_guide: m?.rubric ?? null,
      guide_source: m?.rubric ? "recruiter" : null,
      weight: m?.weight ?? null,
    });
  }
  return { ok: true, questions: out };
}

function defaultDeps(): PrepareDeps {
  return {
    service: createServiceClient(),
    client: getAnthropic() as unknown as LiveQuestionsClient,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  };
}

export async function prepareLiveQuestions(
  sessionId: string,
  deps: PrepareDeps = defaultDeps(),
): Promise<PrepareOutcome> {
  const row = await readSession(deps.service, sessionId);
  if (!row) throw new PrepareLiveQuestionsError("session_not_found", sessionId);
  if (row.kind !== "live") throw new PrepareLiveQuestionsError("not_live", sessionId);

  const existing = frozenOf(row);
  if (existing) return { set: existing, generated: false };
  if (row.status !== "invited" || row.started_at !== null) {
    throw new PrepareLiveQuestionsError("already_started", sessionId);
  }
  const mix = readLiveSettings(row.live_settings, row.id)?.question_mix;
  if (!mix) throw new PrepareLiveQuestionsError("no_question_mix", sessionId);
  // A session invited under the table's split keeps that meaning: it is
  // refused, never frozen as if it were all-job.
  if (mix.policy_version !== QUESTION_MIX_POLICY_VERSION) {
    throw new PrepareLiveQuestionsError("question_mix_superseded", sessionId);
  }

  // Every job question, as the invite froze them. Refused, never cut or padded.
  const invite = jobQuestionsFromInvite(row);
  if (!invite.ok) throw new PrepareLiveQuestionsError(invite.code, sessionId);
  const jobQuestions = invite.questions;
  if (jobQuestions.length < MIN_JOB_QUESTIONS) {
    throw new PrepareLiveQuestionsError("too_few_job_questions", sessionId);
  }
  if (jobQuestions.length > MAX_JOB_QUESTIONS) {
    throw new PrepareLiveQuestionsError("too_many_job_questions", sessionId);
  }
  if (jobQuestions.length !== mix.job_questions) {
    throw new PrepareLiveQuestionsError("job_question_count_mismatch", sessionId);
  }

  const { data: job, error: jobErr } = await deps.service
    .from("jobs")
    .select("title, description, responsibilities, requirements")
    .eq("id", row.job_id)
    .eq("company_id", row.company_id)
    .maybeSingle();
  if (jobErr) throw new PrepareLiveQuestionsError("db_error", sessionId);
  if (!job) throw new PrepareLiveQuestionsError("job_not_found", sessionId);

  // A job question with no rubric is marked against the job's own guide.
  const guided: FrozenLiveQuestion[] = [];
  for (const q of jobQuestions) {
    if (q.scoring_guide) {
      guided.push(q);
      continue;
    }
    try {
      const g = await ensureJobQuestionGuide(
        deps.service,
        {
          jobId: row.job_id,
          companyId: row.company_id,
          jobTitle: (job as { title: string | null }).title,
          question: q.text,
          competency: q.competency,
        },
        { client: deps.client },
      );
      guided.push({ ...q, scoring_guide: g.guide, guide_source: g.source });
    } catch {
      throw new PrepareLiveQuestionsError("guide_failed", sessionId);
    }
  }

  // CV slots: ON HOLD (23 Nov). mix.cv_questions is CV_QUESTIONS_PER_INTERVIEW
  // (question-mix.ts), 0, so this block never runs: no CV read, no question
  // writer. Kept, unchanged, for when CV questions come back.
  let written: Awaited<ReturnType<typeof writeLiveQuestions>> | null = null;
  if (mix.cv_questions > 0) {
    const { data: app, error: appErr } = await deps.service
      .from("job_applications")
      .select("first_name, last_name, cv_text")
      .eq("id", row.application_id)
      .eq("job_id", row.job_id)
      .eq("company_id_snapshot", row.company_id)
      .maybeSingle();
    if (appErr) throw new PrepareLiveQuestionsError("db_error", sessionId);
    if (!app) throw new PrepareLiveQuestionsError("application_not_found", sessionId);
    const a = app as {
      first_name: string | null;
      last_name: string | null;
      cv_text: string | null;
    };
    const name = { firstName: a.first_name, lastName: a.last_name };

    // Contact details first, then the name: nothing that identifies the
    // candidate reaches the question writer.
    const cvText = removeCandidateName(sanitizeCvForInterview(a.cv_text).text, name).text;
    written = await writeLiveQuestions(
      {
        job: job as Parameters<typeof writeLiveQuestions>[0]["job"],
        jobQuestions: jobQuestions.map((q) => q.text),
        cvText,
        cvSlots: mix.cv_questions,
        name,
      },
      { client: deps.client },
    );
  }

  const questions: FrozenLiveQuestion[] = [
    ...guided,
    ...(written?.questions ?? []).map((q) => ({
      question_id: deps.newId(),
      position: mix.job_questions + q.slot,
      text: q.text,
      source: q.source,
      competency: q.competency,
      scoring_guide: q.scoring_guide,
      guide_source: "ai" as const,
      weight: null,
    })),
  ];
  // With no CV slots the question writer is never called: its prompt and
  // model are recorded as "none", its counts as 0.
  const marker: QuestionsFrozenMarker = {
    at: new Date(deps.now()).toISOString(),
    prompt_version: written ? LIVE_QUESTIONS_PROMPT_VERSION : NO_WRITER,
    policy_version: mix.policy_version,
    model: written?.model ?? NO_WRITER,
    calls: written?.calls ?? 0,
    input_tokens: written?.input_tokens ?? 0,
    output_tokens: written?.output_tokens ?? 0,
    rewritten: written?.rewritten ?? 0,
    replaced: written?.replaced ?? 0,
  };
  const snapshots = snapshotsFor(questions);
  const liveSettings = {
    ...(row.live_settings as Record<string, unknown>),
    [QUESTIONS_FROZEN_KEY]: marker,
  };

  // THE freeze: one conditional update. It lands only on a live session that
  // is still invited, not started and not frozen.
  const freeze = deps.service
    .from("interview_sessions")
    .update({ ...snapshots, live_settings: liveSettings })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq("kind", "live")
    .eq("status", "invited")
    .is("started_at", null)
    .is(`live_settings->${QUESTIONS_FROZEN_KEY}`, null);
  const { data: landed, error: updErr } = await (deps.claim
    ? freeze.eq(`live_settings->>${deps.claim.key}`, deps.claim.value)
    : freeze
  ).select(SESSION_COLUMNS);
  if (updErr) throw new PrepareLiveQuestionsError("db_error", sessionId);

  const mine = ((landed ?? []) as SessionRow[])[0];
  if (mine) {
    const set = frozenOf(mine);
    if (!set) throw new PrepareLiveQuestionsError("frozen_unreadable", sessionId);
    console.log(
      `[live-questions] session ${row.id}: frozen ${set.questions.length} questions, calls ${marker.calls}, tokens ${marker.input_tokens}/${marker.output_tokens}, rewritten ${marker.rewritten}, replaced ${marker.replaced}`,
    );
    return { set, generated: true };
  }

  // Another caller froze first, or the session moved on: the stored set wins.
  const now = await readSession(deps.service, sessionId);
  const theirs = now ? frozenOf(now) : null;
  if (theirs) return { set: theirs, generated: false };
  throw new PrepareLiveQuestionsError("freeze_lost", sessionId);
}
