"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Lock,
  Plus,
  Search,
  Settings,
  UserX,
  Video,
} from "lucide-react";
import { DashboardHero, HeroDelta } from "@/app/ai-dashboard/_components/dashboard-hero";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  INTERVIEW_STATUS_LABELS,
  type InterviewListResult,
  type InterviewRow,
  type InterviewScore,
  type InterviewStatus,
  type InterviewTab,
} from "@/lib/interviews/review-types";
import { fetchInterviewList, setInterviewArchived } from "./actions";

/**
 * The interviews list.
 *
 * ── The empty state is the PRIMARY state ─────────────────────
 *
 * Every company sees it on day one, and most will see it for a while: nothing
 * lands here until someone sends an invite from the applicant drawer. It is
 * therefore built as the main case — a full explanation of what an async
 * interview is and a route to where you actually send one — rather than a
 * shrug in the middle of an otherwise-empty table. The table and its hero are
 * not rendered at all until there is something to put in them.
 */

const AVATAR_TINTS: ReadonlyArray<[string, string]> = [
  ["#EEEDFE", "#2E2470"],
  ["#E1F5EE", "#04342C"],
  ["#E4EEFB", "#123B6E"],
  ["#FAECE7", "#7A3618"],
  ["#FBEBCF", "#7A4E05"],
  ["#EDEBF0", "#4A4550"],
];

/** Stable hash of the record id, never the array index — a row must not change
 *  colour because a filter reordered the page. */
function getTint(id: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function relative(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) {
    const hrs = Math.max(1, Math.floor(ms / 3_600_000));
    return `${hrs}h ago`;
  }
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return fmtDate(iso);
}

const PILL: Record<InterviewStatus, string> = {
  submitted: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  started: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
  invited: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  expired: "bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]",
  cancelled: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
};
const DOT: Record<InterviewStatus, string> = {
  submitted: "bg-remotiv-green",
  started: "bg-[var(--ai-sky,#4C8DD9)]",
  invited: "bg-[var(--ai-t4)]",
  expired: "bg-[var(--ai-danger)]",
  cancelled: "bg-[var(--ai-t4)]",
};

const TABS: { key: InterviewTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "submitted", label: "Ready" },
  { key: "started", label: "In progress" },
  { key: "invited", label: "Not started" },
  { key: "expired", label: "Expired" },
  { key: "archived", label: "Archived" },
];

export function InterviewsClient({ initial }: { initial: InterviewListResult }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<InterviewTab>("all");
  const [jobId, setJobId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  const reload = useCallback(
    (next: {
      status?: InterviewTab;
      jobId?: string;
      query?: string;
      page?: number;
    }) => {
      const params = {
        status: next.status ?? tab,
        jobId: (next.jobId ?? jobId) || null,
        query: next.query ?? query,
        page: next.page ?? 1,
      };
      startTransition(async () => {
        setData(await fetchInterviewList(params));
      });
    },
    [tab, jobId, query],
  );

  /* `counts.all` is the whole scoped set, so it answers "has this company ever
     sent one" — not "does the current filter match anything". The zero state
     must not appear just because someone searched for a name that isn't there. */
  const neverSent = data.counts.all === 0;

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  const lede = useMemo(
    () =>
      neverSent
        ? "Ask every candidate the same questions and watch their answers"
        : "Recorded answers from candidates you invited. Watch them",
    [neverSent],
  );

  return (
    <PageContainer>
      <div className="mb-[22px] flex flex-col gap-4 min-[840px]:flex-row min-[840px]:items-end min-[840px]:justify-between min-[840px]:gap-8">
        <div>
          <h1 className="m-0 font-heading text-[32px] font-extrabold leading-none tracking-[-0.04em] text-[var(--ai-t1)] min-[840px]:text-[44px]">
            Interviews
          </h1>
          <p className="m-0 mt-3 max-w-[600px] text-[14.5px] leading-relaxed text-[var(--ai-t2)] min-[840px]:text-[15px]">
            {lede}{" "}
            <span className="relative z-0 inline-block px-1 font-bold text-[var(--ai-t1)] before:absolute before:-left-[3px] before:-right-[3px] before:bottom-[8%] before:top-[6%] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
              whenever suits you
            </span>{" "}
            — no scheduling, no calls.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <Link
            href="/ai-dashboard/jobs"
            className="inline-flex items-center justify-center gap-[9px] rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-5 py-[13px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          >
            <Settings className="size-4" strokeWidth={1.9} />
            Question set
          </Link>
          <Link
            href="/ai-dashboard/applicants"
            className="inline-flex items-center justify-center gap-[9px] rounded-[14px] border border-remotiv-purple bg-remotiv-purple px-[22px] py-[13px] text-sm font-bold text-white shadow-[0_8px_24px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover,#6D38F0)]"
          >
            <Plus className="size-4" strokeWidth={2.4} />
            Invite candidates
          </Link>
        </div>
      </div>

      {neverSent ? (
        <ZeroState />
      ) : (
        <>
          <DashboardHero
            eyebrow="Interviews sent"
            value={data.counts.all}
            delta={
              data.sentThisWeek > 0 ? (
                <HeroDelta>+{data.sentThisWeek} this week</HeroDelta>
              ) : null
            }
            subline={`Across ${data.openRoles} ${data.openRoles === 1 ? "role" : "roles"}`}
          >
            <div className="grid grid-cols-2 gap-y-5 min-[720px]:grid-cols-4 min-[720px]:gap-y-0">
              <HeroCell
                label="Ready to watch"
                dot="var(--ai-mint, #49D7A7)"
                value={data.counts.submitted}
                width={pct(data.counts.submitted, data.counts.all)}
                caption={`${pct(data.counts.submitted, data.counts.all)}% of invites`}
                first
              />
              <HeroCell
                label="In progress"
                dot="#4C8DD9"
                value={data.counts.started}
                width={pct(data.counts.started, data.counts.all)}
                caption="Started, not sent"
              />
              <HeroCell
                label="Not started"
                dot="#B0AAB8"
                value={data.counts.invited}
                width={pct(data.counts.invited, data.counts.all)}
                caption="Waiting on the candidate"
              />
              <HeroCell
                label="Expired"
                dot="#E0524B"
                value={data.counts.expired}
                width={pct(data.counts.expired, data.counts.all)}
                caption="Deadline passed"
              />
            </div>
          </DashboardHero>

          <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
              {/* The strip is wider than a phone, so it scrolls within itself
                  rather than widening the page. */}
              <div className="flex max-w-full overflow-x-auto rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
                {TABS.filter(
                  // Nothing archived, no tab — an always-visible empty tab
                  // invites people to look for a feature they aren't using.
                  (t) => t.key !== "archived" || data.counts.archived > 0,
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      setTab(t.key);
                      reload({ status: t.key, page: 1 });
                    }}
                    className={`flex shrink-0 items-center gap-[7px] rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors ${
                      tab === t.key
                        ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
                        : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                    }`}
                  >
                    {t.label}
                    <span
                      className={`rounded-full px-1.5 py-px text-[10.5px] font-bold ${
                        tab === t.key
                          ? "bg-white/20 text-white"
                          : "bg-[rgba(20,16,32,0.07)]"
                      }`}
                    >
                      {data.counts[t.key]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex w-full items-center gap-[9px] min-[840px]:ml-auto min-[840px]:w-auto">
                <select
                  value={jobId}
                  onChange={(e) => {
                    setJobId(e.target.value);
                    reload({ jobId: e.target.value, page: 1 });
                  }}
                  aria-label="Filter by job"
                  className="min-w-0 flex-1 cursor-pointer appearance-none rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] outline-none focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.14] min-[840px]:flex-none"
                >
                  <option value="">All jobs</option>
                  {data.jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.title}
                    </option>
                  ))}
                </select>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple min-[840px]:w-[210px] min-[840px]:flex-none">
                  <Search className="size-[15px] shrink-0" strokeWidth={1.8} />
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      reload({ query: e.target.value, page: 1 });
                    }}
                    placeholder="Search candidates…"
                    className="w-full min-w-0 border-none bg-transparent text-[13px] text-[var(--ai-t1)] outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_128px_96px_92px_minmax(0,0.7fr)_84px] gap-3 border-b border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[11px] text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--ai-t3)] min-[1017px]:grid">
              <span>Candidate</span>
              <span>Job</span>
              <span>Status</span>
              <span>Answers</span>
              <span>Score</span>
              <span>Submitted</span>
              <span />
            </div>

            <div className={pending ? "opacity-60 transition-opacity" : ""}>
              {data.rows.length === 0 ? (
                <FilteredEmpty tab={tab} query={query} />
              ) : (
                data.rows.map((row) => (
                  <Row key={row.id} row={row} onArchived={() => reload({})} />
                ))
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-3.5">
              <p className="m-0 flex items-center gap-2 text-[12.5px] text-[var(--ai-t3)]">
                <Lock className="size-3.5 shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
                Recordings are deleted automatically 6 months after submission.
              </p>
              <div className="flex items-center gap-3">
                <span className="text-[12.5px] font-semibold text-[var(--ai-t2)]">
                  <b className="text-remotiv-purple">{data.rows.length}</b> of{" "}
                  {data.total}
                </span>
                {totalPages > 1 && (
                  <div className="flex gap-1.5">
                    <PageBtn
                      disabled={data.page <= 1}
                      onClick={() => reload({ page: data.page - 1 })}
                    >
                      Previous
                    </PageBtn>
                    <PageBtn
                      disabled={data.page >= totalPages}
                      onClick={() => reload({ page: data.page + 1 })}
                    >
                      Next
                    </PageBtn>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  );
}


/**
 * The AI score, in every state it actually occurs in.
 *
 * Absent, pending, skipped and failed are four different facts and each says
 * which it is. A number is never shown for anything but `scored`, and a
 * reviewer's correction always wins over the model's — the point of the
 * override column is that the human is right.
 */
function ScorePill({ score }: { score: InterviewScore | null }) {
  if (!score) {
    return (
      <span className="text-[12.5px] italic text-[var(--ai-t4)]">Not scored</span>
    );
  }
  if (score.status === "scored") {
    const shown = score.humanScore ?? score.overall;
    if (shown === null) {
      return (
        <span className="text-[12.5px] italic text-[var(--ai-t4)]">—</span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`font-heading text-base font-extrabold tabular-nums tracking-[-0.035em] ${BAND_TEXT[scoreBand(shown)]}`}
        >
          {shown}
        </span>
        {score.humanScore !== null && (
          <span
            className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-[var(--ai-t4)]"
            title="Adjusted by a reviewer"
          >
            adj
          </span>
        )}
      </span>
    );
  }
  const label =
    score.status === "pending"
      ? "Scoring…"
      : score.status === "norubric"
        ? "No rubric"
        : score.status === "skipped"
          ? "Not scored"
          : "Scoring failed";
  return (
    <span
      className="text-[12.5px] italic text-[var(--ai-t4)]"
      title={score.error ?? undefined}
    >
      {label}
    </span>
  );
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function PageBtn({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-1.5 text-[12px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--ai-line-strong)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]"
    >
      {children}
    </button>
  );
}

function HeroCell({
  label,
  dot,
  value,
  width,
  caption,
  first,
}: {
  label: string;
  dot: string;
  value: number;
  width: number;
  caption: string;
  first?: boolean;
}) {
  return (
    <div className={`min-w-0 px-5 ${first ? "min-[720px]:pl-0" : ""}`}>
      <div className="mb-[9px] flex items-center gap-[7px] whitespace-nowrap text-[11.5px] font-semibold text-white/55">
        <i className="size-[6px] shrink-0 rounded-full" style={{ background: dot }} />
        {label}
      </div>
      <div className="mb-2.5 font-heading text-[26px] font-extrabold leading-none tracking-[-0.03em] text-white">
        {value}
      </div>
      <div className="h-1 overflow-hidden rounded-[3px] bg-white/10">
        <i
          className="block h-full origin-left rounded-[3px]"
          style={{ background: dot, width: `${width}%` }}
        />
      </div>
      <p className="m-0 mt-2 text-[11px] text-white/[0.38]">{caption}</p>
    </div>
  );
}

/** One interview. Rows for candidates who have recorded nothing are not links —
 *  there is no review to open, and a dead link that lands on an empty page is
 *  worse than a row that plainly is not clickable. */
function Row({ row, onArchived }: { row: InterviewRow; onArchived: () => void }) {
  const [bg, fg] = getTint(row.id);
  const openable = row.answered > 0;
  const archived = row.archivedAt !== null;

  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        {/* An unlinked or deleted row gets a neutral mark, not initials of a
            placeholder — "NO" for "No applicant linked" would read as a name. */}
        {row.candidateLink === "linked" ? (
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: bg, color: fg }}
          >
            {initials(row.candidateName)}
          </span>
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
            <UserX className="size-4" strokeWidth={1.8} />
          </span>
        )}
        <div className="min-w-0">
          <p
            className={`m-0 truncate text-sm leading-tight tracking-[-0.01em] ${
              row.candidateLink === "linked"
                ? "font-bold text-[var(--ai-t1)]"
                : "font-semibold italic text-[var(--ai-t3)]"
            }`}
          >
            {row.candidateName}
          </p>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
            {row.candidateLink === "linked"
              ? row.candidateEmail
              : row.candidateLink === "deleted"
                ? "Their application record was removed"
                : "Sent without an applicant record"}
          </p>
        </div>
      </div>

      {/* Kept on mobile: stacked, "which role is this for" is the first thing
          a reviewer needs, and the column header is hidden down there. */}
      <span className="truncate text-[13px] text-[var(--ai-t2)]">
        {row.jobTitle}
      </span>

      <span className="justify-self-start">
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${
            row.purged
              ? "border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t3)]"
              : PILL[row.status]
          }`}
        >
          <span
            className={`size-[5px] shrink-0 rounded-full ${row.purged ? "bg-[var(--ai-t4)]" : DOT[row.status]}`}
          />
          {row.purged ? "Recording purged" : INTERVIEW_STATUS_LABELS[row.status]}
        </span>
      </span>

      {row.answered === 0 ? (
        /* This column answers "how many of how many", so it shows the count —
           repeating the status pill's own words told the reader nothing the
           pill hadn't already said one column earlier. */
        <span className="text-[12.5px] font-semibold tabular-nums text-[var(--ai-t4)]">
          {row.totalQuestions > 0 ? `0/${row.totalQuestions}` : "—"}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-[rgba(20,16,32,0.08)]">
            <i
              className="block h-full origin-left rounded-[3px]"
              style={{
                width: `${pct(row.answered, row.totalQuestions || row.answered)}%`,
                background:
                  row.status === "submitted" ? "var(--ai-mint, #49D7A7)" : "#4C8DD9",
              }}
            />
          </span>
          <span className="shrink-0 text-xs font-bold tabular-nums text-[var(--ai-t2)]">
            {row.answered}/{row.totalQuestions || row.answered}
          </span>
        </span>
      )}

      <span className="justify-self-start">
        <ScorePill score={row.score} />
      </span>

      <span className="whitespace-nowrap text-[13px] text-[var(--ai-t2)]">
        {row.status === "submitted"
          ? relative(row.submittedAt)
          : row.status === "started"
            ? `Started ${relative(row.startedAt)}`
            : row.status === "expired"
              ? `Expired ${fmtDate(row.expiresAt)}`
              : `Due ${fmtDate(row.expiresAt)}`}
        <small className="mt-px block text-[11.5px] text-[var(--ai-t4)]">
          {row.status === "submitted"
            ? fmtDate(row.submittedAt)
            : `Invited ${fmtDate(row.sentAt)}`}
        </small>
      </span>

      {/* ARCHIVE, not cancel. The wording says what it does and does not do,
          because the destructive-sounding one lives elsewhere: cancelling an
          invite stops a candidate recording, archiving only tidies this list. */}
      <span className="justify-self-start min-[1017px]:justify-self-end">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void setInterviewArchived(row.id, !archived).then(onArchived);
          }}
          className="rounded-lg border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-2.5 py-1.5 text-[11.5px] font-bold text-[var(--ai-t3)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          title={
            archived
              ? "Put this back in the working list"
              : "Hide from the list. The candidate is unaffected."
          }
        >
          {archived ? "Restore" : "Archive"}
        </button>
      </span>
    </>
  );

  const grid =
    "grid grid-cols-1 gap-3 border-b border-[var(--ai-line-soft)] px-5 py-3.5 last:border-b-0 min-[1017px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_128px_96px_92px_minmax(0,0.7fr)_84px] min-[1017px]:items-center min-[1017px]:gap-3";

  if (!openable) {
    return (
      <div className={`${grid} bg-[#FDFCFA]`} data-status={row.status}>
        {inner}
      </div>
    );
  }
  return (
    <Link
      href={`/ai-dashboard/interviews/${row.id}`}
      className={`${grid} group relative bg-[var(--ai-surface)] transition-[background,box-shadow] hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)]`}
    >
      <span className="absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple opacity-0 transition-opacity group-hover:opacity-100" />
      {inner}
    </Link>
  );
}

function FilteredEmpty({ tab, query }: { tab: InterviewTab; query: string }) {
  const copy = query.trim()
    ? {
        title: `Nobody matches “${query.trim()}”`,
        body: "Try a different name or role, or clear the filters.",
      }
    : tab === "submitted"
      ? {
          title: "Nothing ready to watch",
          body: "Completed interviews appear here as candidates submit them.",
        }
      : tab === "expired"
        ? {
            title: "Nothing expired",
            body: "Every invite you've sent is still within its deadline.",
          }
        : tab === "archived"
          ? {
              title: "Nothing archived",
              body: "Archiving hides a finished interview from the working list without touching the recording. Nothing is archived right now.",
            }
        : {
            title: "Nothing here",
            body: "Nothing matches these filters. Switch tabs or pick a different role.",
          };

  return (
    <div className="flex flex-col items-center px-6 pb-[60px] pt-14 text-center">
      <span className="mb-[18px] flex size-[66px] items-center justify-center rounded-[20px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
        <Video className="size-7" strokeWidth={1.7} />
      </span>
      <h3 className="m-0 mb-1.5 font-heading text-[19px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
        {copy.title}
      </h3>
      <p className="m-0 max-w-[380px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
        {copy.body}
      </p>
    </div>
  );
}

/**
 * Day one. Flat ink header — no mint block: the mint block is the METRIC hero,
 * and there is no metric here yet. No purple glow on the dark panel either.
 */
function ZeroState() {
  const steps = [
    {
      n: 1,
      t: "Write your questions once",
      s: "Three to five is plenty. They're reused for every candidate on the role.",
    },
    {
      n: 2,
      t: "Invite from the applicant list",
      s: "Shortlisted candidates get a link. They practise first, then record.",
    },
    {
      n: 3,
      t: "Watch and decide together",
      s: "Answers land here with transcripts. Your team adds notes on each one.",
    },
  ];

  return (
    <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
      <div className="bg-[var(--ai-sidebar)] px-6 pb-[30px] pt-[34px] text-center min-[840px]:px-8">
        <span className="mb-4 inline-flex size-16 items-center justify-center rounded-[20px] border border-white/[0.14] bg-white/10 text-white">
          <Video className="size-7" strokeWidth={1.8} />
        </span>
        {/* Explicit colours: the DS's global `p { color:#444 }` beats an
            inherited white on a dark surface. */}
        <h3 className="m-0 mb-[9px] font-heading text-[22px] font-extrabold leading-tight tracking-[-0.033em] text-white min-[840px]:text-2xl">
          Interview five people{" "}
          <mark className="bg-transparent text-remotiv-lime">
            in the time one call takes
          </mark>
        </h3>
        <p className="m-0 mx-auto max-w-[420px] text-[13.5px] leading-relaxed text-white/55">
          Candidates record answers to your questions on their own time. You
          watch when it suits you — no diaries, no time zones, no no-shows.
        </p>
      </div>

      <div className="grid grid-cols-1 min-[840px]:grid-cols-3">
        {steps.map((s) => (
          <div
            key={s.n}
            className="border-b border-[var(--ai-line-soft)] px-6 py-[22px] last:border-b-0 min-[840px]:border-b-0 min-[840px]:border-r min-[840px]:last:border-r-0"
          >
            <span className="mb-3 flex size-[26px] items-center justify-center rounded-[9px] bg-[var(--ai-purple-tint)] text-xs font-extrabold text-[var(--ai-purple-ink)]">
              {s.n}
            </span>
            <p className="m-0 text-sm font-bold leading-snug tracking-[-0.01em] text-[var(--ai-t1)]">
              {s.t}
            </p>
            <p className="m-0 mt-[5px] text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
              {s.s}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-4">
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          Nothing to set up. Your first question set takes about two minutes.
        </p>
        {/* The mock's CTA is "Create your question set" pointing at a standalone
            editor. There isn't one — questions are step 5 of the job wizard, per
            job — so the label is kept and the destination is where they actually
            live. A button that opened nothing would be worse than a rename. */}
        <Link
          href="/ai-dashboard/jobs"
          className="inline-flex shrink-0 items-center gap-[9px] rounded-[14px] border border-remotiv-purple bg-remotiv-purple px-[22px] py-[13px] text-sm font-bold text-white shadow-[0_8px_24px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover,#6D38F0)]"
        >
          <ArrowRight className="size-4" strokeWidth={2.4} />
          Create your question set
        </Link>
      </div>
    </div>
  );
}
