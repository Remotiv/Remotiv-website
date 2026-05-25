"use client";

import { CheckCircle, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/jobs";
import { cn } from "@/lib/utils";

// Constants previously colocated in _jobs-client.tsx but only ever used by
// this modal — moved here so the parent doesn't pull them (and the strings)
// into its bundle.

const CONTACT_EMAIL = "talent@remotiv.work";
const LINKEDIN_URL = "https://www.linkedin.com/company/remotiv-inc/";

// Server cap is 10 MB; align the client so the UX rejects what the API would
// reject anyway. See MAX_CV_FILE_BYTES in src/app/api/apply/route.ts.
const MAX_CV_CLIENT_BYTES = 10 * 1024 * 1024;

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
  const [duplicateMsg, setDuplicateMsg] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-close after success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [success, onClose]);

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
      setCvError("File must be under 10 MB.");
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
        setDuplicateMsg(true);
        return;
      }

      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Submission failed.");

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
    "mb-1.5 block text-[0.72rem] font-semibold uppercase tracking-widest text-[#888]";

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-modal-title"
    >
      <div className="relative mx-auto mb-6 mt-20 flex w-full max-w-lg flex-col rounded-[20px] bg-white shadow-2xl sm:my-16">
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
          <p id="apply-modal-title" className="mb-1 font-heading text-xl font-bold leading-tight text-white">
            {job.title}
          </p>
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
                  You&apos;re already in our talent pool! 🎉
                </h3>
                <p className="mt-3 text-[0.9rem] leading-relaxed text-[#666]">
                  It looks like your profile and CV are already with us. Our team
                  reviews every application carefully and will reach out when the
                  right opportunity comes along.
                </p>
              </div>

              <div className="w-full rounded-2xl bg-remotiv-bg px-6 py-5 text-left">
                <p className="mb-3 text-[0.8rem] font-semibold uppercase tracking-widest text-[#999]">
                  Want to apply for a specific role or update your details?
                </p>
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="flex items-center gap-2 text-[0.9rem] font-medium text-remotiv-purple hover:underline"
                >
                  📧 {CONTACT_EMAIL}
                </a>
                <a
                  href={LINKEDIN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 flex items-center gap-2 text-[0.9rem] font-medium text-remotiv-purple hover:underline"
                >
                  🔗 linkedin.com/company/remotiv-inc
                </a>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full min-h-11 rounded-xl bg-[#111] py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[#333]"
              >
                Got it
              </button>
            </div>
          ) : success ? (
            <div className="flex flex-col items-center justify-center gap-4 px-7 py-16 text-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-remotiv-green/15">
                <CheckCircle className="size-8 text-remotiv-green" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-remotiv-text-dark">Application Submitted!</h3>
              <p className="text-[0.88rem] leading-relaxed text-remotiv-text-light">
                We&apos;ll be in touch soon. This window will close automatically.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="px-5 py-5 sm:px-7 sm:py-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLS}>First Name</label>
                  <input
                    required
                    type="text"
                    placeholder="Jane"
                    value={form.firstName}
                    onChange={(e) => setField("firstName", e.target.value)}
                    className={INPUT_CLS}
                  />
                </div>
                <div>
                  <label className={LABEL_CLS}>Last Name</label>
                  <input
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
                <label className={LABEL_CLS}>Email</label>
                <input
                  required
                  type="email"
                  placeholder="jane@example.com"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS}>Phone Number</label>
                <input
                  required
                  type="tel"
                  placeholder="+1 555 000 0000"
                  value={form.phone}
                  onChange={(e) => setField("phone", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS}>LinkedIn URL</label>
                <input
                  required
                  type="url"
                  placeholder="https://linkedin.com/in/yourname"
                  value={form.linkedin}
                  onChange={(e) => setField("linkedin", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS}>CV / Resume (PDF, max 10 MB)</label>
                <button
                  type="button"
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
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {cvError && (
                  <p className="mt-1.5 text-[0.78rem] text-red-500">{cvError}</p>
                )}
              </div>

              {submitError && (
                <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-[0.82rem] text-red-600">
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
