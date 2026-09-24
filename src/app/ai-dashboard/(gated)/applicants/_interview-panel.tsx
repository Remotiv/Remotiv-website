"use client";

import { AudioLines, CalendarClock, Check, CircleX, Clock, Send, Video } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  BAND_LABEL,
  BAND_PILL,
  type ScoreBand,
  scoreBand,
} from "@/app/ai-dashboard/lib/score-bands";
import { INTERVIEW_KIND_LABELS } from "@/lib/interviews/types";
import {
  type BookingPanel,
  cancelBookingAsRecruiter,
  fetchBookingPanel,
  sendBookingLink,
} from "./booking-actions";
import {
  fetchInterviewPanel,
  sendInterviewInvite,
  sendLiveInterviewInvite,
} from "./interview-actions";
import type { InterviewPanelState, InterviewSessionSummary } from "./interview-types";

/**
 * The drawer's Interviews pane — three sections, as the design has them:
 * async video, AI video, live call.
 *
 * Sending is manual and explicit — nothing here fires on a stage change.
 *
 * ── Where the design shows a value we do not hold ─────────────
 *
 * The space is CLOSED, not labelled and left blank. A heading over nothing is
 * worse than no heading: it reads as a load that failed rather than as a field
 * this product does not have. Three things went that way on the live-call
 * card and each is named at the point it would have appeared — the meeting
 * title, the attendee faces, and the "inside her working hours" line.
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

/* ──────────────────── the design's chrome ──────────────────── */

const CARD =
  "rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";
const CARD_PAD = "px-[22px] py-5";
const CHIP =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--ai-line-soft)] bg-[var(--ai-inset)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ai-t2)]";
/** The design's dashed "nothing here yet" box, used by every empty state. */
const EMPTY_BOX =
  "flex items-center gap-3.5 rounded-2xl border border-dashed border-[var(--ai-line-strong)] p-[18px]";
const BTN_PRIMARY =
  "flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl bg-remotiv-purple px-3.5 py-[11px] text-[13px] font-bold text-white transition-colors hover:bg-[var(--ai-purple-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER =
  "flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[11px] text-[13px] font-bold text-[var(--ai-danger)] transition-colors hover:border-[var(--ai-danger)] hover:bg-[var(--ai-danger)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Section head: title, a status badge, then a rule to the right margin.
 *
 * The badge sits HERE rather than inside the card, which is where the design
 * puts it. The design pairs it with a meeting title ("Technical panel") that
 * we hold no column for; with the title gone the card head would have been a
 * badge alone on a line, so the badge moved up to the one place on this pane
 * that already carries secondary status.
 */
function SubHead({ title, badge }: { title: string; badge?: React.ReactNode }) {
  return (
    <div className="mb-[13px] flex items-center gap-3">
      <h2 className="m-0 whitespace-nowrap font-heading text-[17px] font-bold tracking-[-0.025em] text-[var(--ai-t1)]">
        {title}
      </h2>
      {badge}
      <span className="h-px flex-1 bg-[var(--ai-line)]" aria-hidden="true" />
    </div>
  );
}

function StatusBadge({
  label,
  cls,
  icon: Icon,
}: {
  label: string;
  cls: string;
  icon: typeof Check;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${cls}`}
    >
      <Icon className="size-3" strokeWidth={2.2} />
      {label}
    </span>
  );
}

/* ──────────────────────── formatting ───────────────────────── */

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "18 Sep, 12:31" — when the candidate picked the slot. */
function fmtStamp(iso: string, zone: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: zone,
  })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone })}`;
}

function clockAt(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
}

/**
 * "GMT+5" — the offset, never the abbreviation.
 *
 * The design reads "14:00 CET" / "17:00 PKT", and ICU will not produce that
 * pair. `timeZoneName: "short"` gives Europe/Berlin "CEST" but Asia/Karachi
 * "GMT+5", and America/New_York "GMT-4" rather than EDT — so a row built from
 * abbreviations renders two different notations side by side and reads as a
 * bug. The offset is the one form every zone answers to.
 */
function offsetLabel(iso: string, zone: string): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** Calendar days apart in a chosen zone — not a rolling 24 hours, so a call
 *  at 09:00 tomorrow reads "Tomorrow" from 22:00 tonight. */
function daysUntil(iso: string, zone: string): number {
  const key = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: zone });
  const startOf = (k: string) => Date.parse(`${k}T00:00:00Z`);
  return Math.round((startOf(key(Date.parse(iso))) - startOf(key(Date.now()))) / 86_400_000);
}

function relativeDay(iso: string, zone: string): string {
  const n = daysUntil(iso, zone);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

const PROVIDER_LABELS: Record<string, string> = { google: "Google Meet" };

/* ───────────────────────── the states ──────────────────────── */

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

/** Ring stroke per band — the design's --ok-dot / --warn-dot / danger. */
const BAND_STROKE: Record<ScoreBand, string> = {
  hi: "#49D7A7",
  mid: "#e0a020",
  lo: "#E0524B",
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

/**
 * The results strip: ring, band pill, the model's verdict, and the meta row.
 *
 * Shared by both scored sections — the async round and the AI video round are
 * scored by the same pipeline into the same two tables, so a second copy would
 * have drifted the moment either changed.
 *
 * Deliberately NOT a copy of the review page. The per-question blocks and the
 * criteria list live at /ai-dashboard/interviews/[id] and run to roughly eight
 * hundred lines; reproducing them here would be a second implementation of the
 * same read, and the seek chips they carry are blank on most rows anyway. This
 * strip states the conclusion and hands off.
 */
function ResultStrip({
  session,
  action,
}: {
  session: InterviewSessionSummary;
  action: React.ReactNode;
}) {
  const scored = session.scoreStatus === "scored" && session.score !== null;
  const band = scored ? scoreBand(session.score as number) : null;

  return (
    <div className={CARD}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-[26px] px-6 py-[22px]">
        <div className="flex flex-col items-center gap-[11px]">
          <div className="relative size-[100px] shrink-0">
            <svg className="-rotate-90 size-[100px]" viewBox="0 0 100 100" aria-hidden="true">
              <circle
                cx="50"
                cy="50"
                r="44"
                fill="none"
                stroke="var(--ai-slate-tint)"
                strokeWidth="8"
              />
              {band && (
                <circle
                  cx="50"
                  cy="50"
                  r="44"
                  fill="none"
                  stroke={BAND_STROKE[band]}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - (session.score as number) / 100)}
                />
              )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
              {scored ? (
                <>
                  <b className="font-heading text-[30px] font-extrabold leading-none tracking-[-0.045em] text-[var(--ai-t1)]">
                    {session.score}
                  </b>
                  <i className="text-[10.5px] font-bold uppercase not-italic tracking-[0.06em] text-[var(--ai-t3)]">
                    out of 100
                  </i>
                </>
              ) : (
                <i className="px-2 text-center text-[10.5px] font-bold uppercase not-italic leading-tight tracking-[0.06em] text-[var(--ai-t4)]">
                  {session.scoreStatus === "failed" ? "Scoring failed" : "Not scored yet"}
                </i>
              )}
            </div>
          </div>
          {band && (
            <span
              className={`whitespace-nowrap rounded-full px-[11px] py-1 text-[10.5px] font-bold uppercase tracking-[0.06em] ${BAND_PILL[band]}`}
            >
              {BAND_LABEL[band]}
            </span>
          )}
        </div>

        <div className="min-w-0">
          <h3 className="m-0 font-heading text-[17px] font-bold leading-[1.3] tracking-[-0.025em] text-[var(--ai-t1)]">
            {session.verdict ?? "Recorded — not scored yet."}
          </h3>
          {session.summary && (
            <p className="m-0 mt-2 max-w-[600px] text-[12.5px] leading-[1.7] text-[var(--ai-t2)]">
              {session.summary}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={CHIP}>
              {session.answered} of {session.total} answered
            </span>
            {/* No duration chip. The design has one, and the two columns that
                could produce it disagree: a real session records 17s between
                started_at and submitted_at against 61s of recorded answer, so
                the wall clock is not a length anyone should read. */}
            {session.invitedByName && (
              <span className={CHIP}>
                Sent {fmt(session.sentAt)} by {session.invitedByName}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-stretch gap-2">{action}</div>
      </div>
      <p className="m-0 mt-1 border-t border-[var(--ai-line-soft)] px-6 pb-[18px] pt-3 text-[11px] leading-[1.6] text-[var(--ai-t3)]">
        Scored from the transcript only. Remotiv AI does not analyse face, voice, accent, eye
        contact or background. Per-question scores are advisory — a person decides.
      </p>
    </div>
  );
}

function ReviewLink({ session }: { session: InterviewSessionSummary }) {
  return (
    <Link
      href={`/ai-dashboard/interviews/${session.id}`}
      className="flex items-center justify-center gap-[7px] whitespace-nowrap rounded-xl border border-remotiv-purple bg-[var(--ai-surface)] px-3.5 py-[11px] text-[13px] font-bold text-remotiv-purple transition-colors hover:bg-remotiv-purple hover:text-white"
    >
      <Video className="size-[15px]" strokeWidth={1.9} />
      {session.status === "submitted" ? "Watch the interview" : "See what's recorded"}
    </Link>
  );
}

/* ═══════════════════════ the pane ═══════════════════════════ */

export function InterviewPanel({
  applicationId,
  onToast,
}: {
  applicationId: string;
  onToast: (message: string) => void;
}) {
  return (
    <div className="flex flex-col gap-7">
      <AsyncSection applicationId={applicationId} onToast={onToast} />
      <LiveInterviewSection applicationId={applicationId} onToast={onToast} />
      <BookingSection applicationId={applicationId} onToast={onToast} />
    </div>
  );
}

/* ─────────────────── 1. async video interview ──────────────── */

function AsyncSection({
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
      // This panel is the async one. A live panel passes "live" — the kind is
      // required on the server so neither can forget to say which.
      setState(await fetchInterviewPanel(applicationId, "async"));
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

  const session = state?.session ?? null;
  const badge = session ? (STATE[session.status] ?? STATE.invited) : null;

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
    <section>
      <SubHead
        title={INTERVIEW_KIND_LABELS.async}
        badge={badge ? <StatusBadge {...badge} /> : undefined}
      />

      {loading ? (
        <div className={`${CARD} ${CARD_PAD}`}>
          <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
        </div>
      ) : session && session.answered > 0 ? (
        <ResultStrip session={session} action={<ReviewLink session={session} />} />
      ) : (
        <div className={`${CARD} ${CARD_PAD}`}>
          <div className={EMPTY_BOX}>
            <div className="min-w-0">
              <b className="block text-[13px] font-bold text-[var(--ai-t1)]">
                {session ? badge?.label : "No interview sent"}
              </b>
              <p className="m-0 mt-[3px] max-w-[430px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                {session
                  ? session.status === "expired"
                    ? `The link expired on ${fmt(session.expiresAt)}. Send a new one to reopen it.`
                    : session.status === "cancelled"
                      ? "This interview was replaced by a newer one."
                      : `Sent ${fmt(session.sentAt)}${session.invitedByName ? ` by ${session.invitedByName}` : ""} · nothing recorded yet · link works until ${fmt(session.expiresAt)}.`
                  : "The candidate records answers to the job's questions in their own time. Remotiv scores the transcript and you watch whichever answers matter."}
              </p>
            </div>
            {canResend && !asyncOff && (
              <button
                type="button"
                onClick={() => {
                  void handleSend();
                }}
                disabled={busy}
                className={`ml-auto ${BTN_PRIMARY}`}
              >
                <Video className="size-[15px]" strokeWidth={1.9} />
                {busy ? "Sending…" : session ? "Send a new link" : "Send async interview"}
              </button>
            )}
          </div>
        </div>
      )}

      {canReissue &&
        !asyncOff &&
        session &&
        (reissuing ? (
          <div className="mt-2.5 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
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
            className="mt-2.5 self-start text-[12.5px] font-semibold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
          >
            Send this invitation again
          </button>
        ))}

      {/*
        DISABLED WITH A REASON, not hidden.
        A missing button reads as a product that doesn't have the feature, and
        the recruiter has no way to discover that one switch stands between
        them and it — they file a bug, or conclude interviews aren't available
        on their plan. The note names the setting and links straight to it, so
        the dead end is also the fix.
      */}
      {(canResend || canReissue) && asyncOff && (
        <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
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

      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mt-2.5 rounded-xl bg-[var(--ai-danger-tint)] px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-[var(--ai-danger)]">
      {children}
    </p>
  );
}

/* ───────────────────── 2. AI video interview ───────────────── */

/**
 * The AI Video Interview section — three states, as the design has them: not
 * sent, waiting, completed.
 *
 * ── All three are dormant, and that is expected ───────────────
 *
 * The send needs BOTH the company on the AI_VIDEO_INTERVIEW_COMPANY_IDS
 * allowlist — unset in production, because the candidate route has no live
 * screen yet — and the job's toggle on. No session has ever run: every row in
 * interview_sessions is kind "async", and interview_turns is empty. So
 * `waiting` and `completed` cannot render for anyone today. They are built
 * against real status rather than a demo flag so that the first session to run
 * lands in a finished screen instead of an empty one.
 *
 * A live session that already exists is shown whatever the switches say, for
 * the same reason the async panel shows one after its toggle is turned off:
 * only the SEND is conditional. With neither, the section is not in the page.
 *
 * Hidden rather than disabled with a reason, unlike async-off. That note
 * exists so a recruiter can find the switch; here there is no switch they
 * could flip that would make it work, so a greyed button would be a dead end.
 *
 * Its own state, busy flag and error, so a failed live send never reads as a
 * failed async one.
 */
function LiveInterviewSection({
  applicationId,
  onToast,
}: {
  applicationId: string;
  onToast: (message: string) => void;
}) {
  const [state, setState] = useState<InterviewPanelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reissuing, setReissuing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchInterviewPanel(applicationId, "live"));
    } catch (err) {
      console.error("[applicants] fetchInterviewPanel(live) threw:", err);
      setState(null);
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const session = state?.session ?? null;
  const canSend = Boolean(state?.liveAvailable && state.liveEnabled);
  const shown = Boolean(session) || canSend;

  async function handleSend(reissue = false) {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof sendLiveInterviewInvite>>;
    try {
      result = await sendLiveInterviewInvite(applicationId);
    } catch (err) {
      // Logged for the same reason as the async send: a thrown action's
      // message is replaced by a digest, and the digest needs this line.
      console.error("[applicants] sendLiveInterviewInvite threw:", err);
      result = { success: false, error: "Couldn't send — please try again." };
    }
    setBusy(false);
    setReissuing(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    onToast(reissue ? "New AI Video Interview link sent" : "AI Video Interview sent");
    await load();
  }

  if (!shown) return null;

  const badge = session ? (STATE[session.status] ?? STATE.invited) : null;
  const waiting = session?.status === "invited" || session?.status === "started";

  return (
    <section>
      <SubHead
        title={INTERVIEW_KIND_LABELS.live}
        badge={badge ? <StatusBadge {...badge} /> : undefined}
      />

      {session && session.answered > 0 ? (
        <ResultStrip session={session} action={<ReviewLink session={session} />} />
      ) : waiting && session ? (
        <div className={`${CARD} ${CARD_PAD}`}>
          <div className="flex items-center gap-4 rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[18px]">
            <div className="grid size-[52px] shrink-0 place-items-center rounded-full border-2 border-dashed border-[var(--ai-line-strong)] text-[var(--ai-t3)]">
              <Clock className="size-5" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <b className="block text-[13px] font-bold text-[var(--ai-t1)]">
                {session.status === "started" ? "Started, not finished" : "Sent — not started"}
              </b>
              <p className="m-0 mt-[3px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                Sent {fmt(session.sentAt)}
                {session.invitedByName ? ` by ${session.invitedByName}` : ""} · the link works until{" "}
                {fmt(session.expiresAt)}.
              </p>
            </div>
          </div>
          {/* The design's four-step line, minus "Opened". A session records no
              open — only a message does, and that is a different row about a
              different thing. Three steps that are all real beat four where
              one is always a dash. */}
          <div className="mt-3.5 flex border-t border-[var(--ai-line-soft)] pt-3.5">
            <Step label="Sent" value={fmt(session.sentAt)} />
            <Step label="Started" value={session.startedAt ? fmt(session.startedAt) : "—"} />
            <Step label="Expires" value={fmt(session.expiresAt)} />
          </div>
        </div>
      ) : (
        <div className={`${CARD} ${CARD_PAD}`}>
          <div className={EMPTY_BOX}>
            <div className="min-w-0">
              <b className="block text-[13px] font-bold text-[var(--ai-t1)]">
                A conversational round
              </b>
              {/* The design closes this paragraph with "Recommended here: it
                  would press directly on the mentoring gap…" — a per-candidate
                  recommendation with no generator behind it. Cut for the same
                  reason the Review tab's percentile was. What is left
                  describes the feature, which is a claim the product can keep. */}
              <p className="m-0 mt-[3px] max-w-[430px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                Questions are generated from this application and the async answers, and the
                interviewer follows up when an answer is thin.
              </p>
            </div>
            {canSend && (
              <button
                type="button"
                onClick={() => {
                  void handleSend();
                }}
                disabled={busy}
                className={`ml-auto ${BTN_PRIMARY}`}
              >
                <AudioLines className="size-[15px]" strokeWidth={1.9} />
                {busy ? "Sending…" : session ? "Send a new link" : "Send AI interview"}
              </button>
            )}
          </div>
        </div>
      )}

      {canSend &&
        waiting &&
        session &&
        (reissuing ? (
          <div className="mt-2.5 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
            <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
              {/* One string, so the space before "stops" cannot be lost to
                  JSX whitespace rules — it was, in the first build. */}
              {`Sends a fresh AI Video Interview invitation by email. The link${
                fmt(session.sentAt) ? ` from ${fmt(session.sentAt)}` : " they already have"
              } stops working straight away. Their async video interview isn't affected.`}
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
          <button
            type="button"
            onClick={() => setReissuing(true)}
            className="mt-2.5 self-start text-[12.5px] font-semibold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
          >
            Send this AI Video Interview again
          </button>
        ))}

      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function Step({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 pr-3.5">
      <b className="block text-[11.5px] font-bold text-[var(--ai-t1)]">{label}</b>
      <span className="text-[11px] font-medium text-[var(--ai-t3)]">{value}</span>
    </div>
  );
}

/* ────────────────────────── 3. live call ───────────────────── */

const BOOKING_BADGE: Record<string, { label: string; cls: string; icon: typeof Check }> = {
  booked: {
    label: "Confirmed",
    cls: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
    icon: Check,
  },
  invited: {
    label: "Link sent",
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    icon: Send,
  },
  cancelled: {
    label: "Cancelled",
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    icon: CircleX,
  },
};

/**
 * A booked call, in the recruiter's diary.
 *
 * ── Three things the design shows that we hold no column for ──
 *
 * The meeting TITLE ("Technical panel") — interview_bookings has no title, and
 * the calendar summary is generated at booking time and never stored. The
 * ATTENDEE FACES — there is no attendees table; exactly two people are put on
 * the invitation, the host and the candidate, so four avatars would be an
 * invention. And "INSIDE HER STATED WORKING HOURS" — availability_rules is
 * keyed by member_id, so those are the recruiter's hours, not the candidate's;
 * nothing anywhere records a candidate's stated hours.
 *
 * Each space is closed rather than left labelled and blank.
 *
 * ── No reschedule button, on purpose ──────────────────────────
 *
 * A reschedule is the CANDIDATE's choice of slot. A recruiter silently moving
 * someone into a time they never agreed to is not a reschedule, it is a new
 * appointment. What the recruiter can do is cancel and send a fresh link,
 * which is two deliberate acts rather than one invisible one.
 */
function BookingSection({
  applicationId,
  onToast,
}: {
  applicationId: string;
  onToast: (message: string) => void;
}) {
  const [booking, setBooking] = useState<BookingPanel>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    try {
      setBooking(await fetchBookingPanel(applicationId));
    } catch (err) {
      console.error("[applicants] fetchBookingPanel threw:", err);
    } finally {
      setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function handleCancel() {
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
    await load();
  }

  async function handleSendLink() {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof sendBookingLink>>;
    try {
      result = await sendBookingLink(applicationId);
    } catch (err) {
      // See the note on the async send — an unexplained throw must not be silent.
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

  const badge = booking ? BOOKING_BADGE[booking.status] : undefined;
  const scheduled = booking?.status === "booked" && booking.scheduledStart;

  return (
    <section>
      <SubHead title="Live call" badge={badge ? <StatusBadge {...badge} /> : undefined} />

      <div className={`${CARD} ${CARD_PAD}`}>
        {loading ? (
          <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
        ) : scheduled && booking?.scheduledStart ? (
          <ScheduledCall
            booking={booking}
            start={booking.scheduledStart}
            busy={busy}
            cancelling={cancelling}
            cancelReason={cancelReason}
            onCancelReason={setCancelReason}
            onStartCancel={() => setCancelling(true)}
            onKeep={() => setCancelling(false)}
            onConfirmCancel={() => void handleCancel()}
          />
        ) : (
          <div className={EMPTY_BOX}>
            <div className="min-w-0">
              <b className="block text-[13px] font-bold text-[var(--ai-t1)]">
                {booking?.status === "cancelled" ? "Call cancelled" : "Send a booking link"}
              </b>
              <p className="m-0 mt-[3px] max-w-[430px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">
                {booking?.status === "cancelled" ? (
                  <>
                    Cancelled
                    {booking.cancelledBy === "candidate" ? " by the candidate" : " by your team"}
                    {booking.cancelReason ? ` — “${booking.cancelReason}”` : "."} Send a new link to
                    offer fresh times.
                  </>
                ) : booking?.status === "invited" ? (
                  "The link is with the candidate. They pick from your open slots and the call lands in your calendar."
                ) : (
                  /* The design adds "Her working day is 12:00–21:00 UTC+5, so
                     only slots inside that window will be offered." Cut: the
                     candidate's hours are not recorded anywhere, and the slots
                     offered come from the recruiter's availability_rules. */
                  "The candidate picks from your open slots. The call lands in your calendar and theirs."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void handleSendLink();
              }}
              disabled={busy}
              className={`ml-auto ${BTN_PRIMARY}`}
            >
              <CalendarClock className="size-[15px]" strokeWidth={1.9} />
              {busy ? "Sending…" : booking ? "Send a new link" : "Send booking link"}
            </button>
          </div>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function ScheduledCall({
  booking,
  start,
  busy,
  cancelling,
  cancelReason,
  onCancelReason,
  onStartCancel,
  onKeep,
  onConfirmCancel,
}: {
  booking: NonNullable<BookingPanel>;
  start: string;
  busy: boolean;
  cancelling: boolean;
  cancelReason: string;
  onCancelReason: (v: string) => void;
  onStartCancel: () => void;
  onKeep: () => void;
  onConfirmCancel: () => void;
}) {
  const hostZone = booking.hostTimezone ?? "UTC";
  const candidateZone = booking.candidateTimezone ?? hostZone;
  /*
   * ONE clock when the zones match, two when they differ.
   *
   * Not a shortcut — every booking taken so far has the candidate and the host
   * in the same zone, and a row printing "17:00 · Your time" beside an
   * identical "17:00 · Candidate" reads as a rendering fault. The second cell
   * earns its place only when it says something different.
   */
  const sameZone = hostZone === candidateZone;
  const d = new Date(start);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6">
      <div className="min-w-0">
        <div className="flex items-center gap-4">
          <div className="flex size-[58px] shrink-0 flex-col items-center justify-center rounded-2xl bg-[var(--ai-purple-tint)]">
            <b className="font-heading text-[21px] font-extrabold leading-none tracking-[-0.03em] text-[var(--ai-purple-ink)]">
              {d.toLocaleDateString("en-GB", { day: "numeric", timeZone: hostZone })}
            </b>
            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-remotiv-purple">
              {d.toLocaleDateString("en-GB", { month: "short", timeZone: hostZone })}
            </span>
          </div>
          <div className="min-w-0">
            <h4 className="m-0 font-heading text-[15px] font-bold tracking-[-0.02em] text-[var(--ai-t1)]">
              {d.toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
                timeZone: hostZone,
              })}{" "}
              · {clockAt(start, hostZone)}
              {booking.scheduledEnd ? ` – ${clockAt(booking.scheduledEnd, hostZone)}` : ""}
            </h4>
            {/* The provenance line, with "in 5 days" folded onto it. The design
                gives that its own cell in the clock row, paired with a
                subtitle we cannot produce; alone it left the row ragged. */}
            <p className="m-0 mt-1 text-[12px] font-semibold text-[var(--ai-t3)]">
              {booking.bookedAt
                ? `Booked by the candidate ${fmtStamp(booking.bookedAt, hostZone)} · `
                : ""}
              {booking.durationMinutes} minutes
              {booking.provider
                ? ` · ${PROVIDER_LABELS[booking.provider] ?? booking.provider}`
                : ""}{" "}
              · {relativeDay(start, hostZone)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex border-t border-[var(--ai-line-soft)] pt-3">
          <TimeCell
            time={`${clockAt(start, hostZone)} ${offsetLabel(start, hostZone)}`}
            label={sameZone ? `You and the candidate · ${hostZone}` : `Your time · ${hostZone}`}
            last={sameZone}
          />
          {!sameZone && (
            <TimeCell
              time={`${clockAt(start, candidateZone)} ${offsetLabel(start, candidateZone)}`}
              label={`Candidate · ${candidateZone}`}
              last
            />
          )}
        </div>

        {cancelling && (
          <div className="mt-3.5 border-t border-[var(--ai-line-soft)] pt-3.5">
            <input
              type="text"
              value={cancelReason}
              maxLength={500}
              onChange={(e) => onCancelReason(e.target.value)}
              placeholder="Reason (optional) — the candidate is told the call is off either way"
              className="mb-2 w-full rounded-[10px] border border-[var(--ai-line-strong)] px-2.5 py-2 text-[12.5px] outline-none focus:border-remotiv-purple"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onConfirmCancel}
                className="rounded-[10px] bg-[#E0524B] px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "Cancelling…" : "Cancel the call"}
              </button>
              <button
                type="button"
                onClick={onKeep}
                className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ai-t3)]"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {booking.meetingUrl && (
          <a
            href={booking.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={BTN_PRIMARY}
          >
            Join call
          </a>
        )}
        {booking.canCancel && !cancelling && (
          <button type="button" onClick={onStartCancel} className={BTN_DANGER}>
            Cancel call
          </button>
        )}
      </div>
    </div>
  );
}

function TimeCell({ time, label, last }: { time: string; label: string; last: boolean }) {
  return (
    <div className={last ? "" : "mr-[26px] border-r border-[var(--ai-line-soft)] pr-[26px]"}>
      <b className="block text-[13px] font-bold text-[var(--ai-t1)]">{time}</b>
      <span className="whitespace-nowrap text-[11px] font-semibold text-[var(--ai-t3)]">
        {label}
      </span>
    </div>
  );
}
