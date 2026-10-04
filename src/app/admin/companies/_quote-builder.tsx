"use client";

import { type ReactNode, useId, useState } from "react";
import { parseOptionalMoney } from "@/lib/plans-admin-validate";
import { formatPkr, formatUsd, type PricingRates, RATE_NOT_SET } from "@/lib/plans-usage-types";
import { computeQuote, VERDICT_LABEL } from "@/lib/quote";
import { cn } from "@/lib/utils";

/**
 * The Quote Builder: monthly volumes and a price in, cost, floor, profit,
 * margin and a verdict out. Pure arithmetic in the browser over the saved
 * rates. It saves nothing and calls nothing.
 */

type Field = "applicants" | "asyncInterviews" | "whatsappMessages" | "quotedPrice";

const COUNT_FIELDS: { field: Exclude<Field, "quotedPrice">; label: string; help: string }[] = [
  { field: "applicants", label: "Applicants to score", help: "Per month." },
  {
    field: "asyncInterviews",
    label: "Completed async interviews",
    help: "Per month. Cost follows completions, not invitations.",
  },
  { field: "whatsappMessages", label: "WhatsApp messages", help: "Delivered, per month." },
];

const INPUT =
  "h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-remotiv-purple";

/** A blank count is zero; anything else must be a whole number. */
function parseCount(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return 0;
  return /^\d+$/.test(t) && Number(t) <= 10_000_000 ? Number(t) : null;
}

function Money({ usd, pkrPerUsd }: { usd: number | null; pkrPerUsd: number | null }) {
  if (usd === null) return <span className="text-amber-700">Unavailable</span>;
  return (
    <span>
      <span className="font-semibold text-gray-900">{formatUsd(usd)}</span>
      <span className="ml-2 text-xs text-gray-500">{formatPkr(usd, pkrPerUsd)}</span>
    </span>
  );
}

function Rate({ value, unit }: { value: number | null; unit: string }) {
  return value === null ? (
    <span className="text-amber-700">{RATE_NOT_SET}</span>
  ) : (
    <span className="text-gray-800">
      {formatUsd(value)} {unit}
    </span>
  );
}

export function QuoteBuilder({ rates }: { rates: PricingRates }) {
  const formId = useId();
  const [values, setValues] = useState<Record<Field, string>>({
    applicants: "",
    asyncInterviews: "",
    whatsappMessages: "",
    quotedPrice: "",
  });

  const counts = {
    applicants: parseCount(values.applicants),
    asyncInterviews: parseCount(values.asyncInterviews),
    whatsappMessages: parseCount(values.whatsappMessages),
  };
  const price = parseOptionalMoney(values.quotedPrice, 2);
  const invalid: Partial<Record<Field, string>> = {};
  for (const f of COUNT_FIELDS) {
    if (counts[f.field] === null)
      invalid[f.field] = "Enter a whole number, or leave blank for none.";
  }
  if (!price.ok) invalid.quotedPrice = price.error;

  const quote =
    Object.keys(invalid).length === 0
      ? computeQuote(rates, {
          applicants: counts.applicants ?? 0,
          asyncInterviews: counts.asyncInterviews ?? 0,
          whatsappMessages: counts.whatsappMessages ?? 0,
          quotedPrice: price.ok ? price.value : null,
        })
      : null;

  const input = (field: Field, label: string, help: string) => {
    const id = `${formId}-${field}`;
    const error = invalid[field];
    return (
      <div key={field}>
        <label htmlFor={id} className="block text-sm font-medium text-gray-800">
          {label}
        </label>
        <input
          id={id}
          inputMode={field === "quotedPrice" ? "decimal" : "numeric"}
          autoComplete="off"
          value={values[field]}
          onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
          className={cn(INPUT, "mt-1", error && "border-red-400")}
        />
        <p id={`${id}-help`} className="mt-1 text-xs text-gray-500">
          {help}
        </p>
        {error && (
          <p id={`${id}-error`} className="mt-1 text-xs font-medium text-red-700">
            {error}
          </p>
        )}
      </div>
    );
  };

  const row = (label: string, value: ReactNode) => (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 py-2 last:border-b-0">
      <dt className="text-sm text-gray-600">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );

  return (
    <section aria-labelledby={`${formId}-title`} className="grid gap-4">
      <div>
        <h2 id={`${formId}-title`} className="font-heading text-xl font-bold text-gray-900">
          Quote Builder
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Monthly volumes and a price. Arithmetic only: nothing here is saved.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            {COUNT_FIELDS.map((f) => input(f.field, f.label, f.help))}
            {input("quotedPrice", "Quoted price", "USD per month.")}
          </div>
          <div className="mt-5 border-t border-gray-100 pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Rates used
            </h3>
            <dl>
              {row("CV scoring", <Rate value={rates.cvScoreCost} unit="per applicant" />)}
              {row(
                "Async interview",
                <Rate value={rates.asyncInterviewCost} unit="per completed interview" />,
              )}
              {row("WhatsApp", <Rate value={rates.whatsappMessageCost} unit="per message" />)}
              {row(
                "Fixed cost share",
                rates.fixedMonthlyCost === null ? (
                  <span className="text-amber-700">{RATE_NOT_SET}</span>
                ) : (
                  <span className="text-gray-800">
                    {formatUsd(rates.fixedMonthlyCost / Math.max(1, rates.clientsSharingFixedCost))}{" "}
                    per month ({formatUsd(rates.fixedMonthlyCost)} across{" "}
                    {rates.clientsSharingFixedCost})
                  </span>
                ),
              )}
              {row("Minimum price", <Rate value={rates.minimumPrice} unit="per month" />)}
              {row(
                "Minimum margin",
                rates.minimumMarginPct === null ? (
                  <span className="text-amber-700">{RATE_NOT_SET}</span>
                ) : (
                  <span className="text-gray-800">{rates.minimumMarginPct}%</span>
                ),
              )}
            </dl>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-sm" aria-live="polite">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Result
          </h3>
          {quote === null ? (
            <p className="text-sm text-gray-600">Fix the highlighted fields to see the result.</p>
          ) : (
            <>
              <dl>
                {row("Estimated cost", <Money usd={quote.costUsd} pkrPerUsd={rates.pkrPerUsd} />)}
                {row("Floor price", <Money usd={quote.floorUsd} pkrPerUsd={rates.pkrPerUsd} />)}
                {row(
                  "Profit",
                  quote.profitUsd === null ? (
                    <span className="text-gray-500">Enter a quoted price</span>
                  ) : (
                    <Money usd={quote.profitUsd} pkrPerUsd={rates.pkrPerUsd} />
                  ),
                )}
                {row(
                  "Margin",
                  quote.marginPct === null ? (
                    <span className="text-gray-500">
                      {price.ok && price.value === 0
                        ? "Undefined at a price of zero"
                        : "Enter a quoted price"}
                    </span>
                  ) : (
                    <span className="font-semibold text-gray-900">
                      {quote.marginPct.toFixed(1)}%
                    </span>
                  ),
                )}
                {row(
                  "Verdict",
                  quote.verdict === null ? (
                    <span className="text-gray-500">
                      {quote.floorUsd === null ? "Unavailable" : "Enter a quoted price"}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        quote.verdict === "below_floor"
                          ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                          : "bg-remotiv-green/15 text-gray-800",
                      )}
                    >
                      {VERDICT_LABEL[quote.verdict]}
                    </span>
                  ),
                )}
              </dl>
              {quote.blockedBy.length > 0 && (
                <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
                  <p className="font-semibold">Some figures are unavailable:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {quote.blockedBy.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-4 text-xs text-gray-500">
                Floor price is the larger of the minimum price and cost / (1 - minimum margin).
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
