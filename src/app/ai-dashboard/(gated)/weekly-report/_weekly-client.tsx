"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  EyeOff,
  Info,
  Pencil,
  Users,
} from "lucide-react";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { fetchWeekReport } from "./actions";
import type { AttentionKind, DeltaTone, WeekReport } from "./types";

const RING_C = 2 * Math.PI * 14;

const TINTS: ReadonlyArray<[string, string]> = [
  ["var(--ai-purple-tint)", "var(--ai-purple-ink)"],
  ["var(--ai-mint-tint)", "var(--ai-mint-ink)"],
  ["var(--ai-sky-tint)", "var(--ai-sky-ink)"],
  ["var(--ai-peach-tint)", "var(--ai-peach-ink)"],
  ["var(--ai-amber-tint)", "var(--ai-amber-ink)"],
  ["var(--ai-slate-tint)", "var(--ai-slate-ink)"],
];

/** Stable per record, never by list position — a re-sort must not recolour. */
function tintFor(id: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

/** ≥80 mint · 60–79 amber · <60 red. */
function band(score: number): [string, string] {
  if (score >= 80) return ["#49D7A7", "var(--ai-mint-ink)"];
  if (score >= 60) return ["#F5A524", "var(--ai-amber-ink)"];
  return ["#E0524B", "#B02A24"];
}

/**
 * The comparison chip.
 *
 * Ported from the mock unchanged in behaviour. Four states, and `tone` is a
 * REQUIRED argument rather than something inferred from the metric: a rise in
 * rejections is neither good nor bad, and guessing direction is how a neutral
 * number ends up styled as a win.
 */
function DeltaChip({
  current,
  previous,
  tone,
}: {
  current: number;
  previous: number | null | undefined;
  tone: DeltaTone;
}) {
  if (previous === null || previous === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/[0.07] px-2.5 py-[3px] text-[11.5px] font-semibold text-white/40">
        no prior week
      </span>
    );
  }

  const diff = current - previous;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/10 px-2.5 py-[3px] text-[11.5px] font-bold text-white/55">
        same as last week
      </span>
    );
  }

  const up = diff > 0;
  const better = tone === "good-down" ? !up : up;
  const cls =
    tone === "neutral"
      ? "bg-white/10 text-white/[0.62]"
      : better
        ? "bg-[rgba(73,215,167,0.16)] text-remotiv-green"
        : "bg-[rgba(224,82,75,0.18)] text-[#FF9C96]";
  const Arrow = up ? ArrowUp : ArrowDown;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11.5px] font-bold ${cls}`}
    >
      <Arrow className="size-[11px]" strokeWidth={2.6} />
      {up ? "up" : "down"} from {previous}
    </span>
  );
}

/**
 * The hero sentence, assembled from the week's own numbers.
 *
 * Ported from the mock rather than rewritten as copy: every clause is
 * conditional on real figures, so a week with nothing moved forward reads "and
 * none have been moved forward yet", and a week with no backlog switches to
 * the quiet-roles clause instead of claiming an empty one.
 */
function Sentence({ week }: { week: WeekReport }) {
  const prev = week.previous;
  const people = week.applied === 1 ? "person" : "people";

  let comparison: string | null = null;
  if (prev) {
    comparison =
      week.applied > prev.applied
        ? "— more than the week before —"
        : week.applied < prev.applied
          ? "— fewer than the week before —"
          : "— the same as the week before —";
  }

  const forwardClause =
    week.forward > 0
      ? ` and you moved ${week.forward} of them forward.`
      : " and none have been moved forward yet.";

  const quiet = week.quietRoles;
  let tail = "";
  if (week.stalled > 0) {
    tail = ` ${week.stalled} ${week.stalled === 1 ? "applicant is" : "applicants are"} still waiting at Applied.`;
  } else if (quiet > 0) {
    tail = ` ${quiet} ${quiet === 1 ? "role is" : "roles are"} getting no applicants.`;
  }

  return (
    <p className="relative z-[1] m-0 mb-[26px] max-w-[800px] font-heading text-[27px] font-extrabold leading-[1.32] tracking-[-0.032em] text-white">
      <span className="relative z-0 inline-block px-1.5 text-[var(--ai-sidebar)] before:absolute before:inset-y-[4%] before:-inset-x-[3px] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
        {week.applied} {people} applied
      </span>
      {comparison ? ` ${comparison}` : ""}
      {forwardClause}
      {tail}
    </p>
  );
}

const ATT_STYLE: Record<AttentionKind, { bg: string; fg: string }> = {
  stalled: { bg: "var(--ai-purple-tint)", fg: "var(--remotiv-purple, #7E47FF)" },
  draft: { bg: "var(--ai-amber-tint)", fg: "var(--ai-amber-ink)" },
  quiet: { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
};

const ATT_ICON: Record<AttentionKind, typeof Users> = {
  stalled: Users,
  draft: Pencil,
  quiet: EyeOff,
};

export function WeeklyClient({ initialWeek }: { initialWeek: WeekReport }) {
  const [week, setWeek] = useState(initialWeek);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function go(next: number) {
    if (next < 0 || loading) return;
    setLoading(true);
    try {
      const data = await fetchWeekReport(next);
      setWeek(data);
      setOffset(next);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setToast("Couldn't load that week — please try again.");
    } finally {
      setLoading(false);
    }
  }

  const maxRole = Math.max(1, ...week.roles.map((r) => r.count));
  const BAR_COLOURS = ["#49D7A7", "#9886FE", "#4C8DD9", "#D9F972"];

  return (
    <PageContainer>
      <div className="mb-[22px] flex flex-col items-start justify-between gap-5 min-[840px]:flex-row min-[840px]:items-end min-[840px]:gap-8">
        <div className="min-w-0">
          <h1 className="m-0 font-heading text-[44px] font-extrabold leading-none tracking-[-0.04em] text-[var(--ai-t1)]">
            {week.label}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <span className="text-[15px] font-semibold text-[var(--ai-t2)]">
              {week.range}
            </span>
            {week.isLatest && (
              <span className="rounded-full bg-[var(--ai-mint-tint)] px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-mint-ink)]">
                Most recent
              </span>
            )}
            {!week.isLatest && week.isEarliest && (
              <span className="rounded-full bg-[var(--ai-slate-tint)] px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-slate-ink)]">
                First week
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2.5 pb-1">
          <button
            type="button"
            onClick={() => void go(offset + 1)}
            disabled={week.isEarliest || loading}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-[13px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--ai-line)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]"
          >
            <ChevronLeft className="size-[15px]" strokeWidth={2.2} />
            Previous week
          </button>
          <button
            type="button"
            onClick={() => void go(offset - 1)}
            disabled={offset <= 0 || loading}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-[13px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--ai-line)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]"
          >
            Next week
            <ChevronRight className="size-[15px]" strokeWidth={2.2} />
          </button>
          <button
            type="button"
            onClick={() => setToast(`Export for ${week.range} is coming soon`)}
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-[14px] border border-remotiv-purple bg-remotiv-purple px-5 py-[13px] text-sm font-bold text-white shadow-[0_8px_24px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)]"
          >
            <Download className="size-4" strokeWidth={1.9} />
            Export
          </button>
        </div>
      </div>

      <div
        className={`relative mb-[26px] overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] px-[30px] pb-[26px] pt-7 shadow-[0_18px_46px_rgba(20,16,32,0.24)] transition-opacity ${loading ? "opacity-60" : ""}`}
      >
        <span className="pointer-events-none absolute -right-[8%] -top-[130%] h-[360%] w-[62%] bg-[radial-gradient(ellipse_at_center,rgba(126,71,255,0.44),transparent_62%)]" />
        <p className="relative z-[1] m-0 mb-4 text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/40">
          The week in short
        </p>

        <Sentence week={week} />

        <div className="relative z-[1] grid grid-cols-2 gap-y-[22px] border-t border-white/[0.12] pt-[22px] min-[1120px]:grid-cols-4 min-[1120px]:gap-y-0">
          <HeroCell
            label="New applicants"
            value={week.applied}
            chip={<DeltaChip current={week.applied} previous={week.previous?.applied} tone="good-up" />}
            note={
              week.previous
                ? null
                : "This is the earliest week on record, so there is nothing to compare against."
            }
            first
          />
          <HeroCell
            label="Moved forward"
            value={week.forward}
            valueClass="text-remotiv-green"
            chip={<DeltaChip current={week.forward} previous={week.previous?.forward} tone="good-up" />}
          />
          <HeroCell
            label="Rejected"
            value={week.rejected}
            chip={<DeltaChip current={week.rejected} previous={week.previous?.rejected} tone="neutral" />}
          />
          <HeroCell
            label="Still at Applied"
            value={week.stalled}
            valueClass="text-[#F5A524]"
            chip={<DeltaChip current={week.stalled} previous={week.previous?.stalled} tone="good-down" />}
          />
        </div>
      </div>

      <div className="mb-3.5 grid grid-cols-[minmax(0,1fr)] items-start gap-3.5 min-[1120px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ai-line)] px-5 py-4">
            <div className="min-w-0">
              <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
                Top matches this week
              </h3>
              <p className="m-0 mt-[3px] text-[11.5px] text-[var(--ai-t3)]">
                {week.top.length
                  ? `Top ${week.top.length} of ${week.topTotal} scored, from the ${week.applied} who applied in this period`
                  : "Nothing to rank for this period"}
              </p>
            </div>
            <Link
              href="/ai-dashboard/applicants"
              className="shrink-0 whitespace-nowrap text-[12.5px] font-bold text-remotiv-purple hover:underline"
            >
              All applicants →
            </Link>
          </div>

          {week.top.length === 0 ? (
            <div className="flex flex-col items-center px-6 pb-[42px] pt-[38px] text-center">
              <div className="mb-[15px] flex size-14 items-center justify-center rounded-[18px] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
                <Users className="size-6" strokeWidth={2.2} />
              </div>
              <h4 className="m-0 mb-1.5 font-heading text-[17px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
                Nobody applied this week
              </h4>
              <p className="m-0 max-w-[330px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
                No applications came in during this period.
              </p>
            </div>
          ) : (
            week.top.map((m, i) => {
              const [stroke, ink] = band(m.score);
              const tint = tintFor(m.applicationId);
              return (
                <Link
                  key={m.applicationId}
                  href="/ai-dashboard/applicants"
                  className="group relative grid grid-cols-[26px_minmax(0,1fr)_96px_20px] items-center gap-3 border-b border-[var(--ai-line-soft)] px-5 py-3 last:border-b-0 hover:bg-[#FCFBFA]"
                >
                  <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple opacity-0 transition-opacity group-hover:opacity-100" />
                  <span className="font-heading text-[13px] font-extrabold tabular-nums text-[var(--ai-t4)] transition-colors group-hover:text-remotiv-purple">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex min-w-0 items-center gap-[11px]">
                    <span
                      className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        i === 0
                          ? "shadow-[0_0_0_2px_var(--ai-surface),0_0_0_3.5px_#49D7A7]"
                          : "shadow-[0_0_0_2px_var(--ai-surface),0_0_0_3.5px_rgba(20,16,32,0.07)]"
                      }`}
                      style={{ background: tint[0], color: tint[1] }}
                    >
                      {initialsOf(m.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-[7px] text-sm font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
                        <span className="truncate">{m.name}</span>
                        {i === 0 && (
                          <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                            Best this week
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-[var(--ai-t3)]">
                        {m.role}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2.5">
                    <svg viewBox="0 0 34 34" className="size-[34px] shrink-0 -rotate-90">
                      <title>{`Score ${m.score}`}</title>
                      <circle
                        cx="17"
                        cy="17"
                        r="14"
                        fill="none"
                        stroke="rgba(20,16,32,0.08)"
                        strokeWidth="3.5"
                      />
                      <circle
                        cx="17"
                        cy="17"
                        r="14"
                        fill="none"
                        stroke={stroke}
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeDasharray={RING_C.toFixed(1)}
                        strokeDashoffset={(RING_C * (1 - m.score / 100)).toFixed(1)}
                      />
                    </svg>
                    <span
                      className="font-heading text-[15px] font-extrabold tabular-nums tracking-[-0.03em]"
                      style={{ color: ink }}
                    >
                      {m.score}
                    </span>
                  </span>
                  <span className="flex justify-end text-[var(--ai-t4)] opacity-0 transition-opacity group-hover:text-remotiv-purple group-hover:opacity-100">
                    <ArrowRight className="size-4" strokeWidth={2} />
                  </span>
                </Link>
              );
            })
          )}

          {week.topTotal > week.top.length && (
            <Link
              href="/ai-dashboard/applicants"
              className="block border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-3 text-[12.5px] font-semibold text-[var(--ai-t3)] hover:text-remotiv-purple"
            >
              +{week.topTotal - week.top.length} more scored{" "}
              {week.topTotal - week.top.length === 1 ? "applicant" : "applicants"} this
              week →
            </Link>
          )}
        </section>

        <section className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
          <div className="border-b border-[var(--ai-line)] px-5 py-4">
            <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
              Applicants by role
            </h3>
            <p className="m-0 mt-[3px] text-[11.5px] text-[var(--ai-t3)]">
              This week only, compared with the week before
            </p>
          </div>

          {week.roles.length === 0 ? (
            <p className="m-0 px-5 py-8 text-center text-[13.5px] text-[var(--ai-t3)]">
              No applications to break down for this period.
            </p>
          ) : (
            <div className="flex flex-col gap-[13px] px-5 pb-[18px] pt-4">
              {week.roles.map((r, i) => {
                const versus =
                  r.previous === null
                    ? ""
                    : r.previous === 0 && r.count > 0
                      ? "new this week"
                      : r.count === r.previous
                        ? "same as last week"
                        : `was ${r.previous}`;
                return (
                  <div key={r.jobId ?? r.title}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span
                        className={`min-w-0 truncate text-[13px] font-semibold ${r.count === 0 ? "text-[var(--ai-t4)]" : "text-[var(--ai-t2)]"}`}
                      >
                        {r.title}
                      </span>
                      <span
                        className={`flex shrink-0 items-baseline gap-2 font-heading text-[15px] font-extrabold tabular-nums tracking-[-0.02em] ${r.count === 0 ? "text-[var(--ai-t4)]" : "text-[var(--ai-t1)]"}`}
                      >
                        {r.count}
                        {versus && (
                          <span className="font-sans text-[11px] font-semibold tracking-normal text-[var(--ai-t4)]">
                            {versus}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-[rgba(20,16,32,0.07)]">
                      <i
                        className="block h-full rounded"
                        style={{
                          width: `${Math.round((r.count / maxRole) * 100)}%`,
                          background: BAR_COLOURS[i % BAR_COLOURS.length],
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {week.rolesTotal > week.roles.length && (
                <p className="m-0 pt-0.5 text-[12.5px] font-semibold text-[var(--ai-t3)]">
                  +{week.rolesTotal - week.roles.length} more{" "}
                  {week.rolesTotal - week.roles.length === 1 ? "role" : "roles"}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <section className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
        <div className="border-b border-[var(--ai-line)] px-5 py-4">
          <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
            Needs your attention
          </h3>
          <p className="m-0 mt-[3px] text-[11.5px] text-[var(--ai-t3)]">
            {week.attention.length ? "What built up over this week" : "Clear for this period"}
          </p>
        </div>

        {week.attention.length === 0 ? (
          <div className="flex flex-col items-center px-6 pb-[42px] pt-[38px] text-center">
            <div className="mb-[15px] flex size-14 items-center justify-center rounded-[18px] bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]">
              <Check className="size-6" strokeWidth={2.2} />
            </div>
            <h4 className="m-0 mb-1.5 font-heading text-[17px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
              Nothing needed you this week
            </h4>
            <p className="m-0 max-w-[330px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              No backlog, no stale drafts, no quiet roles. A clean week.
            </p>
          </div>
        ) : (
          week.attention.map((a) => {
            const Icon = ATT_ICON[a.kind];
            const style = ATT_STYLE[a.kind];
            return (
              <Link
                key={`${a.kind}-${a.title}`}
                href={a.href}
                className="group relative flex items-center gap-3.5 border-b border-[var(--ai-line-soft)] px-5 py-3.5 last:border-b-0 hover:bg-[#FCFBFA]"
              >
                <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple opacity-0 transition-opacity group-hover:opacity-100" />
                <span
                  className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px]"
                  style={{ background: style.bg, color: style.fg }}
                >
                  <Icon className="size-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
                    {a.title}
                  </span>
                  <span className="mt-[3px] block text-[12.5px] leading-snug text-[var(--ai-t3)]">
                    {a.detail}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] font-bold text-remotiv-purple">
                  {a.cta}
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-[3px]" strokeWidth={2.2} />
                </span>
              </Link>
            );
          })
        )}
      </section>

      <p className="m-0 mt-4 flex items-center gap-2.5 px-0.5 text-[12.5px] leading-normal text-[var(--ai-t3)]">
        <Info className="size-[15px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
        Weeks run Monday to Sunday and end on the last complete week. Every number is
        counted from your own activity in the period shown.
      </p>

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
  value,
  valueClass,
  chip,
  note,
  first,
}: {
  label: string;
  value: number;
  valueClass?: string;
  chip: React.ReactNode;
  note?: string | null;
  first?: boolean;
}) {
  return (
    <div
      className={`relative min-w-0 px-[22px] ${first ? "min-[1120px]:pl-0" : ""} min-[1120px]:after:absolute min-[1120px]:after:inset-y-1 min-[1120px]:after:right-0 min-[1120px]:after:w-px min-[1120px]:after:bg-white/10 min-[1120px]:after:content-[''] min-[1120px]:last:after:hidden`}
    >
      <p className="m-0 mb-2.5 whitespace-nowrap text-[11.5px] font-semibold text-white/50">
        {label}
      </p>
      <div
        className={`flex flex-wrap items-baseline gap-2.5 font-heading text-[34px] font-extrabold leading-none tracking-[-0.04em] ${valueClass ?? "text-white"}`}
      >
        {value}
        {chip}
      </div>
      {note && (
        <p className="m-0 mt-2.5 text-[11.5px] leading-snug text-white/[0.38]">{note}</p>
      )}
    </div>
  );
}
