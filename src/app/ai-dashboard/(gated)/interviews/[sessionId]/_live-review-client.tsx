"use client";

import { ChevronLeft, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import type {
  LiveRecoveryRequest,
  LiveReviewFlag,
  LiveReviewQuestion,
  LiveReviewTurn,
  LiveReviewView,
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
  style: "Style check",
  transcription_failed: "Transcription failed",
};

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
}: {
  view: LiveReviewView;
  candidateName: string;
  jobTitle: string;
  /** Owner or admin. Combined with the attempt being the latest before anything renders. */
  canAct: boolean;
}) {
  const [audio, setAudio] = useState<AudioState>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const acting = canAct && view.attempt.isLatest;
  const { header, attempt } = view;

  const play = async (turnId: string, start = 0) => {
    setAudioError(null);
    const r = await getLiveTurnAudioUrl(view.sessionId, turnId);
    if (r.ok) setAudio({ turnId, url: r.url, start });
    else setAudioError(r.error);
  };

  // The camera video: one confirmed piece at a time, in order, each a fresh 5-minute link.
  const [video, setVideo] = useState<VideoState>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const openPiece = async (index: number, seek = 0) => {
    setVideoError(null);
    const r = await getLiveVideoPieceUrl(view.sessionId, index);
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
            href="/ai-dashboard/interviews"
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

      {!attempt.isLatest && (
        <p className={`${CARD} m-0 text-sm font-semibold text-[var(--ai-t1)]`} data-audit-only>
          Attempt {attempt.number} of {attempt.of}: kept for audit only. This is not the candidate's
          result.{" "}
          <Link className="underline" href={`/ai-dashboard/interviews/${attempt.latestSessionId}`}>
            See the latest attempt
          </Link>
        </p>
      )}
      {attempt.isLatest && attempt.earlierSessionIds.length > 0 && (
        <p className={`m-0 ${MUTED}`}>
          The candidate restarted; only this attempt counts.{" "}
          {attempt.earlierSessionIds.map((id, i) => (
            <Link key={id} className="underline" href={`/ai-dashboard/interviews/${id}`}>
              View attempt {i + 1} (audit only)
            </Link>
          ))}
        </p>
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
        {header.partial && header.state !== "in_progress" && (
          <p className="m-0 mt-2 text-xs font-semibold text-[var(--ai-amber-ink)]" data-partial>
            Partial interview: not comparable with completed interviews.
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
            action:
              flag.kind === "style"
                ? ("resolve_style_check" as const)
                : ("resolve_needs_check" as const),
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
