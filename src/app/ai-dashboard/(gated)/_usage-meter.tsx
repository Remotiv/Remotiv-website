import Link from "next/link";
import {
  meterLine,
  type OverviewMeterView,
  type QuotaLevel,
  USAGE_LOAD_ERROR,
} from "@/lib/company-usage-types";
import { cn } from "@/lib/utils";
import { PLAN_USAGE_ANCHOR } from "./settings/_plan-usage-card";

/**
 * Overview: one line per capped metric, against this month's limit. Rendered
 * on the server and handed to the overview client as a finished element.
 * Links to the Settings card only for a viewer who can see that card.
 */

const CARD_CLS =
  "mb-[18px] overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-5 py-4 shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

const DOT: Record<QuotaLevel, string> = {
  unlimited: "bg-[var(--ai-line-strong)]",
  ok: "bg-remotiv-green",
  warn: "bg-[var(--ai-amber-dot)]",
  paused: "bg-[var(--ai-danger)]",
};

export function UsageMeter({ view }: { view: OverviewMeterView | { kind: "error" } }) {
  return (
    <section className={CARD_CLS} aria-label="Plan usage this month">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h3 className="m-0 font-heading text-[15.5px] font-extrabold tracking-[-0.02em]">
          This month&apos;s usage
        </h3>
        {view.kind === "meter" && view.linksToCard && (
          <Link
            href={`/ai-dashboard/settings#${PLAN_USAGE_ANCHOR}`}
            className="text-[12.5px] font-bold text-remotiv-purple hover:text-[var(--ai-purple-hover)]"
          >
            Plan &amp; usage →
          </Link>
        )}
      </div>
      {view.kind === "error" ? (
        <p role="alert" className="m-0 mt-2 text-[13px] leading-relaxed text-[var(--ai-t3)]">
          {USAGE_LOAD_ERROR}
        </p>
      ) : (
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0 min-[630px]:flex-row min-[630px]:gap-8">
          {view.metrics.map((m) => (
            <li
              key={m.metric}
              className="flex items-center gap-2 text-[13.5px] tabular-nums text-[var(--ai-t2)]"
            >
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[m.level])} />
              {meterLine(m)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
