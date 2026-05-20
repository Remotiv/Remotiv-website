"use client";

import { Loader2 } from "lucide-react";

/**
 * Centered loading shell for dynamic-imported modals (ProfileModal + PricingModal).
 * Renders an overlay with a centered spinner so the first modal-open on a cold
 * chunk doesn't flash an empty screen. Tiny — under 1KB — and ships in the main
 * chunk, so it's available immediately when next/dynamic starts fetching.
 *
 * No focus trap, no aria-modal — this is purely visual placeholder while
 * the real modal arrives. aria-busy + aria-label communicate state to AT.
 */
export default function ModalShell(): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}
    >
      <Loader2
        className="animate-spin"
        style={{ width: 32, height: 32, color: "#fff" }}
        aria-hidden="true"
      />
    </div>
  );
}
