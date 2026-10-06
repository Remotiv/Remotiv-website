import type { ApplicantsBannerView } from "@/lib/company-usage-types";
import { cn } from "@/lib/utils";

/**
 * Applicants: the 80% and 100% notices for owner, admin and recruiter - the
 * roles that spend credits here - one per metric that has reached either.
 * Rendered on the server and handed to the applicants client as a finished
 * element. Read-only: no link to buy more, because there is no self-serve
 * upgrade.
 */
export function QuotaBanner({ view }: { view: ApplicantsBannerView }) {
  return (
    <div role="status" className="mb-4 flex flex-col gap-2">
      {view.warnings.map((w) => (
        <p
          key={w.metric}
          className={cn(
            "m-0 rounded-[13px] border px-4 py-3 text-[13px] font-semibold leading-relaxed",
            w.level === "paused"
              ? "border-[var(--ai-danger)] bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]"
              : "border-[var(--ai-amber-dot)] bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
          )}
        >
          {w.text}
        </p>
      ))}
    </div>
  );
}
