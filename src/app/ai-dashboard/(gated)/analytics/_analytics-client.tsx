"use client";

import { ArrowRight, BarChart3, Info, Lightbulb, Link2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { BAND_TEXT, scoreBand } from "@/app/ai-dashboard/lib/score-bands";
import { fetchAnalytics } from "./actions";
import {
  type AnalyticsRange,
  type AnalyticsResult,
  type FunnelStage,
  RANGE_LABELS,
  type SourceRow,
} from "./types";
import "./analytics.css";

/**
 * Analytics — statement-led, so a flat ink strip and no mint block.
 *
 * The page opens with three SENTENCES rather than a headline number: the
 * insight strip is the page's identity and stays visible even on day one, in
 * its own empty state.
 */

/** Ring/bar colours by band. The THRESHOLDS live in score-bands.ts — shared
 *  with CV and interview scores rather than restated here. */
const BAND_HEX: Record<string, string> = {
  hi: "#49D7A7",
  mid: "#F5A524",
  lo: "#E0524B",
};
const BAND_INK: Record<string, string> = {
  hi: "#04342C",
  mid: "#7A4E05",
  lo: "#B02A24",
};

const CARD =
  "rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[22px] py-5 shadow-[0_6px_30px_rgba(20,16,32,0.055)]";
const CARD_TITLE = "m-0 mb-1 font-heading text-[16px] font-extrabold tracking-[-0.022em]";
const CARD_SUB = "m-0 mb-[18px] text-[12px] leading-relaxed text-[var(--ai-t3)]";

export function AnalyticsClient({ initial }: { initial: AnalyticsResult }) {
  const [data, setData] = useState(initial);
  const [range, setRange] = useState<AnalyticsRange>("90d");
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  function changeRange(next: AnalyticsRange) {
    setRange(next);
    setFailed(false);
    startTransition(async () => {
      /*
       * Caught here rather than left to the boundary.
       *
       * fetchAnalytics throws when a paged read fails, which is the point — the
       * figures are aggregates and a short read makes all of them wrong. But an
       * error escaping an async transition is framework behaviour we would be
       * relying on untested, and the last time this codebase relied on an
       * unhandled rejection finding its way somewhere useful, the sign-in button
       * sat on "Signing in…" for good. So the failure is handled explicitly, and
       * the previously loaded range stays on screen rather than the page being
       * replaced.
       */
      try {
        setData(await fetchAnalytics(next));
      } catch (err) {
        console.error("[analytics] range change failed:", err);
        setFailed(true);
      }
    });
  }

  return (
    <PageContainer>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="m-0 font-heading text-[44px] font-extrabold leading-none tracking-[-0.04em]">
            Analytics
          </h1>
          <p className="m-0 mt-3 max-w-[620px] text-[15px] leading-relaxed text-[var(--ai-t2)]">
            {data.hasAnyData ? (
              <>
                Where your hiring is <Marker>actually slowing down</Marker> — and which sources are
                worth your time.
              </>
            ) : (
              <>
                Nothing to report yet — this page <Marker>fills in as you hire</Marker>.
              </>
            )}
          </p>
        </div>
        <select
          value={range}
          aria-label="Date range"
          disabled={pending}
          onChange={(e) => changeRange(e.target.value as AnalyticsRange)}
          className="shrink-0 appearance-none rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-[13px] pr-9 text-[13.5px] font-semibold text-[var(--ai-t2)] outline-none focus:border-remotiv-purple disabled:opacity-60"
        >
          {(Object.keys(RANGE_LABELS) as AnalyticsRange[]).map((r) => (
            <option key={r} value={r}>
              {RANGE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      {failed && (
        <p
          role="alert"
          className="mb-[22px] rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700"
        >
          Couldn't load that range — the figures below are still the previous one. Please try again.
        </p>
      )}

      <InsightStrip data={data} />

      {data.hasAnyData ? (
        <>
          <StatGrid data={data} />
          <Funnel data={data} range={range} />
          <div className="mb-4 grid items-start gap-3.5 min-[1180px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Sources data={data} />
            <Agreement data={data} />
          </div>
          <JobHealth data={data} />
          <p className="m-0 mt-[18px] flex items-center gap-2.5 px-0.5 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            <Info className="size-[15px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
            Every figure is counted from your own hiring activity in the selected period. Nothing is
            benchmarked against other companies.
          </p>
        </>
      ) : (
        <DayOne />
      )}
    </PageContainer>
  );
}

/**
 * "1 applicant", not "1 applicants".
 *
 * Counts on this page are frequently 1 — a workspace with one application in a
 * role is the common early case, not an edge one — so every count that carries
 * a noun goes through here rather than being hand-written per call site.
 */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The lime marker. Ink text on lime, rotated — the page's one flourish. */
function Marker({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-[5px] font-bold text-[var(--ai-t1)]">
      <span
        aria-hidden
        className="absolute inset-y-[4%] -left-[3px] -right-[3px] -z-10 -rotate-[1.2deg] rounded-[3px] bg-remotiv-lime"
      />
      {children}
    </span>
  );
}

// ── Insights ─────────────────────────────────────────────────

function InsightStrip({ data }: { data: AnalyticsResult }) {
  return (
    <div className="mb-4 rounded-[22px] bg-[var(--ai-sidebar)] px-[30px] py-[26px] shadow-[0_18px_46px_rgba(20,16,32,0.24)]">
      <p className="m-0 mb-[18px] text-[10.5px] font-bold uppercase tracking-[0.15em] text-white/40">
        Three things worth a look
      </p>

      {data.insights.length === 0 ? (
        <div className="flex items-start gap-3">
          <Lightbulb className="mt-0.5 size-[18px] shrink-0 text-white/40" strokeWidth={1.9} />
          <p className="m-0 max-w-[640px] text-[14.5px] leading-relaxed text-white/60">
            <b className="font-bold text-white">Nothing to flag yet.</b> Once around twenty people
            have applied, this is where you&apos;ll get three plain-English observations about
            what&apos;s working and what isn&apos;t — each one linking straight to the thing
            it&apos;s about.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {data.insights.map((ins, i) => (
            /* A whole-row link, not a sentence with a link buried in it. */
            <Link
              key={ins.figure + ins.cta}
              href={ins.href}
              className="group -mx-3 flex items-start gap-3.5 rounded-[11px] px-3 py-[11px] transition-colors hover:bg-white/[0.05]"
            >
              <span className="mt-1.5 w-3.5 shrink-0 font-heading text-[11px] font-extrabold text-white/[0.28]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span
                aria-hidden
                className={`mt-2 size-2 shrink-0 rounded-full ${
                  ins.tone === "warn"
                    ? "bg-[#F5A524] shadow-[0_0_0_3px_rgba(245,165,36,0.18)]"
                    : "bg-remotiv-green shadow-[0_0_0_3px_rgba(73,215,167,0.18)]"
                }`}
              />
              <p className="m-0 min-w-0 flex-1 text-[15px] font-medium leading-relaxed text-white">
                {ins.before}
                <Marker>{ins.figure}</Marker>
                {ins.after}
              </p>
              <span className="mt-[5px] inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-bold text-remotiv-purple-light transition-colors group-hover:text-white">
                {ins.cta}
                <ArrowRight
                  className="size-[13px] transition-transform group-hover:translate-x-[3px]"
                  strokeWidth={2.4}
                />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Stat cards ───────────────────────────────────────────────

function StatGrid({ data }: { data: AnalyticsResult }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 min-[840px]:grid-cols-3 min-[1320px]:grid-cols-6">
      {data.stats.map((s) => (
        <div
          key={s.key}
          className="rounded-[16px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 pb-[13px] pt-[15px] shadow-[0_4px_20px_rgba(20,16,32,0.045)]"
        >
          <p className="m-0 mb-2.5 truncate text-[11.5px] font-semibold text-[var(--ai-t3)]">
            {s.key}
          </p>
          {s.value === null ? (
            /* An em-dash, never a fabricated 0 — see emptyLabel below it. */
            <p className="m-0 font-heading text-[22px] font-extrabold leading-none text-[var(--ai-t4)]">
              —
            </p>
          ) : (
            <p className="m-0 flex items-baseline gap-0.5 font-heading text-[29px] font-extrabold leading-none tracking-[-0.045em]">
              {s.value}
              {s.unit && (
                <span className="font-sans text-[13px] font-semibold tracking-normal text-[var(--ai-t3)]">
                  {s.unit}
                </span>
              )}
            </p>
          )}
          {s.value === null && s.emptyLabel && (
            <div className="mt-[11px]">
              <span className="inline-flex rounded-full bg-[var(--ai-inset)] px-[7px] py-0.5 text-[11px] font-bold text-[var(--ai-t3)]">
                {s.emptyLabel}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────

/** Bar colour per stage. The bottleneck overrides to amber. */
const STAGE_BAR = ["#7E47FF", "#8C5AFF", "#9E72FF", "#A87FFF", "#B48CFF", "#49D7A7"];

function Funnel({ data, range }: { data: AnalyticsResult; range: AnalyticsRange }) {
  const top = data.funnel[0]?.count || 1;
  const bottleneck = data.funnel.find((f) => f.stage === data.bottleneckStage) ?? null;
  const firstUnreached = data.funnel.find((f) => !f.reached);

  return (
    <div className={`${CARD} mb-4`}>
      <p className={CARD_TITLE}>Hiring funnel</p>
      <p className={CARD_SUB}>
        {RANGE_LABELS[range]} · how many advanced at each step, and how long they waited
      </p>

      <div className="flex flex-col">
        {data.funnel.map((f, i) => {
          const next = data.funnel[i + 1];
          const isSlow = f.stage === data.bottleneckStage;
          return (
            <div key={f.stage}>
              <FunnelRow
                stage={f}
                widthPct={f.reached ? Math.max(2, (f.count / top) * 100) : 9}
                colour={isSlow ? "#F5A524" : STAGE_BAR[i]}
                slow={isSlow}
              />
              {next && <Connector from={f} to={next} />}
            </div>
          );
        })}
      </div>

      {/* Computed, never hardcoded — dropped entirely when nothing stands out. */}
      {bottleneck && (
        <div className="mt-[18px] flex items-start gap-3 rounded-[13px] border border-[rgba(224,160,32,0.26)] bg-[#FBEBCF] px-[15px] py-[13px]">
          <TriangleAlert className="mt-px size-4 shrink-0 text-[#7A4E05]" strokeWidth={2} />
          <p className="m-0 text-[12.5px] leading-relaxed text-[#7A4E05]">
            <b className="font-extrabold">{bottleneck.label} is your bottleneck.</b> Candidates wait{" "}
            {bottleneck.avgDays} days there — longer than any other stage.{" "}
            <Link
              href="/ai-dashboard/applicants"
              className="font-extrabold text-[#7A4E05] underline underline-offset-2"
            >
              See who is waiting
            </Link>
          </p>
        </div>
      )}

      {!bottleneck && firstUnreached && (
        <div className="mt-[18px] flex items-start gap-3 rounded-[13px] border border-[var(--ai-line-strong)] bg-[var(--ai-inset)] px-[15px] py-[13px]">
          <Info className="mt-px size-4 shrink-0 text-[var(--ai-t3)]" strokeWidth={2} />
          <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
            <b className="font-extrabold">Nobody has reached {firstUnreached.label} yet.</b> Those
            stages stay dashed until someone gets there — they aren&apos;t zeros, there&apos;s just
            no data to average.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One stage band.
 *
 * The count is its OWN grid cell, not a child of the bar. Inside the bar it
 * would need a min-width to fit its label, and that floor is what flattened
 * Offer and Hired to identical widths — the bars stop being proportional the
 * moment anything sets a minimum.
 */
function FunnelRow({
  stage,
  widthPct,
  colour,
  slow,
}: {
  stage: FunnelStage;
  widthPct: number;
  colour: string;
  slow: boolean;
}) {
  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)_36px_66px] items-center gap-3 min-[1180px]:grid-cols-[118px_minmax(0,1fr)_40px_74px] min-[1180px]:gap-4">
      <span
        className={`whitespace-nowrap text-[13px] font-bold tracking-[-0.01em] ${
          !stage.reached ? "text-[var(--ai-t4)]" : slow ? "text-[#7A4E05]" : "text-[var(--ai-t1)]"
        }`}
      >
        {stage.label}
      </span>
      <span className="relative flex h-[38px] items-center">
        <span
          className="analytics-reveal h-[38px] rounded-[9px]"
          style={{
            width: `${widthPct}%`,
            background: stage.reached ? colour : undefined,
            ...(stage.reached
              ? {}
              : {
                  backgroundImage:
                    "repeating-linear-gradient(135deg,rgba(20,16,32,0.06) 0 5px,transparent 5px 10px)",
                  border: "1px dashed var(--ai-line-strong)",
                }),
          }}
        />
      </span>
      <span
        className={`text-right font-heading text-[16px] font-extrabold leading-none tabular-nums tracking-[-0.03em] ${
          !stage.reached ? "text-[var(--ai-t4)]" : slow ? "text-[#7A4E05]" : "text-[#2E2470]"
        }`}
      >
        {stage.reached ? stage.count : "—"}
      </span>
      {stage.avgDays === null ? (
        <span className="text-right text-[12px] font-semibold text-[var(--ai-t3)]">
          {stage.reached ? "—" : "Not reached"}
        </span>
      ) : slow ? (
        <span className="justify-self-end rounded-full bg-[#FBEBCF] px-[9px] py-[3px] text-[12px] font-extrabold tabular-nums text-[#7A4E05]">
          {stage.avgDays}d
        </span>
      ) : (
        <span className="text-right text-[12px] font-semibold tabular-nums text-[var(--ai-t3)]">
          {stage.avgDays}d
        </span>
      )}
    </div>
  );
}

/** The drop-off between two stages — the thing a funnel exists to show. */
function Connector({ from, to }: { from: FunnelStage; to: FunnelStage }) {
  if (!to.reached) {
    return (
      <div className="grid grid-cols-[100px_minmax(0,1fr)_36px_66px] gap-3 py-[5px] min-[1180px]:grid-cols-[118px_minmax(0,1fr)_40px_74px] min-[1180px]:gap-4">
        <span className="col-start-2 flex items-center gap-2.5 text-[11.5px] text-[var(--ai-t3)]">
          <span aria-hidden className="ml-[13px] h-[13px] w-px bg-[var(--ai-line-strong)]" />
          No one has reached this stage yet
        </span>
      </div>
    );
  }
  const conv = from.count > 0 ? Math.round((to.count / from.count) * 100) : 0;
  const lost = Math.max(0, from.count - to.count);
  const bad = conv < 50;
  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)_36px_66px] gap-3 py-[5px] min-[1180px]:grid-cols-[118px_minmax(0,1fr)_40px_74px] min-[1180px]:gap-4">
      <span className="col-start-2 flex items-center gap-2.5 text-[11.5px] text-[var(--ai-t3)]">
        <span
          aria-hidden
          className={`ml-[13px] h-[13px] w-px ${bad ? "bg-[#F5A524]" : "bg-[var(--ai-line-strong)]"}`}
        />
        <b
          className={`font-extrabold tabular-nums ${bad ? "text-[#7A4E05]" : "text-[var(--ai-t2)]"}`}
        >
          {conv}%
        </b>{" "}
        advanced <span className="text-[var(--ai-t4)]">· {lost} didn&apos;t</span>
      </span>
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────

function Sources({ data }: { data: AnalyticsResult }) {
  const top = Math.max(1, ...data.sources.map((s) => s.applications));

  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>Where applicants come from</p>
      <p className={CARD_SUB}>
        Bar length is volume · the mint segment is who reached shortlist · the ring is average AI
        score
      </p>

      {!data.anyTaggedSource ? (
        <div className="flex flex-col items-center px-5 pb-[34px] pt-8 text-center">
          <span className="mb-[15px] flex size-[54px] items-center justify-center rounded-[17px] border border-[var(--ai-line)] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
            <Link2 className="size-6" strokeWidth={1.8} />
          </span>
          <h4 className="m-0 mb-[7px] font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
            No tagged links used yet
          </h4>
          <p className="m-0 max-w-[340px] text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            Every applicant currently shows as <b className="font-bold">Direct</b>. Share a job with
            a tracked link and the channel it came from will appear here — including domains we
            don&apos;t recognise.
          </p>
          <Link
            href="/ai-dashboard/jobs"
            className="mt-[15px] text-[12.5px] font-bold text-remotiv-purple hover:opacity-80"
          >
            Copy a tracked link
          </Link>
        </div>
      ) : (
        <>
          {data.sources.map((s) => (
            <SourceRowView key={s.key} source={s} topVolume={top} />
          ))}
          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--ai-line-soft)] pt-[13px] text-[11px] text-[var(--ai-t4)]">
            <Legend colour="#9886FE" label="Applications" />
            <Legend colour="#49D7A7" label="Reached shortlist" />
            <Legend colour="#49D7A7" label="Ring: avg score 80+" round />
            <Legend colour="#F5A524" label="60–79" />
            <Legend colour="#E0524B" label="Under 60" />
          </div>
        </>
      )}
    </div>
  );
}

function Legend({ colour, label, round }: { colour: string; label: string; round?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        aria-hidden
        className={`size-[9px] shrink-0 ${round ? "rounded-full" : "rounded-[3px]"}`}
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

function SourceRowView({ source, topVolume }: { source: SourceRow; topVolume: number }) {
  const width = Math.max(2, Math.round((source.applications / topVolume) * 100));
  const band = source.avgScore === null ? null : scoreBand(source.avgScore);
  const C = 2 * Math.PI * 18;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-3.5 border-b border-[var(--ai-line-soft)] py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="mb-[7px] flex items-baseline justify-between gap-3">
          <span
            className={`min-w-0 truncate ${
              source.unknown
                ? "font-mono text-[12.5px] font-medium text-[var(--ai-t3)]"
                : "text-[13.5px] font-bold tracking-[-0.01em]"
            }`}
          >
            {source.label}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--ai-t3)]">
            <b className="font-bold text-[var(--ai-t1)]">{source.applications}</b>{" "}
            {source.applications === 1 ? "app" : "apps"} · {source.shortlistPct}% shortlisted
          </span>
        </div>
        <div className="relative h-[7px] overflow-hidden rounded-[4px] bg-[rgba(20,16,32,0.07)]">
          <div
            className="analytics-grow relative h-full rounded-[4px]"
            style={{
              width: `${width}%`,
              background: source.unknown ? "var(--ai-t4)" : "#9886FE",
            }}
          >
            {/* NESTED in this source's own fill — a proportion of THIS bar, not a
                tick against the whole track. Positioning against the track
                multiplies two scales and overstates the rate. */}
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-l-[4px] bg-remotiv-green"
              style={{ width: `${source.shortlistPct}%` }}
            />
          </div>
        </div>
      </div>
      <span className="relative size-11 shrink-0">
        {band && source.avgScore !== null ? (
          <>
            <svg
              viewBox="0 0 44 44"
              className="size-11 -rotate-90"
              role="img"
              aria-label={`Average AI score ${source.avgScore}`}
            >
              <title>{`Average AI score ${source.avgScore}`}</title>
              <circle
                cx="22"
                cy="22"
                r="18"
                fill="none"
                strokeWidth="4"
                stroke="rgba(20,16,32,0.08)"
              />
              <circle
                cx="22"
                cy="22"
                r="18"
                fill="none"
                strokeWidth="4"
                strokeLinecap="round"
                stroke={BAND_HEX[band]}
                strokeDasharray={C.toFixed(1)}
                strokeDashoffset={(C * (1 - source.avgScore / 100)).toFixed(1)}
              />
            </svg>
            <span
              className="absolute inset-0 flex items-center justify-center font-heading text-[13px] font-extrabold tracking-[-0.03em]"
              style={{ color: BAND_INK[band] }}
              title={BAND_TEXT[band]}
            >
              {source.avgScore}
            </span>
          </>
        ) : (
          <span className="flex size-11 items-center justify-center text-[13px] text-[var(--ai-t4)]">
            —
          </span>
        )}
      </span>
    </div>
  );
}

// ── AI / human agreement ─────────────────────────────────────

function Agreement({ data }: { data: AnalyticsResult }) {
  const a = data.agreement;
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>AI and human agreement</p>
      <p className={CARD_SUB}>How often a reviewer changes a score, and which way</p>

      {!a ? (
        <div className="flex flex-col items-center px-5 pb-[34px] pt-8 text-center">
          <span className="mb-[15px] flex size-[54px] items-center justify-center rounded-[17px] border border-[var(--ai-line)] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
            <Lightbulb className="size-6" strokeWidth={1.8} />
          </span>
          <h4 className="m-0 mb-[7px] font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
            Nothing scored yet
          </h4>
          <p className="m-0 max-w-[340px] text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            Once your team reviews a few AI-scored candidates, this shows how often you agreed with
            the score and which way you moved it.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-baseline gap-2.5">
            <span className="font-heading text-[38px] font-extrabold leading-none tracking-[-0.05em] text-[#04342C]">
              {a.acceptedPct}%
            </span>
            <span className="text-[12.5px] font-semibold leading-tight text-[var(--ai-t3)]">
              accepted
              <br />
              unchanged
            </span>
          </div>
          <div className="mb-3.5 flex h-[34px] gap-0.5 overflow-hidden rounded-[10px]">
            <Segment pct={a.acceptedPct} bg="#49D7A7" fg="#04342C" />
            <Segment pct={a.upPct} bg="#9886FE" fg="#fff" />
            <Segment pct={a.downPct} bg="#7E47FF" fg="#fff" />
          </div>
          <div className="flex flex-col gap-2.5">
            <LegendRow colour="#49D7A7" label="Accepted as scored" value={a.acceptedPct} />
            <LegendRow colour="#9886FE" label="Scored up by a human" value={a.upPct} />
            <LegendRow colour="#7E47FF" label="Scored down by a human" value={a.downPct} />
          </div>
          <p className="m-0 mt-4 border-t border-[var(--ai-line-soft)] pt-3.5 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            {a.avgChange !== null && (
              <>
                Average change when overridden:{" "}
                <b className="font-bold text-[var(--ai-t1)]">
                  {a.avgChange > 0 ? "+" : ""}
                  {a.avgChange} points
                </b>
                .{" "}
              </>
            )}
            An override doesn&apos;t mean the AI was wrong — it&apos;s how we learn where it reads
            candidates high or low.
          </p>
        </>
      )}
    </div>
  );
}

function Segment({ pct, bg, fg }: { pct: number; bg: string; fg: string }) {
  if (pct <= 0) return null;
  return (
    <span
      className="analytics-reveal flex min-w-0 items-center justify-center overflow-hidden whitespace-nowrap text-[11.5px] font-extrabold"
      style={{ width: `${pct}%`, background: bg, color: fg }}
    >
      {pct >= 8 ? `${pct}%` : ""}
    </span>
  );
}

function LegendRow({ colour, label, value }: { colour: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2.5 text-[12.5px]">
      <i aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colour }} />
      <span className="flex-1 text-[var(--ai-t2)]">{label}</span>
      <b className="font-extrabold tabular-nums">{value}%</b>
    </div>
  );
}

// ── Job health ───────────────────────────────────────────────

function JobHealth({ data }: { data: AnalyticsResult }) {
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>Job health</p>
      <p className={CARD_SUB}>Roles that may need attention</p>

      {data.jobs.length === 0 ? (
        <div className="flex flex-col items-center px-5 pb-[34px] pt-8 text-center">
          <h4 className="m-0 mb-[7px] font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
            No published roles
          </h4>
          <p className="m-0 max-w-[340px] text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            Publish a job and it will appear here with its application volume, average score and
            shortlist rate.
          </p>
          <Link
            href="/ai-dashboard/jobs/new"
            className="mt-[15px] text-[12.5px] font-bold text-remotiv-purple hover:opacity-80"
          >
            Post a job
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1.5fr)_110px_78px_62px] gap-3 border-b border-[var(--ai-line)] pb-2.5 text-[10px] font-extrabold uppercase tracking-[0.09em] text-[var(--ai-t3)] min-[1180px]:grid-cols-[minmax(0,1.9fr)_132px_96px_74px] min-[1180px]:gap-4 [&>span:not(:first-child)]:text-right">
            <span>Role</span>
            <span>Avg score</span>
            <span>Shortlist</span>
            <span>Oldest</span>
          </div>
          {data.jobs.map((j) => {
            const band = j.avgScore === null ? null : scoreBand(j.avgScore);
            return (
              <div
                key={j.jobId}
                className={`grid grid-cols-[minmax(0,1.5fr)_110px_78px_62px] items-center gap-3 border-b border-[var(--ai-line-soft)] py-3.5 last:border-b-0 min-[1180px]:grid-cols-[minmax(0,1.9fr)_132px_96px_74px] min-[1180px]:gap-4 ${
                  j.needsLook
                    ? "-mx-[22px] border-l-[3px] border-l-[#F5A524] bg-[rgba(245,165,36,0.055)] pl-[19px] pr-[22px]"
                    : ""
                }`}
              >
                <div className="min-w-0">
                  <p
                    className={`m-0 truncate text-[13.5px] font-bold leading-tight tracking-[-0.01em] ${
                      j.needsLook ? "text-[#7A4E05]" : ""
                    }`}
                  >
                    {j.title}
                    {j.needsLook && (
                      <span className="ml-2 rounded-[5px] bg-[#FBEBCF] px-[7px] py-0.5 align-[1px] text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#7A4E05]">
                        Needs a look
                      </span>
                    )}
                  </p>
                  <small className="mt-[3px] block text-[11.5px] text-[var(--ai-t3)]">
                    {plural(j.applications, "applicant")}
                  </small>
                </div>
                <span className="flex items-center gap-2.5">
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-[rgba(20,16,32,0.07)]">
                    {band && j.avgScore !== null && (
                      <span
                        className="analytics-grow block h-full rounded-[4px]"
                        style={{ width: `${j.avgScore}%`, background: BAND_HEX[band] }}
                      />
                    )}
                  </span>
                  <b
                    className="w-5 shrink-0 text-right text-[13px] font-extrabold tabular-nums"
                    style={band ? { color: BAND_INK[band] } : undefined}
                  >
                    {j.avgScore ?? "—"}
                  </b>
                </span>
                <span className="text-right text-[13px] font-bold tabular-nums">
                  {j.shortlistPct}%
                </span>
                <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums text-[var(--ai-t3)]">
                  {j.oldestDays}d
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ── Day one ──────────────────────────────────────────────────

/** Replaces the whole body. The insight strip stays — it is the page's identity. */
function DayOne() {
  const steps = [
    {
      title: "Publish a role",
      body: "The moment a job goes live, applications start being counted against it.",
    },
    {
      title: "Let a few people through the funnel",
      body: "Stage timings need at least one person to have moved through to be meaningful.",
    },
    {
      title: "Come back after a week",
      body: "Around 20 applicants is enough for the insights at the top to be worth reading.",
    },
  ];

  return (
    <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
      <div className="bg-[var(--ai-sidebar)] px-8 pb-[30px] pt-[34px] text-center">
        <span className="mb-4 inline-flex size-16 items-center justify-center rounded-[20px] border border-white/[0.14] bg-white/10 text-white">
          <BarChart3 className="size-7" strokeWidth={1.8} />
        </span>
        <h3 className="m-0 mb-2.5 font-heading text-2xl font-extrabold leading-tight tracking-[-0.033em] text-white">
          Your numbers show up <span className="text-remotiv-lime">as you hire</span>
        </h3>
        <p className="mx-auto m-0 max-w-[440px] text-[13.5px] leading-relaxed text-white/[0.55]">
          Analytics is built from your own activity, so there&apos;s nothing here until people start
          applying. No setup, no tracking code — it fills in on its own.
        </p>
      </div>
      <div className="grid min-[1180px]:grid-cols-3">
        {steps.map((s, i) => (
          <div
            key={s.title}
            className="border-b border-[var(--ai-line-soft)] px-6 py-[22px] last:border-b-0 min-[1180px]:border-b-0 min-[1180px]:border-r min-[1180px]:last:border-r-0"
          >
            <span className="mb-3 flex size-[26px] items-center justify-center rounded-[9px] bg-[var(--ai-purple-tint)] text-[12px] font-extrabold text-[var(--ai-purple-ink)]">
              {i + 1}
            </span>
            <p className="m-0 text-sm font-bold leading-snug tracking-[-0.01em]">{s.title}</p>
            <small className="mt-[5px] block text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
              {s.body}
            </small>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-[15px] text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
        Most companies see their first useful numbers about a week after their first job goes live.
      </div>
    </div>
  );
}
