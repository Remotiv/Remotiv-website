/**
 * Loading skeletons used by admin + client `loading.tsx` files.
 *
 * Next.js automatically renders these while the matching page's data
 * fetches. Replaces the previous "blank screen until everything loads"
 * UX (audit Phase 5 #21).
 *
 * The Skeleton primitive uses `animate-pulse` plus `motion-reduce:animate-none`
 * so users with the OS reduced-motion preference see a static block instead
 * of a pulsing one. The page-level wrapper sets `aria-busy="true"` and an
 * sr-only "Loading content..." announcement.
 *
 * No "use client" — these render as RSC-friendly loading fallbacks.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-gray-200 motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * Generic page-level skeleton — header → 4 stat cards → list rows.
 * Matches the typical admin dashboard shape closely enough to be a useful
 * placeholder for /admin/talent, /admin/applications, /admin/jobs, etc.
 *
 * Pages with very different layouts (e.g. /admin/client-batches/[id])
 * can pass `variant="detail"` for a less stat-heavy look.
 */
export function DashboardSkeleton({
  title,
  variant = "list",
}: {
  title?: string;
  variant?: "list" | "detail";
}) {
  return (
    <main
      className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8"
      aria-busy="true"
      aria-label={title ? `Loading ${title}` : "Loading"}
    >
      {/* Page header */}
      <div className="mb-6 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>

      {/* Stat row — only on list-shape dashboards */}
      {variant === "list" && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      )}

      {/* Main content */}
      <div className="space-y-3 rounded-2xl border border-black/5 bg-white p-5 shadow-sm">
        {Array.from({ length: variant === "detail" ? 8 : 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>

      <span className="sr-only">Loading content…</span>
    </main>
  );
}
