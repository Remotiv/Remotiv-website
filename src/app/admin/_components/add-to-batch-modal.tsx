"use client";

import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import {
  addCandidateToBatch,
  createBatch,
  fetchActiveClients,
  fetchBatches,
  type ActiveClient,
  type BatchCandidateInput,
  type ClientBatch,
} from "@/app/admin/client-batches/actions";

const INPUT_CLS =
  "w-full h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

const LABEL_CLS = "mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500";

export type AddToBatchSnapshot = BatchCandidateInput;

export function AddToBatchModal({
  candidate,
  onClose,
  onToast,
}: {
  candidate: AddToBatchSnapshot & { full_name: string };
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [step, setStep] = useState<"client" | "batch" | "confirm">("client");

  const [clients, setClients] = useState<ActiveClient[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);

  const [clientId, setClientId] = useState("");
  const [batches, setBatches] = useState<ClientBatch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);

  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [showCreateBatch, setShowCreateBatch] = useState(false);
  const [newBatchName, setNewBatchName] = useState("");
  const [newPositionTitle, setNewPositionTitle] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchActiveClients()
      .then((cs) => { if (!cancelled) { setClients(cs); setLoadingClients(false); } })
      .catch(() => { if (!cancelled) setLoadingClients(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  async function handleSelectClient() {
    if (!clientId) {
      setError("Select a client first.");
      return;
    }
    setError(null);
    setLoadingBatches(true);
    try {
      const list = await fetchBatches(clientId);
      setBatches(list);
    } finally {
      setLoadingBatches(false);
    }
    setStep("batch");
  }

  async function handleConfirm() {
    setError(null);
    let targetBatchId = selectedBatchId;

    if (showCreateBatch) {
      if (!newBatchName.trim() || !newPositionTitle.trim()) {
        setError("Batch name and position are required.");
        return;
      }
      setSubmitting(true);
      const created = await createBatch({
        client_id: clientId,
        batch_name: newBatchName.trim(),
        position_title: newPositionTitle.trim(),
      });
      if (!created.success) {
        setSubmitting(false);
        setError(created.error);
        return;
      }
      targetBatchId = created.data.id;
    }

    if (!targetBatchId) {
      setError("Select an existing batch or create a new one.");
      return;
    }

    setSubmitting(true);
    const result = await addCandidateToBatch(targetBatchId, {
      source_type: candidate.source_type,
      source_id: candidate.source_id,
      first_name: candidate.first_name,
      last_name: candidate.last_name,
      email: candidate.email,
      phone: candidate.phone ?? null,
      linkedin_url: candidate.linkedin_url ?? null,
      cv_url: candidate.cv_url ?? null,
      location: candidate.location ?? null,
      university: candidate.university ?? null,
      position_applied: candidate.position_applied ?? null,
      total_experience: candidate.total_experience ?? null,
      current_role: candidate.current_role ?? null,
      current_company: candidate.current_company ?? null,
      current_salary: candidate.current_salary ?? null,
      salary_expectations: candidate.salary_expectations ?? null,
      notice_period: candidate.notice_period ?? null,
    });
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    // Duplicate-prevention removed — same candidate may now appear in a batch
    // any number of times.

    const batchName = showCreateBatch
      ? newBatchName.trim()
      : batches.find((b) => b.id === targetBatchId)?.batch_name ?? "batch";
    onToast(`Candidate added to batch ${batchName}`);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={() => !submitting && onClose()}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div role="dialog" aria-modal="true" className="relative my-4 flex w-full max-w-[520px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="relative shrink-0 border-b border-gray-100 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2 className="font-heading text-lg font-bold text-gray-900">Add to Client Batch</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {candidate.full_name} · {candidate.source_type === "application" ? "Job application" : "Talent profile"}
          </p>
          <div className="mt-3 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            <span className={step === "client" ? "text-[#7E47FF]" : ""}>1. Client</span>
            <span>›</span>
            <span className={step === "batch" ? "text-[#7E47FF]" : ""}>2. Batch</span>
            <span>›</span>
            <span className={step === "confirm" ? "text-[#7E47FF]" : ""}>3. Confirm</span>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          {step === "client" && (
            <div>
              <span className={LABEL_CLS}>Client</span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className={INPUT_CLS}
                disabled={loadingClients}
              >
                <option value="">{loadingClients ? "Loading…" : "Select client…"}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.company_name}</option>
                ))}
              </select>
              {!loadingClients && clients.length === 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  No active clients. Create one in <span className="font-semibold">Clients</span> first.
                </p>
              )}
            </div>
          )}

          {step === "batch" && (
            <>
              <div className="flex items-center justify-between">
                <span className={`${LABEL_CLS} mb-0`}>Batch</span>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateBatch((v) => !v);
                    setSelectedBatchId("");
                  }}
                  className="text-[11px] font-semibold text-[#7E47FF] hover:underline"
                >
                  {showCreateBatch ? "← Pick existing" : "+ Create New Batch"}
                </button>
              </div>

              {showCreateBatch ? (
                <div className="flex flex-col gap-3 rounded-xl bg-gray-50 p-4">
                  <div>
                    <span className={LABEL_CLS}>Batch Name</span>
                    <input
                      type="text"
                      value={newBatchName}
                      onChange={(e) => setNewBatchName(e.target.value)}
                      placeholder="e.g. Software Engineer Batch #1"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div>
                    <span className={LABEL_CLS}>Position Title</span>
                    <input
                      type="text"
                      value={newPositionTitle}
                      onChange={(e) => setNewPositionTitle(e.target.value)}
                      placeholder="e.g. Full Stack Developer"
                      className={INPUT_CLS}
                    />
                  </div>
                </div>
              ) : loadingBatches ? (
                <p className="py-6 text-center text-xs text-gray-400">Loading batches…</p>
              ) : batches.length === 0 ? (
                <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                  No batches for this client yet. Click &quot;Create New Batch&quot;.
                </p>
              ) : (
                <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto">
                  {batches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setSelectedBatchId(b.id)}
                      className={`flex flex-col items-start gap-0.5 rounded-xl border px-4 py-3 text-left transition-colors ${
                        selectedBatchId === b.id
                          ? "border-[#7E47FF] bg-[#7E47FF]/5"
                          : "border-gray-200 bg-white hover:border-[#7E47FF]/30"
                      }`}
                    >
                      <span className="text-sm font-semibold text-gray-800">{b.batch_name}</span>
                      <span className="text-[11px] text-gray-500">
                        {b.position_title} · {b.candidate_count} {b.candidate_count === 1 ? "candidate" : "candidates"} · {b.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {step === "confirm" && (
            <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-4 text-sm">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Snapshot preview
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
                <ConfirmKv label="Name" value={candidate.full_name} />
                <ConfirmKv label="Email" value={candidate.email} />
                <ConfirmKv label="Phone" value={candidate.phone ?? "—"} />
                <ConfirmKv label="LinkedIn" value={candidate.linkedin_url ? "✓ Provided" : "—"} />
                <ConfirmKv label="CV" value={candidate.cv_url ? "✓ Provided" : "—"} />
                <ConfirmKv label="Position" value={candidate.position_applied ?? "—"} />
                <ConfirmKv label="Location" value={candidate.location ?? "—"} />
                <ConfirmKv label="Source" value={candidate.source_type === "application" ? "Job application" : "Talent profile"} />
              </div>
              <p className="mt-3 text-[11px] text-gray-500">
                This row will be inserted into <strong className="text-gray-800">{
                  showCreateBatch
                    ? newBatchName || "(new batch)"
                    : batches.find((b) => b.id === selectedBatchId)?.batch_name ?? "(unselected)"
                }</strong> with stage <strong className="text-gray-800">&quot;-&quot;</strong>.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={() => {
              if (step === "confirm") setStep("batch");
              else if (step === "batch") setStep("client");
              else onClose();
            }}
            disabled={submitting}
            className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {step === "client" ? "Cancel" : "Back"}
          </button>
          {step === "client" && (
            <button
              type="button"
              onClick={handleSelectClient}
              disabled={!clientId || loadingClients}
              className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              Next
            </button>
          )}
          {step === "batch" && (
            <button
              type="button"
              onClick={() => {
                if (!showCreateBatch && !selectedBatchId) {
                  setError("Select a batch or create a new one.");
                  return;
                }
                if (showCreateBatch && (!newBatchName.trim() || !newPositionTitle.trim())) {
                  setError("Batch name and position are required.");
                  return;
                }
                setError(null);
                setStep("confirm");
              }}
              className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              Next
            </button>
          )}
          {step === "confirm" && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="flex items-center gap-2 rounded-xl bg-[#49D7A7] px-5 py-2.5 text-sm font-semibold text-[#1a4f3a] hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Plus className="size-4" strokeWidth={2.5} />
                  Adding…
                </>
              ) : (
                <>
                  <Check className="size-4" strokeWidth={2.5} />
                  Confirm
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmKv({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-gray-400">{label}</span>
      <span className="break-all">{value}</span>
    </>
  );
}
