"use client";

import { IconSend } from "@tabler/icons-react";
import { useState } from "react";
import ApplyModal from "@/app/jobs/_apply-modal";
import type { Job } from "@/lib/jobs";

// Thin client boundary so the server job page can open the existing
// ApplyModal (a client component) from multiple "Apply now" buttons without
// any change to the modal or the jobs list. Each instance owns its own
// open-state; they all mount the same modal with the same `job`.
export default function ApplyButton({
  job,
  variant = "hero",
}: {
  job: Job;
  variant?: "hero" | "ticket";
}) {
  const [open, setOpen] = useState(false);

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
