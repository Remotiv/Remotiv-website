"use client";

import { useState } from "react";
import { updateJobDisplayOrder } from "@/app/admin/jobs/actions";

const INPUT_CLS =
  "w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";

type SaveState = "idle" | "saving" | "saved" | "error";

// Inline editable "Display order" cell for the admin jobs table. Self-contained
// so the shared jobs-dashboard only mounts it. Saves on blur / Enter; skips the
// round-trip when the value is unchanged. Stops propagation so it never triggers
// any row-level click handler.
export function JobOrderCell({
  jobId,
  initial,
}: {
  jobId: string;
  initial: number | null;
}) {
  const initialStr = initial != null ? String(initial) : "";
  const [value, setValue] = useState(initialStr);
  const [saved, setSaved] = useState(initialStr);
  const [state, setState] = useState<SaveState>("idle");

  async function commit() {
    const next = value.trim();
    if (next === saved) {
      setState("idle");
      return;
    }
    setState("saving");
    const parsed = next === "" ? null : Number.parseInt(next, 10);
    const payload = parsed != null && Number.isFinite(parsed) ? parsed : null;
    try {
      const result = await updateJobDisplayOrder(jobId, payload);
      if (!result.success) {
        setState("error");
        return;
      }
      // Normalize the field to what was actually stored (null → "").
      const normalized = payload != null ? String(payload) : "";
      setValue(normalized);
      setSaved(normalized);
      setState("saved");
    } catch {
      setState("error");
    }
  }

  const ringClass =
    state === "saved"
      ? "ring-2 ring-remotiv-green/40"
      : state === "error"
        ? "ring-2 ring-red-400"
        : "";

  return (
    <input
      type="number"
      min="1"
      step="1"
      inputMode="numeric"
      value={value}
      placeholder="—"
      aria-label="Display order"
      aria-busy={state === "saving"}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        setValue(e.target.value);
        if (state !== "idle") setState("idle");
      }}
      onBlur={() => {
        void commit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={`${INPUT_CLS} ${ringClass}`}
    />
  );
}
