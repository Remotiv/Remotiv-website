import "server-only";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import {
  getJobScope,
  isEmptyScope,
  type JobScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { readFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
import type {
  EndCheck,
  EndCheckReason,
  LiveOutcome,
  RepeatCheck,
} from "@/lib/interviews/live-ingest";
import {
  LiveRecoveryError,
  type RecoveryDeps,
  resolveFailedTranscription,
  resolveNeedsCheck,
  resolveRepeatCheck,
  resolveStyleCheck,
  retryTranscription,
} from "@/lib/interviews/live-recovery";
import {
  excludedFailedTurns,
  type LiveActionRow,
  needsCheckDecisions,
  repeatCheckDecisions,
  styleCheckDecisions,
} from "@/lib/interviews/live-resolutions";
import type {
  LiveActionResult,
  LiveAudioResult,
  LiveQuestionStatus,
  LiveRecoveryRequest,
  LiveReviewFlag,
  LiveReviewHeader,
  LiveReviewQuestion,
  LiveReviewTurn,
  LiveReviewView,
} from "@/lib/interviews/live-review-types";
import {
  countingLiveScore,
  type LiveScoreRow,
  type StoredQuestionScore,
} from "@/lib/interviews/live-scoring";
import { hasRealWords } from "@/lib/interviews/live-transcribe";
import { type VideoPieceRow, videoTimeline } from "@/lib/interviews/live-video-timeline";
import { findQuoteStart } from "@/lib/interviews/quote-timestamps";
import { resolveCandidate } from "@/lib/interviews/review-candidate";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import type { TranscriptSegment } from "@/lib/interviews/transcribe";
import { isSafeFailureSentence } from "@/lib/queue/failure-class";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The recruiter review of an AI Video Interview: what the page is sent, the
 * turn audio it plays, and the recovery actions it offers.
 *
 * ── Company first, then the hiring team ──────────────────────
 *
 * Every read is scoped to the viewer's company and then to their hiring-team
 * jobs, exactly as the async review (review.ts) is; outside either, the
 * session does not exist to them.
 *
 * ── The attempt that counts ──────────────────────────────────
 *
 * Scores are read through countingLiveScore: the latest attempt's row, never
 * an earlier one's. An earlier attempt can still be opened, for audit only,
 * with its own row, marked as not the candidate's result and with no actions.
 *
 * ── What the page is never sent ──────────────────────────────
 *
 * Scoring guides (scoring_snapshot's rubric), follow-up reasons, storage
 * paths, transcript segments (used here to place quotes, then dropped), raw
 * errors, and anything from the CV. The view types have no field for them.
 *
 * ── Who acts ─────────────────────────────────────────────────
 *
 * Owner and admin (canActOnLiveReview). Recruiters and hiring managers see
 * everything else and no action; runLiveRecovery refuses them, and the
 * recovery functions (live-recovery.ts) refuse them again.
 */

type Service = ReturnType<typeof createServiceClient>;

export type LiveReviewDeps = {
  service: Service;
  /** The viewer's hiring-team scope. Defaults to getJobScope. */
  scope?: (ctx: CompanyContext) => Promise<JobScope>;
};

const defaultDeps = (): LiveReviewDeps => ({ service: createServiceClient() });

/** Five minutes, as for async answers (interviews/actions.ts). */
const PLAYBACK_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;

/** Owner and admin act on a live interview; everyone else views. */
export function canActOnLiveReview(role: string): boolean {
  return role === "owner" || role === "admin";
}

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  kind: string | null;
  attempt: number | null;
  previous_attempt_id: string | null;
  live_outcome: LiveOutcome | null;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
};

const SESSION_COLUMNS =
  "id, company_id, application_id, job_id, kind, attempt, previous_attempt_id, live_outcome, live_settings, questions_snapshot, scoring_snapshot";

/** The live session, if this viewer may see it: their company, their hiring team. */
async function gateLiveSession(
  ctx: CompanyContext,
  sessionId: string,
  deps: LiveReviewDeps,
): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const { data } = await deps.service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const row = data as SessionRow | null;
  if (row?.kind !== "live") return null;
  const scope = await (deps.scope ?? getJobScope)(ctx);
  if (isEmptyScope(scope)) return null;
  const allowed = scopeJobIds(scope);
  if (allowed && (!row.job_id || !allowed.includes(row.job_id))) return null;
  return row;
}

/* ── the view, pure ───────────────────────────────────────────── */

export type ReviewTurnRow = {
  id: string;
  sequence: number;
  speaker: string;
  kind: string | null;
  question_position: number | null;
  responds_to_turn_id: string | null;
  text: string | null;
  transcript: string | null;
  transcript_status: string | null;
  transcript_segments: unknown;
  transcript_error: string | null;
  media_path: string | null;
  content_purged_at: string | null;
  /** Where the turn starts on the conversation clock (the camera video shares it). */
  offset_ms?: number | null;
};

const SOURCE_LABEL: Record<string, string> = {
  job: "Job question",
  cv: "CV question",
  general_experience: "General question",
};

const KIND_LABEL: Record<string, string> = {
  base_question: "",
  follow_up: " · follow-up",
  clarification: " · clarification",
  // An acknowledgement, a repeat of the question or a reminder: the interviewer, no tag.
  procedural: "",
};

const EXCLUDED_REASON: Record<string, string> = {
  excluded_by_reviewer: "Left out after a timing review.",
  transcription_excluded: "Left out: the answer could not be transcribed.",
  style_excluded: "Left out after a review of the AI's explanation.",
  repeat_excluded: "Left out after a review of how the question was repeated.",
  scoring_failed: "Left out: the AI could not score it reliably.",
};

const WAITING_REASON: Record<string, string> = {
  needs_check: "Waiting for a timing check.",
  style_check: "Waiting for a check of the AI's explanation.",
  repeat_check: "Waiting for a check of how the question was repeated.",
  not_final: "Waiting for every answer to be transcribed.",
  unconfirmed: "Waiting for the transcript.",
  scoring_retry: "Scoring will be tried again.",
  no_guide: "Waiting: this question has no scoring guide.",
};

const TIMING_REASON =
  "The answer overlapped the interviewer's speech, so its timing needs a check against the audio before it is scored.";
const STYLE_REASON =
  "The AI's explanation described how the candidate spoke. That part was removed; a person should confirm the score before it counts.";
const FAILED_REASON = "This answer could not be transcribed.";

/** Why a repeat holds its question (live-ingest.ts RepeatCheck), with the interviewer's name. */
const REPEAT_REASON: Record<RepeatCheck, (interviewer: string, position: number) => string> = {
  unexpected_lead_in: (who, n) =>
    `${who} used an unexpected phrase before repeating question ${n}. Check the recording.`,
  altered_wording: (who, n) =>
    `${who} changed the wording when repeating question ${n}, so the answer may have been influenced. It is not scored until a person checks the recording.`,
};

export function repeatReason(check: RepeatCheck, interviewer: string, position: number): string {
  return REPEAT_REASON[check](interviewer, position);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why the ending needs a person (live-ingest.ts EndCheck), said to the recruiter. */
const END_REASON: Record<EndCheckReason, (neverAsked: number) => string> = {
  closed_early: (n) => `Sarah closed the interview before asking ${plural(n, "question")}.`,
  exit_unconfirmed: () =>
    "The provider says the candidate ended the interview, but that isn't confirmed yet. Check the recording before relying on it.",
  left_after_last_answer: () =>
    "The candidate answered every question but left before Sarah closed. Check the recording before relying on it.",
  ending_unknown: () =>
    "How this interview ended couldn't be confirmed. Check the recording before relying on it.",
  provider_error_saved: () =>
    "The provider reported an error, but every answer was saved. Check the recording, then decide whether to offer a restart.",
};

/** The waits only a person's decision ends. */
const REVIEW_WAITS: ReadonlySet<string> = new Set(["needs_check", "repeat_check", "style_check"]);

const RESTART_NOTE = "A restart is your decision for this interview.";

const PARTIAL_NOTE = "Partial interview: not comparable with completed interviews.";
const UNCONFIRMED_NOTE =
  "Not comparable with completed interviews: how it ended needs a check first.";
const HELD_NOTE =
  "Held from ranking: Sarah closed before asking every question, so it is not compared with fully completed interviews.";

export function endReason(check: EndCheck): string {
  return END_REASON[check.reason](check.never_asked);
}

const STATUS_LABEL: Record<LiveQuestionStatus, string> = {
  answered: "Answered",
  skipped: "Skipped",
  not_reached: "Not reached",
  excluded: "Excluded",
  waiting_review: "Waiting for review",
  waiting: "Waiting",
};

function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreNoteFor(overall: number | null, row: LiveScoreRow | null): string | null {
  if (overall !== null) return null;
  if (!row) return "Not scored yet.";
  if (row.status === "incomplete")
    return "No overall score: nothing in this interview could be scored.";
  return "Scores appear once every question waiting for review is resolved.";
}

function headerFor(outcome: LiveOutcome | null, row: LiveScoreRow | null): LiveReviewHeader {
  const answered = outcome?.answered_count ?? 0;
  const total = outcome?.total ?? 0;
  const base = {
    answered,
    total,
    skipped: outcome?.skipped_count ?? 0,
    completionPercent: outcome?.completion_percent ?? 0,
    scoreStatus: row?.status ?? ("not_scored" as const),
    reviewReasons: [] as string[],
    restartNote: null,
  };
  // The overall, only from a row the scorer marked scored.
  const overall = row?.status === "scored" ? row.overall_score : null;
  if (!outcome?.final) {
    return {
      ...base,
      state: "in_progress",
      label: outcome ? "In progress - transcribing answers" : "In progress",
      overall: null,
      partial: false,
      partialNote: null,
      scoreNote: "Scores appear once every answer is transcribed.",
    };
  }
  // Before "incomplete": an unconfirmed ending is never read as an early end.
  if (outcome.outcome === "ending_unconfirmed") {
    return {
      ...base,
      state: "ending_unconfirmed",
      label: "Ending not confirmed - needs review",
      overall,
      partial: true,
      partialNote: UNCONFIRMED_NOTE,
      restartNote: RESTART_NOTE,
      scoreNote: scoreNoteFor(overall, row),
    };
  }
  const incomplete =
    row?.status === "incomplete" ||
    outcome.outcome === "abandoned" ||
    outcome.outcome === "technical_failure";
  if (incomplete) {
    return {
      ...base,
      state: "incomplete",
      label: `Incomplete - ${answered} of ${total} answered`,
      overall: null,
      partial: true,
      partialNote: PARTIAL_NOTE,
      scoreNote:
        outcome.outcome === "abandoned" || outcome.outcome === "technical_failure"
          ? "No overall score: the interview ended early."
          : "No overall score: nothing in this interview could be scored.",
    };
  }
  const partial = outcome.outcome === "partial";
  const held = !partial && outcome.held_from_ranking === true;
  return {
    ...base,
    state: partial ? "partial" : "completed",
    label: partial ? "Partial" : "Completed",
    overall,
    partial: partial || held,
    partialNote: completedNote(partial, held),
    scoreNote: scoreNoteFor(overall, row),
  };
}

function completedNote(partial: boolean, held: boolean): string | null {
  if (partial) return PARTIAL_NOTE;
  return held ? HELD_NOTE : null;
}

/**
 * The Needs review list: the ending's reason once the outcome is decided, then
 * every question flag nobody has resolved yet. A repeat flag's reason already
 * names its question, so it is listed as written.
 */
function reviewReasonsFor(
  outcome: LiveOutcome | null,
  questions: readonly LiveReviewQuestion[],
): string[] {
  const reasons: string[] = [];
  if (outcome?.final && outcome.end_check) reasons.push(endReason(outcome.end_check));
  for (const q of questions) {
    for (const f of q.flags)
      if (f.resolved === null)
        reasons.push(f.kind === "repeat" ? f.reason : `Question ${q.position}: ${f.reason}`);
  }
  return reasons;
}

/** The page's view of one session. Pure: everything it needs is passed in. */
export function buildLiveReviewView(input: {
  session: Pick<
    SessionRow,
    "id" | "live_outcome" | "live_settings" | "questions_snapshot" | "scoring_snapshot"
  >;
  frozenQuestions: readonly { position: number; source: string; text: string }[];
  turns: readonly ReviewTurnRow[];
  /** The session's camera-video pieces (migration 044). None when no video was recorded. */
  videoPieces?: readonly VideoPieceRow[];
  actions: readonly LiveActionRow[];
  row: LiveScoreRow | null;
  attempt: LiveReviewView["attempt"];
}): LiveReviewView {
  const outcome = input.session.live_outcome;
  const settings = input.session.live_settings as { interviewer_name?: unknown } | null;
  const interviewer =
    typeof settings?.interviewer_name === "string" && settings.interviewer_name.trim()
      ? settings.interviewer_name.trim()
      : "Interviewer";
  const byId = new Map(input.turns.map((t) => [t.id, t]));
  const positionOf = (t: ReviewTurnRow) =>
    t.question_position ??
    (t.responds_to_turn_id ? (byId.get(t.responds_to_turn_id)?.question_position ?? null) : null);
  const timing = needsCheckDecisions(input.actions);
  const repeat = repeatCheckDecisions(input.actions);
  const style = styleCheckDecisions(input.actions);
  const excludedSeqs = excludedFailedTurns(
    input.actions,
    input.turns.filter((t) => t.speaker === "candidate"),
  );
  const lastTurnAction = new Map<string, string>();
  for (const a of [...input.actions].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    if (a.turn_id) lastTurnAction.set(a.turn_id, a.decision);
  }
  const entries = new Map<number, StoredQuestionScore>(
    (input.row?.questions ?? []).map((q) => [q.position, q]),
  );

  const questions: LiveReviewQuestion[] = input.frozenQuestions.map((fq) => {
    const facts = outcome?.questions.find((q) => q.position === fq.position);
    const entry = entries.get(fq.position);
    const mine = input.turns
      .filter((t) => positionOf(t) === fq.position)
      .sort((a, b) => a.sequence - b.sequence);

    const conversation: LiveReviewTurn[] = mine.map((t) => {
      const hasAudio = Boolean(t.media_path);
      if (t.speaker === "interviewer") {
        return {
          id: t.id,
          sequence: t.sequence,
          speaker: "interviewer",
          label: `${interviewer}${KIND_LABEL[t.kind ?? ""] ?? ""}`,
          text: t.text,
          state: t.text === null && t.content_purged_at ? "purged" : "text",
          hasAudio,
        };
      }
      const segments = Array.isArray(t.transcript_segments)
        ? (t.transcript_segments as TranscriptSegment[])
        : null;
      const state =
        t.content_purged_at !== null
          ? "purged"
          : t.transcript_status === "failed"
            ? "failed"
            : t.transcript_status !== "done"
              ? "pending"
              : hasRealWords(t.transcript, segments)
                ? "text"
                : "no_words";
      return {
        id: t.id,
        sequence: t.sequence,
        speaker: "candidate",
        label: "Candidate",
        text: state === "text" ? t.transcript : null,
        state,
        hasAudio,
      };
    });

    const flags: LiveReviewFlag[] = [];
    if (facts?.needs_check) {
      flags.push({
        kind: "timing",
        reason: TIMING_REASON,
        resolved: timing.get(fq.position) ?? null,
        turnId: null,
      });
    }
    const repeatCheck = facts?.repeat_check ?? null;
    if (repeatCheck !== null) {
      flags.push({
        kind: "repeat",
        reason: repeatReason(repeatCheck, interviewer, fq.position),
        resolved: repeat.get(fq.position) ?? null,
        turnId: null,
      });
    }
    if (entry?.style_check) {
      flags.push({
        kind: "style",
        reason: STYLE_REASON,
        resolved: style.get(fq.position) ?? null,
        turnId: null,
      });
    }
    for (const t of mine.filter(
      (x) => x.speaker === "candidate" && x.transcript_status === "failed",
    )) {
      flags.push({
        kind: "transcription_failed",
        reason: isSafeFailureSentence(t.transcript_error)
          ? (t.transcript_error as string)
          : FAILED_REASON,
        resolved: excludedSeqs.has(t.sequence)
          ? "exclude"
          : lastTurnAction.get(t.id) === "retry"
            ? "retry"
            : null,
        turnId: t.id,
      });
    }

    let status: LiveQuestionStatus;
    let statusReason: string | null = null;
    if (entry) {
      if (entry.status === "scored") status = "answered";
      else if (entry.status === "lowest") status = "skipped";
      else if (entry.status === "left_out") {
        status = entry.reason === "not_reached" ? "not_reached" : "excluded";
        statusReason = EXCLUDED_REASON[entry.reason] ?? null;
      } else {
        status = REVIEW_WAITS.has(entry.reason) ? "waiting_review" : "waiting";
        statusReason = WAITING_REASON[entry.reason] ?? null;
      }
    } else if (!facts || facts.status === "not_reached") {
      status = "not_reached";
    } else if (facts.needs_check && !timing.has(fq.position)) {
      status = "waiting_review";
      statusReason = WAITING_REASON.needs_check;
    } else if (repeatCheck !== null && !repeat.has(fq.position)) {
      status = "waiting_review";
      statusReason = WAITING_REASON.repeat_check;
    } else {
      status = facts.status === "skipped" ? "skipped" : "answered";
    }

    // Only a counted score is shown: answered (AI) or skipped (the lowest).
    const counted = entry && (entry.status === "scored" || entry.status === "lowest");
    const candidateTurns = mine.filter((t) => t.speaker === "candidate" && t.transcript);
    const quotes =
      counted && entry.status === "scored"
        ? entry.quotes.map((quote) => {
            const needle = normaliseForMatch(quote);
            const turn = candidateTurns.find((t) =>
              ` ${normaliseForMatch(t.transcript ?? "")} `.includes(` ${needle} `),
            );
            const segments =
              turn && Array.isArray(turn.transcript_segments)
                ? (turn.transcript_segments as TranscriptSegment[])
                : null;
            const startSeconds = turn ? findQuoteStart(quote, segments) : null;
            return {
              text: quote,
              turnId: turn?.id ?? null,
              startSeconds,
              atMs:
                turn && typeof turn.offset_ms === "number"
                  ? turn.offset_ms + Math.round((startSeconds ?? 0) * 1000)
                  : null,
            };
          })
        : [];

    return {
      position: fq.position,
      source: fq.source as LiveReviewQuestion["source"],
      sourceLabel: SOURCE_LABEL[fq.source] ?? "Question",
      text: fq.text,
      followUps: facts?.follow_ups ?? 0,
      status,
      statusLabel: STATUS_LABEL[status],
      statusReason,
      score: counted ? entry.score : null,
      confidence:
        counted && entry.status === "scored"
          ? (entry.confidence as LiveReviewQuestion["confidence"])
          : null,
      rationale: counted && entry.status === "scored" ? entry.rationale : null,
      quotes,
      flags,
      conversation,
    };
  });

  const header = headerFor(outcome, input.row);
  return {
    sessionId: input.session.id,
    interviewerName: interviewer,
    attempt: input.attempt,
    header: { ...header, reviewReasons: reviewReasonsFor(outcome, questions) },
    questions,
    video: videoTimeline(input.videoPieces ?? []),
  };
}

/* ── loading ──────────────────────────────────────────────────── */

const TURN_COLUMNS =
  "id, sequence, speaker, kind, question_position, responds_to_turn_id, text, transcript, transcript_status, transcript_segments, transcript_error, media_path, content_purged_at, offset_ms";

/**
 * The review of one live session, or null when the viewer may not see it (not
 * their company, not their hiring team, not live): one 404 for all of them.
 */
export async function loadLiveReview(
  ctx: CompanyContext,
  sessionId: string,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<LiveReviewView | null> {
  const session = await gateLiveSession(ctx, sessionId, deps);
  if (!session) return null;
  return reviewFor(deps.service, session, ctx.companyId);
}

/**
 * The view of a session the caller is already allowed to see. Every read is
 * filtered by `companyId`, the session's own company.
 */
async function reviewFor(
  service: Service,
  session: SessionRow,
  companyId: string,
): Promise<LiveReviewView | null> {
  // Earlier attempts, walking back; the latest, walking forward.
  const earlier: string[] = [];
  let back = session.previous_attempt_id;
  for (let hop = 0; back && hop < MAX_ATTEMPTS; hop++) {
    earlier.unshift(back);
    const { data } = await service
      .from("interview_sessions")
      .select("id, previous_attempt_id")
      .eq("id", back)
      .eq("company_id", companyId)
      .maybeSingle();
    back = (data as { previous_attempt_id: string | null } | null)?.previous_attempt_id ?? null;
  }
  const counting = await countingLiveScore(service, companyId, session.id);
  if (!counting) return null;
  const isLatest = counting.session_id === session.id;

  // The latest attempt's row through countingLiveScore; an earlier attempt's
  // own row only when that earlier attempt is what was opened, for audit.
  let row: LiveScoreRow | null = isLatest ? counting.score : null;
  if (!isLatest) {
    const { data } = await service
      .from("live_interview_scores")
      .select("*")
      .eq("session_id", session.id)
      .eq("company_id", companyId)
      .maybeSingle();
    row = (data as LiveScoreRow | null) ?? null;
  }

  const [{ data: turnRows }, { data: actionRows }, { data: pieceRows }] = await Promise.all([
    service.from("interview_turns").select(TURN_COLUMNS).eq("session_id", session.id),
    service
      .from("live_interview_actions")
      .select("action, decision, question_position, turn_id, turn_sequence, created_at")
      .eq("session_id", session.id)
      .eq("company_id", companyId)
      .order("created_at", { ascending: true }),
    // media_path is read only to know a file exists (videoTimeline); none is returned.
    service
      .from("live_video_pieces")
      .select("piece_index, status, started_ms, duration_ms, is_last, media_path")
      .eq("session_id", session.id)
      .eq("company_id", companyId),
  ]);

  const frozen = readFrozenQuestionSet(session);
  // Text and source only: the guide stays on the server.
  const frozenQuestions = (frozen?.questions ?? []).map((q) => ({
    position: q.position,
    source: q.source,
    text: q.text,
  }));

  return buildLiveReviewView({
    session,
    frozenQuestions,
    turns: (turnRows ?? []) as ReviewTurnRow[],
    actions: (actionRows ?? []) as LiveActionRow[],
    videoPieces: (pieceRows ?? []) as VideoPieceRow[],
    row,
    attempt: {
      number: earlier.length + 1,
      of: earlier.length + 1 + counting.superseded.length,
      isLatest,
      latestSessionId: counting.session_id,
      earlierSessionIds: earlier,
    },
  });
}

/* ── audio ────────────────────────────────────────────────────── */

/**
 * The grant's signed_url_logs row, written BEFORE the link is signed: never an
 * unlogged link (F4). Null when it is written; otherwise the refusal to return.
 * signed_url_logs needs the candidate, so a session with no application gets
 * no link at all.
 */
async function logCompanyGrant(
  service: Service,
  ctx: CompanyContext,
  session: SessionRow,
  table: "interview_turns" | "live_video_pieces",
): Promise<LiveAudioResult | null> {
  if (!session.application_id) {
    return {
      ok: false,
      error: "This recording can't be opened: no applicant is linked to the interview.",
    };
  }
  const { error } = await service.from("signed_url_logs").insert({
    user_id: ctx.user.id,
    candidate_id: session.application_id,
    source_table: table,
    was_admin: false,
  });
  if (error) {
    console.error(
      `[live-review] session ${session.id}: ${table} grant not logged: ${error.message}`,
    );
    return { ok: false, error: "This recording couldn't be opened right now. Try again." };
  }
  return null;
}

/**
 * A signed URL for ONE turn's audio, Sarah's or the candidate's, after the
 * same gate as the page. The path is read server-side and never returned;
 * each grant is logged to signed_url_logs, as async playback is.
 */
export async function signLiveTurnAudio(
  ctx: CompanyContext,
  sessionId: string,
  turnId: string,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<LiveAudioResult> {
  const notYours: LiveAudioResult = { ok: false, error: "That interview isn't in your workspace." };
  if (!turnId) return { ok: false, error: "Bad request." };
  const session = await gateLiveSession(ctx, sessionId, deps);
  if (!session) return notYours;
  const { data } = await deps.service
    .from("interview_turns")
    .select("id, media_path, content_purged_at")
    .eq("id", turnId)
    .eq("session_id", session.id)
    .maybeSingle();
  const turn = data as { media_path: string | null; content_purged_at: string | null } | null;
  if (!turn) return notYours;
  if (!turn.media_path) {
    return {
      ok: false,
      error: turn.content_purged_at
        ? "This recording was deleted after six months."
        : "There is no audio for this turn.",
    };
  }
  const refused = await logCompanyGrant(deps.service, ctx, session, "interview_turns");
  if (refused) return refused;
  const { data: signed, error } = await deps.service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(turn.media_path, PLAYBACK_TTL_SECONDS);
  if (error || !signed?.signedUrl)
    return { ok: false, error: "Couldn't load that audio. Try again." };
  return { ok: true, url: signed.signedUrl };
}

/**
 * A signed URL for ONE confirmed piece of the candidate's camera video, after
 * the same gate as the page, for 5 minutes; logged to signed_url_logs. The
 * piece's path is read server-side and never returned. The video holds the
 * candidate's camera and microphone only: Sarah's voice plays from her turns.
 */
export async function signLiveVideoPiece(
  ctx: CompanyContext,
  sessionId: string,
  pieceIndex: number,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<LiveAudioResult> {
  const notYours: LiveAudioResult = { ok: false, error: "That interview isn't in your workspace." };
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0) return { ok: false, error: "Bad request." };
  const session = await gateLiveSession(ctx, sessionId, deps);
  if (!session) return notYours;
  const { data } = await deps.service
    .from("live_video_pieces")
    .select("status, media_path, content_purged_at")
    .eq("session_id", session.id)
    .eq("company_id", ctx.companyId)
    .eq("piece_index", pieceIndex)
    .maybeSingle();
  const piece = data as {
    status: string;
    media_path: string | null;
    content_purged_at: string | null;
  } | null;
  if (piece?.status !== "confirmed")
    return { ok: false, error: "That part of the video wasn't saved." };
  if (!piece.media_path) {
    return { ok: false, error: "This recording was deleted after six months." };
  }
  const refused = await logCompanyGrant(deps.service, ctx, session, "live_video_pieces");
  if (refused) return refused;
  const { data: signed, error } = await deps.service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(piece.media_path, PLAYBACK_TTL_SECONDS);
  if (error || !signed?.signedUrl)
    return { ok: false, error: "Couldn't load that video. Try again." };
  return { ok: true, url: signed.signedUrl };
}

/* ── Remotiv super admin: read-only, every access logged first (F4) ── */

/*
 * For a caller ALREADY checked as a Remotiv super admin (requireSuperAdmin, in
 * app/admin/interviews). Any company's live session, read-only: there is no
 * recovery here, and runLiveRecovery takes a company context only.
 *
 * Fail closed: the admin_access_logs row (migration 046) is written BEFORE
 * any candidate data is read for the page, and BEFORE a recording link is
 * signed. If it cannot be written, nothing is shown and nothing is signed.
 * The row carries ids only.
 */

export type AdminAccessAction = "view_live_review" | "open_turn_audio" | "open_video_piece";

const NOT_FOUND_PLATFORM: LiveAudioResult = {
  ok: false,
  error: "That interview couldn't be found.",
};
const NOT_LOGGED = "This couldn't be opened: the access log could not be written. Try again.";

/** A live session by id, in any company. Only for a caller already checked as super admin. */
async function platformLiveSession(
  service: Service,
  sessionId: string,
): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const { data } = await service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  const row = data as SessionRow | null;
  return row?.kind === "live" ? row : null;
}

/** Writes the audit row. False when it could not be written: the caller then shows and signs nothing. */
async function logAdminAccess(
  service: Service,
  adminUserId: string,
  action: AdminAccessAction,
  session: SessionRow,
): Promise<boolean> {
  const { error } = await service.from("admin_access_logs").insert({
    user_id: adminUserId,
    action,
    session_id: session.id,
    company_id: session.company_id,
    application_id: session.application_id,
  });
  if (error) {
    console.error(`[admin-access] session ${session.id}: ${action} not logged: ${error.message}`);
    return false;
  }
  return true;
}

/** signed_url_logs as for every other media grant, where it can hold the row (a candidate is required). */
function logAdminGrant(service: Service, adminUserId: string, session: SessionRow, table: string) {
  if (!session.application_id) return;
  service
    .from("signed_url_logs")
    .insert({
      user_id: adminUserId,
      candidate_id: session.application_id,
      source_table: table,
      was_admin: true,
    })
    .then(({ error: e }: { error: { message: string } | null }) => {
      if (e) console.error("[signed_url_logs insert]", e.message);
    });
}

export type PlatformLiveReview =
  | {
      ok: true;
      view: LiveReviewView;
      candidateName: string;
      jobTitle: string;
      companyName: string;
    }
  | { ok: false; reason: "not_found" | "not_logged"; message: string };

/**
 * The read-only review for a super admin, logged first. The candidate's name
 * is the one the company's own page shows (resolveCandidate), read through
 * the session's own company; it never goes into the log.
 */
export async function loadPlatformLiveReview(
  adminUserId: string,
  sessionId: string,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<PlatformLiveReview> {
  const notFound = { ok: false as const, reason: "not_found" as const, message: "Not found." };
  const session = await platformLiveSession(deps.service, sessionId);
  if (!session) return notFound;
  if (!(await logAdminAccess(deps.service, adminUserId, "view_live_review", session))) {
    return { ok: false, reason: "not_logged", message: NOT_LOGGED };
  }
  const view = await reviewFor(deps.service, session, session.company_id);
  if (!view) return notFound;
  const [{ data: app }, { data: job }, { data: company }] = await Promise.all([
    session.application_id
      ? deps.service
          .from("job_applications")
          .select("first_name, last_name, email")
          .eq("id", session.application_id)
          .eq("company_id_snapshot", session.company_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    session.job_id
      ? deps.service
          .from("jobs")
          .select("title")
          .eq("id", session.job_id)
          .eq("company_id", session.company_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    deps.service.from("companies").select("name").eq("id", session.company_id).maybeSingle(),
  ]);
  return {
    ok: true,
    view,
    candidateName: resolveCandidate(
      session.application_id,
      (app as {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      } | null) ?? undefined,
    ).name,
    jobTitle: (job as { title: string | null } | null)?.title ?? "This role",
    companyName: (company as { name: string | null } | null)?.name ?? "A company",
  };
}

/** One turn's audio for a super admin: the turn must be this live session's; logged, then signed. */
export async function signPlatformTurnAudio(
  adminUserId: string,
  sessionId: string,
  turnId: string,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<LiveAudioResult> {
  if (!turnId) return { ok: false, error: "Bad request." };
  const session = await platformLiveSession(deps.service, sessionId);
  if (!session) return NOT_FOUND_PLATFORM;
  const { data } = await deps.service
    .from("interview_turns")
    .select("id, media_path, content_purged_at")
    .eq("id", turnId)
    .eq("session_id", session.id)
    .maybeSingle();
  const turn = data as { media_path: string | null; content_purged_at: string | null } | null;
  if (!turn) return NOT_FOUND_PLATFORM;
  if (!turn.media_path) {
    return {
      ok: false,
      error: turn.content_purged_at
        ? "This recording was deleted after six months."
        : "There is no audio for this turn.",
    };
  }
  if (!(await logAdminAccess(deps.service, adminUserId, "open_turn_audio", session))) {
    return { ok: false, error: NOT_LOGGED };
  }
  const { data: signed, error } = await deps.service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(turn.media_path, PLAYBACK_TTL_SECONDS);
  if (error || !signed?.signedUrl)
    return { ok: false, error: "Couldn't load that audio. Try again." };
  logAdminGrant(deps.service, adminUserId, session, "interview_turns");
  return { ok: true, url: signed.signedUrl };
}

/** One confirmed video piece for a super admin: the piece must be this live session's; logged, then signed. */
export async function signPlatformVideoPiece(
  adminUserId: string,
  sessionId: string,
  pieceIndex: number,
  deps: LiveReviewDeps = defaultDeps(),
): Promise<LiveAudioResult> {
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0) return { ok: false, error: "Bad request." };
  const session = await platformLiveSession(deps.service, sessionId);
  if (!session) return NOT_FOUND_PLATFORM;
  const { data } = await deps.service
    .from("live_video_pieces")
    .select("status, media_path")
    .eq("session_id", session.id)
    .eq("company_id", session.company_id)
    .eq("piece_index", pieceIndex)
    .maybeSingle();
  const piece = data as { status: string; media_path: string | null } | null;
  if (piece?.status !== "confirmed")
    return { ok: false, error: "That part of the video wasn't saved." };
  if (!piece.media_path)
    return { ok: false, error: "This recording was deleted after six months." };
  if (!(await logAdminAccess(deps.service, adminUserId, "open_video_piece", session))) {
    return { ok: false, error: NOT_LOGGED };
  }
  const { data: signed, error } = await deps.service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(piece.media_path, PLAYBACK_TTL_SECONDS);
  if (error || !signed?.signedUrl)
    return { ok: false, error: "Couldn't load that video. Try again." };
  logAdminGrant(deps.service, adminUserId, session, "live_video_pieces");
  return { ok: true, url: signed.signedUrl };
}

export type PlatformLiveSessionRow = {
  id: string;
  /** Last six characters of the session id: how a session is named on the list. */
  shortId: string;
  companyName: string;
  jobTitle: string;
  outcome: string;
  createdAt: string;
};

const OUTCOME_LABEL: Record<string, string> = {
  completed: "Completed",
  partial: "Partial",
  abandoned: "Abandoned",
  technical_failure: "Technical failure",
  ending_unconfirmed: "Ending not confirmed - needs review",
};

function outcomeLabel(status: string, outcome: LiveOutcome | null): string {
  if (!outcome) return status === "invited" ? "Not started" : "No result yet";
  if (!outcome.final) return "In progress";
  return OUTCOME_LABEL[outcome.outcome] ?? "Unknown";
}

/** Every company's live sessions, newest first: ids, names of company and job, outcome. No candidate data. */
export async function listPlatformLiveSessions(
  deps: LiveReviewDeps = defaultDeps(),
  limit = 200,
): Promise<PlatformLiveSessionRow[]> {
  const { data } = await deps.service
    .from("interview_sessions")
    .select("id, company_id, job_id, status, live_outcome, created_at")
    .eq("kind", "live")
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as {
    id: string;
    company_id: string;
    job_id: string | null;
    status: string;
    live_outcome: LiveOutcome | null;
    created_at: string;
  }[];
  if (rows.length === 0) return [];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter((j): j is string => Boolean(j)))];
  const [{ data: companies }, { data: jobs }] = await Promise.all([
    deps.service.from("companies").select("id, name").in("id", companyIds),
    jobIds.length > 0
      ? deps.service.from("jobs").select("id, title, company_id").in("id", jobIds)
      : Promise.resolve({ data: [] }),
  ]);
  const companyName = new Map(
    ((companies ?? []) as { id: string; name: string | null }[]).map((c) => [c.id, c.name]),
  );
  const job = new Map(
    ((jobs ?? []) as { id: string; title: string | null; company_id: string }[]).map((j) => [
      j.id,
      j,
    ]),
  );
  return rows.map((r) => {
    const j = r.job_id ? job.get(r.job_id) : undefined;
    return {
      id: r.id,
      shortId: r.id.slice(-6),
      companyName: companyName.get(r.company_id) ?? "A company",
      // A job is named only on its own company's session.
      jobTitle: (j && j.company_id === r.company_id ? j.title : null) ?? "This role",
      outcome: outcomeLabel(r.status, r.live_outcome),
      createdAt: r.created_at,
    };
  });
}

/* ── actions ──────────────────────────────────────────────────── */

const RECOVERY_MESSAGES: Record<string, string> = {
  forbidden: "Only an owner or admin can do this.",
  bad_input: "Add a note, then try again.",
  not_failed: "That answer's transcription has not failed.",
  no_check: "There is nothing to resolve on that question.",
  not_live: "That interview isn't in your workspace.",
  db_error: "Something went wrong. Try again.",
};

/** Each per-question check is resolved by its own function: one never clears another. */
const QUESTION_RESOLVERS = {
  resolve_needs_check: resolveNeedsCheck,
  resolve_repeat_check: resolveRepeatCheck,
  resolve_style_check: resolveStyleCheck,
} as const;

/**
 * One recovery action from the review page: the page's gate, then the role,
 * then the recovery function (which checks the role again and logs the
 * action). Only on the latest attempt: an earlier attempt is audit only.
 */
export async function runLiveRecovery(
  ctx: CompanyContext,
  request: LiveRecoveryRequest,
  deps: LiveReviewDeps & { recovery?: Partial<RecoveryDeps> } = defaultDeps(),
): Promise<LiveActionResult> {
  const session = await gateLiveSession(ctx, request.sessionId, deps);
  if (!session) return { ok: false, error: "That interview isn't in your workspace." };
  if (!canActOnLiveReview(ctx.role)) return { ok: false, error: RECOVERY_MESSAGES.forbidden };
  const counting = await countingLiveScore(deps.service, ctx.companyId, session.id);
  if (counting?.session_id !== session.id) {
    return { ok: false, error: "This is an earlier attempt, kept for audit only." };
  }
  const recovery: RecoveryDeps = {
    service: deps.service,
    caller: {
      kind: "company",
      userId: ctx.user.id,
      name: ctx.memberName || null,
      role: ctx.role,
      companyId: ctx.companyId,
    },
    ...deps.recovery,
  };
  try {
    if (request.action === "retry_transcription") {
      await retryTranscription(
        { sessionId: session.id, turnId: request.turnId, note: request.note },
        recovery,
      );
    } else if (request.action === "resolve_failed_transcription") {
      await resolveFailedTranscription(
        { sessionId: session.id, turnId: request.turnId, decision: "exclude", note: request.note },
        recovery,
      );
    } else {
      const run = QUESTION_RESOLVERS[request.action];
      await run(
        {
          sessionId: session.id,
          position: request.position,
          decision: request.decision,
          note: request.note,
        },
        recovery,
      );
    }
  } catch (err) {
    if (err instanceof LiveRecoveryError) {
      return { ok: false, error: RECOVERY_MESSAGES[err.code] ?? RECOVERY_MESSAGES.db_error };
    }
    console.error(`[live-review] session ${session.id}: ${request.action} failed`);
    return { ok: false, error: RECOVERY_MESSAGES.db_error };
  }
  return { ok: true };
}
