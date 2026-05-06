"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { isValidEmail } from "@/app/admin/lib/validators";
import { useFocusTrap } from "./_shared/use-focus-trap";
import {
  EditableCell,
  extractPdfText,
  isValidLinkedInUrl,
  parseCvText,
} from "./bulk-upload-shared";

/**
 * Slimmer cousin of BulkUploadCVModal in applications-dashboard.tsx.
 *
 * Drops the Job Role select (batch candidates don't pick from open jobs)
 * and posts each row to /api/batch-candidate-cv instead of /api/apply.
 * Otherwise mirrors the same upload → process → review → submit flow,
 * including click-to-edit cells and the desktop-table / mobile-card split.
 */

type Stage = "upload" | "processing" | "review";
type RowStatus = "ready" | "submitting" | "done" | "error";

// Duplicate-source descriptor — null when the row is genuinely new.
// "batch" / "application" / "talent" map 1:1 to the API response from
// /api/check-duplicate-bulk.
type DuplicateSource = "batch" | "application" | "talent" | null;

type Row = {
  id: string;
  file: File;
  filename: string;
  selected: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
  position: string;
  cvText: string;
  status: RowStatus;
  errorMsg: string | null;
  duplicateSource: DuplicateSource;
  duplicateName: string | null;
};

const MAX_BULK = 50;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

function uid(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function BulkBatchUploadModal({
  batchId,
  onClose,
  onComplete,
}: {
  batchId: string;
  onClose: () => void;
  onComplete: (msg: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [processedCount, setProcessedCount] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [submitTotal, setSubmitTotal] = useState(0);

  // In-flight guard against double-clicks on Submit Selected.
  const submitRef = useRef(false);

  // Focus trap. While uploads are mid-flight, Escape is suppressed (matches
  // the existing close-button behaviour) and focus stays locked on the
  // progress UI. Replaces the previous standalone Escape-handler effect.
  const trapRef = useFocusTrap<HTMLDivElement>(true, () => {
    if (!submitting) onClose();
  });

  function addFiles(picked: FileList | File[] | null) {
    if (!picked) return;
    setError(null);
    const incoming = Array.from(picked);

    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (f.type !== "application/pdf") {
        rejected.push(`${f.name}: not a PDF`);
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        rejected.push(`${f.name}: over 5 MB`);
        continue;
      }
      accepted.push(f);
    }

    setFiles((prev) => {
      const combined = [...prev, ...accepted];
      if (combined.length > MAX_BULK) {
        setError(`Maximum ${MAX_BULK} CVs allowed. Trimmed to first ${MAX_BULK}.`);
        return combined.slice(0, MAX_BULK);
      }
      return combined;
    });

    if (rejected.length > 0) {
      setError((prev) => {
        const prefix = prev ? `${prev}\n` : "";
        return `${prefix}${rejected.length} file(s) skipped: ${rejected.slice(0, 3).join("; ")}${rejected.length > 3 ? "…" : ""}`;
      });
    }
  }

  async function processFiles() {
    if (files.length === 0) return;
    setStage("processing");
    setProcessedCount(0);

    const built: Row[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await extractPdfText(file);
        const parsed = parseCvText(text);
        built.push({
          id: uid(),
          file,
          filename: file.name,
          // Auto-select only when parsed LinkedIn URL passes the gate; the
          // server requires it and rows without one would fail anyway.
          selected: isValidLinkedInUrl(parsed.linkedin),
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          email: parsed.email,
          phone: parsed.phone,
          linkedin: parsed.linkedin,
          position: "",
          cvText: text,
          status: "ready",
          errorMsg: null,
          duplicateSource: null,
          duplicateName: null,
        });
      } catch {
        built.push({
          id: uid(),
          file,
          filename: file.name,
          selected: false,
          firstName: "",
          lastName: "",
          email: "",
          phone: "",
          linkedin: "",
          position: "",
          cvText: "",
          status: "error",
          errorMsg: "Failed to read PDF",
          duplicateSource: null,
          duplicateName: null,
        });
      }
      setProcessedCount(i + 1);
    }

    // Cross-table duplicate check — one network call, server runs the
    // 3 lookups per row in parallel. Auto-deselects any row with a hit so
    // the admin only submits genuinely new candidates by default.
    try {
      const checkRes = await fetch("/api/check-duplicate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: built.map((r) => ({ email: r.email, phone: r.phone })),
        }),
      });
      if (checkRes.ok) {
        const json = (await checkRes.json()) as {
          results?: Array<{ source: DuplicateSource; name: string | null }>;
        };
        const results = json.results ?? [];
        for (let i = 0; i < built.length; i++) {
          const r = results[i];
          if (r?.source) {
            built[i].duplicateSource = r.source;
            built[i].duplicateName = r.name;
            // Auto-deselect duplicates so they're not part of "Submit
            // Selected" by default. Admin can opt back in if they really
            // want a duplicate landing in the batch (the API will still
            // 409 — defense in depth).
            built[i].selected = false;
          }
        }
      }
    } catch {
      // Duplicate check failure is non-fatal — rows just show as "New"
      // and the per-row submit will surface the 409 if any are dupes.
    }

    setRows(built);
    setStage("review");
  }

  function updateRow(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function setAllSelected(value: boolean) {
    // Select-all respects both gates: valid LinkedIn AND not a duplicate.
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        selected:
          value && isValidLinkedInUrl(r.linkedin) && r.duplicateSource === null,
      })),
    );
  }

  function dupBadge(source: DuplicateSource): { label: string; cls: string } {
    if (source === "batch") {
      return { label: "Already in Batch", cls: "bg-amber-100 text-amber-700" };
    }
    if (source === "application") {
      return { label: "Already in Apps", cls: "bg-amber-100 text-amber-700" };
    }
    if (source === "talent") {
      return { label: "Already in Talent", cls: "bg-amber-100 text-amber-700" };
    }
    return { label: "New", cls: "bg-green-100 text-green-700" };
  }

  async function submitSelected() {
    if (submitRef.current) return;
    const selectedRows = rows.filter((r) => r.selected && r.status !== "done");
    if (selectedRows.length === 0) return;

    // Pre-flight: catch invalid email / missing names BEFORE we start
    // firing uploads (each one is an HTTP roundtrip).
    const invalid = selectedRows.find((r) => {
      if (!r.firstName.trim()) return true;
      if (r.email.trim() && !isValidEmail(r.email)) return true;
      return false;
    });
    if (invalid) {
      setError("Some rows have invalid email or missing first name. Please fix and try again.");
      return;
    }

    // Pre-flight: block duplicates the parse-phase check already flagged.
    // Defence in depth; the API will also 409 if the admin manually
    // re-selected one. Surface the count so they know what to fix.
    const dupCount = selectedRows.filter((r) => r.duplicateSource !== null).length;
    if (dupCount > 0) {
      setError(
        `${dupCount} row${dupCount === 1 ? " is a duplicate" : "s are duplicates"}. Deselect them or remove before submitting.`,
      );
      return;
    }

    submitRef.current = true;
    setError(null);
    setSubmitting(true);
    setSubmittedCount(0);
    setSubmitTotal(selectedRows.length);

    let successCount = 0;
    let errorCount = 0;

    for (const row of selectedRows) {
      updateRow(row.id, { status: "submitting", errorMsg: null });

      if (!isValidLinkedInUrl(row.linkedin)) {
        updateRow(row.id, { status: "error", errorMsg: "LinkedIn URL required" });
        errorCount++;
        setSubmittedCount((p) => p + 1);
        continue;
      }

      try {
        const fd = new FormData();
        fd.append("batch_id", batchId);
        fd.append("first_name", row.firstName.trim());
        if (row.lastName.trim()) fd.append("last_name", row.lastName.trim());
        fd.append("email", row.email.trim());
        if (row.phone.trim()) fd.append("phone", row.phone.trim());
        fd.append("linkedin_url", row.linkedin.trim());
        if (row.position.trim()) fd.append("position", row.position.trim());
        if (row.cvText.trim()) fd.append("cv_text", row.cvText);
        fd.append("cv", row.file);

        const res = await fetch("/api/batch-candidate-cv", {
          method: "POST",
          body: fd,
        });
        const json = (await res.json()) as {
          success?: boolean;
          error?: string;
          details?: string;
          source?: DuplicateSource;
        };

        if (res.status === 409 && json.error === "Duplicate") {
          // Server-side duplicate match the parse-phase check missed (e.g. a
          // race where another admin uploaded the same CV moments earlier).
          // Tag the row with the source so the badge updates AFTER submit.
          updateRow(row.id, {
            status: "error",
            errorMsg: json.details ?? "Already exists",
            duplicateSource: json.source ?? null,
          });
          errorCount++;
        } else if (!res.ok || json.error) {
          updateRow(row.id, { status: "error", errorMsg: json.error ?? "Failed" });
          errorCount++;
        } else {
          updateRow(row.id, { status: "done" });
          successCount++;
        }
      } catch (err) {
        updateRow(row.id, {
          status: "error",
          errorMsg: err instanceof Error ? err.message : "Network error",
        });
        errorCount++;
      }
      setSubmittedCount((p) => p + 1);
    }

    submitRef.current = false;
    setSubmitting(false);

    const summary =
      errorCount === 0
        ? `${successCount} candidate${successCount === 1 ? "" : "s"} added to batch`
        : `${successCount} added, ${errorCount} error${errorCount === 1 ? "" : "s"}`;

    if (errorCount === 0) {
      onComplete(summary);
    } else {
      setError(summary);
    }
  }

  // ── Derived for review summary ─────────────────────────────
  const totalRows = rows.length;
  const selectedRows = rows.filter((r) => r.selected).length;
  const invalidLiRows = rows.filter((r) => !isValidLinkedInUrl(r.linkedin)).length;
  const dupRows = rows.filter((r) => r.duplicateSource !== null).length;
  const eligibleRows = rows.filter(
    (r) => isValidLinkedInUrl(r.linkedin) && r.duplicateSource === null,
  );
  const allSelected = eligibleRows.length > 0 && eligibleRows.every((r) => r.selected);

  const modalWidth = stage === "review" ? "max-w-6xl" : "max-w-lg";

  const headerSubtitle = (() => {
    if (stage === "upload") return "Drop up to 50 CV PDFs to add to this batch";
    if (stage === "processing") return `Processing CVs… ${processedCount}/${files.length}`;
    return `${totalRows} CV${totalRows === 1 ? "" : "s"} ready`;
  })();

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-batch-upload-title"
        className={`relative mx-auto my-8 flex w-full ${modalWidth} flex-col rounded-2xl bg-white shadow-2xl`}
      >
        {/* Header */}
        <div className="relative shrink-0 rounded-t-2xl bg-remotiv-purple px-7 py-6 pr-16">
          {!submitting && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-5 flex size-11 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35 sm:size-9 sm:top-6"
            >
              <X className="size-4" strokeWidth={2.5} />
            </button>
          )}
          <p
            id="bulk-batch-upload-title"
            className="font-heading text-xl font-bold text-white"
          >
            Bulk Upload CVs to Batch
          </p>
          <p className="mt-0.5 text-sm text-white/70">{headerSubtitle}</p>
        </div>

        {/* Body */}
        <div className="flex-1 px-4 py-5 sm:px-7 sm:py-6">
          {stage === "upload" ? (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 transition-colors ${
                  dragOver
                    ? "border-remotiv-purple bg-remotiv-purple/5"
                    : "border-gray-200 bg-gray-50 hover:border-remotiv-purple/40"
                }`}
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-remotiv-purple/10">
                  <Upload className="size-5 text-remotiv-purple" strokeWidth={2} />
                </div>
                <p className="font-heading text-sm font-semibold text-gray-800">
                  Drop up to {MAX_BULK} CV PDFs here or click to browse
                </p>
                <p className="text-xs text-gray-400">PDF only · max 5 MB each</p>
                {files.length > 0 && (
                  <p className="mt-2 text-sm font-semibold text-remotiv-purple">
                    {files.length} file{files.length === 1 ? "" : "s"} selected
                  </p>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => addFiles(e.target.files)}
                className="hidden"
              />

              {files.length > 0 && (
                <div className="mt-4 max-h-40 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                  {files.map((f, idx) => (
                    <div key={`${f.name}-${idx}`} className="flex items-center justify-between py-1 text-xs">
                      <span className="truncate text-gray-600">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                        className="ml-2 shrink-0 text-gray-400 hover:text-red-500"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X className="size-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {error && (
                <p className="mt-4 whitespace-pre-line rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={processFiles}
                disabled={files.length === 0}
                className="mt-6 w-full rounded-xl bg-gray-900 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Process CVs
              </button>
            </>
          ) : stage === "processing" ? (
            <div className="flex flex-col items-center justify-center gap-5 py-12">
              <Loader2 className="size-10 animate-spin text-remotiv-purple motion-reduce:animate-none" strokeWidth={2} />
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="font-heading text-sm font-semibold text-gray-800"
              >
                Processing CVs… {processedCount}/{files.length}
              </p>
              <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-remotiv-purple transition-all duration-200"
                  style={{ width: `${(processedCount / Math.max(files.length, 1)) * 100}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Top toolbar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <button
                    type="button"
                    onClick={() => setAllSelected(!allSelected)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <span>{totalRows} total</span>
                </div>
                <button
                  type="button"
                  onClick={() => { setStage("upload"); setRows([]); setError(null); }}
                  disabled={submitting} aria-busy={submitting}
                  className="text-xs font-medium text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-50"
                >
                  ← Back
                </button>
              </div>

              {/* Desktop review table */}
              <div className="hidden max-h-[60vh] overflow-auto rounded-xl border border-gray-100 lg:block">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur">
                    <tr className="border-b border-gray-100">
                      <th className="w-10 px-3 py-3"></th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">CV File</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">First Name</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Last Name</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Email</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Phone</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                        LinkedIn <span className="text-red-500">*</span>
                      </th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Position</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Dup</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Status</th>
                      <th className="w-10 px-3 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-6 py-12 text-center text-sm text-gray-400">
                          No rows
                        </td>
                      </tr>
                    ) : (
                      rows.map((row) => {
                        const liInvalid = !isValidLinkedInUrl(row.linkedin);
                        const isDup = row.duplicateSource !== null;
                        const checkboxDisabled = liInvalid;
                        const checkboxTitle = liInvalid
                          ? "Add a valid LinkedIn URL to enable upload"
                          : isDup
                            ? "Duplicate — server will reject this row"
                            : "";
                        return (
                          <tr
                            key={row.id}
                            className={`border-b border-gray-50 ${isDup ? "bg-amber-50/40" : ""}`}
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={row.selected}
                                disabled={checkboxDisabled}
                                title={checkboxTitle}
                                onChange={(e) => updateRow(row.id, { selected: e.target.checked })}
                                className="size-4 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple disabled:cursor-not-allowed disabled:opacity-40"
                              />
                            </td>
                            <td className="max-w-[180px] px-3 py-2">
                              <p className="truncate text-xs text-gray-600" title={row.filename}>
                                {row.filename}
                              </p>
                            </td>
                            <td className="min-w-[120px] px-3 py-2">
                              <EditableCell
                                value={row.firstName}
                                onChange={(v) => updateRow(row.id, { firstName: v })}
                                placeholder="First name"
                              />
                            </td>
                            <td className="min-w-[120px] px-3 py-2">
                              <EditableCell
                                value={row.lastName}
                                onChange={(v) => updateRow(row.id, { lastName: v })}
                                placeholder="Last name"
                              />
                            </td>
                            <td className="min-w-[200px] px-3 py-2">
                              <EditableCell
                                value={row.email}
                                onChange={(v) => updateRow(row.id, { email: v })}
                                type="email"
                                placeholder="email@example.com"
                              />
                            </td>
                            <td className="min-w-[130px] px-3 py-2">
                              <EditableCell
                                value={row.phone}
                                onChange={(v) => updateRow(row.id, { phone: v })}
                                type="tel"
                                placeholder="+1 555…"
                              />
                            </td>
                            <td className="min-w-[200px] px-3 py-2">
                              <EditableCell
                                value={row.linkedin}
                                onChange={(v) => {
                                  const next: Partial<Row> = { linkedin: v };
                                  if (row.selected && !isValidLinkedInUrl(v)) {
                                    next.selected = false;
                                  }
                                  updateRow(row.id, next);
                                }}
                                type="url"
                                placeholder="https://linkedin.com/in/…"
                              />
                              {liInvalid && (
                                <p className="mt-1 inline-flex items-start gap-1 text-[10px] font-medium leading-tight text-red-500">
                                  <AlertTriangle className="mt-px size-3 shrink-0" strokeWidth={2} />
                                  <span>
                                    {row.linkedin.trim()
                                      ? "Please enter a valid LinkedIn URL"
                                      : "LinkedIn URL missing — add manually"}
                                  </span>
                                </p>
                              )}
                            </td>
                            <td className="min-w-[140px] px-3 py-2">
                              <EditableCell
                                value={row.position}
                                onChange={(v) => updateRow(row.id, { position: v })}
                                placeholder="Position"
                              />
                            </td>
                            <td className="px-3 py-2">
                              {(() => {
                                const b = dupBadge(row.duplicateSource);
                                return (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}
                                    title={row.duplicateName ?? ""}
                                  >
                                    {row.duplicateSource && (
                                      <AlertTriangle className="size-3" strokeWidth={2.5} />
                                    )}
                                    {b.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-3 py-2">
                              {row.status === "ready" && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400">
                                  <Clock className="size-3" strokeWidth={2} /> Ready
                                </span>
                              )}
                              {row.status === "submitting" && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-remotiv-purple">
                                  <Loader2 className="size-3 animate-spin" strokeWidth={2} /> Sending
                                </span>
                              )}
                              {row.status === "done" && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-600">
                                  <CheckCircle className="size-3" strokeWidth={2} /> Done
                                </span>
                              )}
                              {row.status === "error" && (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-medium text-red-500"
                                  title={row.errorMsg ?? ""}
                                >
                                  <X className="size-3" strokeWidth={2.5} /> Error
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => removeRow(row.id)}
                                disabled={submitting} aria-busy={submitting}
                                className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                                aria-label="Remove row"
                              >
                                <X className="size-3.5" strokeWidth={2} />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1 lg:hidden">
                {rows.length === 0 ? (
                  <p className="px-4 py-12 text-center text-sm text-gray-400">No rows</p>
                ) : (
                  rows.map((row) => {
                    const liInvalid = !isValidLinkedInUrl(row.linkedin);
                    const isDup = row.duplicateSource !== null;
                    const badge = dupBadge(row.duplicateSource);
                    return (
                      <div
                        key={row.id}
                        className={`rounded-xl border p-4 ${
                          isDup ? "border-amber-200 bg-amber-50/40" : "border-gray-200 bg-white"
                        }`}
                      >
                        <div className="mb-3 flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            disabled={liInvalid}
                            title={isDup ? "Duplicate — server will reject this row" : ""}
                            onChange={(e) => updateRow(row.id, { selected: e.target.checked })}
                            className="mt-1 size-4 shrink-0 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple disabled:cursor-not-allowed disabled:opacity-40"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                              CV File
                            </p>
                            <p className="truncate text-sm font-medium text-gray-700" title={row.filename}>
                              {row.filename}
                            </p>
                          </div>
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}
                            title={row.duplicateName ?? ""}
                          >
                            {row.duplicateSource && (
                              <AlertTriangle className="size-3" strokeWidth={2.5} />
                            )}
                            {badge.label}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeRow(row.id)}
                            disabled={submitting} aria-busy={submitting}
                            aria-label="Remove row"
                            className="flex size-9 shrink-0 items-center justify-center rounded text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                          >
                            <X className="size-4" strokeWidth={2} />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">First Name</label>
                            <EditableCell value={row.firstName} onChange={(v) => updateRow(row.id, { firstName: v })} placeholder="First name" />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">Last Name</label>
                            <EditableCell value={row.lastName} onChange={(v) => updateRow(row.id, { lastName: v })} placeholder="Last name" />
                          </div>
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">Email</label>
                          <EditableCell value={row.email} onChange={(v) => updateRow(row.id, { email: v })} type="email" placeholder="email@example.com" />
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">Phone</label>
                          <EditableCell value={row.phone} onChange={(v) => updateRow(row.id, { phone: v })} type="tel" placeholder="+1 555…" />
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                            LinkedIn <span className="text-red-500">*</span>
                          </label>
                          <EditableCell
                            value={row.linkedin}
                            onChange={(v) => {
                              const next: Partial<Row> = { linkedin: v };
                              if (row.selected && !isValidLinkedInUrl(v)) {
                                next.selected = false;
                              }
                              updateRow(row.id, next);
                            }}
                            type="url"
                            placeholder="https://linkedin.com/in/…"
                          />
                          {liInvalid && (
                            <p className="mt-1 inline-flex items-start gap-1 text-[10px] font-medium leading-tight text-red-500">
                              <AlertTriangle className="mt-px size-3 shrink-0" strokeWidth={2} />
                              <span>
                                {row.linkedin.trim()
                                  ? "Please enter a valid LinkedIn URL"
                                  : "LinkedIn URL missing — add manually"}
                              </span>
                            </p>
                          )}
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">Position</label>
                          <EditableCell value={row.position} onChange={(v) => updateRow(row.id, { position: v })} placeholder="Position" />
                        </div>

                        {row.status !== "ready" && (
                          <div className="mt-3 flex items-center gap-1.5 border-t border-gray-100 pt-3">
                            {row.status === "submitting" && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-remotiv-purple">
                                <Loader2 className="size-3 animate-spin" strokeWidth={2} /> Sending
                              </span>
                            )}
                            {row.status === "done" && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-600">
                                <CheckCircle className="size-3" strokeWidth={2} /> Done
                              </span>
                            )}
                            {row.status === "error" && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-red-500"
                                title={row.errorMsg ?? ""}
                              >
                                <X className="size-3" strokeWidth={2.5} />
                                {row.errorMsg ?? "Error"}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Bottom bar — sticky and stacks on phones */}
              <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-gray-100 bg-white px-4 pb-2 pt-4 sm:-mx-7 sm:flex-row sm:items-center sm:justify-between sm:px-7">
                <p
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-xs text-gray-500"
                >
                  {submitting ? (
                    <>Uploading {submittedCount}/{submitTotal}…</>
                  ) : (
                    <>
                      {selectedRows} selected
                      {dupRows > 0 && (
                        <span className="text-amber-600">
                          {" "}· {dupRows} duplicate{dupRows === 1 ? "" : "s"} skipped
                        </span>
                      )}
                      {invalidLiRows > 0 && (
                        <span className="text-red-500">
                          {" "}· {invalidLiRows} row{invalidLiRows === 1 ? "" : "s"} blocked — LinkedIn URL required
                        </span>
                      )}
                    </>
                  )}
                </p>

                <button
                  type="button"
                  onClick={submitSelected}
                  disabled={submitting || selectedRows === 0}
                  className="w-full rounded-xl bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto sm:py-2.5"
                >
                  {submitting ? "Uploading…" : `Submit Selected (${selectedRows})`}
                </button>
              </div>

              {error && !submitting && (
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

