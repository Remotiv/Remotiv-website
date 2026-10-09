"use client";

import { CalendarClock, Check, CircleX, Clock, Plus, Send, Video } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type CompanyRole, canManageBookings } from "@/app/ai-dashboard/lib/company-roles";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { formatInZone } from "@/lib/calendar/timezone";
import {
  CUSTOM_LABEL_MAX,
  DEFAULT_FINAL_DURATION,
  FINAL_DURATIONS,
  INTERVIEW_TYPE_LABELS,
  INTERVIEW_TYPES,
  type InterviewType,
  MAX_EXTRA_INTERVIEWERS,
} from "@/lib/final-interviews/constants";
import type {
  EligibleMember,
  FinalInterviewOptions,
  FinalInterviewView,
} from "@/lib/final-interviews/types";
import {
  cancelFinalInterview,
  getFinalInterviewOptions,
  listFinalInterviews,
  resendFinalInterviewLink,
  scheduleFinalInterview,
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
    void load();
  }, [load]);

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
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                      </div>
                    </div>

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
