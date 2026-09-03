"use client";

import { CalendarClock, Check, CircleX, Clock, Send, Video } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import {
  type BookingPanel,
  cancelBookingAsRecruiter,
  fetchBookingPanel,
  sendBookingLink,
} from "./booking-actions";
import { fetchInterviewPanel, sendInterviewInvite } from "./interview-actions";
import type { InterviewPanelState } from "./interview-types";

/**
 * The drawer's video-interview section.
 *
 * Sending is manual and explicit — nothing here fires on a stage change.
 *
 * ── Two different acts, weighted differently ─────────────────
 *
 * Reviving a DEAD link — expired, cancelled, or never sent — is the ordinary
 * case and gets the full-width button. Replacing a LIVE one is a deliberate
 * act with a cost to the candidate, so it is a quiet text trigger with a
 * confirm step that names the cost before it happens.
 *
 * A SUBMITTED interview offers neither, because submitted is final and a
 * button that produced a working link would contradict that.
 */

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const STATE: Record<string, { label: string; cls: string; icon: typeof Check }> = {
  invited: {
    label: "Sent — not started",
    cls: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
    icon: Send,
  },
  started: {
    label: "In progress",
    cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    icon: Clock,
  },
  submitted: {
    label: "Submitted",
    cls: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
    icon: Check,
  },
  expired: {
    label: "Expired",
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    icon: Clock,
  },
  cancelled: {
    label: "Cancelled",
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    icon: CircleX,
  },
};

export function InterviewPanel({
  applicationId,
  onToast,
}: {
  applicationId: string;
  onToast: (message: string) => void;
}) {
  const [state, setState] = useState<InterviewPanelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The confirm step for replacing a link that still works. */
  const [reissuing, setReissuing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchInterviewPanel(applicationId));
    } catch {
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function handleSend(reissue = false) {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof sendInterviewInvite>>;
    try {
      result = await sendInterviewInvite(applicationId);
    } catch (err) {
      /*
       * LOG IT. A bare `catch {}` here is how a unique-constraint violation
       * spent a day looking like a network blip: the action threw, the reason
       * was discarded before anything could read it, and the recruiter was
       * told to try again at something that would never succeed.
       *
       * The message still cannot be shown — Next replaces a thrown server
       * action's message with an opaque digest in production — but the digest
       * plus this line is enough to find it in the server log, which an empty
       * catch was not.
       */
      console.error("[applicants] sendInterviewInvite threw:", err);
      result = { success: false, error: "Couldn't send — please try again." };
    }
    setBusy(false);
    // Closed either way. On failure the reason renders below, and leaving the
    // confirm open beneath it would state a consequence that did not happen.
    setReissuing(false);

    if (!result.success) {
      // Shown in place, not as a toast: "add questions to this job first" is
      // an instruction, and an instruction that fades is no instruction.
      setError(result.error);
      return;
    }
    onToast(reissue ? "New link sent" : "Interview sent");
    await load();
  }

  /**
   * Send a LIVE booking link — a different thing from the async video
   * interview above, deliberately sitting next to it rather than replacing it.
   *
   * The async interview is the candidate recording answers alone; this is a
   * meeting in the recruiter's diary. A team may use either, both in sequence,
   * or neither, so one must not be presented as the other's replacement.
   */
  /** The booking, if there is one. Read alongside the interview panel. */
  const [booking, setBooking] = useState<BookingPanel>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const loadBooking = useCallback(async () => {
    try {
      setBooking(await fetchBookingPanel(applicationId));
    } catch (err) {
      console.error("[applicants] fetchBookingPanel threw:", err);
    }
  }, [applicationId]);

  useEffect(() => {
    void loadBooking();
  }, [loadBooking]);

  /**
   * Cancel from the recruiter's side.
   *
   * There is no "reschedule" button here on purpose — see the note on
   * cancelBookingAsRecruiter. Moving someone into a time they never chose is
   * not a reschedule.
   */
  async function handleCancelBooking() {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof cancelBookingAsRecruiter>>;
    try {
      result = await cancelBookingAsRecruiter(applicationId, cancelReason.trim() || undefined);
    } catch (err) {
      console.error("[applicants] cancelBookingAsRecruiter threw:", err);
      result = { success: false, error: "Couldn't cancel — please try again." };
    }
    setBusy(false);
    setCancelling(false);
    setCancelReason("");

    if (!result.success) {
      setError(result.error);
      return;
    }
    onToast(
      result.data.removedFromCalendar
        ? "Interview cancelled"
        : "Cancelled — remove it from your calendar too",
    );
    await loadBooking();
  }

  async function handleSendBooking() {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof sendBookingLink>>;
    try {
      result = await sendBookingLink(applicationId);
    } catch (err) {
      // See the note in handleSend — an unexplained throw must not be silent.
      console.error("[applicants] sendBookingLink threw:", err);
      result = { success: false, error: "Couldn't send — please try again." };
    }
    setBusy(false);

    if (!result.success) {
      // In place, not a toast: "connect your calendar in Settings" is an
      // instruction, and an instruction that fades is no instruction.
      setError(result.error);
      return;
    }
    onToast("Booking link sent");
    await load();
  }

  if (loading) {
    return <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />;
  }

  const session = state?.session ?? null;
  const badge = session ? (STATE[session.status] ?? STATE.invited) : null;
  const StateIcon = badge?.icon ?? Video;

  /*
   * Two independent questions, and they must not be conflated.
   *
   * `canResend` asks whether ANOTHER link would be meaningful — a submitted or
   * in-progress interview offers nothing. `asyncOff` asks whether the job
   * permits one at all. A job with the toggle off still shows the section and
   * any interview already taken; it just cannot start a new one.
   */
  const canResend = !session || session.status === "expired" || session.status === "cancelled";

  /*
   * The third question, and the one the drawer used to get wrong by not asking
   * it: may a LIVE invite be replaced?
   *
   * sendInterviewInvite has always said yes — it cancels the open session and
   * mints a fresh one, and the reminder and expiry jobs both skip a superseded
   * session by name. Only the client stopped offering it, which left `invited`
   * with no way forward for the five days until the link expired: precisely
   * the state a candidate sits in when the invitation did not reach them.
   *
   * Deliberately NOT folded into `canResend`. That one revives a dead link and
   * costs nothing; this one destroys a working one.
   */
  const canReissue = session?.status === "invited" || session?.status === "started";
  const asyncOff = state !== null && !state.asyncEnabled;

  return (
    <div className="flex flex-col gap-2.5">
      {session && badge && (
        <div className="rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3.5 py-3">
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${badge.cls}`}
            >
              <StateIcon className="size-3" strokeWidth={2.2} />
              {badge.label}
            </span>
            {session.total > 0 && session.status !== "submitted" && (
              <span className="text-[11.5px] font-semibold text-[var(--ai-t3)]">
                {session.answered} of {session.total} answered
              </span>
            )}
          </div>
          <p className="m-0 mt-2 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            {session.status === "submitted"
              ? `Submitted ${fmt(session.submittedAt)}. Answers are final and can't be re-recorded.`
              : session.status === "expired"
                ? `The link expired on ${fmt(session.expiresAt)}. Send a new one to reopen it.`
                : session.status === "cancelled"
                  ? "This interview was replaced by a newer one."
                  : `Sent ${fmt(session.sentAt)}${session.invitedByName ? ` by ${session.invitedByName}` : ""} · link works until ${fmt(session.expiresAt)}.`}
          </p>
        </div>
      )}

      {/* Straight into the review page. Only offered once something has been
          recorded — a link to an empty review is worse than no link. */}
      {/* The interview score sits BESIDE the CV score in the drawer, never
          merged with it: one reads a document, the other reads spoken answers,
          and a blended number would hide which is which. Absent on either side
          says so in its own words rather than showing a zero. */}
      {session && session.answered > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)]">
            Interview
          </span>
          {session.scoreStatus === "scored" && session.score !== null ? (
            <span
              className={`font-heading text-2xl font-extrabold leading-none tracking-[-0.04em] ${BAND_TEXT[scoreBand(session.score)]}`}
            >
              {session.score}
            </span>
          ) : (
            <span className="text-[12.5px] italic text-[var(--ai-t4)]">
              {session.scoreStatus === "pending" || session.scoreStatus === null
                ? "Not scored yet"
                : session.scoreStatus === "failed"
                  ? "Scoring failed"
                  : "Not scored"}
            </span>
          )}
          <span className="ml-auto text-[11.5px] text-[var(--ai-t3)]">
            {session.answered} of {session.total} answered
          </span>
        </div>
      )}

      {session && session.answered > 0 && (
        <Link
          href={`/ai-dashboard/interviews/${session.id}`}
          className="flex w-full items-center justify-center gap-[7px] rounded-xl border border-remotiv-purple bg-[var(--ai-surface)] px-3 py-[11px] text-[13px] font-bold text-remotiv-purple transition-colors hover:bg-remotiv-purple hover:text-white"
        >
          <Video className="size-[15px]" strokeWidth={1.9} />
          {session.status === "submitted" ? "Watch the interview" : "See what's recorded so far"}
        </Link>
      )}

      {canReissue &&
        !asyncOff &&
        session &&
        (reissuing ? (
          <div className="rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
            {/*
              NAME THE COST, do not gesture at it.

              The `started` branch is blunt on purpose. A recruiter clicking
              past a vague warning and costing a candidate three recorded
              answers is the failure this sentence exists to prevent, and the
              counts are what make it concrete — "you may lose progress" is
              not a fact anyone can act on, "they have answered 2 of 5" is.
            */}
            <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
              {session.status === "started" ? (
                <>
                  They&apos;ve answered {session.answered} of {session.total}. A new link starts the
                  interview again from the first question, and the link they&apos;re using stops
                  working. What they&apos;ve recorded stays on this record, but they can&apos;t
                  carry on from it.
                </>
              ) : (
                <>
                  Sends a fresh invitation by email and WhatsApp. The link
                  {fmt(session.sentAt) ? ` from ${fmt(session.sentAt)}` : " they already have"}{" "}
                  stops working straight away — they haven&apos;t started, so nothing is lost.
                </>
              )}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void handleSend(true);
                }}
                className="rounded-[10px] bg-remotiv-purple px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send it again"}
              </button>
              <button
                type="button"
                onClick={() => setReissuing(false)}
                className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ai-t3)]"
              >
                Keep the current link
              </button>
            </div>
          </div>
        ) : (
          /*
           * Quiet by design — a text trigger, not a button. Re-sending over a
           * working link is a deliberate act, so it should take a moment to
           * find and a second click to do; the full-width control above stays
           * reserved for the case where there is nothing live to destroy.
           */
          <button
            type="button"
            onClick={() => setReissuing(true)}
            className="self-start text-[12.5px] font-semibold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
          >
            Send this invitation again
          </button>
        ))}

      {!session && !asyncOff && (
        <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">No interview sent yet.</p>
      )}

      {canResend && (
        <button
          type="button"
          onClick={() => {
            void handleSend();
          }}
          disabled={busy || asyncOff}
          className="flex w-full items-center justify-center gap-[7px] rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[11px] text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Video className="size-[15px]" strokeWidth={1.9} />
          {busy ? "Sending…" : session ? "Send a new link" : "Send video interview"}
        </button>
      )}

      {booking?.status === "booked" && booking.scheduledStart && (
        <div className="rounded-xl border border-[var(--ai-line)] px-3.5 py-3">
          <p className="m-0 text-[13px] font-bold text-[var(--ai-t1)]">
            {new Intl.DateTimeFormat("en-GB", {
              timeZone: booking.hostTimezone ?? "UTC",
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date(booking.scheduledStart))}
          </p>
          <p className="m-0 mt-0.5 text-[11.5px] text-[var(--ai-t3)]">
            {booking.durationMinutes} minutes
            {booking.hostTimezone ? ` · ${booking.hostTimezone}` : ""}
          </p>
          {booking.meetingUrl && (
            <a
              href={booking.meetingUrl}
              className="mt-2 inline-block text-[12.5px] font-semibold text-remotiv-purple underline underline-offset-2"
            >
              Join link
            </a>
          )}

          {cancelling ? (
            <div className="mt-3">
              <input
                type="text"
                value={cancelReason}
                maxLength={500}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Reason (optional)"
                className="mb-2 w-full rounded-[10px] border border-[var(--ai-line-strong)] px-2.5 py-2 text-[12.5px] outline-none focus:border-remotiv-purple"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleCancelBooking()}
                  className="rounded-[10px] bg-[#E0524B] px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
                >
                  {busy ? "Cancelling…" : "Cancel interview"}
                </button>
                <button
                  type="button"
                  onClick={() => setCancelling(false)}
                  className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ai-t3)]"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            booking.canCancel && (
              <button
                type="button"
                onClick={() => setCancelling(true)}
                className="mt-2 block text-[12.5px] font-semibold text-[var(--ai-t3)] hover:text-[#E0524B]"
              >
                Cancel interview
              </button>
            )
          )}
        </div>
      )}

      {booking?.status === "cancelled" && (
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          Interview cancelled
          {booking.cancelledBy === "candidate" ? " by the candidate" : ""}
          {booking.cancelReason ? ` — "${booking.cancelReason}"` : "."}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          void handleSendBooking();
        }}
        disabled={busy}
        className="flex w-full items-center justify-center gap-[7px] rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[11px] text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-remotiv-purple hover:bg-remotiv-purple hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CalendarClock className="size-[15px]" strokeWidth={1.9} />
        {busy ? "Sending…" : "Send booking link"}
      </button>

      {/*
        DISABLED WITH A REASON, not hidden.
        A missing button reads as a product that doesn't have the feature, and
        the recruiter has no way to discover that one switch stands between
        them and it — they file a bug, or conclude interviews aren't available
        on their plan. The greyed control plus the sentence names the setting
        and links straight to it, so the dead end is also the fix.
      */}
      {(canResend || canReissue) && asyncOff && (
        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
          Async video interviews are off for this job.{" "}
          {state?.jobId ? (
            <Link
              href={`/ai-dashboard/jobs/${state.jobId}/edit`}
              className="font-semibold text-remotiv-purple underline underline-offset-2"
            >
              Turn them on under More options
            </Link>
          ) : (
            <span className="font-semibold">
              Turn them on under More options in the job&apos;s settings
            </span>
          )}{" "}
          to send one.
        </p>
      )}

      {error && (
        <p className="m-0 rounded-xl bg-[var(--ai-danger-tint)] px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-[var(--ai-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
