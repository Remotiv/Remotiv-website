"use client";

import { IconSend } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import ApplyModal from "@/app/jobs/_apply-modal";
import { captureAttribution } from "@/app/jobs/_attribution";
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
}: {
  job: Job;
  variant?: "hero" | "ticket";
}) {
  const [open, setOpen] = useState(false);
  useCaptureAttribution();

  const className =
    variant === "ticket"
      ? "flex w-full items-center justify-center gap-2 rounded-xl bg-remotiv-purple px-6 py-3.5 font-heading text-sm font-bold text-white transition-opacity hover:opacity-90"
      : "inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 font-heading text-sm font-bold text-remotiv-purple shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-transform hover:-translate-y-0.5";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <IconSend size={18} stroke={2} />
        Apply now
      </button>
      {open && <ApplyModal job={job} onClose={() => setOpen(false)} />}
    </>
  );
}
