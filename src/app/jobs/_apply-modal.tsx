"use client";

import { CheckCircle, Upload, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import type { Job } from "@/lib/jobs";
import { cn } from "@/lib/utils";

// Server cap is 5 MB; align the client so the UX rejects what the API would
// reject anyway. See MAX_CV_FILE_BYTES in src/app/api/apply/route.ts.
const MAX_CV_CLIENT_BYTES = 5 * 1024 * 1024;

const EMPTY_APPLY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
};

/**
 * Extract plain text from a PDF in the browser via PDF.js. Mirrors the helper
 * used by the admin bulk-upload modal. Worker is bundled from node_modules so
 * we avoid CDN fetches at runtime.
 *
 * PDF.js is a heavy dependency (~600 KB); colocated here so it only loads
 * when this modal does (dynamic-imported by the jobs client island).
 */
async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
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

export default function ApplyModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [form, setForm] = useState(EMPTY_APPLY);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Bridge token returned by /api/apply on successful submission. Drives
  // (1) the "Complete your profile" CTA in the success modal and (2) the
  // auto-close skip — we don't want the modal to vanish before the
  // candidate can click the CTA.
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  // Same-job duplicate now returns { error: "duplicate_application", appliedAt }.
  // Storing the timestamp lets the friendly screen tell the candidate when
  // their existing application landed.
  const [duplicateMsg, setDuplicateMsg] = useState<{
    appliedAt: string | null;
  } | null>(null);
  // Entry fade — backdrop + panel transition in over 150ms after first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  // Focus trap + focus-restore. The hook (src/hooks/use-focus-trap.ts) moves
  // initial focus into the modal on mount, cycles Tab/Shift+Tab within it,
  // and restores focus to the previously-focused element (the "Apply now"
  // button in JobDetail) on unmount. Mirrors PricingModal's wiring exactly.
  // Modal mounts only when the parent passes a non-null job, so `active` is
  // simply true while the component lives.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  // Auto-close after success — but only when we have nothing more to offer.
  // When a bridge token is present, the success modal renders the
  // "Complete your profile" CTA; killing the modal after 3s would yank it
  // out from under the user mid-click.
  useEffect(() => {
    if (!success || bridgeToken) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [success, bridgeToken, onClose]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function setField(key: keyof typeof EMPTY_APPLY, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setCvError(null);
    if (!file) { setCvFile(null); return; }
    if (file.type !== "application/pdf") {
      setCvError("Only PDF files are accepted.");
      setCvFile(null);
      return;
    }
    if (file.size > MAX_CV_CLIENT_BYTES) {
      setCvError("File must be under 5 MB.");
      setCvFile(null);
      return;
    }
    setCvFile(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cvFile) { setCvError("Please upload your CV (PDF)."); return; }

    setSubmitting(true);
    setSubmitError(null);

    try {
      // Extract CV text in the browser — PDF.js works flawlessly here, so the
      // server doesn't need to parse PDFs at all.
      let cvText = "";
      try {
        cvText = await extractPdfText(cvFile);
      } catch {
        // silent — the application still submits without searchable text
      }

      const fd = new FormData();
      fd.append("job_id",       job.id);
      fd.append("first_name",   form.firstName);
      fd.append("last_name",    form.lastName);
      fd.append("email",        form.email);
      fd.append("phone",        form.phone);
      fd.append("linkedin_url", form.linkedin);
      fd.append("cv",           cvFile);
      if (cvText.trim()) fd.append("cv_text", cvText);

      const res = await fetch("/api/apply", { method: "POST", body: fd });

      if (res.status === 409) {
        // The server now distinguishes same-job duplicates with a
        // structured shape. Older "duplicate" responses (no appliedAt)
        // still flow through the same friendly screen — appliedAt is
        // optional in the display.
        const dupJson = (await res.json().catch(() => ({}))) as {
          error?: string;
          appliedAt?: string | null;
        };
        setDuplicateMsg({ appliedAt: dupJson.appliedAt ?? null });
        return;
      }

      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        applicationId?: string;
        bridgeToken?: string | null;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? "Submission failed.");

      if (typeof json.bridgeToken === "string" && json.bridgeToken.length === 64) {
        setBridgeToken(json.bridgeToken);
      }
      setSuccess(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  const INPUT_CLS =
    "w-full rounded-xl border border-black/10 bg-[#FAFAFA] px-4 py-3.5 text-base sm:text-[0.88rem] text-remotiv-text-dark outline-none transition-all placeholder:text-[#bbb] focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/15";
  const LABEL_CLS =
    "mb-1.5 block text-[0.72rem] font-semibold uppercase tracking-widest text-[#6b6b6b]";

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4"
      style={{ opacity: mounted ? 1 : 0, transition: "opacity 150ms ease-out" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-modal-title"
    >
      <div
        ref={modalRef}
        className="relative mx-auto mb-6 mt-20 flex w-full max-w-lg flex-col rounded-[20px] bg-white shadow-2xl sm:my-16"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? "scale(1)" : "scale(0.97)",
          transition: "opacity 150ms ease-out, transform 150ms ease-out",
        }}
      >
        {/* Header — sticky, never scrolls away */}
        <div className="relative shrink-0 rounded-t-[20px] bg-remotiv-purple px-5 py-6 pr-14 sm:px-7 sm:py-8 sm:pr-16">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-6 flex size-11 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2 id="apply-modal-title" className="mb-1 font-heading text-xl font-bold leading-tight text-white">
            {job.title}
          </h2>
          <p className="text-sm text-white/65">{job.company}</p>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto rounded-b-[20px]">
          {duplicateMsg ? (
            <div className="flex flex-col items-center gap-6 px-6 py-8 text-center sm:px-8 sm:py-10">
              <div className="flex size-20 items-center justify-center rounded-full bg-remotiv-purple/10">
                <CheckCircle className="size-10 text-remotiv-purple" strokeWidth={1.5} />
              </div>

              <div>
                <h3 className="font-heading text-xl font-bold text-remotiv-text-dark">
                  You&apos;ve already applied to this job
                </h3>
                <p className="mt-3 text-[0.9rem] leading-relaxed text-[#666]">
                  {duplicateMsg.appliedAt ? (
                    <>
                      We received your application on{" "}
                      <strong>
                        {new Date(duplicateMsg.appliedAt).toLocaleDateString(
                          undefined,
                          { year: "numeric", month: "long", day: "numeric" },
                        )}
                      </strong>
                      . We&apos;re reviewing it and will be in touch soon.
                    </>
                  ) : (
                    <>We&apos;re reviewing your application and will be in touch soon.</>
                  )}
                </p>
              </div>

              <div className="flex w-full flex-col gap-3">
                <Link
                  href="/jobs"
                  className="inline-flex w-full items-center justify-center rounded-xl bg-remotiv-purple px-4 py-3 text-sm font-bold text-white transition hover:opacity-90"
                  onClick={onClose}
                >
                  Browse other jobs →
                </Link>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Close
                </button>
              </div>
            </div>
          ) : success ? (
            <div role="status" className="flex flex-col items-center justify-center gap-4 px-7 py-16 text-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-remotiv-green/15">
                <CheckCircle className="size-8 text-remotiv-green" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-remotiv-text-dark">Application Submitted!</h3>
              {bridgeToken ? (
                <>
                  <p className="text-[0.88rem] leading-relaxed text-remotiv-text-light">
                    Take 2 minutes to complete your talent profile and be visible
                    to every Remotiv employer.
                  </p>
                  <div className="mt-2 flex w-full flex-col gap-3 px-2">
                    <Link
                      href={`/become-a-talent?token=${bridgeToken}`}
                      className="inline-flex items-center justify-center rounded-xl bg-remotiv-purple px-4 py-3 text-sm font-bold text-white transition hover:opacity-90"
                    >
                      Complete your profile for more opportunities →
                    </Link>
                    <button
                      type="button"
                      onClick={onClose}
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-[0.88rem] leading-relaxed text-remotiv-text-light">
                  We&apos;ll be in touch soon. This window will close automatically.
                </p>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="px-5 py-5 sm:px-7 sm:py-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="apply-firstName" className={LABEL_CLS}>
                    First Name<span aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="apply-firstName"
                    required
                    type="text"
                    placeholder="Jane"
                    value={form.firstName}
                    onChange={(e) => setField("firstName", e.target.value)}
                    className={INPUT_CLS}
                  />
                </div>
                <div>
                  <label htmlFor="apply-lastName" className={LABEL_CLS}>
                    Last Name<span aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="apply-lastName"
                    required
                    type="text"
                    placeholder="Smith"
                    value={form.lastName}
                    onChange={(e) => setField("lastName", e.target.value)}
                    className={INPUT_CLS}
                  />
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor="apply-email" className={LABEL_CLS}>
                  Email<span aria-hidden="true"> *</span>
                </label>
                <input
                  id="apply-email"
                  required
                  type="email"
                  placeholder="jane@example.com"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label htmlFor="apply-phone" className={LABEL_CLS}>
                  Phone Number<span aria-hidden="true"> *</span>
                </label>
                <input
                  id="apply-phone"
                  required
                  type="tel"
                  placeholder="+1 555 000 0000"
                  value={form.phone}
                  onChange={(e) => setField("phone", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label htmlFor="apply-linkedin" className={LABEL_CLS}>
                  LinkedIn URL<span aria-hidden="true"> *</span>
                </label>
                <input
                  id="apply-linkedin"
                  required
                  type="url"
                  placeholder="https://linkedin.com/in/yourname"
                  value={form.linkedin}
                  onChange={(e) => setField("linkedin", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label
                  htmlFor="apply-cv"
                  id="apply-cv-label"
                  className={LABEL_CLS}
                >
                  CV / Resume (PDF, max 5 MB)<span aria-hidden="true"> *</span>
                </label>
                <button
                  type="button"
                  aria-labelledby="apply-cv-label"
                  onClick={() => fileRef.current?.click()}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3.5 text-left transition-colors",
                    cvFile
                      ? "border-remotiv-green/40 bg-remotiv-green/5"
                      : "border-black/10 bg-[#FAFAFA] hover:border-remotiv-purple/30",
                  )}
                >
                  <Upload
                    className={cn("size-4 shrink-0", cvFile ? "text-remotiv-green" : "text-[#aaa]")}
                    strokeWidth={2}
                  />
                  <span
                    className={cn(
                      "truncate text-[0.85rem]",
                      cvFile ? "font-medium text-remotiv-text-dark" : "text-[#bbb]",
                    )}
                  >
                    {cvFile ? cvFile.name : "Click to upload your CV…"}
                  </span>
                </button>
                <input
                  id="apply-cv"
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {cvError && (
                  <p role="alert" className="mt-1.5 text-[0.78rem] text-red-500">{cvError}</p>
                )}
              </div>

              {submitError && (
                <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-[0.82rem] text-red-600">
                  {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 w-full rounded-xl bg-[#111] py-4 font-heading text-[0.82rem] font-bold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Submit Application"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
