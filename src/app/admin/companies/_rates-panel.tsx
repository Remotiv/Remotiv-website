import type { PlansAdminResult } from "@/lib/plans-admin";
import { PlansTable } from "./_plans-table";
import { PricingSettings } from "./_pricing-settings";

/**
 * The Plans & Rates tab: a compact pricing summary that expands into its form,
 * then every company's plan as one table. A company's plan is edited in a
 * drawer, and its history is read only when that drawer opens.
 *
 * A server component; PricingSettings and PlansTable are the client parts, and
 * they write only through the existing server actions.
 */
export function RatesPanel({ result }: { result: PlansAdminResult }) {
  const heading = (
    <div className="mb-1">
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
        <div
          role="alert"
          className="mt-3 rounded-2xl bg-red-50 p-5 text-red-800 ring-1 ring-red-200"
        >
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
      <PricingSettings rates={result.rates} />
      <PlansTable companies={result.companies} pkrPerUsd={result.rates.pkrPerUsd} />
    </section>
  );
}
