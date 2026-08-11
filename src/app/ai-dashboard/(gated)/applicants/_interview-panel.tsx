"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import { Check, Clock, Send, Video, XCircle } from "lucide-react";
import { fetchInterviewPanel, sendInterviewInvite } from "./interview-actions";
import type { InterviewPanelState } from "./interview-types";

/**
 * The drawer's video-interview section.
 *
 * Sending is manual and explicit — nothing here fires on a stage change.
 * Re-sending is offered only where it is honest: an invite that expired or was
 * never opened. A SUBMITTED interview offers nothing, because submitted is
 * final and a button that produced a working link would contradict that.
 */

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const STATE: Record<
  string,
  { label: string; cls: string; icon: typeof Check }
> = {
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
    icon: XCircle,
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

  async function handleSend() {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof sendInterviewInvite>>;
    try {
      result = await sendInterviewInvite(applicationId);
    } catch {
      result = { success: false, error: "Couldn't send — please try again." };
    }
    setBusy(false);

    if (!result.success) {
      // Shown in place, not as a toast: "add questions to this job first" is
      // an instruction, and an instruction that fades is no instruction.
      setError(result.error);
      return;
    }
    onToast("Interview sent");
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
  const canResend =
    !session || session.status === "expired" || session.status === "cancelled";
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
          {session.status === "submitted"
            ? "Watch the interview"
            : "See what's recorded so far"}
        </Link>
      )}

      {!session && !asyncOff && (
        <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">
          No interview sent yet.
        </p>
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

      {/*
        DISABLED WITH A REASON, not hidden.
        A missing button reads as a product that doesn't have the feature, and
        the recruiter has no way to discover that one switch stands between
        them and it — they file a bug, or conclude interviews aren't available
        on their plan. The greyed control plus the sentence names the setting
        and links straight to it, so the dead end is also the fix.
      */}
      {canResend && asyncOff && (
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
