"use client";

import { useEffect, useState } from "react";
import type { PlanHistoryEntry, PlanSnapshot } from "@/lib/plans-admin";
import { BILLING_TIME_ZONE } from "@/lib/plans-usage-types";
import { fetchPlanHistory } from "./actions";

/**
 * One company's plan history, newest first, read-only. Mounted only inside an
 * open plan drawer, and it fetches on mount, so history is read for the one
 * company being looked at and never for the whole table. `reloadKey` changes
 * after a save or removal to read it again.
 */

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

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; entries: PlanHistoryEntry[] };

export function PlanHistory({ companyId, reloadKey }: { companyId: string; reloadKey: number }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  // reloadKey is a deliberate trigger: a change means "read again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the read on purpose
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    fetchPlanHistory(companyId)
      .then((result) => {
        if (!current) return;
        setState(result.ok ? { kind: "loaded", entries: result.entries } : { kind: "failed" });
      })
      .catch(() => {
        if (current) setState({ kind: "failed" });
      });
    return () => {
      // A newer read, or the drawer closing, makes this answer stale.
      current = false;
    };
  }, [companyId, reloadKey]);

  if (state.kind === "loading") {
    return (
      <p role="status" className="text-sm text-gray-500">
        Loading history...
      </p>
    );
  }
  if (state.kind === "failed") {
    return (
      <p role="alert" className="text-sm text-red-700">
        History could not be loaded. Details are in the server log.
      </p>
    );
  }
  if (state.entries.length === 0) {
    return <p className="text-sm text-gray-500">No plan changes recorded yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {state.entries.map((h) => (
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
