"use client";

import { useState } from "react";

const PREVIEW_CHARS = 250;

type Props = {
  text: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Renders a long text block with a 250-char preview and a
 * Read more / Show less toggle. Returns null when text is empty
 * so callers don't need an outer && guard.
 *
 * Each instance owns its own expanded state — safe to use multiple
 * times inside a .map() loop.
 */
export function TruncatedDescription({ text, className, style }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  const isTruncatable = text.length > PREVIEW_CHARS;
  const preview = isTruncatable
    ? `${text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "")}…`
    : text;
  const display = expanded ? text : preview;

  return (
    <>
      <p className={className} style={style}>
        {display}
      </p>
      {isTruncatable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-[#7E47FF] underline"
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </>
  );
}
