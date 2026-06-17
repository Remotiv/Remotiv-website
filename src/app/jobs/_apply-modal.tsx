"use client";

import { CheckCircle, Upload, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import type { Job } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import {
  AVAILABILITY_OPTIONS,
  COUNTRIES,
  ExperienceList,
  Field,
  INPUT_CLS,
  LABEL_CLS,
  NOTICE_PERIOD_OPTIONS,
  PillGroup,
  ROLE_CATEGORIES,
  SkillTags,
  WORK_LOCATION_OPTIONS,
  WORK_TYPE_OPTIONS,
  type WorkExperience,
  makeEmptyExperience,
} from "./_apply-wizard-fields";

// Server cap is 5 MB; align the client so the UX rejects what the API would
// reject anyway. See MAX_CV_FILE_BYTES in src/app/api/apply/route.ts.
const MAX_CV_CLIENT_BYTES = 5 * 1024 * 1024;
const SUMMARY_MAX = 2000;

const EMPTY_APPLY = {
  // Step 1 — contact
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
  // Step 2 — professional
  applicantJobTitle: "",
  roleCategory: "",
  yearsExperience: "",
  summary: "",
  // Step 3 — education
  degree: "",
  institution: "",
  // Step 4 — preferences
  city: "",
  country: "",
  availability: "",
  workType: "",
  noticePeriod: "",
  workLocation: "",
};

type Step = 1 | 2 | 3 | 4;
const STEP_LABELS: Record<Step, string> = {
  1: "Contact",
  2: "Professional",
  3: "Education & experience",
  4: "Preferences",
};

const TEXTAREA_CLS =
  "w-full rounded-xl border border-black/10 bg-[#FAFAFA] px-4 py-3 text-base sm:text-[0.88rem] text-remotiv-text-dark outline-none transition-all placeholder:text-[#bbb] focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/15";

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
  const [skills, setSkills] = useState<string[]>([]);
  const [experiences, setExperiences] = useState<WorkExperience[]>(() => [
    makeEmptyExperience(),
  ]);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [stepError, setStepError] = useState<string | null>(null);
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
  // Entry fade is done via CSS keyframes (see globals.css) rather than a
  // state-driven inline transition — a state + rAF flip leaves the modal
  // fully transparent for its first painted frame, which was visible as a
  // blink when the dynamic-import loading fallback handed off to it.
  const fileRef = useRef<HTMLInputElement>(null);
  // Focus trap + focus-restore. The hook (src/hooks/use-focus-trap.ts) moves
  // initial focus into the modal on mount, cycles Tab/Shift+Tab within it,
  // and restores focus to the previously-focused element (the "Apply now"
  // button in JobDetail) on unmount. Mirrors PricingModal's wiring exactly.
  // Modal mounts only when the parent passes a non-null job, so `active` is
  // simply true while the component lives.
  const modalRef = useRef<HTMLDivElement>(null);
  // Per-step body wrapper — used to find the first focusable input on step
  // change without disturbing the modal-level focus trap.
  const stepBodyRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  // ── Dirty tracking ─────────────────────────────────────────
  // Used by attemptClose to confirm before discarding partial input.
  // Captured in a ref so the mount-only Escape listener always reads the
  // latest value without re-binding.
  const isDirty = useMemo(() => {
    if (cvFile) return true;
    if (skills.length > 0) return true;
    if (
      experiences.some(
        (e) =>
          e.title.trim() ||
          e.company.trim() ||
          e.start.trim() ||
          e.end.trim() ||
          e.description.trim() ||
          e.skills.trim(),
      )
    ) {
      return true;
    }
    return Object.values(form).some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
  }, [form, skills, experiences, cvFile]);

  const attemptCloseRef = useRef<() => void>(() => {
    onClose();
  });
  attemptCloseRef.current = () => {
    if (!isDirty || success || duplicateMsg) {
      onClose();
      return;
    }
    if (window.confirm("Discard your application? Any data you entered will be lost.")) {
      onClose();
    }
  };

  function attemptClose() {
    attemptCloseRef.current();
  }

  // Auto-close after success — but only when we have nothing more to offer.
  // When a bridge token is present, the success modal renders the
  // "Complete your profile" CTA; killing the modal after 3s would yank it
  // out from under the user mid-click.
  useEffect(() => {
    if (!success || bridgeToken) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [success, bridgeToken, onClose]);

  // Close on Escape — routes through attemptClose so an in-progress wizard
  // gets a confirm prompt before discarding state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") attemptCloseRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Move focus into the new step's first input after a Next/Back transition.
  useEffect(() => {
    const root = stepBodyRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(
      "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), button[role='radio']",
    );
    el?.focus({ preventScroll: true });
  }, [step]);

  function setField<K extends keyof typeof EMPTY_APPLY>(key: K, value: string) {
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

  // ── Per-step validation ────────────────────────────────────
  function validateStep(s: 1 | 2 | 3 | 4): string | null {
    if (s === 1) {
      if (!form.firstName.trim()) return "First name is required.";
      if (!form.lastName.trim()) return "Last name is required.";
      if (!form.email.trim()) return "Email is required.";
      if (!form.phone.trim()) return "Phone number is required.";
      if (!form.linkedin.trim()) return "LinkedIn URL is required.";
      if (!cvFile) {
        setCvError("Please upload your CV (PDF).");
        return "CV is required.";
      }
      return null;
    }
    if (s === 2) {
      if (!form.applicantJobTitle.trim()) return "Job title is required.";
      if (!form.roleCategory.trim()) return "Role category is required.";
      const yrs = Number.parseInt(form.yearsExperience, 10);
      if (!Number.isFinite(yrs) || yrs < 0) {
        return "Years of experience must be 0 or greater.";
      }
      return null;
    }
    if (s === 3) {
      if (!form.degree.trim()) return "Degree is required.";
      if (!form.institution.trim()) return "Institution is required.";
      const hasValid = experiences.some(
        (e) => e.title.trim() && e.company.trim(),
      );
      if (!hasValid) {
        return "Add at least one job with both title and company filled.";
      }
      return null;
    }
    // step 4
    if (!form.city.trim()) return "City is required.";
    if (!form.country.trim()) return "Country is required.";
    if (!form.availability.trim()) return "Please pick your availability.";
    if (!form.workType.trim()) return "Please pick a work type.";
    if (!form.noticePeriod.trim()) return "Please pick a notice period.";
    if (!form.workLocation.trim()) return "Please pick a work location.";
    return null;
  }

  function goNext() {
    const err = validateStep(step);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    if (step < 4) setStep((step + 1) as Step);
  }

  function goBack() {
    setStepError(null);
    setCvError(null);
    if (step > 1) setStep((step - 1) as Step);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Defence: only step 4 can submit. Earlier-step "Next" buttons are
    // type="button" so they shouldn't reach this — this guard is belt and
    // braces in case a browser fires submit on Enter mid-wizard.
    if (step !== 4) {
      goNext();
      return;
    }
    const err = validateStep(4);
    if (err) {
      setStepError(err);
      return;
    }
    if (!cvFile) {
      setCvError("Please upload your CV (PDF).");
      setStep(1);
      setStepError("CV is required.");
      return;
    }

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

      // New wizard fields. The /api/apply route ignores unknown fields today;
      // this payload becomes load-bearing in the next phase.
      fd.append("applicant_job_title", form.applicantJobTitle);
      fd.append("role_category",       form.roleCategory);
      fd.append("years_experience",    form.yearsExperience);
      fd.append("degree",              form.degree);
      fd.append("institution",         form.institution);
      fd.append("city",                form.city);
      fd.append("country",             form.country);
      fd.append("availability",        form.availability);
      fd.append("work_type",           form.workType);
      fd.append("notice_period",       form.noticePeriod);
      fd.append("work_location",       form.workLocation);
      fd.append("summary",             form.summary);
      fd.append("skills",              JSON.stringify(skills));

      // Mirrors /become-a-talent/page.tsx:797-810 — drop empty rows, split
      // the comma-separated per-row skills into an array, swap end="Present"
      // for the "I currently work here" flag.
      const experiencePayload = experiences
        .filter((ex) => ex.title.trim() || ex.company.trim())
        .map((ex) => ({
          title: ex.title.trim(),
          company: ex.company.trim(),
          start: ex.start.trim(),
          end: ex.currentlyWorking ? "Present" : ex.end.trim(),
          description: ex.description.trim(),
          skills: ex.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }));
      fd.append("employment_history", JSON.stringify(experiencePayload));

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

  return (
    <div
      className="apply-modal-backdrop-anim fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-modal-title"
    >
      <div
        ref={modalRef}
        className="apply-modal-panel-anim relative mx-auto mb-6 mt-20 flex w-full max-w-lg flex-col rounded-[20px] bg-white shadow-2xl sm:my-16 sm:max-w-2xl"
      >
        {/* Header — sticky, never scrolls away */}
        <div className="relative shrink-0 rounded-t-[20px] bg-remotiv-purple px-5 py-6 pr-14 sm:px-7 sm:py-8 sm:pr-16">
          <button
            type="button"
            onClick={attemptClose}
            aria-label="Close"
            className="absolute right-4 top-6 flex size-11 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2 id="apply-modal-title" className="mb-1 font-heading text-xl font-bold leading-tight text-white">
            {job.title}
          </h2>
          <p className="text-sm text-white/65">{job.company}</p>
          {!duplicateMsg && !success && (
            <div className="mt-3.5 flex items-center gap-3">
              <div
                className="flex flex-1 items-center gap-1.5"
                aria-label={`Step ${step} of 4: ${STEP_LABELS[step]}`}
              >
                {([1, 2, 3, 4] as Step[]).map((n) => (
                  <span
                    key={n}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      step >= n ? "bg-white" : "bg-white/30",
                    )}
                  />
                ))}
              </div>
              <p className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-white/75">
                Step {step} / 4
              </p>
            </div>
          )}
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
              <div ref={stepBodyRef}>
                {step === 1 && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="First Name" required htmlFor="apply-firstName">
                        <input
                          id="apply-firstName"
                          type="text"
                          placeholder="Jane"
                          value={form.firstName}
                          onChange={(e) => setField("firstName", e.target.value)}
                          className={INPUT_CLS}
                          maxLength={100}
                        />
                      </Field>
                      <Field label="Last Name" required htmlFor="apply-lastName">
                        <input
                          id="apply-lastName"
                          type="text"
                          placeholder="Smith"
                          value={form.lastName}
                          onChange={(e) => setField("lastName", e.target.value)}
                          className={INPUT_CLS}
                          maxLength={100}
                        />
                      </Field>
                    </div>

                    <Field label="Email" required htmlFor="apply-email">
                      <input
                        id="apply-email"
                        type="email"
                        placeholder="jane@example.com"
                        value={form.email}
                        onChange={(e) => setField("email", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </Field>

                    <Field label="Phone Number" required htmlFor="apply-phone">
                      <input
                        id="apply-phone"
                        type="tel"
                        placeholder="+1 555 000 0000"
                        value={form.phone}
                        onChange={(e) => setField("phone", e.target.value)}
                        className={INPUT_CLS}
                        maxLength={50}
                      />
                    </Field>

                    <Field label="LinkedIn URL" required htmlFor="apply-linkedin">
                      <input
                        id="apply-linkedin"
                        type="url"
                        placeholder="https://linkedin.com/in/yourname"
                        value={form.linkedin}
                        onChange={(e) => setField("linkedin", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </Field>

                    <div>
                      <label
                        htmlFor="apply-cv"
                        id="apply-cv-label"
                        className={LABEL_CLS}
                      >
                        CV / Resume (PDF, max 5 MB)
                        <span aria-hidden="true" className="text-remotiv-purple">
                          {" *"}
                        </span>
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
                  </div>
                )}

                {step === 2 && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field
                        label="Job Title / Role"
                        required
                        htmlFor="apply-applicantJobTitle"
                        hint="Your usual professional title — may differ from the role you're applying for."
                      >
                        <input
                          id="apply-applicantJobTitle"
                          type="text"
                          placeholder="e.g. Senior Frontend Engineer"
                          value={form.applicantJobTitle}
                          onChange={(e) =>
                            setField("applicantJobTitle", e.target.value)
                          }
                          className={INPUT_CLS}
                          maxLength={200}
                        />
                      </Field>
                      <Field label="Role Category" required htmlFor="apply-roleCategory">
                        <select
                          id="apply-roleCategory"
                          value={form.roleCategory}
                          onChange={(e) => setField("roleCategory", e.target.value)}
                          className={INPUT_CLS}
                        >
                          <option value="" disabled>
                            Select category…
                          </option>
                          {ROLE_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>

                    <Field
                      label="Years of Experience"
                      required
                      htmlFor="apply-yearsExperience"
                    >
                      <input
                        id="apply-yearsExperience"
                        type="number"
                        min={0}
                        step={1}
                        placeholder="e.g. 5"
                        value={form.yearsExperience}
                        onChange={(e) =>
                          setField("yearsExperience", e.target.value)
                        }
                        className={INPUT_CLS}
                      />
                    </Field>

                    <Field label="Skills" optional htmlFor="apply-skills" hint="Press Enter or comma to add. Up to 30 tags.">
                      <SkillTags value={skills} onChange={setSkills} />
                    </Field>

                    <Field label="Professional Summary" optional htmlFor="apply-summary">
                      <textarea
                        id="apply-summary"
                        rows={4}
                        placeholder="Short bio — your experience, what you specialise in, and what you're looking for."
                        value={form.summary}
                        onChange={(e) => setField("summary", e.target.value)}
                        className={TEXTAREA_CLS}
                        maxLength={SUMMARY_MAX}
                      />
                      {form.summary.length > 0 && (
                        <p
                          aria-live="polite"
                          className={cn(
                            "mt-1 text-right text-[0.65rem]",
                            form.summary.length >= SUMMARY_MAX
                              ? "text-red-500"
                              : "text-gray-400",
                          )}
                        >
                          {form.summary.length} / {SUMMARY_MAX}
                        </p>
                      )}
                    </Field>
                  </div>
                )}

                {step === 3 && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Degree" required htmlFor="apply-degree">
                        <input
                          id="apply-degree"
                          type="text"
                          placeholder="e.g. BSc Computer Science"
                          value={form.degree}
                          onChange={(e) => setField("degree", e.target.value)}
                          className={INPUT_CLS}
                          maxLength={200}
                        />
                      </Field>
                      <Field label="Institution" required htmlFor="apply-institution">
                        <input
                          id="apply-institution"
                          type="text"
                          placeholder="e.g. NUST"
                          value={form.institution}
                          onChange={(e) => setField("institution", e.target.value)}
                          className={INPUT_CLS}
                          maxLength={200}
                        />
                      </Field>
                    </div>

                    <div>
                      <p className={cn(LABEL_CLS, "mb-3")}>
                        Work Experience
                        <span aria-hidden="true" className="text-remotiv-purple">
                          {" *"}
                        </span>
                      </p>
                      <ExperienceList
                        value={experiences}
                        onChange={setExperiences}
                      />
                    </div>
                  </div>
                )}

                {step === 4 && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="City" required htmlFor="apply-city">
                        <input
                          id="apply-city"
                          type="text"
                          placeholder="e.g. Lahore"
                          value={form.city}
                          onChange={(e) => setField("city", e.target.value)}
                          className={INPUT_CLS}
                          autoComplete="address-level2"
                          maxLength={100}
                        />
                      </Field>
                      <Field label="Country" required htmlFor="apply-country">
                        <select
                          id="apply-country"
                          value={form.country}
                          onChange={(e) => setField("country", e.target.value)}
                          className={INPUT_CLS}
                          autoComplete="country-name"
                        >
                          <option value="" disabled>
                            Select country…
                          </option>
                          {COUNTRIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>

                    <Field label="Availability" required>
                      <PillGroup
                        ariaLabel="Availability"
                        options={AVAILABILITY_OPTIONS}
                        value={form.availability}
                        onChange={(v) => setField("availability", v)}
                      />
                    </Field>

                    <Field label="Work Type" required>
                      <PillGroup
                        ariaLabel="Work type"
                        options={WORK_TYPE_OPTIONS}
                        value={form.workType}
                        onChange={(v) => setField("workType", v)}
                      />
                    </Field>

                    <Field label="Notice Period" required>
                      <PillGroup
                        ariaLabel="Notice period"
                        options={NOTICE_PERIOD_OPTIONS}
                        value={form.noticePeriod}
                        onChange={(v) => setField("noticePeriod", v)}
                      />
                    </Field>

                    <Field label="Work Location" required>
                      <PillGroup
                        ariaLabel="Work location"
                        options={WORK_LOCATION_OPTIONS}
                        value={form.workLocation}
                        onChange={(v) => setField("workLocation", v)}
                      />
                    </Field>
                  </div>
                )}
              </div>

              {stepError && (
                <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-[0.82rem] text-red-600">
                  {stepError}
                </p>
              )}

              {submitError && (
                <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-[0.82rem] text-red-600">
                  {submitError}
                </p>
              )}

              <div className="mt-6 flex items-center justify-between gap-3">
                {step > 1 ? (
                  <button
                    type="button"
                    onClick={goBack}
                    disabled={submitting}
                    className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  >
                    Back
                  </button>
                ) : (
                  <span />
                )}
                {step < 4 ? (
                  <button
                    type="button"
                    onClick={goNext}
                    className="rounded-xl bg-[#111] px-6 py-3.5 font-heading text-[0.82rem] font-bold text-white transition-opacity hover:opacity-80"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={submitting}
                    className="rounded-xl bg-[#111] px-6 py-3.5 font-heading text-[0.82rem] font-bold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                  >
                    {submitting ? "Submitting…" : "Submit Application"}
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
