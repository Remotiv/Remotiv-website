import type {
  AdminCompany,
  PlanHistoryEntry,
  PlanSnapshot,
  PlansAdminResult,
} from "@/lib/plans-admin";
import { BILLING_TIME_ZONE, INTERNAL_LABEL, NO_PLAN_LABEL } from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";
import { PlanEditor } from "./_plan-editor";
import { PricingForm } from "./_pricing-form";

/**
 * The Plans & Rates tab: the pricing settings form, and each company's plan
 * with its history. A server component; the two forms inside are the only
 * client parts, and they write only through the server actions.
 */

const CARD = "rounded-2xl bg-white p-5 shadow-sm";
const BADGE = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";

const OPERATION_LABEL: Record<PlanHistoryEntry["operation"], string> = {
  INSERT: "Plan created",
  UPDATE: "Plan changed",
  DELETE: "Plan removed - back to no plan, unlimited",
};

function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : limit.toLocaleString("en-US");
}

/** One line per plan: what it allowed and what it was quoted at. */
export function planSummary(p: PlanSnapshot): string {
  const price =
    p.quotedPrice === null
      ? "no price"
      : `${p.currency} ${p.quotedPrice.toLocaleString("en-US")}/month`;
  return `${p.planName} · CV scoring ${limitText(p.cvScoringLimit)} · Async interviews ${limitText(p.asyncInterviewLimit)} · ${price}`;
}

function when(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BILLING_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function History({ entries }: { entries: PlanHistoryEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-gray-500">No plan changes recorded yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {entries.map((h) => (
        <li key={h.id} className="rounded-xl bg-gray-50 px-3 py-2 text-sm">
          <p className="font-medium text-gray-800">
            {OPERATION_LABEL[h.operation]}
            <span className="ml-2 font-normal text-gray-500">
              {when(h.changedAt)} by {h.changedBy}
            </span>
          </p>
          <p className="mt-0.5 text-gray-600">
            {h.operation === "DELETE" ? `Was: ${planSummary(h.snapshot)}` : planSummary(h.snapshot)}
          </p>
          {h.snapshot.notes && h.operation !== "DELETE" && (
            <p className="mt-0.5 text-xs text-gray-500">Notes: {h.snapshot.notes}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function CompanyPlanCard({
  company,
  pkrPerUsd,
}: {
  company: AdminCompany;
  pkrPerUsd: number | null;
}) {
  const headingId = `plan-${company.id}`;
  return (
    <article className={CARD} aria-labelledby={headingId}>
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-heading text-base font-bold text-gray-900">
          {company.name}
        </h3>
        {company.isInternal ? (
          <span className={cn(BADGE, "bg-remotiv-purple/10 text-remotiv-purple")}>
            {INTERNAL_LABEL}
          </span>
        ) : company.plan ? (
          <span className={cn(BADGE, "bg-remotiv-green/15 text-gray-800")}>
            {company.plan.planName}
          </span>
        ) : (
          <span className={cn(BADGE, "bg-red-50 text-red-700 ring-1 ring-red-200")}>
            {NO_PLAN_LABEL}
          </span>
        )}
        {company.status !== "active" && (
          <span className="text-xs text-gray-500">{company.status}</span>
        )}
      </header>

      {company.isInternal ? (
        <p className="text-sm text-gray-600">
          Internal workspaces are always unlimited, so this one needs no plan.
        </p>
      ) : (
        <PlanEditor
          companyId={company.id}
          companyName={company.name}
          plan={company.plan}
          pkrPerUsd={pkrPerUsd}
        />
      )}

      <div className="mt-5 border-t border-gray-100 pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          History, newest first
        </h4>
        <History entries={company.history} />
      </div>
    </article>
  );
}

export function RatesPanel({ result }: { result: PlansAdminResult }) {
  const heading = (
    <div className="mb-4">
      <h2 className="font-heading text-xl font-bold text-gray-900">Plans &amp; Rates</h2>
      <p className="mt-1 text-sm text-gray-500">
        Set the rates the estimates use and each company&apos;s plan. Limits are recorded, not
        enforced yet.
      </p>
    </div>
  );

  if (!result.ok) {
    return (
      <section aria-labelledby="plans-error">
        {heading}
        <div role="alert" className="rounded-2xl bg-red-50 p-5 text-red-800 ring-1 ring-red-200">
          <p id="plans-error" className="font-semibold">
            Plans could not be loaded.
          </p>
          <p className="mt-1 text-sm">
            Failed: {result.readErrors.map((e) => e.source).join(", ")}. Details are in the server
            log.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Plans and rates" className="grid gap-4">
      {heading}
      <PricingForm rates={result.rates} />
      {result.companies.map((company) => (
        <CompanyPlanCard key={company.id} company={company} pkrPerUsd={result.rates.pkrPerUsd} />
      ))}
    </section>
  );
}
