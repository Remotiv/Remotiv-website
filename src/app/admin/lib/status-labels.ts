/**
 * Canonical status-string → human label map across all admin surfaces.
 *
 * Each dashboard previously kept its own `STATUS_LABELS` dictionary, leading
 * to drift (e.g. "Pending Review" vs "Pending"; "On Hold" vs "Paused"). This
 * file is the single source of truth. New statuses go here, not in the
 * per-dashboard file.
 *
 * Lookups are case-sensitive against the DB value. The fallback path
 * Title-Cases the raw key so unknown values still render reasonably.
 */

export const STATUS_LABELS: Record<string, string> = {
  // ── Talent / Remote Talent / Applications ───────────────────
  pending: "Pending Review",
  approved: "Approved",
  shortlisted: "Shortlisted",
  placed: "Placed",
  paused: "Paused",
  archived: "Archived",
  rejected: "Rejected",
  hired: "Hired",
  not_a_fit: "Not a Good Fit",
  maybe: "Maybe",

  // ── Jobs ────────────────────────────────────────────────────
  open: "Open",
  closed: "Closed",
  draft: "Draft",
  on_hold: "On Hold",

  // ── Clients / Batches ───────────────────────────────────────
  active: "Active",
  inactive: "Inactive",

  // ── Contacts ────────────────────────────────────────────────
  new: "New",
  in_progress: "In Progress",
  resolved: "Resolved",

  // ── Bookings (Calendly) ─────────────────────────────────────
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",

  // ── Auth-gate (admin_users.status) ──────────────────────────
  // 'active' / 'paused' / 'archived' already covered above.
};

function titleCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ""))
    .join(" ");
}

/**
 * Resolve a status key to its display label. Handles "All" as a special
 * pass-through so filter-pill arrays can include it without a special case.
 */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  if (status === "All") return "All";
  return STATUS_LABELS[status] ?? titleCase(status);
}
