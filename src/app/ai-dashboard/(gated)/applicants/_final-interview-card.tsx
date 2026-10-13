"use client";

import {
  CalendarClock,
  Check,
  CircleDot,
  CircleX,
  ClipboardList,
  Clock,
  PenLine,
  Play,
  Plus,
  Send,
  TriangleAlert,
  Undo2,
  UserX,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type CompanyRole, canManageBookings } from "@/app/ai-dashboard/lib/company-roles";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { formatInZone } from "@/lib/calendar/timezone";
import {
  CUSTOM_LABEL_MAX,
  DEFAULT_FINAL_DURATION,
  FINAL_DURATIONS,
  FINAL_EVALUATION_BASES,
  FINAL_EVALUATION_BASIS_LABELS,
  FINAL_EVALUATION_NOTES_MAX,
  FINAL_RATINGS,
  FINAL_RECOMMENDATION_LABELS,
  FINAL_RECOMMENDATIONS,
  type FinalEvaluationBasis,
  type FinalOutcomeStatus,
  type FinalRecommendation,
  INTERVIEW_TYPE_LABELS,
  INTERVIEW_TYPES,
  type InterviewType,
  MAX_EXTRA_INTERVIEWERS,
  type RecordingStatusLine,
  recordingStatusLine,
} from "@/lib/final-interviews/constants";
import type {
  EligibleMember,
  FinalEvaluationsView,
  FinalEvaluationView,
  FinalInterviewOptions,
  FinalInterviewView,
} from "@/lib/final-interviews/types";
import {
  cancelFinalInterview,
  getFinalInterviewOptions,
  getFinalRecordingPlayback,
  listFinalEvaluations,
  listFinalInterviews,
  resendFinalInterviewLink,
  scheduleFinalInterview,
  setFinalInterviewOutcome,
  submitFinalEvaluation,
} from "./final-interview-actions";

/**
 * The drawer's Final interviews card: every human-led final round for this
 * applicant, each with its own state and its own actions.
 *
 * ── Rounds are independent ───────────────────────────────────
 *
 * A CTO round and a CEO round for one candidate are two rows. Resend and
 * Cancel act on the row's own id, and after any action the whole list is
 * re-read from the server rather than patched here, so what the card shows is
 * always the server's state and never a guess about it.
 *
 * ── Who may act ──────────────────────────────────────────────
 *
 * canManageBookings decides, exactly as the server actions do. A hiring
 * manager sees the list and nothing to press. The server refuses them anyway;
 * the missing buttons are a courtesy, not the permission.
 *
 * ── Nothing loads until it is looked at ──────────────────────
 *
 * The list is fetched when this card mounts, which only happens on the open
 * applicant's Interviews pane. The scheduling options (who may host, who may
 * join) are fetched only when the Schedule form opens.
 *
 * ── The recording (recording step 5) ─────────────────────────
 *
 * Each row says what is happening with its recording, from the summary the
 * list carries; a row whose recording is off shows nothing new. A ready
 * recording plays inline. Its signed URL is asked for only when Watch is
 * pressed, never with the list, and is fetched again once if the player
 * reports an error (an expired URL, say). Everyone who sees the card may
 * watch, hiring managers included. There is no download button;
 * controlsList="nodownload" hides the browser's own, which does not stop a
 * determined viewer saving the file.
 *
 * ── Evaluations and the outcome ──────────────────────────────
 *
 * Once a row's booked call has started, its Evaluations panel can be opened;
 * that row's evaluations load then, and only for the one open row. Blind
 * until you submit: before that the panel shows a count. Mark completed /
 * Mark no-show (and Undo) are drawn from the row's canSetOutcome, which the
 * server works out from the same rule it enforces.
 */

/* ──────────────────── the drawer's chrome ──────────────────── */

const CARD =
  "rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";
const CARD_PAD = "px-[22px] py-5";
const EMPTY_BOX =
  "flex items-center gap-3.5 rounded-2xl border border-dashed border-[var(--ai-line-strong)] p-[18px]";
const BTN_PRIMARY =
  "flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl bg-remotiv-purple px-3.5 py-[11px] text-[13px] font-bold text-white transition-colors hover:bg-[var(--ai-purple-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_QUIET =
  "flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[9px] text-[12.5px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER =
  "flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[9px] text-[12.5px] font-bold text-[var(--ai-danger)] transition-colors hover:border-[var(--ai-danger)] hover:bg-[var(--ai-danger)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
const FIELD =
  "w-full rounded-[10px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-2.5 text-[13px] text-[var(--ai-t1)] outline-none focus:border-remotiv-purple disabled:opacity-60";
const LABEL = "mb-1.5 block text-[11.5px] font-bold tracking-[0.02em] text-[var(--ai-t3)]";

type Badge = { label: string; cls: string; icon: typeof Check };

/** One badge per row, from the interview's status and its newest booking. */
function badgeFor(row: FinalInterviewView): Badge {
  if (row.status === "cancelled") {
    return {
      label: "Cancelled",
      cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
      icon: CircleX,
    };
  }
  if (row.status === "completed") {
    return {
      label: "Completed",
      cls: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
      icon: Check,
    };
  }
  if (row.status === "no_show") {
    return {
      label: "No show",
      cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
      icon: CircleX,
    };
  }
  switch (row.booking.state) {
    case "booked":
      return {
        label: "Booked",
        cls: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
        icon: Check,
      };
    case "invited":
      return {
        label: "Link sent",
        cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
        icon: Send,
      };
    case "expired":
      return {
        label: "Link expired",
        cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
        icon: Clock,
      };
    case "booking_cancelled":
      return {
        label: "Booking cancelled",
        cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
        icon: CircleX,
      };
    default:
      return {
        label: "No link sent",
        cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
        icon: Clock,
      };
  }
}

/**
 * Which actions a row offers. Resend covers every state where a fresh link is
 * the right next step, including "no link sent", which is what a scheduling
 * whose email failed leaves behind and what its error message points at.
 * Cancel covers a live link or a booked call.
 */
function actionsFor(row: FinalInterviewView): { resend: boolean; cancel: boolean } {
  if (row.status !== "active") return { resend: false, cancel: false };
  const s = row.booking.state;
  return {
    resend: s === "not_sent" || s === "invited" || s === "expired" || s === "booking_cancelled",
    cancel: s === "invited" || s === "booked",
  };
}

function detectZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function StatusBadge({ badge: { label, cls, icon: Icon } }: { badge: Badge }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${cls}`}
    >
      <Icon className="size-3" strokeWidth={2.2} />
      {label}
    </span>
  );
}

const TONE: Record<RecordingStatusLine["tone"], { cls: string; icon: typeof Check }> = {
  info: { cls: "text-[var(--ai-t2)]", icon: CircleDot },
  warn: { cls: "text-[var(--ai-amber-ink)]", icon: TriangleAlert },
  bad: { cls: "text-[var(--ai-danger)]", icon: CircleX },
  ready: { cls: "text-[var(--ai-mint-ink)]", icon: Check },
};

/** The row's recording line: words first, colour second. */
function RecordingStatus({ line }: { line: RecordingStatusLine }) {
  const { cls, icon: Icon } = TONE[line.tone];
  return (
    <p className={`m-0 mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-[1.5] ${cls}`}>
      <Icon className="mt-[3px] size-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
      <span className="min-w-0">
        <span className="font-semibold">{line.text}</span>
        {line.detail && <span className="text-[var(--ai-t3)]"> · {line.detail}</span>}
      </span>
    </p>
  );
}

/** How a listed evaluation says where its author saw the interview. */
const BASIS_SEEN: Record<FinalEvaluationBasis, string> = {
  attended: "Attended",
  watched_recording: "Watched the recording",
};

const OUTCOME_TOAST: Record<FinalOutcomeStatus, string> = {
  completed: "Marked completed.",
  no_show: "Marked no-show.",
  active: "Outcome undone.",
};

const OUTCOME_LABEL: Record<FinalOutcomeStatus, string> = {
  completed: "completed",
  no_show: "no-show",
  active: "active",
};

type Player = {
  rowId: string;
  recordingId: string;
  url: string;
  /** Whether the one fresh-URL retry has been used. */
  retried: boolean;
};

/* ───────────────────────── the card ───────────────────────── */

export function FinalInterviewCard({
  applicationId,
  viewerRole,
  onToast,
}: {
  applicationId: string;
  /** The account role. Decides whether any button is drawn. */
  viewerRole: CompanyRole;
  onToast: (message: string) => void;
}) {
  const canManage = canManageBookings(viewerRole);
  /** null while the first read is in flight. */
  const [rows, setRows] = useState<FinalInterviewView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The id of the row with an action in flight, so a second click does nothing. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [zone, setZone] = useState("UTC");
  /** The open inline player, at most one on the card. */
  const [player, setPlayer] = useState<Player | null>(null);
  /** The row whose playback URL is being fetched. */
  const [watchingId, setWatchingId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<{ rowId: string; message: string } | null>(null);
  const watchButtons = useRef(new Map<string, HTMLButtonElement>());
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The row to hand focus back to when the player closes. */
  const returnFocusTo = useRef<string | null>(null);
  /** The row whose Evaluations panel is open, at most one. Its evaluations load only then. */
  const [evalRowId, setEvalRowId] = useState<string | null>(null);
  const [evals, setEvals] = useState<FinalEvaluationsView | null>(null);
  const [evalsError, setEvalsError] = useState<string | null>(null);
  /** The latest row asked for, so a slow answer for another row is dropped. */
  const evalRequest = useRef<string | null>(null);
  const [evalDialogRow, setEvalDialogRow] = useState<FinalInterviewView | null>(null);

  // Detected in an effect, never during render: the server has no zone.
  useEffect(() => {
    setZone(detectZone());
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await listFinalInterviews(applicationId);
      if (!result.success) {
        setLoadError(result.error);
        setRows([]);
        return;
      }
      setLoadError(null);
      setRows(result.data);
    } catch (err) {
      console.error("[applicants] listFinalInterviews threw:", err);
      setLoadError("Couldn't load the final interviews. Reload to try again.");
      setRows([]);
    }
  }, [applicationId]);

  useEffect(() => {
    setRows(null);
    setConfirmingId(null);
    setPlayer(null);
    setPlayerError(null);
    setEvalRowId(null);
    setEvals(null);
    setEvalDialogRow(null);
    evalRequest.current = null;
    void load();
  }, [load]);

  /** One row's evaluations, from the server. Keeps what is shown until the answer arrives. */
  const loadEvaluations = useCallback(async (rowId: string) => {
    evalRequest.current = rowId;
    setEvalsError(null);
    try {
      const result = await listFinalEvaluations(rowId);
      if (evalRequest.current !== rowId) return;
      if (!result.success) {
        setEvalsError(result.error);
        return;
      }
      setEvals(result.data);
    } catch (err) {
      console.error("[applicants] listFinalEvaluations threw:", err);
      if (evalRequest.current === rowId) {
        setEvalsError("Couldn't load the evaluations. Try again.");
      }
    }
  }, []);

  function toggleEvaluations(rowId: string) {
    if (evalRowId === rowId) {
      setEvalRowId(null);
      evalRequest.current = null;
      return;
    }
    setEvalRowId(rowId);
    setEvals(null);
    void loadEvaluations(rowId);
  }

  // Focus follows the player: into it when it opens, back to its Watch button
  // when it closes.
  const playerRowId = player?.rowId ?? null;
  useEffect(() => {
    if (playerRowId) {
      videoRef.current?.focus();
      return;
    }
    const back = returnFocusTo.current;
    if (back) {
      returnFocusTo.current = null;
      watchButtons.current.get(back)?.focus();
    }
  }, [playerRowId]);

  /** Ask for a playback URL. Only ever called from a click or a player error. */
  async function fetchPlayback(rowId: string, recordingId: string, retried: boolean) {
    setWatchingId(rowId);
    setPlayerError(null);
    try {
      const result = await getFinalRecordingPlayback(recordingId);
      if (!result.success) {
        setPlayer(null);
        setPlayerError({ rowId, message: result.error });
        return;
      }
      setPlayer({ rowId, recordingId, url: result.data.url, retried });
    } catch (err) {
      console.error("[applicants] getFinalRecordingPlayback threw:", err);
      setPlayer(null);
      setPlayerError({ rowId, message: "Couldn't load the recording. Try again." });
    } finally {
      setWatchingId(null);
    }
  }

  function watch(rowId: string, recordingId: string) {
    if (watchingId !== null) return;
    returnFocusTo.current = rowId;
    void fetchPlayback(rowId, recordingId, false);
  }

  function closePlayer() {
    setPlayer(null);
    setPlayerError(null);
  }

  /** An expired or failed URL is replaced once; a second failure is reported. */
  function onPlayerError() {
    if (!player) return;
    if (!player.retried) {
      void fetchPlayback(player.rowId, player.recordingId, true);
      return;
    }
    setPlayerError({
      rowId: player.rowId,
      message: "The recording couldn't be played. Try again.",
    });
    setPlayer(null);
  }

  async function resend(id: string) {
    if (busyId !== null) return;
    setBusyId(id);
    try {
      const result = await resendFinalInterviewLink(id);
      onToast(result.success ? "Booking link sent." : result.error);
    } catch (err) {
      console.error("[applicants] resendFinalInterviewLink threw:", err);
      onToast("Couldn't send the link - please try again.");
    } finally {
      setBusyId(null);
    }
    // The server's state, not a guess about it.
    await load();
  }

  async function cancel(id: string) {
    if (busyId !== null) return;
    setBusyId(id);
    try {
      const result = await cancelFinalInterview(id);
      onToast(result.success ? "Final interview cancelled." : result.error);
    } catch (err) {
      console.error("[applicants] cancelFinalInterview threw:", err);
      onToast("Couldn't cancel - please try again.");
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
    await load();
  }

  async function setOutcome(id: string, status: FinalOutcomeStatus) {
    if (busyId !== null) return;
    setBusyId(id);
    try {
      const result = await setFinalInterviewOutcome({ finalInterviewId: id, status });
      onToast(result.success ? OUTCOME_TOAST[status] : result.error);
    } catch (err) {
      console.error("[applicants] setFinalInterviewOutcome threw:", err);
      onToast("Couldn't save that - please try again.");
    } finally {
      setBusyId(null);
    }
    await load();
  }

  const scheduleButton = canManage ? (
    <button
      type="button"
      onClick={() => setFormOpen(true)}
      disabled={busyId !== null}
      className={`ml-auto ${BTN_PRIMARY}`}
    >
      <Plus className="size-[15px]" strokeWidth={2.2} />
      Schedule final interview
    </button>
  ) : null;

  return (
    <section>
      <div className="mb-[13px] flex items-center gap-3">
        <h2 className="m-0 whitespace-nowrap font-heading text-[17px] font-bold tracking-[-0.025em] text-[var(--ai-t1)]">
          Final interviews
        </h2>
        <span className="h-px flex-1 bg-[var(--ai-line)]" aria-hidden="true" />
      </div>

      <div className={`${CARD} ${CARD_PAD}`}>
        {rows === null ? (
          <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
        ) : rows.length === 0 ? (
          <div className={EMPTY_BOX}>
            <div className="min-w-0">
              <b className="block text-[13px] font-bold text-[var(--ai-t1)]">
                No final interviews yet.
              </b>
              <p className="m-0 mt-[3px] max-w-[430px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                {canManage
                  ? "A human-led round on Google Meet, recorded, with a host from your team and anyone else who should sit in. The candidate books a time from the host's calendar."
                  : "An owner, admin or recruiter can schedule one."}
              </p>
            </div>
            {scheduleButton}
          </div>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col divide-y divide-[var(--ai-line-soft)] p-0">
              {rows.map((row) => {
                const actions = actionsFor(row);
                const busy = busyId === row.id;
                const confirming = confirmingId === row.id;
                const recordingLine = recordingStatusLine(row.recording, (iso) =>
                  formatInZone(Date.parse(iso), zone),
                );
                const recordingId =
                  row.recording.state === "ready" ? row.recording.recordingId : null;
                const playing = player?.rowId === row.id;
                const evalOpen = evalRowId === row.id;
                const marked = row.status === "completed" || row.status === "no_show";
                return (
                  <li key={row.id} className="py-3.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="text-[13.5px] font-bold text-[var(--ai-t1)]">{row.label}</b>
                          <StatusBadge badge={badgeFor(row)} />
                        </div>
                        <p className="m-0 mt-1 text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                          Host: {row.host.name}
                          {row.interviewers.length > 0 &&
                            ` · With: ${row.interviewers.map((m) => m.name).join(", ")}`}
                          {` · ${row.booking.durationMinutes} minutes`}
                        </p>
                        {row.booking.state === "booked" && row.booking.scheduledStart && (
                          <p className="m-0 mt-1 text-[12.5px] font-semibold text-[var(--ai-t2)]">
                            {formatInZone(Date.parse(row.booking.scheduledStart), zone)}
                            <span className="font-normal text-[var(--ai-t4)]"> · {zone}</span>
                          </p>
                        )}
                        {row.booking.state === "booking_cancelled" && row.booking.cancelReason && (
                          <p className="m-0 mt-1 text-[12.5px] text-[var(--ai-t3)]">
                            Reason given: {row.booking.cancelReason}
                          </p>
                        )}
                        {recordingLine && <RecordingStatus line={recordingLine} />}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {recordingId && !playing && (
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) watchButtons.current.set(row.id, el);
                              else watchButtons.current.delete(row.id);
                            }}
                            disabled={watchingId !== null}
                            onClick={() => watch(row.id, recordingId)}
                            className={BTN_QUIET}
                          >
                            <Play className="size-[14px]" strokeWidth={2} />
                            {watchingId === row.id ? "Loading…" : "Watch"}
                          </button>
                        )}
                        {row.booking.state === "booked" && row.booking.meetingUrl && (
                          <a
                            href={row.booking.meetingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={BTN_QUIET}
                          >
                            <Video className="size-[14px]" strokeWidth={2} />
                            Join call
                          </a>
                        )}
                        {canManage && actions.resend && !confirming && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void resend(row.id)}
                            className={BTN_QUIET}
                          >
                            <Send className="size-[14px]" strokeWidth={2} />
                            {busy ? "Sending…" : "Resend link"}
                          </button>
                        )}
                        {canManage && actions.cancel && !confirming && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => setConfirmingId(row.id)}
                            className={BTN_DANGER}
                          >
                            Cancel
                          </button>
                        )}
                        {row.canSetOutcome && row.status === "active" && !confirming && (
                          <>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void setOutcome(row.id, "completed")}
                              className={BTN_QUIET}
                            >
                              <Check className="size-[14px]" strokeWidth={2} />
                              Mark completed
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void setOutcome(row.id, "no_show")}
                              className={BTN_QUIET}
                            >
                              <UserX className="size-[14px]" strokeWidth={2} />
                              Mark no-show
                            </button>
                          </>
                        )}
                        {row.canSetOutcome && marked && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void setOutcome(row.id, "active")}
                            aria-label={`Undo ${OUTCOME_LABEL[row.status as FinalOutcomeStatus]}`}
                            className={BTN_QUIET}
                          >
                            <Undo2 className="size-[14px]" strokeWidth={2} />
                            Undo
                          </button>
                        )}
                        {row.started && (
                          <button
                            type="button"
                            aria-expanded={evalOpen}
                            aria-controls={`evaluations-${row.id}`}
                            onClick={() => toggleEvaluations(row.id)}
                            className={BTN_QUIET}
                          >
                            <ClipboardList className="size-[14px]" strokeWidth={2} />
                            Evaluations
                          </button>
                        )}
                      </div>
                    </div>

                    {evalOpen && (
                      <EvaluationsPanel
                        id={`evaluations-${row.id}`}
                        view={evals}
                        error={evalsError}
                        zone={zone}
                        onEvaluate={() => setEvalDialogRow(row)}
                      />
                    )}

                    {playing && player && (
                      <div className="mt-3 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] p-2.5">
                        {/* biome-ignore lint/a11y/useMediaCaption: meeting recordings have no transcript or caption track yet */}
                        <video
                          ref={videoRef}
                          key={player.url}
                          src={player.url}
                          controls
                          preload="metadata"
                          controlsList="nodownload"
                          playsInline
                          onError={onPlayerError}
                          aria-label={`Recording of the ${row.label}`}
                          className="block max-h-[60vh] w-full rounded-lg bg-black"
                        />
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <p className="m-0 text-[11.5px] text-[var(--ai-t3)]">
                            {watchingId === row.id ? "Refreshing the recording…" : row.label}
                          </p>
                          <button type="button" onClick={closePlayer} className={BTN_QUIET}>
                            <X className="size-[14px]" strokeWidth={2} />
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                    {playerError?.rowId === row.id && (
                      <p
                        role="alert"
                        className="m-0 mt-2 text-[12.5px] font-semibold text-[var(--ai-danger)]"
                      >
                        {playerError.message}
                      </p>
                    )}

                    {canManage && confirming && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
                        <p className="m-0 mr-auto text-[12.5px] font-semibold text-[var(--ai-t1)]">
                          Cancel this final interview? The candidate is emailed.
                        </p>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void cancel(row.id)}
                          className={BTN_DANGER}
                        >
                          {busy ? "Cancelling…" : "Yes, cancel it"}
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => setConfirmingId(null)}
                          className={BTN_QUIET}
                        >
                          Keep it
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {scheduleButton && <div className="mt-4 flex">{scheduleButton}</div>}
          </>
        )}
      </div>

      {loadError && (
        <p role="alert" className="m-0 mt-2.5 text-[12.5px] font-semibold text-[var(--ai-danger)]">
          {loadError}
        </p>
      )}

      {evalDialogRow && (
        <EvaluationDialog
          row={evalDialogRow}
          own={evals?.own ?? null}
          onClose={() => setEvalDialogRow(null)}
          onSaved={(created) => {
            const rowId = evalDialogRow.id;
            setEvalDialogRow(null);
            onToast(created ? "Evaluation submitted." : "Evaluation updated.");
            void loadEvaluations(rowId);
          }}
        />
      )}

      {canManage && formOpen && (
        <ScheduleDialog
          applicationId={applicationId}
          onClose={() => setFormOpen(false)}
          onScheduled={() => {
            setFormOpen(false);
            onToast("Booking link sent.");
            void load();
          }}
        />
      )}
    </section>
  );
}

/* ───────────────────── one row's evaluations ────────────────── */

/**
 * Blind until you submit: the server sends only a count until your own
 * evaluation exists, and this shows exactly what it was sent.
 */
function EvaluationsPanel({
  id,
  view,
  error,
  zone,
  onEvaluate,
}: {
  id: string;
  view: FinalEvaluationsView | null;
  error: string | null;
  zone: string;
  onEvaluate: () => void;
}) {
  let summary = "";
  if (view) {
    summary = `${view.submittedCount} submitted`;
    if (!view.own) {
      summary += view.canEvaluate ? ". Submit yours to see the others." : ".";
    }
  }
  return (
    <section
      id={id}
      aria-label="Evaluations"
      className="mt-3 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3"
    >
      {error && (
        <p role="alert" className="m-0 text-[12.5px] font-semibold text-[var(--ai-danger)]">
          {error}
        </p>
      )}
      {!error && view === null && (
        <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-surface)]" />
      )}
      {!error && view && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-[12.5px] font-semibold text-[var(--ai-t1)]">{summary}</p>
            {view.canEvaluate && (
              <button type="button" onClick={onEvaluate} className={BTN_QUIET}>
                <PenLine className="size-[14px]" strokeWidth={2} />
                {view.own ? "Edit your evaluation" : "Add your evaluation"}
              </button>
            )}
          </div>
          {view.own && view.evaluations.length > 0 && (
            <ul className="m-0 mt-2 flex list-none flex-col divide-y divide-[var(--ai-line-soft)] p-0">
              {view.evaluations.map((e) => (
                <EvaluationItem key={e.memberId} evaluation={e} zone={zone} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function EvaluationItem({
  evaluation: e,
  zone,
}: {
  evaluation: FinalEvaluationView;
  zone: string;
}) {
  return (
    <li className="py-2.5 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <b className="text-[13px] font-bold text-[var(--ai-t1)]">
          {e.name}
          {e.isYou && <span className="font-semibold text-[var(--ai-t3)]"> (you)</span>}
        </b>
        <span className="text-[12px] font-bold text-[var(--ai-t2)]">
          <span className="sr-only">Rating </span>
          {e.rating}/5
        </span>
        <span className="rounded-full bg-[var(--ai-purple-tint)] px-2 py-0.5 text-[11px] font-bold text-[var(--ai-purple-ink)]">
          {FINAL_RECOMMENDATION_LABELS[e.recommendation]}
        </span>
        <span className="text-[12px] text-[var(--ai-t3)]">{BASIS_SEEN[e.basis]}</span>
      </div>
      {e.notes && (
        <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-[var(--ai-t2)]">
          {e.notes}
        </p>
      )}
      {e.edited && (
        <p className="m-0 mt-1 text-[11.5px] text-[var(--ai-t4)]">
          Edited {formatInZone(Date.parse(e.updatedAt), zone)}
        </p>
      )}
    </li>
  );
}

/* ─────────────────────── the schedule form ─────────────────── */

/**
 * Type, host, extra interviewers and length, then one send. The options are
 * read when this opens, never before. Validation here is only what makes the
 * form usable; the server re-checks everything and its message is shown as is.
 */
function ScheduleDialog({
  applicationId,
  onClose,
  onScheduled,
}: {
  applicationId: string;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, true, { onClose, overlayRef, initialFocus: "first" });
  const id = useId();

  const [options, setOptions] = useState<FinalInterviewOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [interviewType, setInterviewType] = useState<InterviewType>("final");
  const [customLabel, setCustomLabel] = useState("");
  const [hostMemberId, setHostMemberId] = useState("");
  const [interviewerIds, setInterviewerIds] = useState<string[]>([]);
  const [durationMinutes, setDurationMinutes] = useState<number>(DEFAULT_FINAL_DURATION);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFinalInterviewOptions(applicationId)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setOptionsError(result.error);
          return;
        }
        setOptions(result.data);
        // The first host who can actually host, so the form opens ready to send.
        const firstHost = result.data.hosts.find((h) => h.calendarConnected);
        if (firstHost) setHostMemberId(firstHost.memberId);
      })
      .catch((err) => {
        console.error("[applicants] getFinalInterviewOptions threw:", err);
        if (!cancelled) setOptionsError("Couldn't load who can take part. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  const isCustom = interviewType === "custom";
  const label = customLabel.trim();
  const customLabelProblem =
    isCustom && (label.length < 1 || label.length > CUSTOM_LABEL_MAX)
      ? `Give the custom interview a name (1 to ${CUSTOM_LABEL_MAX} characters).`
      : null;
  const canSubmit =
    options !== null && !submitting && hostMemberId !== "" && customLabelProblem === null;

  // The host never sits in the interviewer list as well.
  const interviewerChoices: EligibleMember[] = (options?.interviewers ?? []).filter(
    (m) => m.memberId !== hostMemberId,
  );
  const chosenInterviewers = interviewerIds.filter((mid) => mid !== hostMemberId);
  const atMax = chosenInterviewers.length >= MAX_EXTRA_INTERVIEWERS;

  function toggleInterviewer(memberId: string) {
    setInterviewerIds((prev) =>
      prev.includes(memberId) ? prev.filter((x) => x !== memberId) : [...prev, memberId],
    );
  }

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await scheduleFinalInterview({
        applicationId,
        interviewType,
        customLabel: isCustom ? label : null,
        hostMemberId,
        interviewerMemberIds: chosenInterviewers,
        durationMinutes,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      onScheduled();
    } catch (err) {
      console.error("[applicants] scheduleFinalInterview threw:", err);
      setError("Couldn't schedule - please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-6 backdrop-blur-[5px]"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="relative w-full max-w-[520px] overflow-hidden rounded-3xl bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)] outline-none"
      >
        <div className="bg-[var(--ai-sidebar)] px-7 pb-[22px] pt-6">
          <h2
            id={`${id}-title`}
            className="m-0 font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white"
          >
            Schedule a final interview
          </h2>
          <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
            The candidate gets a booking link for the host&apos;s free times, and must agree to the
            interview being recorded before they can book.
          </p>
        </div>

        <form
          className="px-7 py-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {options === null && !optionsError && (
            <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
          )}
          {optionsError && (
            <p role="alert" className="m-0 text-[13px] font-semibold text-[var(--ai-danger)]">
              {optionsError}
            </p>
          )}

          {options && (
            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor={`${id}-type`} className={LABEL}>
                  Interview type
                </label>
                <select
                  id={`${id}-type`}
                  value={interviewType}
                  onChange={(e) => setInterviewType(e.target.value as InterviewType)}
                  className={FIELD}
                >
                  {INTERVIEW_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t === "custom" ? "Custom" : INTERVIEW_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>

              {isCustom && (
                <div>
                  <label htmlFor={`${id}-label`} className={LABEL}>
                    Name of the interview
                  </label>
                  <input
                    id={`${id}-label`}
                    type="text"
                    value={customLabel}
                    maxLength={CUSTOM_LABEL_MAX}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    placeholder="Founder chat"
                    aria-describedby={`${id}-label-hint`}
                    className={FIELD}
                  />
                  <p id={`${id}-label-hint`} className="m-0 mt-1 text-[11.5px] text-[var(--ai-t3)]">
                    1 to {CUSTOM_LABEL_MAX} characters. This is what the candidate sees.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor={`${id}-host`} className={LABEL}>
                  Host
                </label>
                <select
                  id={`${id}-host`}
                  value={hostMemberId}
                  onChange={(e) => {
                    setHostMemberId(e.target.value);
                    setInterviewerIds((prev) => prev.filter((x) => x !== e.target.value));
                  }}
                  aria-describedby={`${id}-host-hint`}
                  className={FIELD}
                >
                  <option value="">Choose a host</option>
                  {options.hosts.map((m) => (
                    <option key={m.memberId} value={m.memberId} disabled={!m.calendarConnected}>
                      {m.name}
                      {m.calendarConnected ? "" : " - Calendar not connected"}
                    </option>
                  ))}
                </select>
                <p id={`${id}-host-hint`} className="m-0 mt-1 text-[11.5px] text-[var(--ai-t3)]">
                  The call lands on the host&apos;s Google Calendar and records to their Drive, so
                  the host needs their calendar connected in Settings.
                </p>
              </div>

              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className={LABEL}>
                  Extra interviewers (optional, up to {MAX_EXTRA_INTERVIEWERS})
                </legend>
                {interviewerChoices.length === 0 ? (
                  <p className="m-0 text-[12.5px] text-[var(--ai-t3)]">
                    Nobody else on this job&apos;s hiring team.
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                    {interviewerChoices.map((m) => {
                      const checked = chosenInterviewers.includes(m.memberId);
                      return (
                        <li key={m.memberId}>
                          <label
                            className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold ${
                              checked
                                ? "border-remotiv-purple bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                                : "border-[var(--ai-line-strong)] text-[var(--ai-t2)]"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && atMax}
                              onChange={() => toggleInterviewer(m.memberId)}
                              className="size-3.5 accent-remotiv-purple"
                            />
                            {m.name}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>

              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className={LABEL}>Length</legend>
                <div className="flex gap-2" role="radiogroup" aria-label="Length">
                  {FINAL_DURATIONS.map((d) => (
                    <label
                      key={d}
                      className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2 text-[13px] font-semibold ${
                        durationMinutes === d
                          ? "border-remotiv-purple bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                          : "border-[var(--ai-line-strong)] text-[var(--ai-t2)]"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${id}-duration`}
                        value={d}
                        checked={durationMinutes === d}
                        onChange={() => setDurationMinutes(d)}
                        className="size-3.5 accent-remotiv-purple"
                      />
                      {d} min
                    </label>
                  ))}
                </div>
              </fieldset>

              {(customLabelProblem || error) && (
                <p role="alert" className="m-0 text-[12.5px] font-semibold text-[var(--ai-danger)]">
                  {error ?? customLabelProblem}
                </p>
              )}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2.5">
            <button type="button" onClick={onClose} disabled={submitting} className={BTN_QUIET}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} className={BTN_PRIMARY}>
              <CalendarClock className="size-[15px]" strokeWidth={1.9} />
              {submitting ? "Sending…" : "Send booking link"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ──────────────────────── the evaluation form ───────────────────── */

const CHOICE =
  "inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-semibold";
const CHOICE_ON = "border-remotiv-purple bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]";
const CHOICE_OFF = "border-[var(--ai-line-strong)] text-[var(--ai-t2)]";

/**
 * Add or edit your own evaluation. Nothing is chosen for you, the basis
 * included. The server re-checks every field and its message is shown as is.
 */
function EvaluationDialog({
  row,
  own,
  onClose,
  onSaved,
}: {
  row: FinalInterviewView;
  own: FinalEvaluationView | null;
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, true, { onClose, overlayRef, initialFocus: "first" });
  const id = useId();

  const [rating, setRating] = useState<number | null>(own?.rating ?? null);
  const [recommendation, setRecommendation] = useState<FinalRecommendation | null>(
    own?.recommendation ?? null,
  );
  const [basis, setBasis] = useState<FinalEvaluationBasis | null>(own?.basis ?? null);
  const [notes, setNotes] = useState(own?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !submitting &&
    rating !== null &&
    recommendation !== null &&
    basis !== null &&
    notes.trim().length <= FINAL_EVALUATION_NOTES_MAX;

  async function submit() {
    if (!canSubmit || submitting || rating === null || !recommendation || !basis) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitFinalEvaluation({
        finalInterviewId: row.id,
        rating,
        recommendation,
        basis,
        notes,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      onSaved(result.data.created);
    } catch (err) {
      console.error("[applicants] submitFinalEvaluation threw:", err);
      setError("Couldn't save your evaluation - please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-4 backdrop-blur-[5px] sm:p-6"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="relative max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-3xl bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)] outline-none"
      >
        <div className="bg-[var(--ai-sidebar)] px-5 pb-[22px] pt-6 sm:px-7">
          <h2
            id={`${id}-title`}
            className="m-0 font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white"
          >
            {own ? "Edit your evaluation" : "Add your evaluation"}
          </h2>
          <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
            {row.label}. You see the others&apos; evaluations once yours is in.
          </p>
        </div>

        <form
          className="px-5 py-6 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-4">
            <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={`${id}-rating-hint`}>
              <legend className={LABEL}>Rating</legend>
              <div className="flex flex-wrap gap-2">
                {FINAL_RATINGS.map((r) => (
                  <label key={r} className={`${CHOICE} ${rating === r ? CHOICE_ON : CHOICE_OFF}`}>
                    <input
                      type="radio"
                      name={`${id}-rating`}
                      value={r}
                      checked={rating === r}
                      onChange={() => setRating(r)}
                      className="size-3.5 accent-remotiv-purple"
                    />
                    {r}
                  </label>
                ))}
              </div>
              <p id={`${id}-rating-hint`} className="m-0 mt-1 text-[11.5px] text-[var(--ai-t3)]">
                1 is the lowest, 5 the highest.
              </p>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className={LABEL}>Recommendation</legend>
              <div className="flex flex-wrap gap-2">
                {FINAL_RECOMMENDATIONS.map((r) => (
                  <label
                    key={r}
                    className={`${CHOICE} ${recommendation === r ? CHOICE_ON : CHOICE_OFF}`}
                  >
                    <input
                      type="radio"
                      name={`${id}-recommendation`}
                      value={r}
                      checked={recommendation === r}
                      onChange={() => setRecommendation(r)}
                      className="size-3.5 accent-remotiv-purple"
                    />
                    {FINAL_RECOMMENDATION_LABELS[r]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className={LABEL}>How you saw the interview</legend>
              <div className="flex flex-wrap gap-2">
                {FINAL_EVALUATION_BASES.map((b) => (
                  <label key={b} className={`${CHOICE} ${basis === b ? CHOICE_ON : CHOICE_OFF}`}>
                    <input
                      type="radio"
                      name={`${id}-basis`}
                      value={b}
                      checked={basis === b}
                      onChange={() => setBasis(b)}
                      className="size-3.5 accent-remotiv-purple"
                    />
                    {FINAL_EVALUATION_BASIS_LABELS[b]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor={`${id}-notes`} className={LABEL}>
                Notes (optional)
              </label>
              <textarea
                id={`${id}-notes`}
                value={notes}
                maxLength={FINAL_EVALUATION_NOTES_MAX}
                rows={5}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={`${id}-notes-count`}
                className={`${FIELD} resize-y`}
              />
              <p
                id={`${id}-notes-count`}
                className="m-0 mt-1 text-right text-[11.5px] text-[var(--ai-t3)]"
              >
                {notes.length.toLocaleString("en-US")} /{" "}
                {FINAL_EVALUATION_NOTES_MAX.toLocaleString("en-US")}
              </p>
            </div>

            {error && (
              <p role="alert" className="m-0 text-[12.5px] font-semibold text-[var(--ai-danger)]">
                {error}
              </p>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button type="button" onClick={onClose} disabled={submitting} className={BTN_QUIET}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} className={BTN_PRIMARY}>
              <Check className="size-[15px]" strokeWidth={2} />
              {submitting ? "Saving…" : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
