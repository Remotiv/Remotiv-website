import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { hashSessionToken } from "./tokens";
import {
  type CandidateQuestion,
  type CandidateSession,
  shortLabelFor,
} from "./types";

/**
 * Resolve a raw token to everything the candidate page may see.
 *
 * ── Treat the page as hostile input ──────────────────────────
 *
 * The token is the only credential. Everything here is therefore derived
 * server-side from the SESSION, never from anything the client sends: the
 * job, the questions, the company, the expiry and which answers already exist.
 * A client that posts a different job_id or question_id gets nothing.
 *
 * ── What never crosses the wire ──────────────────────────────
 *
 * `video_path` is deliberately absent from every shape this returns. A path is
 * a key into a private bucket; handing one to the candidate page turns a
 * bearer token for one interview into a probe against every object in it.
 * Playback for the candidate's own review goes through a signed URL minted by
 * a route that re-resolves the session — see the review route.
 *
 * Rubric, competency and weight are also withheld — they are the marking
 * scheme, and showing it to the person being marked defeats the exercise.
 */

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  status: string;
  allow_rerecord: boolean | null;
  /**
   * When the candidate acknowledged the pre-recording screen — NOT a consent
   * record in the legal sense. The lawful basis for recording is legitimate
   * interests (see /privacy section 4); this column evidences that they were
   * told what is recorded, who sees it and how long it is kept, before
   * anything started. The name predates that decision; don't read the basis
   * off it.
   */
  consent_at: string | null;
  submitted_at: string | null;
  expires_at: string;
  questions_snapshot: SnapshotQuestion[] | null;
};

/**
 * The question set as it stood WHEN THE INVITE WAS SENT.
 *
 * ── Why this is frozen ───────────────────────────────────────
 *
 * syncInterviewQuestions deletes every row for a job and re-inserts with
 * position = i+1 on each save. Answers are keyed (session_id, position),
 * `answered` is matched by position, and the storage key is
 * {sessionId}/q{position}.{ext} — so a recruiter editing a job while someone
 * was mid-interview shifted that candidate's recorded answers onto different
 * questions, ticked the wrong ones on the review screen, and could make a
 * re-record overwrite a DIFFERENT answer's video object.
 *
 * Freezing the set at send time makes an in-flight interview immutable: a
 * later job edit affects future invites only. Same pattern as
 * job_applications.screening_answers.
 *
 * ── What is deliberately NOT here ────────────────────────────
 *
 * rubric, competency and weight. That is the MARKING SCHEME, and this column
 * is read to build the candidate payload — including it would hand the person
 * being marked the mark scheme, undoing the withholding resolveSessionByToken
 * is careful about everywhere else. Do not "complete" this shape.
 */
type SnapshotQuestion = {
  id: string;
  position: number;
  question: string | null;
  prep_seconds: number | null;
  answer_seconds: number | null;
  required: boolean | null;
};

export type ResolvedSession = {
  row: SessionRow;
  session: CandidateSession;
};

/**
 * Look a token up and decide which state the page renders.
 *
 * Expiry is evaluated HERE rather than trusted from the stored status: a
 * session invited five days ago is expired whether or not anything has run to
 * mark it so, and a candidate must not get a working recorder past the
 * deadline because a cron did not fire.
 */
export async function resolveSessionByToken(
  rawToken: string,
): Promise<ResolvedSession | null> {
  if (!rawToken || rawToken.length < 20 || rawToken.length > 200) return null;

  const service = createServiceClient();
  const { data } = await service
    .from("interview_sessions")
    .select(
      "id, company_id, application_id, job_id, status, allow_rerecord, consent_at, submitted_at, expires_at, questions_snapshot",
    )
    .eq("token_hash", hashSessionToken(rawToken))
    .maybeSingle();

  const row = data as SessionRow | null;
  if (!row) return null;

  const [{ data: companyRow }, { data: jobRow }] = await Promise.all([
    service.from("companies").select("name").eq("id", row.company_id).maybeSingle(),
    row.job_id
      ? service
          .from("jobs")
          .select("title, allow_rerecord")
          .eq("id", row.job_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const companyName =
    ((companyRow as { name: string | null } | null)?.name ?? "").trim() ||
    "the company";
  const job = jobRow as { title: string | null; allow_rerecord: boolean | null } | null;

  const expired = new Date(row.expires_at).getTime() < Date.now();
  const state: CandidateSession["state"] =
    row.status === "cancelled"
      ? "cancelled"
      : row.status === "submitted"
        ? "submitted"
        : expired || row.status === "expired"
          ? "expired"
          : "ready";

  const questions = await loadCandidateQuestions(service, row);

  const totalSeconds = questions.reduce((sum, q) => sum + q.answerSeconds, 0);

  return {
    row,
    session: {
      state,
      companyName,
      companyInitial: companyName.trim()[0]?.toUpperCase() ?? "?",
      jobTitle: (job?.title ?? "").trim() || "this role",
      expiresAt: row.expires_at,
      submittedAt: row.submitted_at,
      // The session's own flag wins; the job's is the fallback for a session
      // created before the column carried a value.
      allowRerecord: row.allow_rerecord ?? job?.allow_rerecord ?? true,
      consentGiven: row.consent_at !== null,
      questions,
      // Answer time plus a minute per question for reading and prep, rounded
      // up — the Welcome screen's "About N minutes" should not undersell it.
      estimatedMinutes: Math.max(
        1,
        Math.ceil(totalSeconds / 60) + questions.length,
      ),
    },
  };
}

/**
 * The job's questions, joined to whatever this session has already answered.
 *
 * `answered` is what resume is built on — there is no separate progress
 * column. The candidate page opens at the first unanswered required question,
 * so returning to the link after a dropped connection continues rather than
 * restarting, and the same field drives the review list's state chips.
 */
async function loadCandidateQuestions(
  service: ReturnType<typeof createServiceClient>,
  row: SessionRow,
): Promise<CandidateQuestion[]> {
  /*
   * The snapshot wins whenever it exists.
   *
   * The live table is the FALLBACK, for sessions invited before the column
   * existed — those rows are null and must keep working exactly as before,
   * so this is a null check rather than a migration. A session invited from
   * now on never reads interview_questions again, which is what makes a job
   * edit mid-interview invisible to an already-invited candidate.
   *
   * An empty array is a real answer and is NOT the same as null: a job whose
   * questions were all removed after the invite should still show the
   * candidate the set they were invited to, not fall through to the live
   * table and find nothing.
   */
  const snapshot = Array.isArray(row.questions_snapshot)
    ? row.questions_snapshot
    : null;

  if (!snapshot && !row.job_id) return [];

  const qData =
    snapshot ??
    (
      await service
        .from("interview_questions")
        .select("id, position, question, prep_seconds, answer_seconds, required")
        .eq("job_id", row.job_id ?? "")
        .eq("company_id", row.company_id)
        .order("position", { ascending: true })
        .limit(50)
    ).data;

  const { data: aData } = await service
    .from("interview_answers")
    .select("position, duration_seconds")
    .eq("session_id", row.id)
    .limit(50);

  const answered = new Map<number, number | null>();
  for (const a of (aData ?? []) as {
    position: number;
    duration_seconds: number | null;
  }[]) {
    answered.set(a.position, a.duration_seconds);
  }

  return ((qData ?? []) as SnapshotQuestion[])
    // The live-table read is ordered by the query; a snapshot is ordered by
    // however it was written, so both are sorted here rather than trusting
    // either source.
    .sort((a, c) => a.position - c.position)
    .map((q) => {
    const text = (q.question ?? "").trim();
    return {
      id: q.id,
      position: q.position,
      question: text,
      shortLabel: shortLabelFor(text),
      prepSeconds: q.prep_seconds ?? 30,
      answerSeconds: q.answer_seconds ?? 120,
      required: q.required !== false,
      answered: answered.has(q.position),
      recordedSeconds: answered.get(q.position) ?? null,
    };
  });
}

/** The bucket every interview recording lives in. PRIVATE — never public. */
export const INTERVIEW_BUCKET = "interview-videos";

/** Accepted upload types, matched against sniffed bytes, not the claimed type. */
export const INTERVIEW_MIME_TYPES = ["video/webm", "video/mp4"] as const;

/** 100MB, matching the bucket's own ceiling. */
export const INTERVIEW_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Storage key for one answer.
 *
 * Session-scoped and position-scoped, so a re-record overwrites rather than
 * accumulating orphans, and nothing about the path is guessable from the
 * candidate's side — they never see it either way.
 */
export function answerPath(sessionId: string, position: number, ext: string): string {
  return `${sessionId}/q${position}.${ext}`;
}
