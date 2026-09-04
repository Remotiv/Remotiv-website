"use client";

import { IconSend } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import ApplyModal from "@/app/jobs/_apply-modal";
import { captureAttribution } from "@/app/jobs/_attribution";
import type { BrandPreset } from "@/components/white-label/brand";
import type { Job } from "@/lib/jobs";

// Thin client boundary so the server job page can open the existing
// ApplyModal (a client component) from multiple "Apply now" buttons without
// any change to the modal or the jobs list. Each instance owns its own
// open-state; they all mount the same modal with the same `job`.
/**
 * Capture attribution when a job page mounts.
 *
 * Lives on this button because it is the one client boundary already present on
 * every job detail page — no new component, no new mount. It runs on LANDING,
 * not on click: the utm is on the URL the moment they arrive, and by the time
 * anyone presses Apply they may have navigated twice. captureAttribution is
 * idempotent and never throws, so mounting several buttons on one page is
 * harmless.
 */
function useCaptureAttribution(): void {
  useEffect(() => {
    captureAttribution();
  }, []);
}

export default function ApplyButton({
  job,
  variant = "hero",
  className: override,
  label = "Apply for this role",
  children,
  preset,
}: {
  job: Job;
  variant?: "hero" | "ticket";
  /**
   * The white-label pages style their own buttons — `.btn`, `.btn.onbrand` —
   * so they pass a class instead of picking a variant. When present it REPLACES
   * the variant class rather than merging: the two systems have different
   * padding, radius and colour, and a merge would be both.
   */
  className?: string;
  /** White-label copy is "Apply for this role"; the variants keep "Apply now". */
  label?: string;
  /** The white-label icon, so the design's arrow travels with its own stroke. */
  children?: React.ReactNode;
  /**
   * Passed straight through to the modal, which portals out of the canvas and
   * so cannot inherit the brand. Only the white-label page supplies it; the
   * Remotiv variants leave it undefined and the modal stays Remotiv purple.
   */
  preset?: BrandPreset;
}) {
  const [open, setOpen] = useState(false);
  useCaptureAttribution();

  const variantClass =
    variant === "ticket"
      ? "flex w-full items-center justify-center gap-2 rounded-xl bg-remotiv-purple px-6 py-3.5 font-heading text-sm font-bold text-white transition-opacity hover:opacity-90"
      : "inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 font-heading text-sm font-bold text-remotiv-purple shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-transform hover:-translate-y-0.5";

  const whiteLabel = Boolean(override);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={override ?? variantClass}>
        {whiteLabel ? (
          <>
            {label}
            {children}
          </>
        ) : (
          <>
            <IconSend size={18} stroke={2} />
            Apply now
          </>
        )}
      </button>
      {open && <ApplyModal job={job} onClose={() => setOpen(false)} preset={preset} />}
    </>
  );
}
