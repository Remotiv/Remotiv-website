"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  type PricingField,
  SUGGESTED_PRICING,
  validatePricingSettings,
} from "@/lib/plans-admin-validate";
import { formatPkr, type PricingRates } from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";
import { savePricingSettingsAction } from "./actions";

/**
 * The one pricing_settings row, editable. USD throughout, with PKR beside each
 * money field once an exchange rate is entered. Suggested starting values are
 * shown beside every field and filled in only when the admin asks; nothing is
 * saved until Save is pressed.
 */

type FieldSpec = {
  field: PricingField;
  label: string;
  help: string;
  /** Show the PKR equivalent beside it. */
  money: boolean;
};

const FIELDS: FieldSpec[] = [
  {
    field: "cv_score_cost",
    label: "CV scoring cost",
    help: "USD per applicant scored.",
    money: true,
  },
  {
    field: "async_interview_cost",
    label: "Async interview cost",
    help: "USD per completed async interview.",
    money: true,
  },
  {
    field: "whatsapp_message_cost",
    label: "WhatsApp message cost",
    help: "USD per delivered message.",
    money: true,
  },
  {
    field: "fixed_monthly_cost",
    label: "Fixed monthly cost",
    help: "USD per month to run the platform.",
    money: true,
  },
  {
    field: "clients_sharing_fixed_cost",
    label: "Clients sharing the fixed cost",
    help: "Each client carries the fixed cost divided by this number. Whole number, at least 1.",
    money: false,
  },
  {
    field: "minimum_price",
    label: "Minimum price",
    help: "USD per month. A quote's floor never goes below this.",
    money: true,
  },
  {
    field: "minimum_margin_pct",
    label: "Minimum margin",
    help: "Percent of the price kept as profit. Must be below 100.",
    money: false,
  },
  {
    field: "pkr_per_usd",
    label: "PKR per USD",
    help: "The exchange rate used for every PKR figure.",
    money: false,
  },
];

const INPUT =
  "h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-remotiv-purple";

function initialValue(rates: PricingRates, field: PricingField): string {
  const map: Record<PricingField, number | null> = {
    cv_score_cost: rates.cvScoreCost,
    async_interview_cost: rates.asyncInterviewCost,
    whatsapp_message_cost: rates.whatsappMessageCost,
    fixed_monthly_cost: rates.fixedMonthlyCost,
    clients_sharing_fixed_cost: rates.clientsSharingFixedCost,
    minimum_price: rates.minimumPrice,
    minimum_margin_pct: rates.minimumMarginPct,
    pkr_per_usd: rates.pkrPerUsd,
  };
  const v = map[field];
  return v === null ? "" : String(v);
}

export function PricingForm({ rates }: { rates: PricingRates }) {
  const router = useRouter();
  const formId = useId();
  const [values, setValues] = useState<Record<PricingField, string>>(
    () =>
      Object.fromEntries(FIELDS.map((f) => [f.field, initialValue(rates, f.field)])) as Record<
        PricingField,
        string
      >,
  );
  const [errors, setErrors] = useState<Partial<Record<PricingField, string>>>({});
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // PKR beside each money field, from the rate being typed if it is valid.
  const typedPkr = Number(values.pkr_per_usd);
  const pkrRate = values.pkr_per_usd.trim() !== "" && typedPkr > 0 ? typedPkr : null;

  function fillSuggested() {
    setValues({ ...SUGGESTED_PRICING });
    setErrors({});
    setStatus({
      tone: "ok",
      text: "Suggested values filled in. Nothing is saved until you press Save.",
    });
  }

  function save() {
    const checked = validatePricingSettings(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setStatus({ tone: "error", text: "Some values need fixing." });
      return;
    }
    setErrors({});
    setStatus(null);
    startTransition(async () => {
      const result = await savePricingSettingsAction(values);
      if (result.ok) {
        setStatus({ tone: "ok", text: "Pricing settings saved." });
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        setStatus({ tone: "error", text: result.error });
      }
    });
  }

  return (
    <section aria-labelledby={`${formId}-title`} className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${formId}-title`} className="font-heading text-base font-bold text-gray-900">
            Pricing settings
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            USD throughout. A blank field is not set, and anything that depends on it reads
            &ldquo;rate not set&rdquo; rather than zero.
          </p>
        </div>
        <button
          type="button"
          onClick={fillSuggested}
          className="inline-flex min-h-10 items-center rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          Fill in suggested starting values
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const id = `${formId}-${f.field}`;
            const error = errors[f.field];
            const amount = Number(values[f.field]);
            const showPkr = f.money && values[f.field].trim() !== "" && Number.isFinite(amount);
            return (
              <div key={f.field}>
                <label htmlFor={id} className="block text-sm font-medium text-gray-800">
                  {f.label}
                </label>
                <input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={values[f.field]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.field]: e.target.value }))}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
                  className={cn(INPUT, "mt-1", error && "border-red-400")}
                />
                <p id={`${id}-help`} className="mt-1 text-xs text-gray-500">
                  {f.help} Suggested: {SUGGESTED_PRICING[f.field]}.
                  {showPkr && (
                    <span className="ml-1 text-gray-700">{formatPkr(amount, pkrRate)}</span>
                  )}
                </p>
                {error && (
                  <p id={`${id}-error`} className="mt-1 text-xs font-medium text-red-700">
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-10 items-center rounded-xl bg-gray-900 px-5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save pricing settings"}
          </button>
          <p
            role={status?.tone === "error" ? "alert" : "status"}
            className={cn("text-sm", status?.tone === "error" ? "text-red-700" : "text-gray-600")}
          >
            {status?.text ?? ""}
          </p>
        </div>
      </form>
    </section>
  );
}
