"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Clock,
  Copy,
  Lock,
  Mic,
  TriangleAlert,
  Archive,
  Trash2,
  Users,
  UserX,
  Video,
  VideoOff,
} from "lucide-react";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
} from "@/app/ai-dashboard/lib/applicant-types";
import { updateApplicationStage } from "@/app/ai-dashboard/(gated)/applicants/actions";
import type {
  InterviewAnswerView,
  InterviewNote,
  InterviewSessionDetail,
} from "@/lib/interviews/review-types";
import {
  addInterviewNote,
  deleteInterview,
  deleteInterviewNote,
  getAnswerPlaybackUrl,
  setInterviewArchived,
  updateInterviewNote,
} from "../actions";

/**
 * Interview review — a working page, deliberately without a hero.
 *
 * ── The states are the substance ─────────────────────────────
 *
 * Most of what a reviewer sees today is NOT a playing video with a transcript
 * beside it. There is no OpenAI key configured, so every transcript is
 * pending; a session in testing has already passed its six-month retention and
 * has no media at all. Each of those has to read as a deliberate state rather
 * than as a page that failed to load, which is most of what this file is.
 */

function mmss(total: number | null): string {
  if (!total || total < 0) return "—";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

export function ReviewClient({ session }: { session: InterviewSessionDetail }) {
  const firstPlayable = session.answers.findIndex((a) => a.hasVideo);
  const [active, setActive] = useState(
    firstPlayable >= 0 ? firstPlayable : 0,
  );
  const [stage, setStage] = useState(session.stage);
  const [toast, setToast] = useState<string | null>(null);
  const [archivedAt, setArchivedAt] = useState(session.archivedAt);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const answer: InterviewAnswerView | undefined = session.answers[active];

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function onStage(next: string) {
    const prev = stage;
    setStage(next);
    // Reuses the applicants action — the pipeline has ONE write path, and a
    // second one here would drift on stage-change emails and the audit trail.
    const res = await updateApplicationStage(session.applicationId ?? "", next);
    if (!res.success) {
      setStage(prev);
      setToast(res.error);
      return;
    }
    setToast(`Moved to ${PIPELINE_STAGE_LABELS[next as never] ?? next}`);
  }

  const answeredCount = session.answers.length;

  return (
    <PageContainer>
      {/* ── Working header ── */}
      <div className="mb-[18px] flex flex-col gap-4 min-[840px]:flex-row min-[840px]:items-center min-[840px]:justify-between min-[840px]:gap-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <Link
            href="/ai-dashboard/interviews"
            aria-label="Back to interviews"
            className="flex size-[38px] shrink-0 items-center justify-center rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          >
            <ChevronLeft className="size-[17px]" strokeWidth={2.2} />
          </Link>
          {session.candidateLink === "linked" ? (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--ai-purple-tint)] text-sm font-bold text-[var(--ai-purple-ink)]">
              {initials(session.candidateName)}
            </span>
          ) : (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
              <UserX className="size-[18px]" strokeWidth={1.8} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="m-0 truncate font-heading text-[22px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--ai-t1)] min-[840px]:text-[26px]">
              {session.candidateName}
            </h1>
            <p className="m-0 mt-1 flex flex-wrap items-center gap-2 text-[13px] text-[var(--ai-t3)]">
              <span className="truncate">{session.jobTitle}</span>
              <span className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />
              <span>{headerWhen(session)}</span>
              {session.candidateLink !== "linked" && (
                <>
                  <span className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />
                  <span className="italic">
                    {session.candidateLink === "deleted"
                      ? "applicant record removed"
                      : "no applicant record"}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-bold ${
              answeredCount === 0
                ? "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]"
                : answeredCount >= session.totalQuestions
                  ? "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]"
                  : "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]"
            }`}
          >
            {answeredCount === 0
              ? "Not started"
              : `${answeredCount} of ${session.totalQuestions} answered`}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void setInterviewArchived(session.id, archivedAt === null).then(
                (r) => {
                  setBusy(false);
                  if (!r.ok) {
                    setToast(r.error);
                    return;
                  }
                  const next = archivedAt === null ? new Date().toISOString() : null;
                  setArchivedAt(next);
                  setToast(next ? "Archived" : "Restored to the list");
                },
              );
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[11px] text-[13px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:opacity-50"
          >
            <Archive className="size-[15px]" strokeWidth={1.9} />
            {archivedAt === null ? "Archive" : "Restore"}
          </button>

          {session.canDelete && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[11px] text-[13px] font-semibold text-[var(--ai-t3)] transition-colors hover:border-[var(--ai-danger)] hover:bg-[var(--ai-danger)] hover:text-white"
            >
              <Trash2 className="size-[15px]" strokeWidth={1.9} />
              Delete
            </button>
          )}

          {session.applicationId && (
            <select
              value={stage}
              onChange={(e) => void onStage(e.target.value)}
              aria-label="Pipeline stage"
              className="cursor-pointer appearance-none rounded-xl border-[1.5px] border-[var(--ai-line-strong)] bg-[var(--ai-surface)] py-[11px] pl-3.5 pr-8 text-[13.5px] font-bold text-[var(--ai-t1)] outline-none focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]"
            >
              {PIPELINE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {PIPELINE_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {archivedAt !== null && (
        <Notice tone="slate" icon={<Archive className="size-[17px]" strokeWidth={2} />}>
          <b className="font-bold">Archived.</b> Hidden from the interviews list
          and its counts. The recording, transcripts and notes are untouched,
          and the candidate is unaffected — archiving is not the same as
          cancelling an invitation. Restore puts it back exactly as it was.
        </Notice>
      )}

      <SessionNotice session={session} />

      {answeredCount === 0 ? (
        <NothingRecorded session={session} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-3.5 min-[1017px]:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)]">
          {/* ── Left: player + question + transcript ── */}
          <div className="min-w-0">
            {answer && <Player key={answer.id} sessionId={session.id} answer={answer} />}

            <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
              <div className="px-5 py-[18px]">
                <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)]">
                    Question {active + 1} of {session.totalQuestions}
                  </span>
                  {answer?.competency && (
                    <span className="rounded-md bg-[var(--ai-purple-tint)] px-2.5 py-[3px] text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-purple-ink)]">
                      {answer.competency}
                    </span>
                  )}
                </div>
                <p className="m-0 mb-4 text-[16.5px] font-bold leading-snug tracking-[-0.015em] text-[var(--ai-t1)]">
                  {answer?.questionText}
                </p>

                <div className="border-t border-[var(--ai-line-soft)] pt-[15px]">
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <p className="m-0 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)]">
                      Transcript
                    </p>
                    {answer?.transcriptState === "done" && (
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(answer.transcript ?? "")
                            .then(() => setToast("Transcript copied"))
                            .catch(() => setToast("Couldn't copy that"));
                        }}
                        className="inline-flex items-center gap-1.5 border-none bg-transparent p-0 text-[11.5px] font-bold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
                      >
                        <Copy className="size-[13px]" strokeWidth={2} />
                        Copy
                      </button>
                    )}
                  </div>
                  {answer && <Transcript answer={answer} />}
                </div>
              </div>
            </div>
          </div>

          {/* ── Right: answer list + notes ── */}
          <div className="min-w-0">
            <div className="mb-3.5 overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
              <div className="flex items-center justify-between gap-2.5 border-b border-[var(--ai-line)] px-[15px] py-3">
                <p className="m-0 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)]">
                  Answers
                </p>
                <span className="text-[11.5px] font-bold text-[var(--ai-t3)]">
                  {answeredCount} recorded
                </span>
              </div>
              {session.answers.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setActive(i)}
                  className={`relative flex w-full items-center gap-[11px] border-b border-[var(--ai-line-soft)] px-[15px] py-3 text-left transition-colors last:border-b-0 ${
                    i === active
                      ? "bg-[var(--ai-purple-tint)]"
                      : "bg-[var(--ai-surface)] hover:bg-[#FCFBFA]"
                  }`}
                >
                  <span
                    className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple ${i === active ? "" : "opacity-0"}`}
                  />
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-lg text-[11.5px] font-extrabold ${
                      i === active
                        ? "bg-remotiv-purple text-white"
                        : "bg-[var(--ai-inset)] text-[var(--ai-t3)]"
                    }`}
                  >
                    {a.position}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`m-0 block truncate text-[13px] leading-tight ${
                        i === active
                          ? "font-bold text-[var(--ai-purple-ink)]"
                          : "font-semibold text-[var(--ai-t1)]"
                      }`}
                    >
                      {a.questionText}
                    </span>
                    {a.purged && (
                      <span className="mt-0.5 block text-[11.5px] font-bold text-[var(--ai-t4)]">
                        Recording removed
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 text-xs font-semibold tabular-nums ${
                      i === active
                        ? "font-bold text-[var(--ai-purple-ink)]"
                        : "text-[var(--ai-t3)]"
                    }`}
                  >
                    {mmss(a.durationSeconds)}
                  </span>
                </button>
              ))}
            </div>

            <NotesCard
              sessionId={session.id}
              initial={session.notes}
              viewerMemberId={session.viewerMemberId}
              onToast={setToast}
            />

            <p className="m-0 mt-[18px] flex items-start gap-2.5 px-0.5 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
              <Lock className="mt-px size-[15px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
              <span>{retentionLine(session)}</span>
            </p>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <DeleteConfirm
          session={session}
          busy={busy}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setBusy(true);
            void deleteInterview(session.id).then((r) => {
              setBusy(false);
              if (!r.ok) {
                setConfirmingDelete(false);
                setToast(r.error);
                return;
              }
              router.push("/ai-dashboard/interviews");
              router.refresh();
            });
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-7 left-1/2 z-[200] -translate-x-1/2 rounded-[13px] bg-[var(--ai-sidebar)] px-[19px] py-3.5 text-[13.5px] font-semibold text-white shadow-[0_18px_44px_rgba(0,0,0,0.34)]">
          {toast}
        </div>
      )}
    </PageContainer>
  );
}

/**
 * The confirm step.
 *
 * Names the candidate, counts the recordings, and says in plain words that the
 * video is destroyed — "delete" alone reads like archiving to most people, and
 * this is the one action in the product that reaches into storage.
 */
function DeleteConfirm({
  session,
  busy,
  onCancel,
  onConfirm,
}: {
  session: InterviewSessionDetail;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const withVideo = session.answers.filter((a) => a.hasVideo).length;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-6 backdrop-blur-[5px]">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-[470px] overflow-hidden rounded-3xl bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        <div className="bg-[var(--ai-sidebar)] px-7 pb-[22px] pt-6">
          <h2 className="m-0 font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white">
            Delete this interview?
          </h2>
          <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
            {session.candidateName} · {session.jobTitle}
          </p>
        </div>
        <div className="px-7 py-6">
          <p className="m-0 text-[13.5px] leading-relaxed text-[var(--ai-t2)]">
            {withVideo > 0 ? (
              <>
                <b className="font-bold text-[var(--ai-t1)]">
                  {withVideo} recording{withVideo === 1 ? "" : "s"} will be
                  permanently destroyed
                </b>
                , along with the transcripts, this interview&apos;s answers and
                every reviewer note on it.
              </>
            ) : (
              <>
                <b className="font-bold text-[var(--ai-t1)]">
                  This interview and every reviewer note on it will be
                  permanently deleted.
                </b>{" "}
                There are no recordings left to remove.
              </>
            )}
          </p>
          <p className="m-0 mt-3 text-[13.5px] font-bold leading-relaxed text-[var(--ai-danger)]">
            This cannot be undone.
          </p>
          <p className="m-0 mt-3 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            If you only want it out of your list, cancel and use{" "}
            <b className="font-bold text-[var(--ai-t2)]">Archive</b> instead —
            that hides it and keeps everything.
          </p>
          <div className="mt-6 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-xl border border-[var(--ai-line-strong)] bg-transparent px-[17px] py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:opacity-50"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="rounded-xl border border-[var(--ai-danger)] bg-[var(--ai-danger)] px-[17px] py-[11px] text-[13.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function headerWhen(s: InterviewSessionDetail): string {
  if (s.status === "submitted") return `Submitted ${fmtDate(s.submittedAt)}`;
  if (s.status === "started") return "Started · not submitted";
  if (s.status === "expired") return `Expired ${fmtDate(s.expiresAt)}`;
  if (s.status === "cancelled") return "Invitation cancelled";
  return `Invited ${fmtDate(s.sentAt)} · due ${fmtDate(s.expiresAt)}`;
}

function retentionLine(s: InterviewSessionDetail): string {
  if (s.purged) {
    return "The recordings were deleted six months after submission, as scheduled. Questions, transcripts and the answer record are kept with the application.";
  }
  if (s.status !== "submitted") {
    return "Retention starts at submission — recordings are then kept for 6 months.";
  }
  return s.deleteAfter
    ? `Recordings are deleted automatically on ${fmtDate(s.deleteAfter)} — six months after submission.`
    : "Recordings are deleted automatically six months after submission.";
}

/** Session-level banner for the states that change how the page should be read. */
function SessionNotice({ session }: { session: InterviewSessionDetail }) {
  if (session.purged) {
    return (
      <Notice tone="slate" icon={<Lock className="size-[17px]" strokeWidth={2} />}>
        <b className="font-bold">Recordings removed after six months.</b> Deleted
        on schedule under the retention policy the candidate agreed to.
        Questions, durations and the answer record remain below.
      </Notice>
    );
  }
  if (session.status === "started") {
    return (
      <Notice tone="sky" icon={<Clock className="size-[17px]" strokeWidth={2} />}>
        <b className="font-bold">Still in progress.</b>{" "}
        {session.candidateName.split(" ")[0]} has recorded{" "}
        {session.answers.length} of {session.totalQuestions} answers and can
        still re-record before submitting. Watch what's here if you like, but
        hold off deciding until it's complete.
      </Notice>
    );
  }
  if (session.status === "cancelled") {
    return (
      <Notice tone="slate" icon={<TriangleAlert className="size-[17px]" strokeWidth={2} />}>
        <b className="font-bold">This invitation was cancelled.</b> It was
        replaced by a newer one, or withdrawn. Anything recorded before that is
        still below.
      </Notice>
    );
  }
  return null;
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "sky" | "slate";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === "sky"
      ? "border-[rgba(76,141,217,0.26)] bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]"
      : "border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t2)]";
  return (
    <div className={`mb-4 flex gap-3 rounded-[14px] border px-4 py-3.5 ${cls}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <p className="m-0 text-[13px] leading-relaxed text-current">{children}</p>
    </div>
  );
}

/**
 * The player.
 *
 * The signed URL is fetched on demand and never stored — a fresh one is minted
 * each time an answer is selected, and it expires in five minutes. The storage
 * path is not part of any prop on this page.
 */
function Player({
  sessionId,
  answer,
}: {
  sessionId: string;
  answer: InterviewAnswerView;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(false);

  const load = useCallback(async () => {
    if (asked.current) return;
    asked.current = true;
    setLoading(true);
    const res = await getAnswerPlaybackUrl(sessionId, answer.id);
    setLoading(false);
    if (res.ok) setUrl(res.url);
    else setError(res.error);
  }, [sessionId, answer.id]);

  useEffect(() => {
    if (answer.hasVideo) void load();
  }, [answer.hasVideo, load]);

  if (answer.purged) {
    return (
      <FlatPlayer
        icon={<Lock className="size-[25px]" strokeWidth={1.7} />}
        title="Recording deleted on schedule"
        body="This answer was removed six months after submission, exactly as the retention policy says. The question, its duration and your team's notes are kept."
      />
    );
  }
  if (!answer.hasVideo) {
    return (
      <FlatPlayer
        icon={<VideoOff className="size-[25px]" strokeWidth={1.7} />}
        title="No recording for this question"
        body="The candidate didn't record an answer here."
      />
    );
  }
  if (error) {
    return (
      <FlatPlayer
        icon={<TriangleAlert className="size-[25px]" strokeWidth={1.7} />}
        title="Couldn't load this recording"
        body={error}
      />
    );
  }

  return (
    <div className="mb-3.5 aspect-video overflow-hidden rounded-[18px] bg-[var(--ai-sidebar)] shadow-[0_12px_36px_rgba(20,16,32,0.2)]">
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: the transcript below IS the caption track
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          className="size-full object-contain"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-white/40">
          <Video className={`size-8 ${loading ? "animate-pulse" : ""}`} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

/** A deliberate panel, not a broken player: dashed border, icon, explanation. */
function FlatPlayer({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="mb-3.5 flex aspect-video flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] p-7 text-center">
      <span className="flex size-14 items-center justify-center rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t4)]">
        {icon}
      </span>
      <h4 className="m-0 font-heading text-base font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
        {title}
      </h4>
      <p className="m-0 max-w-[360px] text-[13px] leading-relaxed text-[var(--ai-t3)]">
        {body}
      </p>
    </div>
  );
}

/**
 * Transcript, in five states.
 *
 * `pending` is the DEFAULT today — OPENAI_API_KEY is not configured, so every
 * answer sits here. It must read as "not yet, and nothing is wrong with the
 * recording" rather than as a panel that failed to load, which is why it gets
 * a full explanation and shimmer bars instead of a spinner or a blank.
 */
function Transcript({ answer }: { answer: InterviewAnswerView }) {
  if (answer.transcriptState === "done") {
    return (
      <p className="m-0 text-[13.5px] leading-[1.78] text-[var(--ai-t2)]">
        {answer.transcript}
      </p>
    );
  }

  const copy = {
    pending: {
      title: "Transcript not available yet",
      body: "Transcription isn't switched on for this workspace, so answers are video-only for now. Nothing is missing from the recording — watch and score it as normal.",
    },
    failed: {
      title: "Transcription didn't complete",
      body:
        answer.transcriptError?.slice(0, 200) ??
        "The transcription service couldn't process this recording. The video is unaffected.",
    },
    skipped: {
      title: "Transcript skipped",
      body: "This answer was deliberately not transcribed. The recording is unaffected.",
    },
    empty: {
      title: "Nothing was transcribed",
      body: "Transcription ran but returned no words — usually silence or an inaudible recording. Worth watching the video to check.",
    },
    done: { title: "", body: "" },
  }[answer.transcriptState];

  return (
    <>
      <div className="flex gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-[15px]">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t3)]">
          <Mic className="size-4" strokeWidth={1.9} />
        </span>
        <span className="min-w-0">
          <p className="m-0 text-[13px] font-bold leading-tight text-[var(--ai-t1)]">
            {copy.title}
          </p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            {copy.body}
          </p>
        </span>
      </div>
      {answer.transcriptState === "pending" && (
        <div className="mt-3 flex flex-col gap-[7px]">
          {["100%", "96%", "88%"].map((w) => (
            <i
              key={w}
              className="block h-[9px] rounded-[5px] bg-[rgba(20,16,32,0.06)]"
              style={{ width: w }}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Invited or expired with nothing recorded — there is no review to show. */
function NothingRecorded({ session }: { session: InterviewSessionDetail }) {
  const expired = session.status === "expired";
  return (
    <div className="rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-8 pb-14 pt-[52px] text-center shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
      <span className="mb-[18px] inline-flex size-[68px] items-center justify-center rounded-[22px] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
        <VideoOff className="size-[30px]" strokeWidth={1.8} />
      </span>
      <h3 className="m-0 mb-2.5 font-heading text-[21px] font-extrabold tracking-[-0.028em] text-[var(--ai-t1)]">
        {expired
          ? `${session.candidateName.split(" ")[0]} never started this interview`
          : `${session.candidateName.split(" ")[0]} hasn't started yet`}
      </h3>
      <p className="m-0 mx-auto mb-5 max-w-[430px] text-sm leading-relaxed text-[var(--ai-t3)]">
        {expired
          ? `The invitation expired on ${fmtDate(session.expiresAt)} with nothing recorded. Send a new one from their applicant record if you'd still like to hear from them.`
          : `The invitation went out on ${fmtDate(session.sentAt)} and the link is open until ${fmtDate(session.expiresAt)}. You'll see answers here as they come in — there's nothing to do until then.`}
      </p>
      {session.applicationId && (
        <Link
          href={`/ai-dashboard/applicants?open=${session.applicationId}`}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[18px] py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
        >
          <Users className="size-[15px]" strokeWidth={1.9} />
          Open applicant record
        </Link>
      )}
    </div>
  );
}

/**
 * Reviewer notes — a thread, not one editable blob.
 *
 * Two people watching the same interview each add a note. Nobody overwrites a
 * colleague, and the order the notes arrived in is part of what the record
 * says. Own notes can be edited or deleted; someone else's cannot be touched,
 * enforced on the statement itself server-side, not just by hiding a button.
 *
 * Rendered independently of the media, so it survives a purge — see the note
 * on `notes` in the reader.
 */
function NotesCard({
  sessionId,
  initial,
  viewerMemberId,
  onToast,
}: {
  sessionId: string;
  initial: InterviewNote[];
  viewerMemberId: string;
  onToast: (message: string) => void;
}) {
  const [notes, setNotes] = useState(initial);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(
    fn: () => Promise<
      { ok: true; notes: InterviewNote[] } | { ok: false; error: string }
    >,
    success?: string,
  ) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      onToast(res.error);
      return false;
    }
    setNotes(res.notes);
    if (success) onToast(success);
    return true;
  }

  return (
    <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
      <div className="flex items-center justify-between gap-2.5 border-b border-[var(--ai-line)] px-[15px] py-3">
        <p className="m-0 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)]">
          Reviewer notes
        </p>
        {notes.length > 0 && (
          <span className="text-[11.5px] font-bold text-[var(--ai-t3)]">
            {notes.length}
          </span>
        )}
      </div>

      <div className="px-[15px] py-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What stood out? Anything you want the team to see before deciding."
          className="min-h-[96px] w-full resize-y rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ai-t1)] outline-none transition-colors placeholder:text-[var(--ai-t4)] hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]"
        />
        <div className="mt-[11px] flex items-center justify-between gap-3">
          <span className="flex items-center gap-[7px] text-[11.5px] leading-snug text-[var(--ai-t3)]">
            <Users className="size-[13px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
            Visible to everyone on this job&apos;s team
          </span>
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => {
              void run(
                () => addInterviewNote(sessionId, draft),
                "Note saved — your team can see it",
              ).then((ok) => {
                if (ok) setDraft("");
              });
            }}
            className="inline-flex shrink-0 items-center gap-[7px] rounded-full border border-remotiv-purple bg-remotiv-purple px-4 py-2 text-[12.5px] font-bold text-white shadow-[0_5px_16px_rgba(126,71,255,0.28)] transition-colors hover:bg-[var(--ai-purple-hover,#6D38F0)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            Save note
          </button>
        </div>

        {notes.length === 0 && (
          /* Edit/Delete only appear on a note you wrote, so on an empty thread
             there is nothing to hover and their absence looks like a missing
             feature. Saying it once here costs a line and answers it. */
          <p className="m-0 mt-3 border-t border-[var(--ai-line-soft)] pt-3 text-[11.5px] leading-relaxed text-[var(--ai-t4)]">
            No notes yet. Notes are attributed and timestamped, and you can edit
            or delete your own afterwards — your teammates&apos; stay as they
            wrote them.
          </p>
        )}

        {notes.length > 0 && (
          <div className="mt-3.5 flex flex-col gap-3 border-t border-[var(--ai-line-soft)] pt-3.5">
            {notes.map((n) => {
              const mine = n.memberId === viewerMemberId && viewerMemberId !== "";
              const edited =
                n.updatedAt !== null && n.updatedAt !== n.createdAt;

              if (editingId === n.id) {
                return (
                  <div key={n.id} className="flex flex-col gap-2">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="min-h-[80px] w-full resize-y rounded-xl border border-remotiv-purple bg-[var(--ai-surface)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--ai-t1)] outline-none ring-[3px] ring-remotiv-purple/[0.16]"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-full border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-1.5 text-[12px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy || !editDraft.trim()}
                        onClick={() => {
                          void run(
                            () => updateInterviewNote(sessionId, n.id, editDraft),
                            "Note updated",
                          ).then((ok) => {
                            if (ok) setEditingId(null);
                          });
                        }}
                        className="rounded-full border border-remotiv-purple bg-remotiv-purple px-3.5 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-[var(--ai-purple-hover,#6D38F0)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={n.id} className="group flex gap-2.5">
                  <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--ai-mint-tint)] text-[9.5px] font-extrabold text-[var(--ai-mint-ink)]">
                    {initials(n.authorName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
                      {n.body}
                    </p>
                    <div className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-1">
                      <small className="text-[11px] text-[var(--ai-t4)]">
                        {n.authorName} · {noteWhen(n.createdAt)}
                        {/* An edit is disclosed rather than silent — a note
                            that changed after a colleague read it should say so. */}
                        {edited ? " · edited" : ""}
                      </small>
                      {mine && (
                        <span className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(n.id);
                              setEditDraft(n.body);
                            }}
                            className="border-none bg-transparent p-0 text-[11px] font-bold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void run(
                                () => deleteInterviewNote(sessionId, n.id),
                                "Note deleted",
                              );
                            }}
                            className="border-none bg-transparent p-0 text-[11px] font-bold text-[var(--ai-t3)] transition-colors hover:text-[var(--ai-danger)] disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function noteWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
