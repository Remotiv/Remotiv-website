"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

type TooltipProps = {
  /** The element that triggers the tooltip (e.g. a badge, button). */
  children: ReactNode;
  /** Tooltip text. Should be short — 1-2 sentences max. */
  content: string;
  /** Optional className for the wrapping span. */
  className?: string;
};

/**
 * Accessible tooltip: shows on hover AND keyboard focus, dismisses on
 * Escape, hidden from DOM/AT when inactive.
 *
 * Uses aria-describedby to associate the tooltip with the trigger.
 * The trigger element should already be focusable (button, link, or
 * [tabindex="0"]). If the children don't have focus, wrap the children
 * with a span tabindex="0" yourself.
 *
 * Phase 6 C3 — shared component for Match Score explainer and any
 * future contextual help affordance.
 */
export default function Tooltip({
  children,
  content,
  className,
}: TooltipProps): React.ReactElement {
  const id = useId();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVisible(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible]);

  return (
    <span
      className={className}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      <span aria-describedby={visible ? id : undefined}>{children}</span>
      {visible && (
        <span
          id={id}
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1a1a1a",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: "0.72rem",
            fontWeight: 500,
            whiteSpace: "normal",
            maxWidth: 240,
            zIndex: 100,
            pointerEvents: "none",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
