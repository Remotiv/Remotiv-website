"use client";

import { X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useModalFocus } from "@/hooks/use-modal-focus";
import type { AdminCompany } from "@/lib/plans-admin";
import { PLAN_STATUS_LABEL, planStatus } from "@/lib/plans-table";
import { PlanEditor } from "./_plan-editor";
import { PlanHistory } from "./_plan-history";

/**
 * The right-side plan drawer for one customer company: the existing plan
 * editor, then that company's history, which is read only now that the drawer
 * is open.
 *
 * Focus is the shared useModalFocus primitive, the same one every dashboard
 * dialog uses: focus moves in, Tab stays inside, Escape closes, focus returns
 * to the row's button, and the page behind is inert. The drawer is rendered
 * only while open and is not portalled, so its container exists when the
 * hook's effect runs, which is why `true` is the right active flag here (the
 * team drawer does the same). The hook's warning about passing `true` applies
 * to dialogs that portal after a mount guard.
 *
 * Internal companies never get this drawer: the table offers no action for them.
 */
export function PlanDrawer({
  company,
  pkrPerUsd,
  onClose,
}: {
  company: AdminCompany;
  pkrPerUsd: number | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [historyKey, setHistoryKey] = useState(0);

  useModalFocus(panelRef, true, { onClose, overlayRef });

  return (
    <div ref={overlayRef} className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close plan"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm sm:block"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full shrink-0 flex-col overflow-y-auto bg-white shadow-2xl outline-none sm:w-[520px]"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate font-heading text-lg font-bold text-gray-900">
              {company.name}
            </h2>
            <p className="mt-0.5 text-sm text-gray-500">
              {company.plan ? "Edit plan" : "Create plan"} ·{" "}
              {PLAN_STATUS_LABEL[planStatus(company)]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <X className="size-5" strokeWidth={2.5} />
          </button>
        </div>

        <div className="px-5 py-5">
          <PlanEditor
            companyId={company.id}
            companyName={company.name}
            plan={company.plan}
            pkrPerUsd={pkrPerUsd}
            onChanged={() => setHistoryKey((k) => k + 1)}
          />

          <section
            aria-labelledby={`${titleId}-history`}
            className="mt-6 border-t border-gray-100 pt-4"
          >
            <h3
              id={`${titleId}-history`}
              className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500"
            >
              History, newest first
            </h3>
            <PlanHistory companyId={company.id} reloadKey={historyKey} />
          </section>
        </div>
      </div>
    </div>
  );
}
