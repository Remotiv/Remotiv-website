import {
  METRIC_LABEL,
  type MetricUsage,
  NEED_MORE,
  type PlanUsageCardView,
  type QuotaLevel,
  UNLIMITED_THIS_MONTH,
  USAGE_LOAD_ERROR,
  usedOfLimit,
} from "@/lib/company-usage-types";
import { BILLING_TIME_ZONE } from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";

/**
 * Settings: "Plan & usage". Read-only, rendered on the server and handed to
 * the settings client as a finished element, so no figure passes through
 * client state. Owner and admin only; the price row exists only when the
 * server sent a price, which it does for billing roles alone.
 */

const CARD_CLS =
  "mb-4 scroll-mt-6 overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] last:mb-0";
const ROW_CLS = "flex items-baseline justify-between gap-4 py-2.5";
const KEY_CLS = "text-[13.5px] text-[var(--ai-t2)]";
const VALUE_CLS = "text-[13.5px] font-semibold tabular-nums";

const LEVEL_TEXT: Record<QuotaLevel, string> = {
  unlimited: "text-[var(--ai-t1)]",
  ok: "text-[var(--ai-t1)]",
  warn: "text-[var(--ai-amber-ink)]",
  paused: "text-[var(--ai-danger)]",
};

export const PLAN_USAGE_ANCHOR = "plan-usage";

function Header({ planName }: { planName: string | null }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-5">
      <div>
        <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
          Plan &amp; usage
        </h2>
        <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
          This month&apos;s AI scoring and async interview invitations.
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-[var(--ai-purple-tint)] px-3 py-1 text-xs font-bold text-[var(--ai-purple-ink)]">
        {planName ?? UNLIMITED_THIS_MONTH}
      </span>
    </div>
  );
}

function MetricRow({ m }: { m: MetricUsage }) {
  return (
    <div className={ROW_CLS}>
      <span className={KEY_CLS}>{METRIC_LABEL[m.metric]}</span>
      <span className={cn(VALUE_CLS, LEVEL_TEXT[m.level])}>{usedOfLimit(m)} this month</span>
    </div>
  );
}

export function PlanUsageCard({ view }: { view: PlanUsageCardView | { kind: "error" } }) {
  if (view.kind === "error") {
    return (
      <section id={PLAN_USAGE_ANCHOR} className={CARD_CLS} aria-labelledby="plan-usage-title">
        <div className="px-6 py-5">
          <h2
            id="plan-usage-title"
            className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]"
          >
            Plan &amp; usage
          </h2>
          <p role="alert" className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
            {USAGE_LOAD_ERROR}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id={PLAN_USAGE_ANCHOR} className={CARD_CLS} aria-label="Plan & usage">
      <Header planName={view.planName} />
      <div className="px-6 pb-[22px] pt-[14px]">
        <div className="divide-y divide-[var(--ai-line)] rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5">
          {view.metrics.map((m) => (
            <MetricRow key={m.metric} m={m} />
          ))}
          <div className={ROW_CLS}>
            <span className={KEY_CLS}>Resets on</span>
            <span className={cn(VALUE_CLS, "text-[var(--ai-t1)]")}>
              {view.resetDate}, {BILLING_TIME_ZONE}
            </span>
          </div>
          {view.price && (
            <div className={ROW_CLS}>
              <span className={KEY_CLS}>Quoted price</span>
              <span className={cn(VALUE_CLS, "text-[var(--ai-t1)]")}>
                {view.price.currency} {view.price.amount.toLocaleString("en-US")} per month
              </span>
            </div>
          )}
        </div>

        {view.warnings.length > 0 && (
          <ul className="m-0 mt-3 list-none space-y-1.5 p-0">
            {view.warnings.map((w) => (
              <li
                key={w.metric}
                className={cn(
                  "text-[13px] font-semibold leading-[1.5]",
                  w.level === "paused" ? "text-[var(--ai-danger)]" : "text-[var(--ai-amber-ink)]",
                )}
              >
                {w.text}
              </li>
            ))}
          </ul>
        )}

        <p className="m-0 mt-3 text-xs leading-[1.5] text-[var(--ai-t3)]">{NEED_MORE}</p>
      </div>
    </section>
  );
}
