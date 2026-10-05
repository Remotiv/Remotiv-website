import {
  type AllowanceState,
  allowanceState,
  BILLING_TIME_ZONE,
  type CompanyUsage,
  type CostText,
  costText,
  estimateCost,
  NOT_ENFORCED_YET,
  NOT_TRACKED_YET,
  type PlansUsageResult,
  type PricingRates,
  totalText,
} from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";

/**
 * The Usage tab: this calendar month, per company. Read-only. Nothing
 * here can edit a plan, change a rate or affect what a company may do; it
 * shows what was used and what it is estimated to have cost.
 *
 * A server component with no client script: every number is fixed at render.
 */

const CARD = "rounded-2xl bg-white p-5 shadow-sm";
const BADGE = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";
const CELL = "px-3 py-2.5 align-top text-sm";
const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500";

const TONE: Record<CostText["tone"], string> = {
  amount: "text-gray-900",
  warn: "text-amber-700",
  muted: "text-gray-500",
};

function Allowance({ state }: { state: AllowanceState }) {
  if (state.kind === "no_plan") {
    return (
      <span className={cn(BADGE, "bg-red-50 text-red-700 ring-1 ring-red-200")}>{state.label}</span>
    );
  }
  if (state.kind === "internal") {
    return (
      <span className={cn(BADGE, "bg-remotiv-purple/10 text-remotiv-purple")}>{state.label}</span>
    );
  }
  if (state.kind === "limit" && state.over) {
    return <span className="text-sm font-semibold text-red-700">{state.label}</span>;
  }
  return <span className="text-sm text-gray-700">{state.label}</span>;
}

function Muted({ children }: { children: string }) {
  return <span className="text-sm text-gray-500">{children}</span>;
}

function Cost({ text }: { text: CostText }) {
  return (
    <div>
      <span className={cn("text-sm font-medium", TONE[text.tone])}>{text.primary}</span>
      {text.secondary && <span className="block text-xs text-gray-500">{text.secondary}</span>}
    </div>
  );
}

function CompanyCard({ usage, rates }: { usage: CompanyUsage; rates: PricingRates }) {
  const estimate = estimateCost(usage, rates);
  const hasPlan = usage.plan !== null;
  const base = { isInternal: usage.isInternal, hasPlan };
  const cvAllowance = allowanceState({
    ...base,
    limit: usage.plan?.cvScoringLimit ?? null,
    used: usage.cvScored,
  });
  // Invitation credits (usage_events interview_sent), the count the gate
  // enforces. Never sessions created, and never completions.
  const asyncAllowance = allowanceState({
    ...base,
    limit: usage.plan?.asyncInterviewLimit ?? null,
    used: usage.asyncInvitations,
  });
  // Live AI is capped by minutes, which are not measured: the interview count is
  // never set against the plan's minutes allowance, and no cost is calculated.
  const total = totalText(estimate, rates.pkrPerUsd);

  return (
    <article className={CARD} aria-labelledby={`usage-${usage.companyId}`}>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3
          id={`usage-${usage.companyId}`}
          className="font-heading text-base font-bold text-gray-900"
        >
          {usage.name}
        </h3>
        {/* Internal and no-plan carry their own badge; a customer on a plan shows its name. */}
        {hasPlan && !usage.isInternal ? (
          <span className={cn(BADGE, "bg-remotiv-green/15 text-gray-800")}>
            {usage.plan?.planName}
          </span>
        ) : (
          <Allowance state={cvAllowance} />
        )}
        {usage.status !== "active" && <span className="text-xs text-gray-500">{usage.status}</span>}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="border-b border-gray-100">
              <th scope="col" className={HEAD}>
                This month
              </th>
              <th scope="col" className={HEAD}>
                Used
              </th>
              <th scope="col" className={HEAD}>
                Allowance
              </th>
              <th scope="col" className={HEAD}>
                Estimated cost
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                AI-scored applicants
              </th>
              <td className={CELL}>{usage.cvScored}</td>
              <td className={CELL}>
                <Allowance state={cvAllowance} />
              </td>
              <td className={CELL}>
                <Cost text={costText(estimate.cv, rates.pkrPerUsd)} />
              </td>
            </tr>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                Async interview invitations sent
              </th>
              <td className={CELL}>{usage.asyncInvitations}</td>
              <td className={CELL}>
                <Allowance state={asyncAllowance} />
              </td>
              <td className={CELL}>
                <Muted>Costed on completion</Muted>
              </td>
            </tr>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                Completed async interviews
              </th>
              <td className={CELL}>{usage.asyncCompleted}</td>
              <td className={CELL}>
                <Muted>Counted, not capped</Muted>
              </td>
              <td className={CELL}>
                <Cost text={costText(estimate.asyncInterviews, rates.pkrPerUsd)} />
              </td>
            </tr>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                Live AI interviews
              </th>
              <td className={CELL}>{usage.liveInterviews}</td>
              <td className={CELL}>
                <Muted>{NOT_ENFORCED_YET}</Muted>
              </td>
              <td className={CELL}>
                <Cost text={costText(estimate.live, rates.pkrPerUsd)} />
              </td>
            </tr>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                Live minutes
              </th>
              <td className={CELL}>
                <Muted>{NOT_TRACKED_YET}</Muted>
              </td>
              <td className={CELL} />
              <td className={CELL} />
            </tr>
            <tr className="border-b border-gray-50">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                WhatsApp delivered
              </th>
              <td className={CELL}>{usage.whatsappDelivered}</td>
              <td className={CELL}>
                <span className="text-sm text-gray-700">Not capped</span>
              </td>
              <td className={CELL}>
                <Cost text={costText(estimate.whatsapp, rates.pkrPerUsd)} />
              </td>
            </tr>
            <tr className="border-b border-gray-100">
              <th scope="row" className={cn(CELL, "text-left font-medium text-gray-700")}>
                Fixed cost share
              </th>
              <td className={CELL} />
              <td className={CELL} />
              <td className={CELL}>
                <Cost text={costText(estimate.fixedAllocation, rates.pkrPerUsd)} />
              </td>
            </tr>
            <tr>
              <th scope="row" className={cn(CELL, "text-left font-semibold text-gray-900")}>
                Estimated total
              </th>
              <td className={CELL} />
              <td className={CELL}>
                {usage.plan?.quotedPrice != null && (
                  <span className="text-sm text-gray-700">
                    Quoted {usage.plan.currency} {usage.plan.quotedPrice.toLocaleString("en-US")}
                  </span>
                )}
              </td>
              <td className={CELL}>
                <Cost text={total} />
                {estimate.excludesLive && (
                  <span className="mt-1 block text-xs text-gray-500">
                    Excludes live AI interviews: their cost is not calculated yet.
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  );
}

export function UsagePanel({ result }: { result: PlansUsageResult }) {
  const heading = (
    <div className="mb-4">
      <h2 className="font-heading text-xl font-bold text-gray-900">Usage</h2>
      <p className="mt-1 text-sm text-gray-500">
        {result.window.label}, calendar month in {BILLING_TIME_ZONE}. Read-only.
      </p>
    </div>
  );

  if (!result.ok) {
    return (
      <section aria-labelledby="usage-error">
        {heading}
        <div role="alert" className="rounded-2xl bg-red-50 p-5 text-red-800 ring-1 ring-red-200">
          <p id="usage-error" className="font-semibold">
            Usage could not be loaded.
          </p>
          <p className="mt-1 text-sm">
            Failed: {result.readErrors.map((e) => e.source).join(", ")}. Details are in the server
            log.
          </p>
        </div>
      </section>
    );
  }

  const unsetRates = [
    result.rates.cvScoreCost === null && "CV scoring",
    result.rates.asyncInterviewCost === null && "async interview",
    result.rates.whatsappMessageCost === null && "WhatsApp",
    result.rates.fixedMonthlyCost === null && "fixed monthly cost",
    result.rates.pkrPerUsd === null && "PKR exchange rate",
  ].filter(Boolean) as string[];

  return (
    <section aria-label="Usage">
      {heading}
      {unsetRates.length > 0 && (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          Not set in pricing settings: {unsetRates.join(", ")}. Costs that depend on them read
          &ldquo;rate not set&rdquo; rather than zero.
        </p>
      )}
      {result.companies.length === 0 ? (
        <p className={cn(CARD, "text-sm text-gray-600")}>No companies yet.</p>
      ) : (
        <div className="grid gap-4">
          {result.companies.map((usage) => (
            <CompanyCard key={usage.companyId} usage={usage} rates={result.rates} />
          ))}
        </div>
      )}
      <ul className="mt-4 space-y-1 text-xs text-gray-500">
        <li>AI-scored applicants counts every scoring run this month, re-scores included.</li>
        <li>
          Async interview invitations sent counts invitation credits used this month: one for each
          invitation email the provider accepted, re-sends included, and none for a send that
          failed. This is what the allowance counts and enforces. It is not a count of interviews
          created or completed.
        </li>
        <li>
          Completed async interviews counts interviews submitted this month, by submission date. The
          async cost is estimated from these, because transcription and scoring happen after a
          candidate submits. Answers from an interview that expired unsubmitted are transcribed but
          not costed here.
        </li>
        <li>
          WhatsApp delivered counts messages that reached delivered or read, by the month sent.
        </li>
        <li>
          Live AI interviews are counted. Their minutes are not measured yet, so no allowance is
          enforced against them and no cost is calculated.
        </li>
        <li>
          This tab only shows usage. The CV scoring limit and the async interview invitation limit
          are enforced where the work happens. Live AI is not enforced yet.
        </li>
      </ul>
    </section>
  );
}
