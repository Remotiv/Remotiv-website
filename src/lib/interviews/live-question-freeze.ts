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
import { readLiveSettings } from "@/lib/interviews/types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Write and freeze an AI Video Interview's questions, once, before it starts.
 *
 * ── Job questions: the job's own, word for word ──────────────
 *
 * The first job-slot-many questions (4 for 30 minutes) are the job's authored
 * interview questions, taken in the job's order from the snapshot the live
 * invite froze, with their own competency, rubric and weight. They are never
 * rewritten, so every candidate invited under the same questions hears the
 * same text in the same order. A job with fewer authored questions than job
 * slots is refused before any model call: the model never fills a job slot.
 *
 * Every question is frozen with a private scoring guide. A job question the
 * recruiter gave no rubric gets the JOB's guide (live-guides.ts): written once
 * for the job and wording, shared by every candidate, frozen here with
 * guide_source 'ai'. A recruiter's rubric is frozen with guide_source
 * 'recruiter'.
 *
 * ── CV slots: written per candidate ──────────────────────────
 *
 * live-questions.ts writes only the CV slots, from the CV with contact details
 * and the name removed, seeing the job questions only to avoid overlap.
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
 * ── Not wired yet ────────────────────────────────────────────
 *
 * Live links stay locked (session.ts resolves a live session as not open).
 * The candidate-screen commit calls this before creating the provider session.
 * The live invite freezes the job's questions (applicants/interview-actions.ts);
 * this keeps the first job-slot-many of them and adds the CV slots.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * The CV, the name, the job text and the questions. One line per outcome with
 * the session id, call count and token totals.
 */

type Service = ReturnType<typeof createServiceClient>;

export type PrepareDeps = {
  service: Service;
  client: LiveQuestionsClient;
  now: () => number;
  newId: () => string;
};

export type PrepareErrorCode =
  | "session_not_found"
  | "not_live"
  | "already_started"
  | "no_question_mix"
  | "frozen_unreadable"
  | "not_enough_job_questions"
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

/**
 * The first `count` questions the live invite froze, in the job's order,
 * renumbered 1..count, with the marking fields frozen beside them. Null when
 * the invite froze fewer, or one has no text.
 */
function jobQuestionsFromInvite(row: SessionRow, count: number): FrozenLiveQuestion[] | null {
  if (!Array.isArray(row.questions_snapshot)) return null;
  const asked = (row.questions_snapshot as Record<string, unknown>[])
    .filter((q) => q && typeof q.position === "number")
    .sort((a, b) => (a.position as number) - (b.position as number))
    .slice(0, count);
  if (asked.length < count) return null;
  const marking = readScoringSnapshot(row.scoring_snapshot);
  const out: FrozenLiveQuestion[] = [];
  for (const [i, q] of asked.entries()) {
    const text = typeof q.question === "string" ? q.question.trim() : "";
    const id = typeof q.id === "string" ? q.id : "";
    if (!text || !id) return null;
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
  return out;
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

  // The job slots: the job's own questions as the invite froze them.
  const jobQuestions = jobQuestionsFromInvite(row, mix.job_questions);
  if (!jobQuestions) throw new PrepareLiveQuestionsError("not_enough_job_questions", sessionId);

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

  const { data: app, error: appErr } = await deps.service
    .from("job_applications")
    .select("first_name, last_name, cv_text")
    .eq("id", row.application_id)
    .eq("job_id", row.job_id)
    .eq("company_id_snapshot", row.company_id)
    .maybeSingle();
  if (appErr) throw new PrepareLiveQuestionsError("db_error", sessionId);
  if (!app) throw new PrepareLiveQuestionsError("application_not_found", sessionId);
  const a = app as { first_name: string | null; last_name: string | null; cv_text: string | null };
  const name = { firstName: a.first_name, lastName: a.last_name };

  // Contact details first, then the name: nothing that identifies the
  // candidate reaches the question writer.
  const cvText = removeCandidateName(sanitizeCvForInterview(a.cv_text).text, name).text;
  const written = await writeLiveQuestions(
    {
      job: job as Parameters<typeof writeLiveQuestions>[0]["job"],
      jobQuestions: jobQuestions.map((q) => q.text),
      cvText,
      cvSlots: mix.cv_questions,
      name,
    },
    { client: deps.client },
  );

  const questions: FrozenLiveQuestion[] = [
    ...guided,
    ...written.questions.map((q) => ({
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
  const marker: QuestionsFrozenMarker = {
    at: new Date(deps.now()).toISOString(),
    prompt_version: LIVE_QUESTIONS_PROMPT_VERSION,
    policy_version: mix.policy_version,
    model: written.model,
    calls: written.calls,
    input_tokens: written.input_tokens,
    output_tokens: written.output_tokens,
    rewritten: written.rewritten,
    replaced: written.replaced,
  };
  const snapshots = snapshotsFor(questions);
  const liveSettings = {
    ...(row.live_settings as Record<string, unknown>),
    [QUESTIONS_FROZEN_KEY]: marker,
  };

  // THE freeze: one conditional update. It lands only on a live session that
  // is still invited, not started and not frozen.
  const { data: landed, error: updErr } = await deps.service
    .from("interview_sessions")
    .update({ ...snapshots, live_settings: liveSettings })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq("kind", "live")
    .eq("status", "invited")
    .is("started_at", null)
    .is(`live_settings->${QUESTIONS_FROZEN_KEY}`, null)
    .select(SESSION_COLUMNS);
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
