"use client";

import { ChevronLeft, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getAdminLiveTurnAudioUrl,
  getAdminLiveVideoPieceUrl,
} from "@/app/admin/interviews/actions";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import {
  type LiveRecoveryRequest,
  type LiveRestartCode,
  type LiveRestartDecideResult,
  type LiveRestartDecision,
  type LiveRestartPanel,
  type LiveRestartResendResult,
  type LiveRestartSend,
  type LiveReviewFlag,
  type LiveReviewQuestion,
  type LiveReviewTurn,
  type LiveReviewView,
  restartPanelFor,
} from "@/lib/interviews/live-review-types";
import {
  clock,
  type LiveReviewVideo,
  type LiveVideoPiece,
  videoPositionAt,
} from "@/lib/interviews/live-video-timeline";
import { getLiveTurnAudioUrl, getLiveVideoPieceUrl, runLiveReviewAction } from "../live-actions";

/**
 * The recruiter review of an AI Video Interview. Everything shown comes from
 * LiveReviewView (lib/interviews/live-review.ts), which carries no scoring
 * guide, follow-up reason, storage path or CV detail. Actions render only when
 * `canAct` (owner or admin, on the latest attempt); the server refuses them
 * for anyone else regardless.
 */

const CARD = "rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] p-5";
const CHIP = "whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold";
const MUTED = "text-[13px] text-[var(--ai-t3)]";
const BUTTON =
  "rounded-lg border border-[var(--ai-line)] px-3 py-1.5 text-xs font-semibold text-[var(--ai-t1)] transition-colors hover:border-[var(--ai-sidebar)] disabled:cursor-not-allowed disabled:opacity-50";

const STATE_CHIP: Record<string, string> = {
  completed: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  partial: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  ending_unconfirmed: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  incomplete: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  in_progress: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
};

const STATUS_CHIP: Record<string, string> = {
  answered: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  skipped: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  not_reached: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  excluded: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  waiting_review: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  waiting: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
};

const FLAG_TITLE: Record<LiveReviewFlag["kind"], string> = {
  timing: "Timing check",
  repeat: "Repeat check",
  wording: "Wording check",
  style: "Style check",
  transcription_failed: "Transcription failed",
};

/** The action that resolves each per-question check: one never clears another. */
const RESOLVE_ACTION = {
  timing: "resolve_needs_check",
  repeat: "resolve_repeat_check",
  wording: "resolve_wording_check",
  style: "resolve_style_check",
} as const;

const RESOLVED_TEXT: Record<string, string> = {
  score: "Resolved: scored as usual.",
  exclude: "Resolved: left out of the score.",
  retry: "Transcription asked for again.",
};

const TURN_STATE_TEXT: Record<string, string> = {
  pending: "Transcribing…",
  failed: "Could not be transcribed.",
  no_words: "No words heard.",
  purged: "Deleted after six months.",
};

/**
 * Who is looking. "company": the company's own review, as always. "platform":
 * a Remotiv super admin from /admin/interviews (F4), read-only: no action
 * ever renders, and recordings go through the admin actions, which check and
 * log every link.
 */
export type LiveReviewMode = "company" | "platform";

const MEDIA = {
  company: {
    audio: getLiveTurnAudioUrl,
    video: getLiveVideoPieceUrl,
    base: "/ai-dashboard/interviews",
  },
  platform: {
    audio: getAdminLiveTurnAudioUrl,
    video: getAdminLiveVideoPieceUrl,
    base: "/admin/interviews",
  },
} as const;

type AudioState = { turnId: string; url: string; start: number } | null;
type VideoState = { index: number; url: string; seek: number } | null;

/** Safeguard C, said where the reviewer looks. */
const VIDEO_SOUND_NOTE =
  "The video has the candidate's camera and microphone. Sarah's voice is not in it: play her lines in the conversation below.";

export function LiveReviewClient({
  view,
  candidateName,
  jobTitle,
  canAct,
  mode = "company",
  restartActions,
}: {
  view: LiveReviewView;
  candidateName: string;
  jobTitle: string;
  /** Owner or admin. Combined with the attempt being the latest before anything renders. */
  canAct: boolean;
  mode?: LiveReviewMode;
  /** The restart decision's server actions, passed by the company's review page only. */
  restartActions?: RestartActions;
}) {
  const [audio, setAudio] = useState<AudioState>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const media = MEDIA[mode];
  // A super admin never acts, whatever canAct says.
  const acting = mode === "company" && canAct && view.attempt.isLatest;
  const { header, attempt } = view;

  const play = async (turnId: string, start = 0) => {
    setAudioError(null);
    const r = await media.audio(view.sessionId, turnId);
    if (r.ok) setAudio({ turnId, url: r.url, start });
    else setAudioError(r.error);
  };

  // The camera video: one confirmed piece at a time, in order, each a fresh 5-minute link.
  const [video, setVideo] = useState<VideoState>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const openPiece = async (index: number, seek = 0) => {
    setVideoError(null);
    const r = await media.video(view.sessionId, index);
    if (r.ok) setVideo({ index, url: r.url, seek });
    else setVideoError(r.error);
  };
  const playable = view.video.pieces.filter((p) => p.hasVideo);
  const nextPiece = () => {
    const at = playable.findIndex((p) => p.index === video?.index);
    const next = playable[at + 1];
    if (next) void openPiece(next.index);
  };
  const watchAt = (atMs: number) => {
    const pos = videoPositionAt(atMs, view.video.pieces);
    if (!pos) {
      setVideoError(`No video at ${clock(atMs)}: that part was not saved.`);
      return;
    }
    void openPiece(pos.index, pos.offsetSeconds);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={media.base}
            aria-label="Back to interviews"
            className="flex size-[38px] shrink-0 items-center justify-center rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)]"
          >
            <ChevronLeft className="size-[17px]" strokeWidth={2.2} />
          </Link>
          <div className="min-w-0">
            <h1 className="m-0 truncate font-heading text-[22px] font-extrabold tracking-[-0.035em] text-[var(--ai-t1)]">
              {candidateName}
            </h1>
            <p className={`m-0 mt-1 ${MUTED}`}>
              {jobTitle} · AI Video Interview
              {attempt.of > 1 && (
                <span data-attempt>
                  {" "}
                  · Attempt {attempt.number} of {attempt.of}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" data-header>
          <span className={`${CHIP} ${STATE_CHIP[header.state]}`} data-outcome={header.state}>
            {header.label}
          </span>
          {header.state !== "incomplete" && (
            <span className={MUTED}>
              {header.answered} of {header.total} answered
            </span>
          )}
          <span className={MUTED}>{header.skipped} skipped</span>
          <span className={MUTED}>{header.completionPercent}% complete</span>
        </div>
      </header>

      {mode === "platform" && (
        <p className={`${CARD} m-0 text-sm font-semibold text-[var(--ai-t1)]`} data-read-only>
          Viewing as Remotiv super admin: read-only. Opening this review and each recording is
          logged with your account.
        </p>
      )}

      {!attempt.isLatest && (
        <p className={`${CARD} m-0 text-sm font-semibold text-[var(--ai-t1)]`} data-audit-only>
          Attempt {attempt.number} of {attempt.of}: kept for audit only. This is not the candidate's
          result.{" "}
          <Link className="underline" href={`${media.base}/${attempt.latestSessionId}`}>
            See the latest attempt
          </Link>
        </p>
      )}
      {attempt.isLatest && attempt.earlierSessionIds.length > 0 && (
        <p className={`m-0 ${MUTED}`}>
          The candidate restarted; only this attempt counts.{" "}
          {attempt.earlierSessionIds.map((id, i) => (
            <Link key={id} className="underline" href={`${media.base}/${id}`}>
              View attempt {i + 1} (audit only)
            </Link>
          ))}
        </p>
      )}

      <RestartPanel
        sessionId={view.sessionId}
        panel={restartPanelFor(view.restart, { canAct, platform: mode === "platform" })}
        actions={restartActions}
      />

      {(header.reviewReasons.length > 0 || header.restartNote) && (
        <section className={CARD} aria-label="Needs review" data-needs-review>
          <h2 className="m-0 text-sm font-bold text-[var(--ai-t1)]">Needs review</h2>
          {header.reviewReasons.length > 0 && (
            <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--ai-t2)]">
              {header.reviewReasons.map((reason) => (
                <li key={reason} data-review-reason>
                  {reason}
                </li>
              ))}
            </ul>
          )}
          {header.restartNote && (
            <p className={`m-0 mt-2 ${MUTED}`} data-restart-note>
              {header.restartNote}
            </p>
          )}
        </section>
      )}

      <section className={CARD} aria-label="Overall">
        {header.overall !== null ? (
          <p className="m-0 flex items-baseline gap-3" data-overall>
            <span
              className={`font-heading text-[40px] font-extrabold ${BAND_TEXT[scoreBand(header.overall)]}`}
            >
              {header.overall}
            </span>
            <span className={MUTED}>overall, from the answered and skipped questions</span>
          </p>
        ) : (
          <p className={`m-0 ${MUTED}`} data-no-overall>
            {header.scoreNote ?? "No overall score."}
          </p>
        )}
        {header.partialNote && (
          <p className="m-0 mt-2 text-xs font-semibold text-[var(--ai-amber-ink)]" data-partial>
            {header.partialNote}
          </p>
        )}
      </section>

      {audioError && (
        <p role="alert" className="m-0 text-sm text-[var(--ai-peach-ink)]">
          {audioError}
        </p>
      )}

      <VideoSection
        video={view.video}
        playing={video}
        error={videoError}
        onStart={() => playable[0] && void openPiece(playable[0].index)}
        onEnded={nextPiece}
      />

      {view.questions.map((q) => (
        <QuestionCard
          key={q.position}
          q={q}
          sessionId={view.sessionId}
          acting={acting}
          audio={audio}
          onPlay={play}
          pieces={view.video.pieces}
          onWatch={watchAt}
        />
      ))}
    </div>
  );
}

/* ── the restart decision (F10 C5) ──────────────────────────────── */

export type RestartActions = {
  decide: (
    sessionId: string,
    decision: "restart" | "no_restart",
    note: string,
  ) => Promise<LiveRestartDecideResult>;
  resend: (restartSessionId: string) => Promise<LiveRestartResendResult>;
};

const NOTE_MAX = 2000;

/** A time as the page shows it: UTC, so the server and the browser agree. */
function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}

// TODO-COPY: every string in RESTART_TEXT and RESTART_CODE_TEXT is a placeholder - Waleed writes the final copy.
const RESTART_TEXT = {
  title: "Restart decision",
  intro: "The first attempt did not finish cleanly. Decide whether the candidate takes it again.",
  restart: "Restart",
  noRestart: "No restart",
  noteLabel: "Note (required)",
  continue: "Continue",
  back: "Back",
  confirmRestart:
    "Confirm restart: a new link is emailed to the candidate, with at least 72 hours to take it.",
  confirmNoRestart: "Confirm no restart: this attempt stays as it is. This can't be changed later.",
  confirm: "Confirm",
  working: "Saving...",
  awaiting: "A restart decision is waiting for an owner or admin.",
  tooSoon: (at: string | null) =>
    at ? `A restart can be decided from ${when(at)}.` : "A restart can be decided soon.",
  notFinal: "A restart can be decided once every answer has been transcribed.",
  notEnded: "A restart can be decided after the interview has ended.",
  decided: (d: LiveRestartDecision) =>
    `Restart decision: ${d.decision === "restart" ? "restart" : "no restart"}, by ${d.byName ?? "a team member"} (${d.byRole}), ${when(d.at)}.`,
  noteShown: (note: string) => `Note: ${note}`,
  earlier: "Earlier attempt - restarted. Kept for audit only.",
  invitedDeadline: (deadline: string | null) =>
    deadline ? `Restart link deadline: ${when(deadline)}.` : "Restart link sent.",
  unconfirmed:
    "Delivery can't be confirmed here - send the link again if the candidate didn't receive it.",
  resend: "Send the link again",
  expired: "The restart link expired before it was used.",
  saved: "Decision saved.",
  sent: (deadline: string) => `Restart link sent - deadline ${when(deadline)}.`,
} as const;

const RESTART_CODE_TEXT: Record<LiveRestartCode, string> = {
  signed_out: "Sign in to your workspace first.",
  not_found: "That interview isn't in your workspace.",
  role_not_allowed: "Only an owner or admin can decide a restart.",
  not_latest: "This is an earlier attempt, kept for audit only.",
  not_eligible: "This interview can't be restarted.",
  too_soon: "It's too soon to decide - try again in a little while.",
  not_final: "Wait until every answer has been transcribed.",
  not_eligible_outcome: "This interview's outcome is never restarted.",
  already_decided: "A restart decision has already been made.",
  note_invalid: "Write a note of up to 2000 characters.",
  past_retention: "A restart would end after the recording's deletion date, so it can't be sent.",
  expired: "The restart link has expired.",
  not_invited: "The candidate has already started the restarted interview.",
  email_failed: "The email was not delivered. Send the link again.",
  deadline_not_extended:
    "The link wasn't sent: its deadline couldn't be extended. The candidate's current link still works - try again.",
  db_error: "Something went wrong. Please try again.",
};

function notYetText(panel: Extract<LiveRestartPanel, { panel: "not_yet" }>): string {
  if (panel.reason === "too_soon") return RESTART_TEXT.tooSoon(panel.availableAt);
  if (panel.reason === "not_final") return RESTART_TEXT.notFinal;
  return RESTART_TEXT.notEnded;
}

/**
 * What a send or re-send did, as the panel says it right after the click. The
 * deadline is the one the email quoted and the database holds; a deadline not
 * extended after delivery still stands, so it reads as sent.
 */
export function restartSendText(sent: LiveRestartSend): string {
  if (sent.emailFailed) return RESTART_CODE_TEXT[sent.code];
  return RESTART_TEXT.sent(sent.deadline);
}

/** A send worth retrying from here: the email was not delivered. */
function retryable(sent: LiveRestartSend): boolean {
  return sent.emailFailed && sent.code === "email_failed";
}

function RestartPanel({
  sessionId,
  panel,
  actions,
}: {
  sessionId: string;
  panel: LiveRestartPanel;
  actions?: RestartActions;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<"restart" | "no_restart" | null>(null);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The restart to send again from here, after a decision whose link needs it.
  const [retryId, setRetryId] = useState<string | null>(null);

  if (panel.panel === "none") return null;
  const clean = note.trim();
  const noteOk = clean.length >= 1 && clean.length <= NOTE_MAX;

  const decide = async () => {
    if (!actions || !choice) return;
    setBusy(true);
    setMessage(null);
    const r = await actions.decide(sessionId, choice, note);
    setBusy(false);
    if (!r.ok) {
      setMessage(RESTART_CODE_TEXT[r.code]);
      return;
    }
    if (r.decision === "no_restart") {
      setMessage(RESTART_TEXT.saved);
    } else {
      setMessage(restartSendText(r));
      setRetryId(retryable(r) ? r.restartSessionId : null);
    }
    router.refresh();
  };

  const resend = async (restartSessionId: string) => {
    if (!actions) return;
    setBusy(true);
    setMessage(null);
    const r = await actions.resend(restartSessionId);
    setBusy(false);
    setMessage(r.ok ? restartSendText(r) : RESTART_CODE_TEXT[r.code]);
    setRetryId(r.ok && retryable(r) && restartSessionId !== sessionId ? restartSessionId : null);
    if (r.ok) router.refresh();
  };

  return (
    <section className={CARD} aria-label={RESTART_TEXT.title} data-restart-panel={panel.panel}>
      <h2 className="m-0 text-sm font-bold text-[var(--ai-t1)]">{RESTART_TEXT.title}</h2>
      {panel.panel === "decide" && !actions && (
        <p className={`m-0 mt-2 ${MUTED}`}>{RESTART_TEXT.awaiting}</p>
      )}
      {panel.panel === "decide" && actions && (
        <div className="mt-2 flex flex-col gap-3" data-restart-form>
          <p className={`m-0 ${MUTED}`}>{RESTART_TEXT.intro}</p>
          {!confirming ? (
            <>
              <div className="flex gap-2">
                {(["restart", "no_restart"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={BUTTON}
                    aria-pressed={choice === c}
                    onClick={() => setChoice(c)}
                    data-restart-choice={c}
                  >
                    {c === "restart" ? RESTART_TEXT.restart : RESTART_TEXT.noRestart}
                  </button>
                ))}
              </div>
              <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--ai-t2)]">
                {RESTART_TEXT.noteLabel}
                <textarea
                  className="rounded-lg border border-[var(--ai-line)] bg-transparent p-2 text-sm text-[var(--ai-t1)]"
                  rows={3}
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={!choice || !noteOk}
                  onClick={() => setConfirming(true)}
                >
                  {RESTART_TEXT.continue}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="m-0 text-sm text-[var(--ai-t1)]" data-restart-confirm>
                {choice === "restart" ? RESTART_TEXT.confirmRestart : RESTART_TEXT.confirmNoRestart}
              </p>
              <div className="flex gap-2">
                <button type="button" className={BUTTON} disabled={busy} onClick={decide}>
                  {busy ? RESTART_TEXT.working : RESTART_TEXT.confirm}
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  {RESTART_TEXT.back}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {panel.panel === "awaiting_decision" && (
        <p className={`m-0 mt-2 ${MUTED}`}>{RESTART_TEXT.awaiting}</p>
      )}
      {panel.panel === "not_yet" && (
        <p className={`m-0 mt-2 ${MUTED}`} data-restart-not-yet={panel.reason}>
          {notYetText(panel)}
        </p>
      )}
      {(panel.panel === "decided" || panel.panel === "earlier_restarted") && (
        <div className="mt-2 flex flex-col gap-1">
          {panel.panel === "earlier_restarted" && (
            <p className="m-0 text-sm font-semibold text-[var(--ai-t1)]" data-restart-earlier>
              {RESTART_TEXT.earlier}
            </p>
          )}
          {panel.decision && (
            <p className={`m-0 ${MUTED}`} data-restart-decision={panel.decision.decision}>
              {RESTART_TEXT.decided(panel.decision)}
            </p>
          )}
          {panel.decision?.note && (
            <p className={`m-0 ${MUTED}`} data-restart-note-text>
              {RESTART_TEXT.noteShown(panel.decision.note)}
            </p>
          )}
        </div>
      )}
      {panel.panel === "restart_invited" && (
        <div className="mt-2 flex flex-col gap-2" data-restart-invited>
          <p className={`m-0 ${MUTED}`}>{RESTART_TEXT.invitedDeadline(panel.deadline)}</p>
          <p className={`m-0 ${MUTED}`}>{RESTART_TEXT.unconfirmed}</p>
          {panel.canResend && actions && (
            <div>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => resend(sessionId)}
                data-restart-resend
              >
                {busy ? RESTART_TEXT.working : RESTART_TEXT.resend}
              </button>
            </div>
          )}
        </div>
      )}
      {panel.panel === "restart_expired" && (
        <p className={`m-0 mt-2 ${MUTED}`}>{RESTART_TEXT.expired}</p>
      )}
      {message && (
        <p role="status" className="m-0 mt-2 text-sm text-[var(--ai-t1)]" data-restart-message>
          {message}
        </p>
      )}
      {retryId && actions && (
        <div className="mt-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => resend(retryId)}
            data-restart-retry
          >
            {busy ? RESTART_TEXT.working : RESTART_TEXT.resend}
          </button>
        </div>
      )}
    </section>
  );
}

function incompleteNote(missing: number): string {
  if (missing === 0) return "The recording is incomplete.";
  return `The recording is incomplete: ${missing} ${missing === 1 ? "part was" : "parts were"} not saved.`;
}

function VideoSection({
  video,
  playing,
  error,
  onStart,
  onEnded,
}: {
  video: LiveReviewVideo;
  playing: VideoState;
  error: string | null;
  onStart: () => void;
  onEnded: () => void;
}) {
  let body: React.ReactNode;
  if (!video.recorded) {
    body = <p className={`m-0 ${MUTED}`}>No camera video was recorded for this interview.</p>;
  } else if (video.purged && video.pieces.every((p) => !p.hasVideo)) {
    body = <p className={`m-0 ${MUTED}`}>This video was deleted after six months.</p>;
  } else {
    body = (
      <>
        {playing ? (
          // biome-ignore lint/a11y/useMediaCaption: the transcript of every turn is printed below.
          <video
            key={playing.url}
            className="w-full rounded-xl bg-black"
            controls
            autoPlay
            src={playing.url}
            data-video-piece={playing.index}
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = playing.seek;
            }}
            onEnded={onEnded}
          />
        ) : (
          <button
            type="button"
            className={BUTTON}
            onClick={onStart}
            disabled={video.pieces.length === 0}
          >
            Play video
          </button>
        )}
        {video.gaps.length > 0 && (
          <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0" data-video-gaps>
            {video.gaps.map((g) => (
              <li key={g.fromMs} className={MUTED}>
                Video missing from {clock(g.fromMs)}{" "}
                {g.toMs === null ? "to the end" : `to ${clock(g.toMs)}`}
              </li>
            ))}
          </ul>
        )}
        {!video.complete && (
          <p className={`m-0 mt-2 ${MUTED}`} data-video-incomplete>
            {incompleteNote(video.missingPieces.length)}
          </p>
        )}
      </>
    );
  }
  return (
    <section className={CARD} aria-label="Camera video" data-video>
      <p className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-[var(--ai-t3)]">
        Camera video
      </p>
      {body}
      <p className={`m-0 mt-3 ${MUTED}`} data-video-sound>
        {VIDEO_SOUND_NOTE}
      </p>
      {error && (
        <p role="alert" className="m-0 mt-2 text-sm text-[var(--ai-peach-ink)]">
          {error}
        </p>
      )}
    </section>
  );
}

function QuestionCard({
  q,
  sessionId,
  acting,
  audio,
  onPlay,
  pieces,
  onWatch,
}: {
  q: LiveReviewQuestion;
  sessionId: string;
  acting: boolean;
  audio: AudioState;
  onPlay: (turnId: string, start?: number) => void;
  pieces: readonly LiveVideoPiece[];
  onWatch: (atMs: number) => void;
}) {
  return (
    <article className={CARD} data-question={q.position}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP} bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]`}>
          {q.sourceLabel}
        </span>
        <span className={MUTED}>Question {q.position}</span>
        <span className={`${CHIP} ${STATUS_CHIP[q.status]}`} data-status={q.status}>
          {q.statusLabel}
        </span>
      </div>
      <h2 className="m-0 mt-3 text-[16px] font-bold text-[var(--ai-t1)]">{q.text}</h2>
      {q.statusReason && <p className={`m-0 mt-1 ${MUTED}`}>{q.statusReason}</p>}

      {q.score !== null &&
        (q.status === "skipped" ? (
          // Never a bare 0: a skipped question must not read like a bad answer's 0.
          <p className="m-0 mt-4 text-sm font-semibold text-[var(--ai-t2)]" data-score data-skipped>
            Skipped - {q.score} (no answer)
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-baseline gap-4" data-score>
            <span
              className={`font-heading text-[28px] font-extrabold ${BAND_TEXT[scoreBand(q.score)]}`}
            >
              {q.score}
            </span>
            {q.confidence && (
              <span className={MUTED} data-confidence>
                Confidence: {q.confidence}
              </span>
            )}
          </div>
        ))}
      {q.rationale && <p className="m-0 mt-2 text-sm text-[var(--ai-t2)]">{q.rationale}</p>}
      {q.quotes.length > 0 && (
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {q.quotes.map((quote) => (
            <li key={quote.text}>
              <button
                type="button"
                className="text-left text-sm italic text-[var(--ai-t1)] underline decoration-dotted"
                disabled={!quote.turnId}
                onClick={() => quote.turnId && onPlay(quote.turnId, quote.startSeconds ?? 0)}
              >
                “{quote.text}”
              </button>
              {quote.atMs !== null && videoPositionAt(quote.atMs, pieces) && (
                <button
                  type="button"
                  className="ml-2 text-xs text-[var(--ai-t3)] underline"
                  data-watch={quote.atMs}
                  onClick={() => quote.atMs !== null && onWatch(quote.atMs)}
                >
                  Watch
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {q.flags.map((flag) => (
        <div
          key={`${flag.kind}-${flag.turnId ?? q.position}`}
          className="mt-4 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] p-3"
          data-flag={flag.kind}
        >
          <p className="m-0 text-sm font-bold text-[var(--ai-t1)]">{FLAG_TITLE[flag.kind]}</p>
          <p className={`m-0 mt-1 ${MUTED}`}>{flag.reason}</p>
          {flag.resolved && <p className={`m-0 mt-1 ${MUTED}`}>{RESOLVED_TEXT[flag.resolved]}</p>}
          {acting && <FlagActions flag={flag} position={q.position} sessionId={sessionId} />}
        </div>
      ))}

      <div className="mt-5">
        <p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--ai-t3)]">
          Conversation · {q.followUps} {q.followUps === 1 ? "follow-up" : "follow-ups"}
        </p>
        <ol className="m-0 mt-2 flex list-none flex-col gap-3 p-0">
          {q.conversation.map((turn) => (
            <TurnLine key={turn.id} turn={turn} audio={audio} onPlay={onPlay} />
          ))}
        </ol>
      </div>
    </article>
  );
}

function TurnLine({
  turn,
  audio,
  onPlay,
}: {
  turn: LiveReviewTurn;
  audio: AudioState;
  onPlay: (turnId: string, start?: number) => void;
}) {
  const playing = audio?.turnId === turn.id;
  return (
    <li data-turn={turn.speaker}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-[var(--ai-t2)]">{turn.label}</span>
        {turn.hasAudio && (
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
            onClick={() => onPlay(turn.id)}
            aria-label={`Play ${turn.label}`}
          >
            <Play className="size-3" /> Play
          </button>
        )}
      </div>
      <p className="m-0 mt-0.5 text-sm text-[var(--ai-t1)]">
        {turn.state === "text" ? (
          turn.text
        ) : (
          <span className="italic text-[var(--ai-t3)]">{TURN_STATE_TEXT[turn.state]}</span>
        )}
      </p>
      {playing && audio && (
        // biome-ignore lint/a11y/useMediaCaption: the transcript of this turn is printed directly above.
        <audio
          className="mt-2 w-full"
          controls
          autoPlay
          src={audio.url}
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = audio.start;
          }}
        />
      )}
    </li>
  );
}

function FlagActions({
  flag,
  position,
  sessionId,
}: {
  flag: LiveReviewFlag;
  position: number;
  sessionId: string;
}) {
  const options: { label: string; request: (note: string) => LiveRecoveryRequest }[] =
    flag.kind === "transcription_failed" && flag.turnId
      ? [
          {
            label: "Retry transcription",
            request: (note) => ({
              action: "retry_transcription",
              sessionId,
              turnId: flag.turnId as string,
              note,
            }),
          },
          {
            label: "Leave the question out",
            request: (note) => ({
              action: "resolve_failed_transcription",
              sessionId,
              turnId: flag.turnId as string,
              note,
            }),
          },
        ]
      : (["score", "exclude"] as const).map((decision) => ({
          label: decision === "score" ? "Score as usual" : "Leave out",
          request: (note: string) => ({
            action: RESOLVE_ACTION[flag.kind === "transcription_failed" ? "timing" : flag.kind],
            sessionId,
            position,
            decision,
            note,
          }),
        }));
  return <NoteActions options={options} />;
}

function NoteActions({
  options,
}: {
  options: { label: string; request: (note: string) => LiveRecoveryRequest }[];
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = note.trim().length > 0 && !busy;
  return (
    <div className="mt-3 flex flex-col gap-2" data-actions>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--ai-t2)]">
        Note (required)
        <textarea
          className="min-h-[60px] rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] p-2 text-sm font-normal text-[var(--ai-t1)]"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="font-normal text-[var(--ai-t3)]">Don't include personal details.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={BUTTON}
            disabled={!ready}
            data-action={o.request("").action}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const r = await runLiveReviewAction(o.request(note.trim()));
              setBusy(false);
              if (!r.ok) {
                setError(r.error);
                return;
              }
              setNote("");
              router.refresh();
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="m-0 text-xs text-[var(--ai-peach-ink)]">
          {error}
        </p>
      )}
    </div>
  );
}
