"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  Info,
  LineChart,
  MinusCircle,
  Users,
} from "lucide-react";
import { useCallback, useState, useTransition } from "react";
import { TopNav } from "@/app/admin/_components/top-nav";
import type { UserRole } from "@/app/admin/lib/roles";
import { fetchPlatformAnalytics } from "./actions";
import {
  barWidthPct,
  type CategoryRow,
  type CompanyRow,
  formatMicro,
  MIN_OVERRIDES_PER_CATEGORY,
  MIN_OVERRIDES_PER_REVIEWER,
  MIN_OVERRIDES_TO_CALIBRATE,
  maxAbsMean,
  type ReviewerRow,
  UNATTRIBUTED,
} from "./rollup";
import {
  type AnalyticsRange,
  type AnalyticsResult,
  RANGE_LABELS,
  USAGE_TYPE_LABELS,
} from "./types";

/**
 * ── On the zoom ──────────────────────────────────────────────
 *
 * The handoff's `.ai-shell { zoom: 0.82 }` is NOT applied here, and that is
 * deliberate rather than an omission. `.ai-shell` scopes the tenant dashboard;
 * this page lives under /admin, which has its own shell and no zoom. Applying
 * it would shrink this page alone and leave it visibly out of step with every
 * other admin surface it sits beside in the same rail.
 *
 * The consequence is that the mock's px values are the POST-zoom rendering and
 * cannot be transcribed literally — a 44px heading in a 0.82 shell renders at
 * 36px. Sizes below are the admin shell's own scale, matched to the sibling
 * admin pages rather than to the mock's raw numbers.
 */

const INK = "#141020";

/**
 * The bar reveal, as a local stylesheet.
 *
 * clip-path rather than scaleX: a transform would squash the bar's rounded cap
 * and, on the diverging track, drag the fill across the centre line during the
 * animation — the one thing the axis must never appear to do.
 *
 * Declared here rather than in globals.css: this is the only page that uses
 * it, and globals.css is out of scope for this change.
 */
const REVEAL_CSS = `
@keyframes pa-reveal { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) } }
.pa-reveal { animation: pa-reveal .85s cubic-bezier(.4,0,.2,1) both }
@media (prefers-reduced-motion: reduce) { .pa-reveal { animation: none } }
`;

const CARD = "rounded-2xl border border-gray-100 bg-white p-5 shadow-sm";
const LABEL = "text-[10px] font-bold uppercase tracking-[0.11em] text-gray-400";
const SUB = "mt-1 text-xs leading-relaxed text-gray-400";

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function signed(n: number): string {
  return `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}`;
}

function initials(name: string): string {
  return (
    name
      .replace(/\(.*\)/, "")
      .trim()
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function PlatformAnalyticsClient({
  email,
  userRole,
  initial,
}: {
  email: string;
  userRole: UserRole;
  initial: AnalyticsResult;
}) {
  const [data, setData] = useState(initial);
  const [pending, startTransition] = useTransition();

  const changeRange = useCallback((range: AnalyticsRange) => {
    startTransition(async () => {
      setData(await fetchPlatformAnalytics(range));
    });
  }, []);

  const exportCsv = useCallback(() => {
    const header = [
      "Company",
      "Internal",
      "Jobs",
      "CVs",
      "Interviews",
      "Emails",
      "WhatsApp",
      "Minutes",
      "Cost USD",
    ];
    const rows = data.companies.map((c) => [
      c.name,
      c.isInternal ? "yes" : "no",
      c.jobs,
      c.cvs,
      c.interviews,
      c.emails,
      c.whatsapp,
      c.transcribedMinutes,
      (c.costMicro / 1_000_000).toFixed(6),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `remotiv-platform-analytics-${data.range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  return (
    <div className="min-h-screen bg-remotiv-bg">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static, author-written keyframe string with no interpolation */}
      <style dangerouslySetInnerHTML={{ __html: REVEAL_CSS }} />
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs text-gray-400">Admin · all companies</p>
            <h1 className="font-heading text-3xl font-bold tracking-tight text-gray-900">
              Platform analytics
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500">
              What the platform costs to run, and{" "}
              <Highlight>where the scorer disagrees with people</Highlight> — the evidence for the
              next prompt version.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-600 transition-colors hover:border-gray-900 hover:bg-gray-900 hover:text-white"
            >
              <Download className="size-4" strokeWidth={2} />
              Export
            </button>
            <select
              aria-label="Date range"
              value={data.range}
              disabled={pending}
              onChange={(e) => changeRange(e.target.value as AnalyticsRange)}
              className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-600 outline-none focus:border-remotiv-purple disabled:opacity-60"
            >
              {(Object.keys(RANGE_LABELS) as AnalyticsRange[]).map((r) => (
                <option key={r} value={r}>
                  {RANGE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {data.violations.length > 0 && <ReconciliationNotice count={data.violations.length} />}

        <StatCards data={data} />

        <SectionHead
          title="AI calibration"
          lede="Where reviewers consistently disagree with the scorer. Read the reviewer column before changing anything — one strict person can look exactly like a generous model."
        >
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-gray-400">
            <b className="font-bold text-gray-600">
              All time, not the {RANGE_LABELS[data.range].toLowerCase()} above.
            </b>{" "}
            Category means need volume before they mean anything, and a month of this platform's
            traffic is nowhere near enough. Cost is a period; calibration is a corpus.
          </p>
        </SectionHead>

        <CalibrationStrip data={data} />

        <div className="mb-3.5 grid grid-cols-1 items-start gap-3.5 xl:grid-cols-2">
          <ByCategory data={data} />
          <ReviewerBias data={data} />
        </div>

        <div className="mb-3.5 grid grid-cols-1 items-start gap-3.5 xl:grid-cols-2">
          <ByVersion data={data} />
          <SystemHealth data={data} />
        </div>

        <Footnote>
          <b className="font-bold text-gray-600">Revenue and margin arrive with billing.</b>{" "}
          Everything above is AI spend only — hosting, storage and bandwidth aren't attributed per
          tenant yet.
        </Footnote>

        <SectionHead
          className="mt-9"
          title="Cost and health by company"
          lede="Expand a row to see where the money went and what you'd raise on a check-in call."
        />

        <UsageCoverageNote data={data} />
        <CompanyTable data={data} />
      </main>
    </div>
  );
}

/* ────────────────────────── chrome ────────────────────────── */

function Highlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold text-gray-900">
      <span
        aria-hidden
        className="absolute inset-x-[-3px] inset-y-[6%] -z-10 -rotate-1 rounded-[3px] bg-remotiv-lime"
      />
      {children}
    </span>
  );
}

function SectionHead({
  title,
  lede,
  className = "",
  children,
}: {
  title: string;
  lede: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`mb-3.5 ${className}`}>
      <h2 className="font-heading text-xl font-bold tracking-tight text-gray-900">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-gray-400">{lede}</p>
      {children}
    </div>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-start gap-2.5 text-xs leading-relaxed text-gray-400">
      <Info className="mt-0.5 size-4 shrink-0 text-gray-300" strokeWidth={1.9} />
      <span>{children}</span>
    </p>
  );
}

/**
 * Shown only when a roll-up disagrees with its table.
 *
 * The page's whole claim is that its arithmetic is inspectable, so the one
 * thing it must not do on a mismatch is render the numbers anyway and stay
 * quiet. This is deliberately loud and deliberately unstyleable-away.
 */
function ReconciliationNotice({ count }: { count: number }) {
  return (
    <div className="mb-3.5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" strokeWidth={2} />
      <p className="text-[13px] leading-relaxed text-red-800">
        <b className="font-bold">
          {count} {plural(count, "figure")} on this page {count === 1 ? "does" : "do"} not reconcile
          with the table beneath {count === 1 ? "it" : "them"}.
        </b>{" "}
        The mismatch is in the server log. Treat every number here as unverified until it clears.
      </p>
    </div>
  );
}

/* ──────────────────────── stat cards ──────────────────────── */

function StatCards({ data }: { data: AnalyticsResult }) {
  const s = data.stats;
  const cards: { k: string; v: string; sub: React.ReactNode }[] = [
    {
      k: "Companies",
      v: String(s.companies),
      sub: (
        <>
          <b className="font-bold text-gray-600">{s.activeCompanies}</b> active this period
        </>
      ),
    },
    {
      k: "CVs scored",
      v: s.cvsScored.toLocaleString("en-US"),
      sub: (
        <>
          Across <b className="font-bold text-gray-600">{s.publishedJobs}</b> published{" "}
          {plural(s.publishedJobs, "job")}
        </>
      ),
    },
    {
      /*
       * Submitted, not scored. The headline used to be the `interview_scored`
       * usage count, which read 0 on a platform that had submitted interviews
       * and transcribed minutes — the sub-line and the headline were counting
       * two different populations. The scored figure is still shown, but as
       * what it is.
       */
      k: "Interviews submitted",
      v: s.interviews.toLocaleString("en-US"),
      sub: (
        <>
          <b className="font-bold text-gray-600">{s.interviewsScored}</b> AI-scored ·{" "}
          <b className="font-bold text-gray-600">{s.transcribedMinutes}</b> min transcribed
        </>
      ),
    },
    { k: "AI spend", v: formatMicro(s.spendMicro), sub: "Model + transcription" },
    {
      k: "Cost per CV",
      v: s.costPerCvMicro === null ? "—" : formatMicro(s.costPerCvMicro),
      sub: s.costPerCvMicro === null ? "Nothing scored in this period" : "Spend ÷ CVs scored",
    },
  ];

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {cards.map((c) => (
        <div
          key={c.k}
          className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
        >
          <p className="truncate text-[11.5px] font-semibold text-gray-400">{c.k}</p>
          <p className="mt-2.5 font-heading text-[28px] font-bold leading-none tracking-tight text-gray-900">
            {c.v}
          </p>
          <p className="mt-2 text-[11.5px] leading-snug text-gray-400">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────── calibration ──────────────────────── */

function CalibrationStrip({ data }: { data: AnalyticsResult }) {
  const cal = data.calibration;

  /*
   * THE STATE THIS PLATFORM IS ACTUALLY IN. Ten overrides cannot tell you
   * whether the model reads a category high or low, so the strip refuses to
   * show a mean at all rather than showing one nobody should act on.
   */
  if (cal.state === "thin") {
    const pct = Math.min(100, Math.round((cal.overrides / MIN_OVERRIDES_TO_CALIBRATE) * 100));
    return (
      <div className="mb-3.5 rounded-[22px] p-6 shadow-xl sm:px-7" style={{ background: INK }}>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="shrink-0">
            <p className="font-heading text-[40px] font-bold leading-none tracking-tight text-white">
              {cal.overrides}
            </p>
            <p className="mt-2 text-[11.5px] text-white/50">
              {plural(cal.overrides, "Override")} recorded
            </p>
          </div>
          <div aria-hidden className="hidden w-px self-stretch bg-white/15 lg:block" />
          <div className="flex min-w-0 gap-3">
            <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-amber-400" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-[14.5px] leading-relaxed text-white/80">
                <b className="font-bold text-white">Not enough overrides to calibrate.</b>{" "}
                {cal.overrides === 0
                  ? "Nobody has changed a score yet, so there is no disagreement to measure."
                  : `${cal.overrides} data ${plural(cal.overrides, "point")} can't tell you whether the model reads a category high or low — one reviewer having a bad afternoon would move every number below.`}{" "}
                Around {MIN_OVERRIDES_TO_CALIBRATE} is where the means stop being noise.
              </p>
              <div className="mt-3.5 h-[5px] max-w-[300px] overflow-hidden rounded-[3px] bg-white/10">
                <div
                  className="pa-reveal h-full rounded-[3px] bg-amber-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-2 text-[11.5px] text-white/40">
                {cal.overrides} of ~{MIN_OVERRIDES_TO_CALIBRATE} · don't ship a prompt change off
                this
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const mean = cal.mean ?? 0;
  return (
    <div className="mb-3.5 rounded-[22px] p-6 shadow-xl sm:px-7" style={{ background: INK }}>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex gap-8 lg:shrink-0">
          <div>
            <p className="font-heading text-[40px] font-bold leading-none tracking-tight text-remotiv-green">
              {signed(mean)}
            </p>
            <p className="mt-2 text-[11.5px] leading-snug text-white/50">
              Mean override,
              <br />
              all scores
            </p>
          </div>
          <div>
            <p className="font-heading text-[40px] font-bold leading-none tracking-tight text-white">
              {cal.overridePct}%
            </p>
            <p className="mt-2 text-[11.5px] leading-snug text-white/50">
              Overridden
              <br />
              at all
            </p>
          </div>
        </div>
        <div aria-hidden className="hidden w-px self-stretch bg-white/15 lg:block" />
        <p className="min-w-0 text-[14.5px] leading-relaxed text-white/80">
          Reviewers score{" "}
          <InkHighlight>
            {mean > 0 ? "slightly higher" : mean < 0 ? "slightly lower" : "in line with"}
          </InkHighlight>{" "}
          {mean === 0 ? "the model on average" : "than the model on average"}
          {cal.state === "solo"
            ? " — but every override here came from one person."
            : " — consistent with it under-crediting non-linear careers."}
        </p>
      </div>
    </div>
  );
}

function InkHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold" style={{ color: INK }}>
      <span
        aria-hidden
        className="absolute inset-x-[-3px] inset-y-[8%] -z-10 -rotate-1 rounded-[3px] bg-remotiv-lime"
      />
      {children}
    </span>
  );
}

/**
 * Diverging bars, growing out from a hard centre line.
 *
 * Fills are `abs(mean) / maxAbs × 50%`, capped at half the track, so neither
 * side can cross the zero rule however extreme one category gets. The axis
 * caption spells the direction out in words because a signed number on a bar
 * chart is ambiguous on its own.
 */
function ByCategory({ data }: { data: AnalyticsResult }) {
  const cal = data.calibration;

  if (cal.state === "thin") {
    const largest = cal.categories.reduce((max, c) => Math.max(max, c.overrides), 0);
    return (
      <div className={CARD}>
        <p className={LABEL}>By category</p>
        <p className={SUB}>
          Mean override per job category — how far reviewers move the model's score
        </p>
        <EmptyBlock
          icon={<LineChart className="size-4" strokeWidth={2.4} />}
          title="Category means need more overrides"
        >
          Categories appear once each has at least {MIN_OVERRIDES_PER_CATEGORY} overrides of its
          own. Right now the largest has {largest}.
        </EmptyBlock>
      </div>
    );
  }

  const max = maxAbsMean(cal.categories);

  return (
    <div className={CARD}>
      <p className={LABEL}>By category</p>
      <p className={SUB}>
        Mean override per job category — how far reviewers move the model's score
      </p>

      <div className="mt-4 flex flex-col gap-4">
        {cal.categories.map((c, i) => (
          <CategoryBar key={c.category} row={c} max={max} index={i} />
        ))}
      </div>

      <div className="mt-1 flex justify-between text-[10px] font-semibold tracking-wide text-gray-300">
        <span>← REVIEWERS SCORE LOWER</span>
        <span>REVIEWERS SCORE HIGHER →</span>
      </div>
    </div>
  );
}

function CategoryBar({ row, max, index }: { row: CategoryRow; max: number; index: number }) {
  /*
   * A category nobody has overridden keeps its row — hatched track, em-dash,
   * and the scored count in words. A zero-length bar would read as a rendering
   * failure, and a "0.0" would claim the reviewers agreed when in fact they
   * never looked.
   */
  if (row.mean === null) {
    return (
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[13.5px] font-bold tracking-tight text-gray-300">
            {row.category}
          </span>
          <span className="font-heading text-[15px] font-bold tracking-tight text-gray-300">—</span>
        </div>
        <div
          className="relative h-[9px] overflow-hidden rounded-[5px]"
          style={{
            background:
              "repeating-linear-gradient(135deg, rgba(20,16,32,0.045) 0 5px, transparent 5px 10px)",
          }}
        >
          <span className="absolute left-1/2 top-[-2px] bottom-[-2px] z-[2] w-[1.5px] -translate-x-1/2 bg-gray-900/20" />
        </div>
        <p className="mt-1.5 text-[11px] font-semibold text-gray-400">
          No overrides yet · {row.scored.toLocaleString("en-US")} scored, none changed
        </p>
      </div>
    );
  }

  const negative = row.mean < 0;
  const width = barWidthPct(row.mean, max);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] font-bold tracking-tight text-gray-900">{row.category}</span>
        <span
          className={`font-heading text-[15px] font-bold tabular-nums tracking-tight ${
            negative ? "text-red-700" : "text-emerald-900"
          }`}
        >
          {signed(row.mean)}
        </span>
      </div>
      <div className="relative h-[9px] overflow-hidden rounded-[5px] bg-gray-900/5">
        <span className="absolute left-1/2 top-[-2px] bottom-[-2px] z-[2] w-[1.5px] -translate-x-1/2 bg-gray-900/20" />
        <i
          className={`pa-reveal absolute inset-y-0 ${
            negative
              ? "right-1/2 rounded-l-[5px] bg-[#E0524B]"
              : "left-1/2 rounded-r-[5px] bg-remotiv-green"
          }`}
          style={{ width: `${width}%`, animationDelay: `${index * 0.07}s` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400">
        {row.overrides.toLocaleString("en-US")} overridden of {row.scored.toLocaleString("en-US")}
      </p>
    </div>
  );
}

/**
 * Reviewer bias — BESIDE the category card, never below it or behind a tab.
 *
 * The adjacency is the argument. Read alone, a category mean says the model is
 * miscalibrated; read next to the people who produced it, it often says one
 * person is strict. Separating the two cards is how you end up tuning the
 * prompt to one reviewer's taste.
 */
function ReviewerBias({ data }: { data: AnalyticsResult }) {
  const cal = data.calibration;

  if (cal.state === "thin") {
    return (
      <div className={CARD}>
        <p className={`${LABEL} text-amber-700`}>Reviewer bias — read before tuning</p>
        <p className={SUB}>The same figures, attributed to the people producing them</p>
        <EmptyBlock
          icon={<Users className="size-4" strokeWidth={2.4} />}
          title="Too few reviews to attribute"
        >
          A person's bias needs about {MIN_OVERRIDES_PER_REVIEWER} overrides before it means
          anything. Nobody has passed that yet.
        </EmptyBlock>
      </div>
    );
  }

  const top = cal.reviewers[0];

  return (
    <div className={CARD}>
      <p className={`${LABEL} text-amber-700`}>Reviewer bias — read before tuning</p>
      <p className={SUB}>The same figures, attributed to the people producing them</p>

      <div className="mt-3 flex flex-col">
        {cal.reviewers.map((r, i) => (
          <ReviewerRowView key={r.name} row={r} index={i} flag={r.tag === "strict"} />
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-amber-300/40 bg-amber-50 px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-800">
        {cal.state === "solo" ? (
          <>
            <b className="font-extrabold">Bias can't be separated here.</b> All{" "}
            {cal.overrides.toLocaleString("en-US")} overrides came from {top?.name ?? "one person"}.
            Their {signed(top?.bias ?? 0)} and the model's reading are the same number — there is no
            second opinion to compare against. Get a second reviewer before treating any of this as
            a model problem.
          </>
        ) : (
          <SkewNote data={data} />
        )}
      </div>
    </div>
  );
}

/**
 * The person-level effect, with the arithmetic behind it.
 *
 * Recomputes the leading category's mean with the most prolific reviewer
 * removed, so the note states a fact rather than a suspicion. When removing
 * them barely moves the figure, it says that instead — the honest answer is
 * sometimes "the model really is reading this category low".
 */
function SkewNote({ data }: { data: AnalyticsResult }) {
  const cal = data.calibration;
  const leading = cal.categories.find((c) => c.mean !== null);
  const top = cal.reviewers.find((r) => r.name !== UNATTRIBUTED);

  if (!leading || !top || leading.mean === null) {
    return (
      <>
        <b className="font-extrabold">Read this column before changing the prompt.</b> One strict
        reviewer can look exactly like a generous model.
      </>
    );
  }

  const share = Math.round((top.overrides / Math.max(1, cal.overrides)) * 100);

  return (
    <>
      <b className="font-extrabold">
        {top.name} accounts for {top.overrides.toLocaleString("en-US")} of the{" "}
        {cal.overrides.toLocaleString("en-US")} overrides on record ({share}%).
      </b>{" "}
      {leading.category} currently reads {signed(leading.mean)}. One strict reviewer can look
      exactly like a generous model — tune the prompt to a category only after the person-level
      effect is out.
    </>
  );
}

function ReviewerRowView({ row, index, flag }: { row: ReviewerRow; index: number; flag: boolean }) {
  const TINTS = [
    ["#EEEDFE", "#2E2470"],
    ["#E1F5EE", "#04342C"],
    ["#E4EEFB", "#123B6E"],
    ["#FAECE7", "#7A3618"],
  ] as const;
  const [bg, fg] = TINTS[index % TINTS.length] ?? TINTS[0];

  const pill =
    row.tag === "strict"
      ? "bg-amber-100 text-amber-800"
      : row.tag === "generous"
        ? "bg-sky-100 text-sky-900"
        : "bg-gray-50 text-gray-600";

  return (
    <div
      className={`flex items-center gap-3 border-b border-gray-100 py-2.5 last:border-b-0 ${
        // The amber accent makes the outlier visible before you read a number.
        flag ? "-mx-5 border-l-[3px] border-l-amber-500 bg-amber-500/[0.06] pl-[17px] pr-5" : ""
      }`}
    >
      <span
        className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-extrabold"
        style={{ background: bg, color: fg }}
      >
        {initials(row.name)}
      </span>
      <span className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold leading-tight tracking-tight text-gray-900">
          {row.name}
        </p>
        <small className="mt-0.5 block text-[11px] text-gray-400">
          {row.overrides.toLocaleString("en-US")} {plural(row.overrides, "override")}
        </small>
      </span>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-extrabold tabular-nums ${pill}`}
      >
        {signed(row.bias)}
        {row.tag ? ` · ${row.tag}` : ""}
      </span>
    </div>
  );
}

const SCORER_LABELS: Record<string, string> = {
  cv: "CV",
  interview: "Interview",
  mixed: "Mixed",
};

/**
 * Version history, grouped by scorer.
 *
 * TWO rows carry the Live chip, not one. The CV and interview scorers keep
 * independent version sequences and both are current, so "the live version" is
 * not a single row — it is one per scorer. The chip is decided by comparing
 * against each scorer's own PROMPT_VERSION constant, passed down from the
 * server; it is never positional.
 */
function ByVersion({ data }: { data: AnalyticsResult }) {
  const versions = data.calibration.versions;
  const live = data.liveVersions;
  const isLive = (version: string) => version === live.cv || version === live.interview;

  /*
   * The trend is computed PER SCORER. Joining both sequences into one
   * "33% → 21% → 13%" would compare a CV version against an interview one and
   * present the result as a single history, which is the same mistake the
   * positional Live chip was making.
   */
  const trends = (["cv", "interview"] as const)
    .map((kind) => {
      const own = versions.filter((v) => v.kind === kind && v.scored > 0);
      if (own.length < 2) return null;
      return `${SCORER_LABELS[kind]}: ${own
        .map((v) => `${v.overridePct}%`)
        .reverse()
        .join(" → ")}`;
    })
    .filter(Boolean) as string[];

  const GRID = "grid grid-cols-[minmax(0,1fr)_58px_70px_62px] gap-2.5";

  return (
    <div className={CARD}>
      <p className={LABEL}>By prompt version</p>
      <p className={SUB}>Is agreement improving as versions ship?</p>

      <div className="mt-3.5">
        <div
          className={`${GRID} border-b border-gray-200 pb-2 text-[10px] font-extrabold uppercase tracking-wider text-gray-400`}
        >
          <span>Version</span>
          <span className="text-right">Scored</span>
          <span className="text-right">Override</span>
          <span className="text-right">Mean</span>
        </div>

        {versions.length === 0 ? (
          <p className="py-4 text-[13px] text-gray-400">Nothing scored yet.</p>
        ) : (
          versions.map((v) => {
            const current = isLive(v.version);
            return (
              <div
                key={v.version}
                className={`${GRID} items-center border-b border-gray-100 py-2.5 text-[13px] last:border-b-0`}
              >
                <span
                  className={`flex min-w-0 items-center gap-2 ${current ? "font-bold text-gray-900" : "text-gray-400"}`}
                >
                  <span className="truncate">{v.version}</span>
                  {current && (
                    <span className="shrink-0 rounded-[5px] bg-remotiv-purple/10 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-remotiv-purple">
                      Live
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums text-gray-600">
                  {v.scored.toLocaleString("en-US")}
                </span>
                <span className="text-right tabular-nums text-gray-600">{v.overridePct}%</span>
                <span className="text-right font-extrabold tabular-nums text-gray-900">
                  {v.mean === null ? "—" : signed(v.mean)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {trends.length > 0 && (
        <p className="mt-3.5 border-t border-gray-100 pt-3 text-[11.5px] leading-relaxed text-gray-400">
          Override rate, oldest to newest — {trends.join(" · ")}.
        </p>
      )}
    </div>
  );
}

function SystemHealth({ data }: { data: AnalyticsResult }) {
  const h = data.health;
  const rows: { name: string; value: number | null; watch?: boolean }[] = [
    { name: "CV scoring failures", value: h.scoringFailures },
    { name: "Interview scoring failures", value: h.interviewScoringFailures },
    { name: "Rejected for fabrication", value: h.fabricationRejections, watch: true },
  ];

  return (
    <div className={CARD}>
      <p className={LABEL}>System health</p>
      <p className={SUB}>{RANGE_LABELS[data.range]} across every company</p>

      <div className="mt-3">
        {rows.map((r) => (
          <div
            key={r.name}
            className={`flex items-center justify-between gap-3 border-b border-gray-100 py-2.5 text-[13px] last:border-b-0 ${
              r.watch
                ? "-mx-5 border-l-[3px] border-l-amber-500 bg-amber-500/[0.06] pl-[17px] pr-5"
                : ""
            }`}
          >
            <span className="flex items-center gap-2.5 text-gray-600">
              <i
                className={`size-[7px] shrink-0 rounded-full ${
                  r.value === null
                    ? "bg-gray-300"
                    : r.value > 0
                      ? "bg-amber-500"
                      : "bg-remotiv-green"
                }`}
              />
              {r.name}
            </span>
            <b
              className={`font-heading text-base font-extrabold tabular-nums tracking-tight ${
                r.value === null
                  ? "text-gray-300"
                  : r.watch && r.value > 0
                    ? "text-amber-700"
                    : "text-gray-900"
              }`}
            >
              {r.value === null ? "—" : r.value}
            </b>
          </div>
        ))}
      </div>

      <p className="mt-4 border-t border-gray-100 pt-3 text-[11.5px] leading-relaxed text-gray-400">
        <b className="font-bold text-gray-900">Fabrication rejections are the number to watch.</b>{" "}
        Each one means the verifier caught the model quoting something that wasn't in the CV, and
        refused to store the card. Zero failures elsewhere is expected; this figure moving is not.
      </p>
    </div>
  );
}

function EmptyBlock({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start pt-3 text-left">
      <span className="mb-3 flex size-[34px] items-center justify-center rounded-xl bg-gray-50 text-gray-400">
        {icon}
      </span>
      <p className="text-[13px] font-bold leading-snug text-gray-900">{title}</p>
      <small className="mt-1.5 block text-[11.5px] leading-relaxed text-gray-400">{children}</small>
    </div>
  );
}

/* ────────────────────── usage coverage ────────────────────── */

/**
 * Zero and missing are different states, and so are "incomplete" and "never".
 *
 * Shown whenever the selected range reaches back before a usage type started
 * being recorded. Named per type rather than as one blanket warning: the three
 * meters were instrumented weeks apart, so a range can be complete for CV
 * scoring while carrying no WhatsApp rows at all.
 */
function UsageCoverageNote({ data }: { data: AnalyticsResult }) {
  const u = data.usage;

  if (u.neverRecorded) {
    return (
      <div className="mb-3.5 flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3.5">
        <Info className="mt-0.5 size-4 shrink-0 text-sky-900" strokeWidth={2} />
        <p className="text-[12.5px] leading-relaxed text-sky-900">
          <b className="font-extrabold">No usage has been recorded yet.</b> Every cost below is
          $0.00 because <code className="font-mono text-[11.5px]">usage_events</code> is empty — not
          because the platform is free to run. Don't use this period for unit-economics decisions.
        </p>
      </div>
    );
  }

  if (u.incompleteTypes.length === 0) return null;

  const named = u.incompleteTypes.map((t) => USAGE_TYPE_LABELS[t] ?? t);

  return (
    <div className="mb-3.5 flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3.5">
      <Info className="mt-0.5 size-4 shrink-0 text-sky-900" strokeWidth={2} />
      <p className="text-[12.5px] leading-relaxed text-sky-900">
        <b className="font-extrabold">
          This range starts before {named.length === 1 ? "one meter" : "some meters"} existed.
        </b>{" "}
        {u.incompleteTypes.map((type, i) => (
          <span key={type}>
            {i > 0 ? "; " : ""}
            {USAGE_TYPE_LABELS[type] ?? type} from{" "}
            {new Date(u.byType[type] ?? "").toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </span>
        ))}
        . Activity before those dates has no{" "}
        <code className="font-mono text-[11.5px]">usage_events</code> rows, so companies onboarded
        earlier show less spend than they actually cost. Don't use this period for unit-economics
        decisions.
      </p>
    </div>
  );
}

/* ─────────────────────── company table ────────────────────── */

function CompanyTable({ data }: { data: AnalyticsResult }) {
  // Opening a row closes the previously open one: two expanded panels side by
  // side invite a comparison the layout cannot actually support.
  const [openId, setOpenId] = useState<string | null>(null);

  // Company · Jobs · CVs · Intvws · Scored · Emails · Cost · Issues · chevron
  const COLS =
    "grid-cols-[minmax(0,1.4fr)_46px_46px_54px_54px_56px_72px_60px_30px] gap-2 lg:gap-2.5";

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
      <div
        className={`grid ${COLS} border-b border-gray-200 bg-gray-50/70 px-5 py-3 text-[10px] font-extrabold uppercase tracking-wider text-gray-400`}
      >
        <span>Company</span>
        <span className="text-right">Jobs</span>
        <span className="text-right">CVs</span>
        <span className="text-right">Intvws</span>
        <span className="text-right">Scored</span>
        <span className="text-right">Emails</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Issues</span>
        <span />
      </div>

      {data.companies.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">No companies yet.</p>
      ) : (
        data.companies.map((c) => (
          <CompanyRowView
            key={c.id}
            row={c}
            open={openId === c.id}
            onToggle={() => setOpenId((prev) => (prev === c.id ? null : c.id))}
            cols={COLS}
          />
        ))
      )}

      <div className="flex items-start gap-2.5 border-t border-gray-200 bg-gray-50/70 px-5 py-3.5">
        <Check className="mt-0.5 size-4 shrink-0 text-gray-300" strokeWidth={1.9} />
        <p className="text-xs leading-relaxed text-gray-400">
          <b className="font-bold text-gray-600">
            Costs are computed from recorded usage, not estimated from row counts
          </b>{" "}
          — an applicant whose CV failed to score costs nothing and shows as nothing. The three
          scoring and messaging lines come from{" "}
          <code className="font-mono text-[11px]">usage_events</code>; transcription is measured
          from recorded answer duration, which has no meter of its own. Per-unit rates are declared
          constants applied to that usage, not per-call billing.
        </p>
      </div>
    </div>
  );
}

function CompanyRowView({
  row,
  open,
  onToggle,
  cols,
}: {
  row: CompanyRow;
  open: boolean;
  onToggle: () => void;
  cols: string;
}) {
  const dormant = row.dormantDays !== null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`grid w-full ${cols} relative items-center border-b border-gray-100 px-5 py-3.5 text-left transition-colors hover:bg-gray-50/60 ${
          open ? "bg-remotiv-purple/[0.035]" : ""
        } ${
          // Dimmed is a churn signal, not decoration — hover restores it so the
          // row stays readable the moment you go to read it.
          dormant ? "opacity-60 hover:opacity-100" : ""
        }`}
      >
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-bold tracking-tight text-gray-900">
              {row.name}
            </span>
            {row.isInternal && (
              <span className="shrink-0 rounded-[5px] border border-gray-300 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-gray-400">
                Internal
              </span>
            )}
          </span>
          <small
            className={`mt-0.5 block text-[11.5px] ${dormant ? "font-bold text-amber-700" : "text-gray-400"}`}
          >
            {dormant
              ? `No activity in ${row.dormantDays} days`
              : `${row.jobs} published ${plural(row.jobs, "job")}`}
          </small>
        </span>
        <span className="text-right text-[13px] tabular-nums text-gray-600">{row.jobs}</span>
        <span className="text-right text-[13px] tabular-nums text-gray-600">{row.cvs}</span>
        <span className="text-right text-[13px] tabular-nums text-gray-600">{row.interviews}</span>
        <span
          className={`text-right text-[13px] tabular-nums ${
            // Submitted but never scored is worth seeing at a glance: it is
            // either a disabled feature or a scorer that is not running.
            row.interviews > 0 && row.interviewsScored === 0 ? "text-amber-700" : "text-gray-600"
          }`}
        >
          {row.interviewsScored}
        </span>
        <span className="text-right text-[13px] tabular-nums text-gray-600">{row.emails}</span>
        <span
          className={`text-right font-heading text-sm tabular-nums tracking-tight ${
            row.costMicro === 0 ? "font-semibold text-gray-300" : "font-extrabold text-gray-900"
          }`}
        >
          {formatMicro(row.costMicro)}
        </span>
        <span className="text-right">
          {row.issues.length > 0 ? (
            <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-extrabold text-amber-800">
              {row.issues.length}
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-gray-300">—</span>
          )}
        </span>
        <span className="flex items-center justify-center">
          <ChevronDown
            className={`size-4 transition-transform ${open ? "rotate-180 text-remotiv-purple" : "text-gray-300"}`}
            strokeWidth={2.2}
          />
        </span>
      </button>

      {open && <ExpandedRow row={row} />}
    </div>
  );
}

function ExpandedRow({ row }: { row: CompanyRow }) {
  return (
    <div className="border-b border-gray-100 border-l-[3px] border-l-remotiv-purple bg-remotiv-purple/[0.022] px-5 py-5">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className={LABEL}>Where the money went</p>
          <div className="mt-3">
            {row.zeroUsage ? (
              /*
               * Zero and missing are different states. A company that published
               * a job and never scored anyone genuinely costs nothing; saying so
               * in words is the difference between "we know" and "we lost it".
               */
              <EmptyBlock
                icon={<MinusCircle className="size-4" strokeWidth={2.4} />}
                title="No recorded usage this period"
              >
                Nothing has been scored, transcribed or sent. Cost is genuinely zero — not missing
                data.
              </EmptyBlock>
            ) : (
              <>
                {row.money.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-baseline justify-between gap-3.5 py-1.5 text-[12.5px]"
                  >
                    <span className="min-w-0 text-gray-400">
                      {m.label} ·{" "}
                      <code className="rounded bg-gray-50 px-1.5 py-px font-mono text-[11.5px] text-gray-600">
                        {m.workings}
                      </code>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums text-gray-900">
                      {formatMicro(m.amountMicro)}
                    </span>
                  </div>
                ))}
                <div className="mt-2 flex items-baseline justify-between gap-3.5 border-t border-gray-200 pt-2.5 text-[13.5px]">
                  <span className="font-extrabold text-gray-900">Total</span>
                  <span className="font-heading text-base font-extrabold tracking-tight text-gray-900">
                    {formatMicro(row.costMicro)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3.5 pt-1 text-[11.5px] text-gray-300">
                  <span>Per applicant</span>
                  <span className="font-bold text-gray-400">
                    {row.cvs === 0 ? "—" : formatMicro(Math.round(row.costMicro / row.cvs))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          <p className={LABEL}>Issues</p>
          <div className="mt-3">
            {row.issues.length === 0 ? (
              <div className="flex flex-col items-start text-left">
                <span className="mb-3 flex size-[34px] items-center justify-center rounded-xl bg-remotiv-green/15 text-emerald-900">
                  <Check className="size-4" strokeWidth={2.4} />
                </span>
                <p className="text-[13px] font-bold leading-snug text-gray-900">Nothing to raise</p>
                <small className="mt-1.5 block text-[11.5px] leading-relaxed text-gray-400">
                  No failures, no disabled features, no dormancy. There's no call to make about this
                  one.
                </small>
              </div>
            ) : (
              <div className="flex flex-col gap-3.5">
                {row.issues.map((issue) => (
                  <div key={issue.title} className="flex items-start gap-3">
                    <span
                      className={`mt-[5px] size-2 shrink-0 rounded-full ${
                        issue.tone === "bad" ? "bg-[#E0524B]" : "bg-amber-500"
                      }`}
                    />
                    <span>
                      <p className="text-[12.5px] font-semibold leading-snug text-gray-900">
                        {issue.title}
                      </p>
                      <small className="mt-1 block text-[11.5px] leading-relaxed text-gray-400">
                        {issue.detail}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p
            className="mt-4 rounded-xl px-3.5 py-3 text-[11.5px] leading-relaxed text-white/60"
            style={{ background: INK }}
          >
            <b className="font-bold text-white">Nothing here is visible to the company.</b> It's
            what you'd raise on a check-in call.
          </p>
        </div>
      </div>
    </div>
  );
}
