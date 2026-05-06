"use client";

import type { ReactNode } from "react";

/**
 * Shared status pill primitive. Use this instead of inline Tailwind classes
 * so every admin surface treats the same status state with the same color.
 *
 *   variant=success → green   (active / approved / hired / open)
 *   variant=warning → amber   (pending / in review)
 *   variant=danger  → red     (rejected / closed / archived / paused)
 *   variant=info    → purple  (shortlisted / interview / scheduled)
 *   variant=neutral → gray    (default fallback)
 */

export type StatusVariant =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

const VARIANT_CLASSES: Record<StatusVariant, string> = {
  success: "bg-remotiv-green/15 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-red-100 text-red-700",
  info: "bg-remotiv-purple/10 text-remotiv-purple",
  neutral: "bg-gray-100 text-gray-700",
};

export function StatusBadge({
  variant,
  children,
  className = "",
}: {
  variant: StatusVariant;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Map a free-text status string to one of the five variants. */
export function statusToVariant(status: string | null | undefined): StatusVariant {
  const s = (status ?? "").toLowerCase();
  if (
    s === "active" ||
    s === "approved" ||
    s === "open" ||
    s === "hired" ||
    s === "completed" ||
    s === "resolved"
  )
    return "success";
  if (s === "pending" || s === "in_progress" || s === "in progress" || s === "new")
    return "warning";
  if (
    s === "rejected" ||
    s === "closed" ||
    s === "archived" ||
    s === "cancelled" ||
    s === "not_a_fit"
  )
    return "danger";
  if (
    s === "shortlisted" ||
    s === "request_interview" ||
    s === "scheduled" ||
    s === "placed" ||
    s === "maybe"
  )
    return "info";
  if (s === "paused" || s === "on_hold" || s === "draft") return "neutral";
  return "neutral";
}
