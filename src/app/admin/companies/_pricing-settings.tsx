"use client";

import { useId, useState } from "react";
import { formatRate } from "@/lib/plans-table";
import type { PricingRates } from "@/lib/plans-usage-types";
import { PricingForm } from "./_pricing-form";

/**
 * Pricing settings, compact: a one-line summary of every rate, and an inline
 * disclosure that expands the existing form. Inline rather than a modal, so the
 * plan drawer is the only dialog on this tab.
 */
export function PricingSettings({ rates }: { rates: PricingRates }) {
  const formId = useId();
  const [open, setOpen] = useState(false);

  const items: { label: string; value: string | null }[] = [
    {
      label: "CV scoring",
      value: rates.cvScoreCost === null ? null : `${formatRate(rates.cvScoreCost)} per applicant`,
    },
    {
      label: "Async interview",
      value:
        rates.asyncInterviewCost === null
          ? null
          : `${formatRate(rates.asyncInterviewCost)} per completed interview`,
    },
    {
      label: "WhatsApp",
      value:
        rates.whatsappMessageCost === null
          ? null
          : `${formatRate(rates.whatsappMessageCost)} per message`,
    },
    {
      label: "Fixed cost",
      value:
        rates.fixedMonthlyCost === null
          ? null
          : `${formatRate(rates.fixedMonthlyCost)}/month across ${rates.clientsSharingFixedCost} ${rates.clientsSharingFixedCost === 1 ? "client" : "clients"}`,
    },
    {
      label: "Minimum price",
      value: rates.minimumPrice === null ? null : `${formatRate(rates.minimumPrice)}/month`,
    },
    {
      label: "Minimum margin",
      value: rates.minimumMarginPct === null ? null : `${rates.minimumMarginPct}%`,
    },
    { label: "PKR per USD", value: rates.pkrPerUsd === null ? null : String(rates.pkrPerUsd) },
  ];
  const noneSet = items.every((i) => i.value === null);

  return (
    <div className="grid gap-3">
      <section aria-labelledby={`${formId}-title`} className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={`${formId}-title`} className="font-heading text-base font-bold text-gray-900">
              Pricing settings
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">
              USD. Used by the Usage estimates and the Quote Builder.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${formId}-form`}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-10 items-center rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {open ? "Close editor" : "Edit pricing settings"}
          </button>
        </div>

        {noneSet && (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
            No rates are set yet. Estimates and quotes read &ldquo;rate not set&rdquo; until they
            are.
          </p>
        )}

        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          {items.map((i) => (
            <div key={i.label} className="flex gap-1.5">
              <dt className="text-gray-500">{i.label}</dt>
              <dd className={i.value === null ? "text-amber-700" : "font-medium text-gray-900"}>
                {i.value ?? "not set"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* The form draws its own card, so it sits below the summary, not inside it. */}
      <div id={`${formId}-form`} hidden={!open}>
        {open && <PricingForm rates={rates} />}
      </div>
    </div>
  );
}
