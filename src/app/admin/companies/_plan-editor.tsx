"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import type { PlanSnapshot } from "@/lib/plans-admin";
import { type PlanField, validateCompanyPlan } from "@/lib/plans-admin-validate";
import { formatPkr } from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";
import { removeCompanyPlanAction, saveCompanyPlanAction } from "./actions";

/**
 * One company's plan: name, CV scoring limit, async interview limit, quoted
 * price and notes. Saving goes through set_company_plan and removing through
 * remove_company_plan, both on the server, as the signed-in admin.
 *
 * Limits are recorded, not enforced: nothing checks them yet. The copy says so.
 */

const INPUT =
  "h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-remotiv-purple";

function fromPlan(plan: PlanSnapshot | null): Record<PlanField, string> {
  return {
    planName: plan?.planName ?? "",
    cvScoringLimit: plan?.cvScoringLimit == null ? "" : String(plan.cvScoringLimit),
    asyncInterviewLimit: plan?.asyncInterviewLimit == null ? "" : String(plan.asyncInterviewLimit),
    quotedPrice: plan?.quotedPrice == null ? "" : String(plan.quotedPrice),
    notes: plan?.notes ?? "",
  };
}

export function PlanEditor({
  companyId,
  companyName,
  plan,
  pkrPerUsd,
}: {
  companyId: string;
  companyName: string;
  plan: PlanSnapshot | null;
  pkrPerUsd: number | null;
}) {
  const router = useRouter();
  const formId = useId();
  const [values, setValues] = useState(() => fromPlan(plan));
  const [errors, setErrors] = useState<Partial<Record<PlanField, string>>>({});
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [pending, startTransition] = useTransition();

  const set = (field: PlanField) => (e: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [field]: e.target.value }));

  function save() {
    const checked = validateCompanyPlan(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setStatus({ tone: "error", text: "Some values need fixing." });
      return;
    }
    setErrors({});
    setStatus(null);
    startTransition(async () => {
      const result = await saveCompanyPlanAction(companyId, values);
      if (result.ok) {
        setStatus({ tone: "ok", text: "Plan saved. The change is recorded in the history below." });
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        setStatus({ tone: "error", text: result.error });
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeCompanyPlanAction(companyId);
      setConfirmingRemove(false);
      if (result.ok) {
        setValues(fromPlan(null));
        setStatus({
          tone: "ok",
          text: "Plan removed. This company now has no plan, so it is unlimited.",
        });
        router.refresh();
      } else {
        setStatus({ tone: "error", text: result.error });
      }
    });
  }

  const field = (name: PlanField, label: string, help: string, extra?: string) => {
    const id = `${formId}-${name}`;
    const error = errors[name];
    return (
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-800">
          {label}
        </label>
        <input
          id={id}
          inputMode={name === "planName" ? "text" : name === "quotedPrice" ? "decimal" : "numeric"}
          autoComplete="off"
          value={values[name]}
          onChange={set(name)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
          className={cn(INPUT, "mt-1", error && "border-red-400")}
        />
        <p id={`${id}-help`} className="mt-1 text-xs text-gray-500">
          {help}
          {extra && <span className="ml-1 text-gray-700">{extra}</span>}
        </p>
        {error && (
          <p id={`${id}-error`} className="mt-1 text-xs font-medium text-red-700">
            {error}
          </p>
        )}
      </div>
    );
  };

  const price = Number(values.quotedPrice);
  const priceExtra =
    values.quotedPrice.trim() !== "" && Number.isFinite(price)
      ? formatPkr(price, pkrPerUsd)
      : undefined;

  return (
    <form
      aria-label={`Plan for ${companyName}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field("planName", "Plan name", "Blank saves as Custom.")}
        {field("quotedPrice", "Quoted price", "USD per month. Blank records no price.", priceExtra)}
        {field(
          "cvScoringLimit",
          "CV scoring limit per month",
          "Applicants scored, re-scores included. Blank means unlimited.",
        )}
        {field(
          "asyncInterviewLimit",
          "Async interview limit per month",
          "Invitations sent, re-sends included. Blank means unlimited.",
        )}
      </div>
      <div className="mt-4">
        <label htmlFor={`${formId}-notes`} className="block text-sm font-medium text-gray-800">
          Notes
        </label>
        <textarea
          id={`${formId}-notes`}
          rows={2}
          value={values.notes}
          onChange={set("notes")}
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? `${formId}-notes-error` : undefined}
          className={cn(INPUT, "mt-1 h-auto py-2", errors.notes && "border-red-400")}
        />
        {errors.notes && (
          <p id={`${formId}-notes-error`} className="mt-1 text-xs font-medium text-red-700">
            {errors.notes}
          </p>
        )}
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Limits are recorded here, not enforced yet. Saving changes nothing a company can do.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center rounded-xl bg-gray-900 px-5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
        >
          {pending ? "Saving..." : plan ? "Save plan" : "Create plan"}
        </button>
        {plan && !confirmingRemove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmingRemove(true)}
            className="inline-flex min-h-10 items-center rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            Remove plan
          </button>
        )}
        {plan && confirmingRemove && (
          <span className="flex flex-wrap items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
            Remove this plan? The company goes back to no plan, which is unlimited.
            <button
              type="button"
              disabled={pending}
              onClick={remove}
              className="inline-flex min-h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
            >
              Yes, remove
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmingRemove(false)}
              className="inline-flex min-h-9 items-center rounded-lg border border-red-200 bg-white px-3 text-sm font-semibold text-red-800 hover:bg-red-100"
            >
              Cancel
            </button>
          </span>
        )}
        <p
          role={status?.tone === "error" ? "alert" : "status"}
          className={cn("text-sm", status?.tone === "error" ? "text-red-700" : "text-gray-600")}
        >
          {status?.text ?? ""}
        </p>
      </div>
    </form>
  );
}
