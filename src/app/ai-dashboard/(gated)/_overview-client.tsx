"use client";

import Link from "next/link";
import {
  ArrowRight,
  Briefcase,
  FileText,
  LineChart,
  Mail,
  Pencil,
  Plus,
  Users,
} from "lucide-react";
import {
  PIPELINE_STAGE_LABELS,
  type PipelineStage,
} from "@/app/ai-dashboard/lib/applicant-types";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import type {
  ActivityItem,
  LiveRole,
  OverviewData,
  RecentApplicant,
} from "./overview-types";

// ── Constants ────────────────────────────────────────────────

/**
 * The mock's own breakpoint is max-width:1180px. Media queries evaluate
 * against the UNZOOMED viewport, so it scales by the shell's 0.82 to 968 —
 * below that the hero, the two-column row, the action cards and the role
 * strip all collapse. The extra 525 tier is ours: the mock never gets narrow
 * enough to need it, but two columns on a phone would crush the cards.
 */
const FUNNEL_DOT: Record<PipelineStage, string> = {
  applied: "#B0AAB8",
  screening: "var(--ai-amber-dot)",
  shortlisted: "#49D7A7",
  interview: "#4C8DD9",
  offer: "#9886FE",
  hired: "#D9F972",
  rejected: "#E0524B",
};

const STAGE_PILL: Record<PipelineStage, string> = {
  applied: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  screening: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  shortlisted: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  interview: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
  offer: "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]",
  hired: "bg-remotiv-green text-[var(--ai-mint-ink)]",
  rejected: "bg-[#FBEAE8] text-[#B02A24]",
};

const ACTIVITY_DOT: Record<ActivityItem["kind"], string> = {
  stage: "#49D7A7",
  applied: "#7E47FF",
  published: "#B0AAB8",
};

const AVATAR_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)" },
  { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)" },
  { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
  { bg: "var(--ai-amber-tint)", fg: "var(--ai-amber-ink)" },
];

const ROLE_BAR = ["#49D7A7", "#9886FE", "#4C8DD9", "#D9F972"];

// ── Helpers ──────────────────────────────────────────────────

function getTint(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "?";
}

/** Local time of day for the signed-in member — computed, never stored. */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** First word of the member's name; falls back to the email's local part. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The design system's lime highlight sticker. `z-0` opens a stacking context
 * so the pseudo's negative z-index resolves inside the span instead of
 * dropping behind the page background.
 */
function LimeHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold text-[var(--ai-t1)] before:absolute before:-left-[3px] before:-right-[3px] before:bottom-[8%] before:top-[6%] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
      {children}
    </span>
  );
}

// ── AI hero ──────────────────────────────────────────────────

/**
 * The segment's dark strip.
 *
 * The mock claims "128 CVs read, scored and ranked — while you slept". CV
 * scoring and ranking do not exist yet, so that claim is not made anywhere
 * here. What IS true today: /api/apply evaluates each application's screening
 * answers against the job's ideal answers at the moment it is submitted, and
 * files it into the pipeline. The headline says only that, and only when
 * screening answers actually exist.
 *
 * Every <p> below sets its colour explicitly — the DS ships a global
 * `p { color:#444 }` that beats an inherited white on this surface.
 */
function AiHero({
  data,
  canCreateJob,
}: {
  data: OverviewData;
  canCreateJob: boolean;
}) {
  const { totalApplicants, screenedCount, publishedJobs, funnel } = data;

  /**
   * The mock's pill is "AI RECRUITER · LIVE". The recruiter is real but its
   * scope today is narrow: /api/apply checks each screening answer against
   * the job's ideal answer on arrival. It does NOT read or score CVs — so the
   * pill names screening specifically rather than implying the whole job.
   */
  const pill =
    screenedCount > 0 ? "AI RECRUITER · SCREENING LIVE" : "AI RECRUITER · STANDING BY";

  const headline = (() => {
    if (totalApplicants === 0) {
      return publishedJobs > 0 ? (
        <>
          Your roles are live —{" "}
          <mark className="bg-transparent text-remotiv-lime">
            applications land here
          </mark>{" "}
          the moment they arrive.
        </>
      ) : (
        <>
          Publish a role and it goes live on remotiv.work{" "}
          <mark className="bg-transparent text-remotiv-lime">instantly</mark>.
        </>
      );
    }
    if (screenedCount > 0) {
      return (
        <>
          {screenedCount} application{screenedCount === 1 ? "" : "s"} arrived
          with your screening answers{" "}
          <mark className="bg-transparent text-remotiv-lime">
            already checked
          </mark>
          .
        </>
      );
    }
    return (
      <>
        {totalApplicants} application{totalApplicants === 1 ? "" : "s"}{" "}
        collected and filed —{" "}
        <mark className="bg-transparent text-remotiv-lime">all in one place</mark>
        .
      </>
    );
  })();

  const body = (() => {
    if (totalApplicants === 0) {
      return "Every published role collects applicants from remotiv.work straight into this pipeline. Add screening questions and each answer is checked against your ideal answer on arrival.";
    }
    if (screenedCount > 0) {
      return "Each answer is compared to your ideal answer the moment an application is submitted, so you open a pipeline that is already sorted rather than an inbox.";
    }
    return "Add screening questions to a role and every future application arrives with its answers already checked against yours.";
  })();

  return (
    <div className="relative mb-3.5 grid grid-cols-1 gap-7 overflow-hidden rounded-[24px] bg-[var(--ai-sidebar)] px-6 py-7 shadow-[0_20px_52px_rgba(20,16,32,0.26)] min-[968px]:grid-cols-[minmax(0,1fr)_1px_minmax(0,1.15fr)] min-[968px]:items-center min-[968px]:gap-[30px] min-[968px]:px-[30px]">
      <span
        aria-hidden
        className="pointer-events-none absolute -right-[100px] -top-[130px] size-[400px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(126,71,255,0.52), transparent 68%)",
        }}
      />

      <div className="relative z-[1] min-w-0">
        <span className="mb-3.5 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-remotiv-green/[0.32] bg-remotiv-green/[0.14] py-[5px] pl-[9px] pr-3 text-[11.5px] font-bold tracking-[0.04em] text-remotiv-green">
          <span className="ai-beat size-[7px] rounded-full bg-remotiv-green" />
          {pill}
        </span>
        <h2 className="m-0 mb-2.5 font-heading text-[29px] font-extrabold leading-[1.18] tracking-[-0.035em] text-white">
          {headline}
        </h2>
        <p className="m-0 mb-5 max-w-[400px] text-[13.5px] leading-relaxed text-white/55">
          {body}
        </p>
        <div className="flex flex-wrap gap-2.5">
          <Link
            href="/ai-dashboard/applicants"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-[11px] bg-remotiv-green px-[18px] py-[11px] text-[13.5px] font-bold text-[var(--ai-mint-ink)] transition-colors hover:bg-[var(--ai-mint-hover,#3BC495)]"
          >
            <ArrowRight className="size-[15px]" strokeWidth={2.2} />
            {totalApplicants > 0 ? "Review applicants" : "Open applicants"}
          </Link>
          {canCreateJob && (
            <Link
              href="/ai-dashboard/jobs"
              className="inline-flex items-center whitespace-nowrap rounded-[11px] border border-white/[0.16] bg-white/[0.08] px-[18px] py-[11px] text-[13.5px] font-semibold text-white transition-colors hover:bg-white/[0.16]"
            >
              Tune screening
            </Link>
          )}
        </div>
      </div>

      <div aria-hidden className="hidden h-[150px] self-center bg-white/[0.12] min-[968px]:block" />

      <div className="relative z-[1] min-w-0">
        <p className="m-0 mb-3.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
          Pipeline
        </p>
        <div className="flex items-stretch overflow-x-auto">
          {funnel.map((step, i) => (
            <div
              key={step.stage}
              className={`relative min-w-0 flex-1 px-3 min-[630px]:px-4 ${i === 0 ? "min-[968px]:pl-0" : ""}`}
            >
              {i < funnel.length - 1 && (
                <span
                  aria-hidden
                  className="absolute right-0 top-[46%] hidden size-[7px] -translate-y-1/2 translate-x-1/2 rotate-45 border-r-[1.5px] border-t-[1.5px] border-white/[0.24] min-[630px]:block"
                />
              )}
              <div className="mb-[9px] flex items-center gap-[7px] whitespace-nowrap text-[11.5px] font-semibold text-white/55">
                <i
                  className="size-[6px] shrink-0 rounded-full"
                  style={{ background: FUNNEL_DOT[step.stage] }}
                />
                {PIPELINE_STAGE_LABELS[step.stage]}
              </div>
              <div className="mb-2.5 font-heading text-[25px] font-extrabold leading-none tracking-[-0.025em] text-white">
                {step.count}
              </div>
              <div className="h-1 overflow-hidden rounded-[3px] bg-white/10">
                <div
                  className="h-full rounded-[3px]"
                  style={{
                    width: `${step.pct}%`,
                    background: FUNNEL_DOT[step.stage],
                  }}
                />
              </div>
              <p className="m-0 mt-2 text-[11px] text-white/[0.38]">
                {step.stage === "applied"
                  ? `+${data.newThisWeek} this week`
                  : `${step.pct}% of total`}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Needs you ────────────────────────────────────────────────

type NeedsCard = {
  key: string;
  tally: number;
  title: string;
  body: string;
  cta: string;
  href: string;
  icon: typeof FileText;
  tintBg: string;
  tintFg: string;
};

/** The mock's purple card-flip: white → #7E47FF, arrow slides 4px. */
function ActionCard({ card }: { card: NeedsCard }) {
  const Icon = card.icon;
  return (
    <Link
      href={card.href}
      className="group relative block overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-[19px] transition-[background-color,box-shadow,border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-remotiv-purple hover:bg-remotiv-purple hover:shadow-[0_16px_48px_rgba(126,71,255,0.28)]"
    >
      <span className="absolute right-[18px] top-[17px] font-heading text-[26px] font-extrabold tracking-[-0.035em] text-[var(--ai-t1)] transition-colors duration-300 group-hover:text-white">
        {card.tally}
      </span>
      <span
        className="mb-3.5 flex size-[38px] items-center justify-center rounded-full border border-[var(--ai-line)] transition-all duration-300 group-hover:border-white/[0.24] group-hover:bg-white/[0.16] group-hover:!text-white"
        style={{ background: card.tintBg, color: card.tintFg }}
      >
        <Icon className="size-[17px]" strokeWidth={1.8} />
      </span>
      <h4 className="m-0 mb-1.5 font-heading text-base font-extrabold tracking-[-0.02em] transition-colors duration-300 group-hover:text-white">
        {card.title}
      </h4>
      <p className="m-0 mb-[15px] text-[13px] leading-relaxed text-[var(--ai-t3)] transition-colors duration-300 group-hover:text-white/[0.72]">
        {card.body}
      </p>
      <span className="flex items-center gap-[7px] text-[12.5px] font-bold text-remotiv-purple transition-colors duration-300 group-hover:text-white">
        {card.cta}
        <ArrowRight
          className="size-[15px] transition-transform duration-200 group-hover:translate-x-1"
          strokeWidth={2}
        />
      </span>
    </Link>
  );
}

// ── Sections ─────────────────────────────────────────────────

function SectionHead({
  title,
  count,
  linkHref,
  linkLabel,
}: {
  title: string;
  count?: number;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mx-0.5 mb-[13px] mt-[26px] flex items-baseline justify-between gap-4">
      <h3 className="m-0 flex items-center gap-2.5 font-heading text-[17px] font-extrabold tracking-[-0.025em]">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-[var(--ai-sidebar)] px-[9px] py-[3px] text-[11px] font-extrabold tracking-[0.02em] text-white">
            {count}
          </span>
        )}
      </h3>
      {linkHref && linkLabel && (
        <Link
          href={linkHref}
          className="text-[12.5px] font-bold text-remotiv-purple hover:text-[var(--ai-purple-hover)]"
        >
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}

function ApplicantRow({ row, index }: { row: RecentApplicant; index: number }) {
  const tint = getTint(row.id);
  return (
    <Link
      href="/ai-dashboard/applicants"
      className="group relative grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-[13px] border-b border-[var(--ai-line-soft)] px-5 py-3 transition-colors before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-remotiv-purple before:opacity-0 before:transition-opacity before:content-[''] last:border-b-0 hover:bg-[#FCFBFA] hover:before:opacity-100"
    >
      <span className="font-heading text-[13px] font-extrabold tabular-nums text-[var(--ai-t4)] transition-colors group-hover:text-remotiv-purple">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="flex min-w-0 items-center gap-[11px]">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold shadow-[0_0_0_2px_var(--ai-surface),0_0_0_3.5px_rgba(20,16,32,0.07)]"
          style={{ background: tint.bg, color: tint.fg }}
        >
          {initials(row.name)}
        </span>
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
            {row.name}
          </p>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
            {row.jobTitle}
          </p>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-2.5">
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${STAGE_PILL[row.stage]}`}
        >
          {PIPELINE_STAGE_LABELS[row.stage]}
        </span>
        <small className="hidden whitespace-nowrap text-[11.5px] text-[var(--ai-t4)] min-[525px]:block">
          {timeAgo(row.createdAt)}
        </small>
      </span>
    </Link>
  );
}

function RoleCard({ role, index, max }: { role: LiveRole; index: number; max: number }) {
  return (
    <Link
      href="/ai-dashboard/applicants"
      className="block rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-[17px] transition-[box-shadow,border-color,transform] hover:-translate-y-0.5 hover:border-[var(--ai-line-strong)] hover:shadow-[0_12px_32px_rgba(20,16,32,0.09)]"
    >
      <div className="mb-[13px] flex items-center gap-2.5">
        <span
          className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px]"
          style={{ background: getTint(role.id).bg, color: getTint(role.id).fg }}
        >
          <Briefcase className="size-4" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 truncate text-[13.5px] font-bold leading-tight tracking-[-0.01em]">
          {role.title}
        </span>
      </div>
      <div className="mb-[11px] flex items-baseline gap-[7px] font-heading text-2xl font-extrabold leading-none tracking-[-0.03em]">
        {role.applicants}
        <small className="font-sans text-[11.5px] font-semibold tracking-normal text-[var(--ai-t3)]">
          {role.applicants === 1 ? "applicant" : "applicants"}
        </small>
      </div>
      <div className="mb-[9px] h-[5px] overflow-hidden rounded-[3px] bg-[rgba(20,16,32,0.07)]">
        <div
          className="h-full rounded-[3px]"
          style={{
            width: `${max > 0 ? Math.round((role.applicants / max) * 100) : 0}%`,
            background: ROLE_BAR[index % ROLE_BAR.length],
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--ai-t3)]">
        <span>Published</span>
        {role.newThisWeek > 0 && (
          <b className="rounded-full bg-[var(--ai-mint-tint)] px-[7px] py-0.5 text-[10.5px] font-bold text-[var(--ai-mint-ink)]">
            +{role.newThisWeek} this week
          </b>
        )}
      </div>
    </Link>
  );
}

// ── Main ─────────────────────────────────────────────────────

export function OverviewClient({
  memberName,
  companyName,
  canCreateJob,
  canManageTeam: canTeam,
  data,
}: {
  memberName: string;
  companyName: string;
  canCreateJob: boolean;
  canManageTeam: boolean;
  data: OverviewData;
}) {
  const {
    totalApplicants,
    newThisWeek,
    awaitingReview,
    draftJobs,
    soleDraftId,
    soleDraftTitle,
    pendingInvites,
    publishedJobs,
    liveRoles,
    recentApplicants,
    activity,
  } = data;

  /**
   * Every card is a real condition with a real tally and a real destination.
   * Inactive conditions are filtered out, and when none survive the whole
   * section is not rendered — that behaviour is in the spec.
   */
  const needs: NeedsCard[] = [
    awaitingReview > 0 && {
      key: "review",
      tally: awaitingReview,
      title: "Applicants awaiting review",
      body: `${awaitingReview === 1 ? "One applicant is" : `${awaitingReview} applicants are`} still sitting at Applied. Move them along the pipeline so nothing stalls.`,
      cta: "Review applicants",
      href: "/ai-dashboard/applicants",
      icon: FileText,
      tintBg: "var(--ai-purple-tint)",
      tintFg: "var(--ai-purple-ink)",
    },
    draftJobs > 0 &&
      canCreateJob && {
        key: "draft",
        tally: draftJobs,
        title:
          draftJobs === 1 && soleDraftTitle
            ? `${soleDraftTitle} is still a draft`
            : `${draftJobs} roles still drafts`,
        body: "A draft isn't public and won't collect applicants until it goes live on remotiv.work.",
        cta: draftJobs === 1 ? "Finish and publish" : "Open jobs",
        href:
          draftJobs === 1 && soleDraftId
            ? `/ai-dashboard/jobs/${soleDraftId}/edit`
            : "/ai-dashboard/jobs",
        icon: Pencil,
        tintBg: "var(--ai-amber-tint)",
        tintFg: "var(--ai-amber-ink)",
      },
    pendingInvites > 0 &&
      canTeam && {
        key: "invites",
        tally: pendingInvites,
        title: "Invites awaiting acceptance",
        body: `${pendingInvites === 1 ? "One invite hasn't" : `${pendingInvites} invites haven't`} been accepted yet. Invite links expire after seven days — resend if it has gone stale.`,
        cta: "Open team",
        href: "/ai-dashboard/team",
        icon: Mail,
        tintBg: "var(--ai-sky-tint)",
        tintFg: "var(--ai-sky-ink)",
      },
  ].filter(Boolean) as NeedsCard[];

  const maxRole = liveRoles[0]?.applicants ?? 0;

  /**
   * Two sentences, mirroring the mock. The second is the mock's "Nothing is
   * waiting on Remotiv — it's all on you now", which is literally true of this
   * product: company-owned jobs and their applicants are invisible to
   * Remotiv's own admin (company_id_snapshot enforces that separation), so
   * there is no agency step in the loop. Interviews are not mentioned — they
   * don't exist yet.
   */
  const lede = (() => {
    if (totalApplicants === 0 && publishedJobs === 0) {
      return (
        <>
          Nothing is live yet. Publish your first role and it goes out on
          remotiv.work <LimeHighlight>the same day</LimeHighlight>. Nothing
          waits on Remotiv — you post, and applications come straight to you.
        </>
      );
    }
    if (newThisWeek > 0) {
      return (
        <>
          You have{" "}
          <LimeHighlight>
            {newThisWeek} new applicant{newThisWeek === 1 ? "" : "s"}
          </LimeHighlight>{" "}
          this week across {publishedJobs} live role
          {publishedJobs === 1 ? "" : "s"}. Nothing is waiting on Remotiv —
          these applicants are yours to move.
        </>
      );
    }
    return (
      <>
        No new applicants this week.{" "}
        <LimeHighlight>
          {publishedJobs} role{publishedJobs === 1 ? "" : "s"}
        </LimeHighlight>{" "}
        {publishedJobs === 1 ? "is" : "are"} live and collecting on
        remotiv.work. Nothing is waiting on Remotiv — it&apos;s all on you now.
      </>
    );
  })();

  return (
    <PageContainer>
      {/* Header */}
      <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[630px]:flex-row min-[630px]:items-end min-[630px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            {greeting()}, {firstName(memberName)}
          </h1>
          <p className="mt-2.5 max-w-[560px] text-[14.5px] leading-relaxed text-[var(--ai-t2)]">
            {lede}
          </p>
        </div>
        <div className="flex shrink-0 gap-2.5">
          {/* Disabled, not wired: there is no report to generate — no export
              endpoint, no scheduled digest, and no interviews or scores to
              summarise. Shipping it live would open a toast that does nothing.
              Same treatment as the Jobs list's Archive button. */}
          <button
            type="button"
            disabled
            title="Weekly reports arrive in a later release"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <LineChart className="size-[15px]" strokeWidth={1.9} />
            Weekly report
          </button>
          {canCreateJob && (
            <Link
              href="/ai-dashboard/jobs/new"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-remotiv-purple px-[18px] py-[11px] text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)] hover:shadow-[0_10px_28px_rgba(126,71,255,0.4)]"
            >
              <Plus className="size-[15px]" strokeWidth={2.2} />
              New job
            </Link>
          )}
        </div>
      </div>

      <AiHero data={data} canCreateJob={canCreateJob} />

      {/* Needs you — hidden entirely when nothing is outstanding. */}
      {needs.length > 0 && (
        <>
          <SectionHead title="Needs you" count={needs.length} />
          <div className="grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[968px]:grid-cols-3">
            {needs.map((card) => (
              <ActionCard key={card.key} card={card} />
            ))}
          </div>
        </>
      )}

      {/* This week */}
      <SectionHead title="This week" />
      <div className="grid grid-cols-1 items-start gap-3.5 min-[968px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ai-line)] px-5 py-4">
            <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
              Latest applicants
            </h3>
            {totalApplicants > 0 && (
              <Link
                href="/ai-dashboard/applicants"
                className="text-[12.5px] font-bold text-remotiv-purple hover:text-[var(--ai-purple-hover)]"
              >
                All {totalApplicants} →
              </Link>
            )}
          </div>
          {recentApplicants.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <div className="mb-3.5 flex size-[52px] items-center justify-center rounded-[16px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
                <Users className="size-6" strokeWidth={1.7} />
              </div>
              <p className="m-0 max-w-[300px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
                No applications yet. They appear here the moment someone applies
                to one of your live roles.
              </p>
            </div>
          ) : (
            recentApplicants.map((r, i) => (
              <ApplicantRow key={r.id} row={r} index={i} />
            ))
          )}
        </div>

        <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ai-line)] px-5 py-4">
            <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
              Recent activity
            </h3>
          </div>
          <div className="px-5 pb-[18px] pt-4">
            {activity.length === 0 ? (
              <p className="m-0 text-[13px] leading-relaxed text-[var(--ai-t3)]">
                Nothing has happened in {companyName} yet. Publishing a role and
                the first applications will show up here.
              </p>
            ) : (
              activity.map((item, i) => (
                <div
                  key={item.id}
                  className={`relative flex gap-3 ${
                    i === activity.length - 1 ? "" : "pb-4"
                  }`}
                >
                  {i < activity.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[5px] top-4 w-[1.5px] bg-[var(--ai-line)]"
                    />
                  )}
                  <span
                    className="z-[1] mt-[3px] size-[11px] shrink-0 rounded-full shadow-[0_0_0_3px_var(--ai-surface),0_0_0_4.5px_rgba(20,16,32,0.1)]"
                    style={{ background: ACTIVITY_DOT[item.kind] }}
                  />
                  <div className="min-w-0">
                    <p className="m-0 text-[13px] leading-snug text-[var(--ai-t2)]">
                      <b className="font-bold text-[var(--ai-t1)]">
                        {item.subject}
                      </b>{" "}
                      {item.predicate}
                    </p>
                    <small className="mt-[3px] block text-[11.5px] text-[var(--ai-t4)]">
                      {item.actor ? `${item.actor} · ` : ""}
                      {timeAgo(item.createdAt)}
                    </small>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Live roles */}
      {liveRoles.length > 0 && (
        <>
          <SectionHead
            title="Live roles"
            linkHref="/ai-dashboard/jobs"
            linkLabel="All jobs"
          />
          <div className="grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[968px]:grid-cols-4">
            {liveRoles.map((role, i) => (
              <RoleCard key={role.id} role={role} index={i} max={maxRole} />
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}
