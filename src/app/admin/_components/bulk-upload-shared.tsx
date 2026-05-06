"use client";

/**
 * Shared utilities for the two bulk-CV-upload surfaces:
 *   - BulkUploadCVModal in applications-dashboard.tsx (creates job_applications)
 *   - BulkBatchUploadModal in bulk-batch-upload-modal.tsx (creates client_batch_candidates)
 *
 * Both modals do the same client-side PDF parsing + click-to-edit UI before
 * the parsed rows are sent to different server endpoints. Putting these
 * helpers in one file means we ship pdfjs-dist once, not twice, and any
 * future improvements to the parser apply to both surfaces automatically.
 */

import { useState } from "react";

// ── LinkedIn URL gate ────────────────────────────────────────

// Case-insensitive: any casing of "linkedin.com" passes.
export const LINKEDIN_URL_PATTERN = /linkedin\.com/i;

export function isValidLinkedInUrl(url: string): boolean {
  if (!url || !url.trim()) return false;
  return LINKEDIN_URL_PATTERN.test(url.trim());
}

// ── PDF parsing ──────────────────────────────────────────────

export type ParsedCv = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
};

export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // Worker bundled locally from node_modules — avoids CDN failures
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    let line = "";
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (line.trim()) lines.push(line.trim());
        line = item.str;
      } else {
        line += (line ? " " : "") + item.str;
      }
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

export function parseCvText(rawText: string): ParsedCv {
  // Some PDFs render each glyph with a space between it (a l i . s y e d).
  // Collapse single-space gaps between word/email/URL characters; loop
  // until the text stops changing so arbitrary-length runs are joined.
  let cleanText = rawText;
  let prev = "";
  while (prev !== cleanText) {
    prev = cleanText;
    cleanText = cleanText.replace(
      /([a-zA-Z0-9@._+\-:/]) ([a-zA-Z0-9@._+\-:/])/g,
      "$1$2",
    );
  }

  const emailMatch = cleanText.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);

  // Phone — prefer Pakistani local (03xx-xxxxxxx), then +92, then +1.
  // Skip the generic 10–15 digit fallback; it would match WhatsApp/foreign numbers.
  const phoneMatch =
    cleanText.match(/03[0-9]{2}[-\s]?[0-9]{7}/) ||
    cleanText.match(/\+92[0-9]{10}/) ||
    cleanText.match(/\+1[0-9]{10}/);
  const phone = phoneMatch ? phoneMatch[0] : "";

  // LinkedIn — full URL preferred, bare domain fallback
  const linkedinMatch =
    cleanText.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i) ||
    cleanText.match(/linkedin\.com\/in\/[\w-]+\/?/i);
  const linkedinUrl = linkedinMatch
    ? linkedinMatch[0].startsWith("http")
      ? linkedinMatch[0]
      : `https://${linkedinMatch[0]}`
    : "";

  // Name — use RAW first line so spaces between letters are preserved,
  // then strip the spaces between consecutive uppercase glyphs only.
  const rawLines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = rawLines[0] ?? "";
  let cleanName = firstLine;
  let prevName = "";
  while (prevName !== cleanName) {
    prevName = cleanName;
    cleanName = cleanName.replace(/([A-Z]) ([A-Z])/g, "$1$2");
  }
  const nameParts = cleanName.trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ");

  return {
    firstName,
    lastName,
    email: emailMatch?.[0] ?? "",
    phone,
    linkedin: linkedinUrl,
  };
}

// ── Click-to-edit cell ───────────────────────────────────────

/**
 * Renders as a hover-highlighted button until clicked, then swaps to an
 * autoFocused <input>. Enter or blur commits; Escape reverts.
 *
 * `onChange` only fires when the value actually changed, so a click-to-
 * dismiss with no edit doesn't dirty the row.
 */
export function EditableCell({
  value,
  onChange,
  type = "text",
  placeholder,
  emptyHint = "—",
}: {
  value: string;
  onChange: (next: string) => void;
  type?: "text" | "email" | "tel" | "url";
  placeholder?: string;
  emptyHint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function commit() {
    setEditing(false);
    if (draft !== value) onChange(draft);
  }

  if (editing) {
    return (
      <input
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        autoFocus
        placeholder={placeholder}
        // biome-ignore lint/a11y/noAutofocus: editable cell explicitly opts in to autoFocus on click-to-edit
        className="w-full rounded border border-remotiv-purple px-2 py-1 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-remotiv-purple/30"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      title="Click to edit"
      className="flex min-h-[28px] w-full items-center rounded px-2 py-1 text-left text-xs text-gray-800 transition-colors hover:bg-gray-100"
    >
      {value ? (
        <span className="truncate">{value}</span>
      ) : (
        <span className="text-gray-300">{emptyHint}</span>
      )}
    </button>
  );
}
