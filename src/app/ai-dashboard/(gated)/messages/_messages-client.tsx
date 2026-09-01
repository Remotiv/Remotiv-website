"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  User,
  X,
  CircleX,
} from "lucide-react";
import {
  DashboardHero,
  HeroDelta,
} from "@/app/ai-dashboard/_components/dashboard-hero";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  cancelScheduledMessage,
  fetchMessageAggregates,
  fetchMessages,
  sendScheduledNow,
} from "./actions";
import { Composer, initialsOf, tintFor } from "./_composer";
import {
  MESSAGES_PAGE_SIZE,
  MESSAGE_KIND_LABELS,
  type ManualTemplate,
  type MessageAggregates,
  type MessageKind,
  type MessageRecipient,
  type MessageRow,
  type MessageTab,
} from "./types";

const GRID =
  "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_104px] items-center gap-3.5 min-[1100px]:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_116px_0.8fr_0.75fr_40px]";

const PILL: Record<MessageKind, { cls: string; dot: string }> = {
  written: { cls: "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]", dot: "bg-remotiv-purple" },
  automatic: { cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]", dot: "bg-[var(--ai-t4)]" },
  scheduled: { cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]", dot: "bg-[var(--ai-amber-dot)]" },
  failed: { cls: "bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]", dot: "bg-[#E0524B]" },
};

const TABS: ReadonlyArray<{ key: MessageTab; label: string }> = [
  { key: "all", label: "All" },
  { key: "written", label: "Written" },
  { key: "automatic", label: "Automatic" },
  { key: "scheduled", label: "Scheduled" },
];

/** "in 2 days" / "6h ago" — the relative half of the When column. */
function relative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const unit = mins < 60 ? `${mins}m` : hours < 24 ? `${hours}h` : `${days} day${days === 1 ? "" : "s"}`;
  if (mins < 1) return diff >= 0 ? "in a moment" : "just now";
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

/** The exact stamp beneath it. */
function exact(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

function whenOf(row: MessageRow): { rel: string; exact: string } {
  const stamp = row.kind === "scheduled" ? (row.scheduledFor ?? row.createdAt) : (row.sentAt ?? row.createdAt);
  return { rel: relative(stamp), exact: exact(stamp) };
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0% of all sent";
  return `${Math.round((part / whole) * 100)}% of all sent`;
}

export function MessagesClient({
  companyName,
  replyToAddress,
  initialRows,
  initialFailed,
  initialMatching,
  initialAggregates,
  recipients,
  templates,
  jobs,
  applicantCount,
  roleCount,
  unassigned,
}: {
  companyName: string;
  replyToAddress: string | null;
  initialRows: MessageRow[];
  /** The server's first read failed — show the failure state, not an empty inbox. */
  initialFailed: boolean;
  initialMatching: number;
  initialAggregates: MessageAggregates;
  recipients: MessageRecipient[];
  templates: ManualTemplate[];
  jobs: { id: string; title: string }[];
  applicantCount: number;
  roleCount: number;
  /** True for a scoped member on no hiring teams — see the empty state. */
  unassigned: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [matching, setMatching] = useState(initialMatching);
  /**
   * Workspace counts, straight from the server aggregate.
   *
   * NEVER derived from `rows` — those are one page of up to 20, and computing
   * a tab badge from them is precisely the bug the handoff calls out. Local
   * mutations adjust this object explicitly instead.
   */
  const [agg, setAgg] = useState(initialAggregates);

  const [tab, setTab] = useState<MessageTab>("all");
  const [jobId, setJobId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  /** The list could not be READ. Distinct from "this inbox is empty". */
  const [loadFailed, setLoadFailed] = useState(initialFailed);

  const [viewing, setViewing] = useState<MessageRow | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    function onClick() {
      setMenuFor(null);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const reload = useCallback(
    async (next: { tab: MessageTab; jobId: string; search: string; page: number }) => {
      setLoading(true);
      try {
        const result = await fetchMessages(next);
        // Not "no messages" — we do not know. Clearing the rows AND raising the
        // flag together is deliberate: leaving the previous filter's rows on
        // screen under a new filter would be a second wrong answer.
        if (!result.ok) {
          setLoadFailed(true);
          setRows([]);
          setMatching(0);
          return;
        }
        setLoadFailed(false);
        setRows(result.value.rows);
        setMatching(result.value.matching);
      } catch {
        setLoadFailed(true);
        setRows([]);
        setMatching(0);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Debounced so typing doesn't fire a query per keystroke. The first render
  // is skipped — the server already delivered page 0 of the default filters.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!primed) {
      setPrimed(true);
      return;
    }
    const t = window.setTimeout(() => {
      void reload({ tab, jobId, search, page });
    }, 240);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, jobId, search, page]);

  async function refreshAggregates() {
    try {
      // A stale badge beats a wrong one: an unavailable read leaves the
      // previous counts alone rather than zeroing them.
      const next = await fetchMessageAggregates();
      if (next.ok) setAgg(next.value);
    } catch {
      /* a stale badge is better than a crashed page */
    }
  }

  const pageCount = Math.max(1, Math.ceil(matching / MESSAGES_PAGE_SIZE));
  const rangeStart = matching === 0 ? 0 : page * MESSAGES_PAGE_SIZE + 1;
  const rangeEnd = Math.min(matching, page * MESSAGES_PAGE_SIZE + rows.length);

  const heroSub = useMemo(
    () =>
      `To ${applicantCount} applicant${applicantCount === 1 ? "" : "s"} across ${roleCount} role${roleCount === 1 ? "" : "s"}`,
    [applicantCount, roleCount],
  );

  function resetTo(next: Partial<{ tab: MessageTab; jobId: string; search: string }>) {
    if (next.tab !== undefined) setTab(next.tab);
    if (next.jobId !== undefined) setJobId(next.jobId);
    if (next.search !== undefined) setSearch(next.search);
    setPage(0);
  }

  async function handleCancel(row: MessageRow) {
    const result = await cancelScheduledMessage(row.id);
    if (!result.success) {
      setToast(result.error);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    setMatching((m) => Math.max(0, m - 1));
    setAgg((a) => ({
      ...a,
      all: Math.max(0, a.all - 1),
      scheduled: Math.max(0, a.scheduled - 1),
    }));
    setToast(`Scheduled email to ${row.candidateName} cancelled`);
  }

  async function handleSendNow(row: MessageRow) {
    const result = await sendScheduledNow(row.id);
    if (!result.success) {
      setToast(result.error);
      return;
    }
    setToast(`Sent to ${row.candidateName} now`);
    await Promise.all([reload({ tab, jobId, search, page }), refreshAggregates()]);
  }

  /*
   * The failure case comes FIRST, ahead of every absence state below it.
   *
   * `agg.all === 0` used to serve this case too, rendering "No messages yet —
   * every email sent to a candidate lands here". That sentence is product
   * education: exactly right for a genuinely new workspace, and a false
   * guarantee over a read that failed. A recruiter who has been emailing
   * candidates all week reads it and concludes the messages are gone.
   */
  const emptyCopy = loadFailed
    ? {
        title: "We couldn't load your messages",
        text: "Nothing has been lost — this is a problem on our side. Reload the page to try again.",
      }
    : unassigned
    ? {
        title: "You haven't been assigned to any roles yet",
        text: "Messages follow the roles you're on. Ask an owner or admin to add you to a job's hiring team and its candidate emails will appear here.",
      }
    : search
    ? {
        title: `Nothing matches “${search}”`,
        text: "Try a different candidate, subject, or role — or clear the filters.",
      }
    : tab === "scheduled"
      ? {
          title: "Nothing scheduled",
          text: "Scheduled emails — like pending rejections — appear here until they send.",
        }
      : agg.all === 0
        ? {
            title: "No messages yet",
            text: "Every email sent to a candidate lands here — including the automatic ones sent on application.",
          }
        : {
            title: "No messages here",
            text: "Nothing matches these filters. Switch tabs or pick a different role.",
          };

  return (
    <PageContainer>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="m-0 font-heading text-[44px] font-extrabold leading-none tracking-[-0.04em] text-[var(--ai-t1)]">
            Messages
          </h1>
          <p className="m-0 mt-3 max-w-[600px] text-[15px] leading-relaxed text-[var(--ai-t2)]">
            Every email your candidates have received. Most go out{" "}
            <span className="relative z-0 inline-block px-[5px] font-bold text-[var(--ai-t1)] before:absolute before:inset-y-[4%] before:-inset-x-[3px] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
              automatically
            </span>{" "}
            — the ones you write are marked.
          </p>
        </div>
        <div className="flex shrink-0 gap-3 pb-1">
          <button
            type="button"
            onClick={() => setToast("Template library — coming soon")}
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-5 py-[13px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          >
            <FileText className="size-4" strokeWidth={1.9} />
            Templates
          </button>
          <button
            type="button"
            onClick={() => {
              setComposerFor(null);
              setFollowUp(false);
              setComposerOpen(true);
            }}
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-[14px] border border-remotiv-purple bg-remotiv-purple px-[22px] py-[13px] text-sm font-bold text-white shadow-[0_8px_24px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)]"
          >
            <Plus className="size-4" strokeWidth={2.4} />
            New message
          </button>
        </div>
      </div>

      <DashboardHero
        eyebrow="Emails sent"
        value={agg.sent}
        delta={
          agg.sentThisWeek > 0 ? (
            <HeroDelta>+{agg.sentThisWeek} this week</HeroDelta>
          ) : null
        }
        subline={heroSub}
      >
        <div className="grid grid-cols-2 gap-y-5 min-[720px]:grid-cols-4 min-[720px]:gap-y-0">
          <HeroCell
            label="Written by you"
            dot="var(--ai-purple-soft, #9886FE)"
            value={agg.written}
            width={agg.sent ? (agg.written / agg.sent) * 100 : 0}
            caption={pct(agg.written, agg.sent)}
            first
          />
          <HeroCell
            label="Automatic"
            dot="#B0AAB8"
            value={agg.automatic}
            width={agg.sent ? (agg.automatic / agg.sent) * 100 : 0}
            caption={pct(agg.automatic, agg.sent)}
          />
          <HeroCell
            label="Scheduled"
            dot="var(--ai-amber-dot)"
            value={agg.scheduled}
            width={agg.scheduled ? 6 : 0}
            caption={agg.scheduled ? "Pending rejections" : "Nothing pending"}
          />
          <HeroCell
            label="Failed"
            dot={agg.failed ? "#E0524B" : "#49D7A7"}
            value={agg.failed}
            width={100}
            caption={
              agg.failed
                ? `${agg.failed} didn't arrive`
                : agg.sent
                  ? "100% delivered"
                  : "Nothing sent yet"
            }
            ok={agg.failed === 0}
          />
        </div>
      </DashboardHero>

      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          <div className="flex rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => resetTo({ tab: t.key })}
                className={`flex items-center gap-[7px] rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors ${
                  tab === t.key
                    ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
                    : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                }`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 py-px text-[10.5px] font-bold ${
                    tab === t.key ? "bg-white/20 text-white" : "bg-[rgba(20,16,32,0.07)]"
                  }`}
                >
                  {agg[t.key]}
                </span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            <select
              value={jobId}
              onChange={(e) => resetTo({ jobId: e.target.value })}
              aria-label="Filter by job"
              className="cursor-pointer appearance-none rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] outline-none focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.14]"
            >
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
            <div className="flex w-[210px] items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple focus-within:ring-[3px] focus-within:ring-remotiv-purple/[0.14]">
              <Search className="size-[15px] shrink-0" strokeWidth={1.8} />
              <input
                value={search}
                onChange={(e) => resetTo({ search: e.target.value })}
                placeholder="Search messages…"
                aria-label="Search messages"
                className="w-full border-none bg-transparent text-[13px] text-[var(--ai-t1)] outline-none"
              />
            </div>
          </div>
        </div>

        <div
          className={`${GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[11px] text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--ai-t3)]`}
        >
          <span>Candidate</span>
          <span>Subject</span>
          <span>Type</span>
          <span className="hidden min-[1100px]:block">Sent by</span>
          <span className="hidden min-[1100px]:block">When</span>
          <span />
        </div>

        {rows.length === 0 && !loading ? (
          <div className="flex flex-col items-center px-6 pb-[62px] pt-[58px] text-center">
            <div className="mb-[18px] flex size-[66px] items-center justify-center rounded-[20px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
              <Mail className="size-7" strokeWidth={1.7} />
            </div>
            <h3 className="m-0 mb-1.5 font-heading text-[19px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
              {emptyCopy.title}
            </h3>
            <p className="m-0 max-w-[350px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              {emptyCopy.text}
            </p>
          </div>
        ) : (
          rows.map((row) => {
            const when = whenOf(row);
            const tint = tintFor(row.applicationId ?? row.id);
            const scheduled = row.kind === "scheduled";
            return (
              <div
                key={row.id}
                className={`group relative border-b border-[var(--ai-line-soft)] last:border-b-0 ${
                  scheduled ? "bg-[#FDFCFA]" : "bg-[var(--ai-surface)]"
                } transition-shadow hover:z-[2] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)]`}
              >
                <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple opacity-0 transition-opacity group-hover:opacity-100" />
                <button
                  type="button"
                  onClick={() => setViewing(row)}
                  className={`${GRID} w-full cursor-pointer px-5 py-[13px] text-left`}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold shadow-[0_0_0_2px_var(--ai-surface),0_0_0_3.5px_rgba(20,16,32,0.07)]"
                      style={{ background: tint[0], color: tint[1] }}
                    >
                      {initialsOf(row.candidateName)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
                        {row.candidateName}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-[var(--ai-t3)]">
                        {row.jobTitle}
                      </span>
                    </span>
                  </span>

                  <span
                    className={`min-w-0 truncate text-[13.5px] ${
                      row.kind === "automatic"
                        ? "font-medium text-[var(--ai-t2)]"
                        : "font-semibold text-[var(--ai-t1)]"
                    }`}
                  >
                    {row.subject || "(no subject)"}
                  </span>

                  <span
                    className={`inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${PILL[row.kind].cls}`}
                  >
                    <span className={`size-[5px] shrink-0 rounded-full ${PILL[row.kind].dot}`} />
                    {MESSAGE_KIND_LABELS[row.kind]}
                  </span>

                  <span className="hidden min-w-0 items-center gap-2 whitespace-nowrap text-[13px] text-[var(--ai-t2)] min-[1100px]:flex">
                    {row.sentByName ? (
                      <>
                        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--ai-mint-tint)] text-[9.5px] font-bold text-[var(--ai-mint-ink)]">
                          {initialsOf(row.sentByName)}
                        </span>
                        {row.sentByName}
                      </>
                    ) : (
                      <span className="text-[var(--ai-t4)]">—</span>
                    )}
                  </span>

                  <span
                    className={`hidden whitespace-nowrap text-[13px] min-[1100px]:block ${
                      scheduled ? "font-semibold text-[var(--ai-amber-ink)]" : "text-[var(--ai-t2)]"
                    }`}
                  >
                    {when.rel}
                    <small className="mt-px block text-[11.5px] font-normal text-[var(--ai-t4)]">
                      {when.exact}
                    </small>
                  </span>
                  <span />
                </button>

                <div className="absolute right-4 top-1/2 hidden -translate-y-1/2 min-[1100px]:block">
                  <button
                    type="button"
                    aria-label="Actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === row.id ? null : row.id);
                    }}
                    className={`flex size-8 items-center justify-center rounded-[9px] text-[var(--ai-t4)] transition-all hover:bg-[var(--ai-sidebar)] hover:text-white ${
                      menuFor === row.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <MoreHorizontal className="size-[18px]" strokeWidth={2} />
                  </button>

                  {menuFor === row.id && (
                    <div
                      className="absolute right-0 top-[38px] z-[60] min-w-[186px] rounded-[14px] border border-[var(--ai-line)] bg-white p-1.5 shadow-[0_24px_60px_rgba(20,16,32,0.2)]"
                      onClick={(e) => e.stopPropagation()}
                      role="menu"
                      tabIndex={-1}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setMenuFor(null);
                      }}
                    >
                      {scheduled ? (
                        <>
                          <MenuItem
                            icon={<Send className="size-4" strokeWidth={1.7} />}
                            label="Send now"
                            onClick={() => {
                              setMenuFor(null);
                              void handleSendNow(row);
                            }}
                          />
                          <MenuItem
                            icon={<Eye className="size-4" strokeWidth={1.7} />}
                            label="Preview message"
                            onClick={() => {
                              setMenuFor(null);
                              setViewing(row);
                            }}
                          />
                          <div className="my-[5px] h-px bg-[var(--ai-line)]" />
                          <MenuItem
                            icon={<CircleX className="size-4" strokeWidth={1.7} />}
                            label="Cancel send"
                            danger
                            onClick={() => {
                              setMenuFor(null);
                              void handleCancel(row);
                            }}
                          />
                        </>
                      ) : (
                        <>
                          <MenuItem
                            icon={<Eye className="size-4" strokeWidth={1.7} />}
                            label="Open message"
                            onClick={() => {
                              setMenuFor(null);
                              setViewing(row);
                            }}
                          />
                          <MenuItem
                            icon={<Send className="size-4" strokeWidth={1.7} />}
                            label="Send follow-up"
                            onClick={() => {
                              setMenuFor(null);
                              setComposerFor(row.applicationId);
                              setFollowUp(true);
                              setComposerOpen(true);
                            }}
                          />
                          <MenuItem
                            icon={<User className="size-4" strokeWidth={1.7} />}
                            label="View applicant"
                            onClick={() => {
                              setMenuFor(null);
                              window.location.href = "/ai-dashboard/applicants";
                            }}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="m-0 flex items-center gap-2 text-[12.5px] text-[var(--ai-t3)]">
            <Check className="size-3.5 shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
            {replyToAddress ? (
              <>
                Candidates reply to{" "}
                <b className="font-bold text-[var(--ai-t2)]">{replyToAddress}</b> — Remotiv
                never receives replies.
              </>
            ) : (
              <>
                No reply-to address is set, so candidates can&apos;t reply to these emails.
              </>
            )}
          </p>
          <div className="flex items-center gap-3">
            <span className="whitespace-nowrap text-[12.5px] font-semibold text-[var(--ai-t2)]">
              <b className="text-remotiv-purple">
                {rangeStart}–{rangeEnd}
              </b>{" "}
              of {matching}
              {matching !== agg.all && (
                <span className="text-[var(--ai-t3)]"> (of {agg.all} total)</span>
              )}
            </span>
            {pageCount > 1 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page <= 0 || loading}
                  aria-label="Previous page"
                  className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="size-4" strokeWidth={2} />
                </button>
                <span className="whitespace-nowrap px-1 text-[12.5px] font-semibold tabular-nums text-[var(--ai-t2)]">
                  {page + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1 || loading}
                  aria-label="Next page"
                  className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight className="size-4" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {viewing && (
        <MessageViewer
          row={viewing}
          onClose={() => setViewing(null)}
          onFollowUp={() => {
            const target = viewing.applicationId;
            setViewing(null);
            setComposerFor(target);
            setFollowUp(true);
            setComposerOpen(true);
          }}
        />
      )}

      <Composer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        companyName={companyName}
        replyToAddress={replyToAddress}
        recipients={recipients}
        templates={templates}
        presetApplicationId={composerFor}
        isFollowUp={followUp}
        onSent={async ({ applicationId }) => {
          const who = recipients.find((r) => r.applicationId === applicationId);
          setToast(`Email sent to ${who?.name ?? "the candidate"}`);
          await Promise.all([reload({ tab, jobId, search, page: 0 }), refreshAggregates()]);
          setPage(0);
        }}
      />

      {toast && (
        <div className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-[13px] bg-[var(--ai-sidebar)] px-[19px] py-[13px] text-[13.5px] font-semibold text-white shadow-[0_18px_44px_rgba(0,0,0,0.34)]">
          <Check className="size-4 shrink-0 text-remotiv-green" strokeWidth={2.4} />
          {toast}
        </div>
      )}
    </PageContainer>
  );
}

function HeroCell({
  label,
  dot,
  value,
  width,
  caption,
  first,
  ok,
}: {
  label: string;
  dot: string;
  value: number;
  width: number;
  caption: string;
  first?: boolean;
  ok?: boolean;
}) {
  return (
    <div
      className={`relative min-w-0 px-5 ${first ? "min-[720px]:pl-0" : ""} min-[720px]:after:absolute min-[720px]:after:inset-y-[12%] min-[720px]:after:right-0 min-[720px]:after:w-px min-[720px]:after:bg-white/10 min-[720px]:after:content-['']  min-[720px]:last:after:hidden`}
    >
      <div className="mb-[9px] flex items-center gap-[7px] whitespace-nowrap text-[11.5px] font-semibold text-white/55">
        <i className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} />
        {label}
      </div>
      <div className="mb-2.5 font-heading text-[26px] font-extrabold leading-none tracking-[-0.03em] text-white">
        {value}
      </div>
      <div className="h-1 overflow-hidden rounded-[3px] bg-white/10">
        <i
          className="block h-full rounded-[3px]"
          style={{ width: `${Math.max(0, Math.min(100, width))}%`, background: dot }}
        />
      </div>
      <p
        className={`m-0 mt-2 whitespace-nowrap text-[11px] ${ok ? "text-remotiv-green" : "text-white/40"}`}
      >
        {caption}
      </p>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[9px] text-left text-[13px] font-medium transition-colors ${
        danger
          ? "text-[var(--ai-danger)] hover:bg-[var(--ai-danger-tint)]"
          : "text-[var(--ai-t2)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}

function MessageViewer({
  row,
  onClose,
  onFollowUp,
}: {
  row: MessageRow;
  onClose: () => void;
  onFollowUp: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const when = whenOf(row);
  const tint = tintFor(row.applicationId ?? row.id);
  const provenance = row.sentByName
    ? `Written by ${row.sentByName}`
    : row.kind === "scheduled"
      ? "Scheduled · automatic"
      : row.kind === "written"
        ? "Written by your team"
        : "Sent automatically";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-6 backdrop-blur-[5px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={row.subject || "Message"}
        className="relative flex max-h-[calc(var(--vh-full)*0.88)] w-full max-w-[560px] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        <div className="bg-[var(--ai-sidebar)] px-[26px] py-[22px]">
          <div className="flex items-start justify-between gap-3.5">
            <div className="min-w-0">
              <p className="m-0 mb-[7px] text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
                {provenance}
              </p>
              <div className="flex min-w-0 items-center gap-[13px]">
                <span
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-bold shadow-[0_0_0_2px_var(--ai-sidebar),0_0_0_3.5px_rgba(255,255,255,0.2)]"
                  style={{ background: tint[0], color: tint[1] }}
                >
                  {initialsOf(row.candidateName)}
                </span>
                <div className="min-w-0">
                  <p className="m-0 truncate font-heading text-[19px] font-extrabold leading-tight tracking-[-0.028em] text-white">
                    {row.candidateName}
                  </p>
                  {/* The address is omitted when it IS the name — an applicant
                      with no name on record, or a deleted one — rather than
                      printed twice under itself. */}
                  <p className="m-0 mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-white/50">
                    {row.candidateEmail && row.candidateEmail !== row.candidateName && (
                      <>
                        <span className="truncate">{row.candidateEmail}</span>
                        <span className="size-[3px] shrink-0 rounded-full bg-white/30" />
                      </>
                    )}
                    <span>
                      {row.kind === "scheduled" ? "Sends " : ""}
                      {when.rel}
                    </span>
                  </p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.16] bg-white/[0.07] text-white/75 transition-colors hover:bg-white/[0.16] hover:text-white"
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-[26px] pb-6 pt-5">
          <p className="m-0 mb-3.5 font-heading text-[17px] font-extrabold leading-snug tracking-[-0.022em] text-[var(--ai-t1)]">
            {row.subject || "(no subject)"}
          </p>
          <p className="m-0 whitespace-pre-wrap rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-[18px] py-4 text-[13.5px] leading-[1.7] text-[var(--ai-t2)]">
            {row.body || "This message has no body."}
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-3.5">
          <span className="flex items-center gap-2 text-xs text-[var(--ai-t3)]">
            {row.kind === "scheduled" ? (
              <>
                <Clock className="size-3.5 shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
                Not sent yet · {when.exact}
              </>
            ) : row.kind === "failed" ? (
              <>
                <CircleX className="size-3.5 shrink-0 text-[var(--ai-danger)]" strokeWidth={1.9} />
                Didn&apos;t send
              </>
            ) : (
              <>
                <Check className="size-3.5 shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
                Delivered · {when.exact}
              </>
            )}
          </span>
          <div className="flex shrink-0 gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[17px] py-2.5 text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
            >
              Close
            </button>
            {row.applicationId && (
              <button
                type="button"
                onClick={onFollowUp}
                className="inline-flex items-center gap-2 rounded-[11px] border border-remotiv-purple bg-remotiv-purple px-[18px] py-2.5 text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)]"
              >
                <Send className="size-[15px]" strokeWidth={2} />
                Send follow-up
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
