"use client";

import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isValidEmail } from "@/app/admin/lib/validators";
import { submitHireRequest } from "./hire-request-action";

type EngagementType = "per_hour" | "per_month" | "full_time";
type Timeline = "asap" | "within_2_weeks" | "within_1_month" | "flexible";

export type HireRequestWizardProps = {
  open: boolean;
  onClose: () => void;
  candidate: {
    id: string;
    name: string;
    rate: string;
    role?: string;
  };
};

const BUDGET_OPTIONS: Record<EngagementType, string[]> = {
  per_hour: ["$25-50/hr", "$50-100/hr", "$100+/hr"],
  per_month: ["<$2K/mo", "$2-5K/mo", "$5-10K/mo", "$10K+/mo"],
  full_time: ["<$30K/yr", "$30-60K/yr", "$60-100K/yr", "$100K+/yr"],
};

const TIMELINE_OPTIONS: { value: Timeline; label: string }[] = [
  { value: "asap", label: "ASAP" },
  { value: "within_2_weeks", label: "Within 2 weeks" },
  { value: "within_1_month", label: "Within 1 month" },
  { value: "flexible", label: "Flexible" },
];

const ENGAGEMENT_OPTIONS: { value: EngagementType; title: string; subtitle: string }[] = [
  { value: "per_hour", title: "Per hour", subtitle: "Project-based, billed hourly" },
  { value: "per_month", title: "Per month", subtitle: "Monthly retainer, ongoing work" },
  { value: "full_time", title: "Full time", subtitle: "Long-term hire, dedicated" },
];

export default function HireRequestWizard({ open, onClose, candidate }: HireRequestWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [engagementType, setEngagementType] = useState<EngagementType | null>(null);

  const [budgetRange, setBudgetRange] = useState<string>("");
  const [projectDescription, setProjectDescription] = useState<string>("");
  const [timeline, setTimeline] = useState<Timeline | "">("");

  const [fullName, setFullName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [company, setCompany] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [companyUrl, setCompanyUrl] = useState<string>("");

  const [emailTouched, setEmailTouched] = useState<boolean>(false);

  // OS-level reduced-motion preference. Evaluated once at mount — fine for
  // a modal that doesn't persist across sessions. Used to disable the option-
  // button + send-button inline transitions for users who opted out.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // M5: synchronous double-submit lock — disabled={submitting} only flips
  // after React commits, leaving a microsecond race window.
  const submitLockRef = useRef(false);
  // M6: focus the success heading when step 4 mounts so keyboard + SR users
  // land on the new content instead of losing focus to <body>.
  const successHeadingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== 4) return;
    const t = setTimeout(() => successHeadingRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [step]);

  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setStep(1);
        setEngagementType(null);
        setBudgetRange("");
        setProjectDescription("");
        setTimeline("");
        setFullName("");
        setEmail("");
        setCompany("");
        setNotes("");
        setCompanyUrl("");
        setEmailTouched(false);
        setError(null);
        setSubmitting(false);
      }, 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setBudgetRange("");
  }, [engagementType]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  useEffect(() => {
    if (!open) return;
    const count = Number.parseInt(document.body.dataset.scrollLocks ?? "0", 10);
    document.body.dataset.scrollLocks = String(count + 1);
    if (count === 0) document.body.style.overflow = "hidden";
    return () => {
      const current = Number.parseInt(document.body.dataset.scrollLocks ?? "1", 10);
      const next = current - 1;
      document.body.dataset.scrollLocks = String(next);
      if (next <= 0) {
        document.body.style.overflow = "";
        delete document.body.dataset.scrollLocks;
      }
    };
  }, [open]);

  const firstFieldRef = useRef<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => firstFieldRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [open, step]);

  const step1Valid = engagementType !== null;
  const step2Valid = budgetRange !== "" && projectDescription.trim().length > 0 && timeline !== "";
  const step3Valid = fullName.trim().length > 0 && isValidEmail(email.trim()) && company.trim().length > 0;

  // Surface a per-field email error AFTER the user has interacted with the
  // input (blur) and the value is non-empty + invalid. We don't show the
  // error while still typing (would be jarring) or on an empty field (the
  // user hasn't given a value yet — no error to report).
  const emailHasInlineError =
    emailTouched && email.trim().length > 0 && !isValidEmail(email.trim());

  const handleSubmit = useCallback(async () => {
    if (!step3Valid || !engagementType || !timeline) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitHireRequest({
        engagementType,
        budgetRange,
        projectDescription: projectDescription.trim(),
        timeline,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        company: company.trim(),
        notes: notes.trim() || undefined,
        candidateId: candidate.id,
        candidateName: candidate.name,
        candidateRate: candidate.rate,
        companyUrl,
      });
      if (result.success) {
        setStep(4);
      } else {
        setError(result.error);
      }
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }, [step3Valid, engagementType, budgetRange, projectDescription, timeline, fullName, email, company, notes, candidate, companyUrl]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hire-wizard-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: 0,
          width: "100%",
          maxWidth: 480,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
          fontFamily: "'DM Sans', system-ui, sans-serif",
          position: "relative",
        }}
      >
        {/* honeypot */}
        <input
          type="text"
          name="companyUrl"
          value={companyUrl}
          onChange={(e) => setCompanyUrl(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
          aria-hidden="true"
        />

        {step !== 4 && (
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              zIndex: 5,
              background: "#fff",
              border: "1px solid #e8e0db",
              borderRadius: "50%",
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: submitting ? "not-allowed" : "pointer",
              color: "#555",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            <X size={18} />
          </button>
        )}

        <div style={{ overflowY: "auto", padding: 28, flex: 1 }}>
        {step !== 4 && (
          <>
            <div
              role="group"
              aria-label={`Step ${step} of 3`}
              style={{ display: "flex", gap: 6, marginBottom: 18, paddingRight: 40 }}
            >
              <div
                aria-current={step === 1 ? "step" : undefined}
                style={{ flex: 1, height: 4, background: step >= 1 ? "#7E47FF" : "#e8e0db", borderRadius: 999 }}
              />
              <div
                aria-current={step === 2 ? "step" : undefined}
                style={{ flex: 1, height: 4, background: step >= 2 ? "#7E47FF" : "#e8e0db", borderRadius: 999 }}
              />
              <div
                aria-current={step === 3 ? "step" : undefined}
                style={{ flex: 1, height: 4, background: step >= 3 ? "#7E47FF" : "#e8e0db", borderRadius: 999 }}
              />
            </div>

            <div style={{ fontSize: 11, color: "#7E47FF", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 6 }}>
              Step {step} of 3 — {step === 1 ? "Engagement" : step === 2 ? "Project" : "Contact"}
            </div>
            <div id="hire-wizard-title" style={{ fontSize: 20, fontWeight: 500, color: "#111", marginBottom: 6 }}>
              {step === 1 && "What kind of engagement?"}
              {step === 2 && "Tell us about the project"}
              {step === 3 && "How can we reach you?"}
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
              {step === 1 && `Hiring ${candidate.name}${candidate.role ? ` · ${candidate.role}` : ""} · ${candidate.rate}`}
              {step === 2 && "This helps us match your needs"}
              {step === 3 && "Our team responds within 24 hours"}
            </div>

            {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {ENGAGEMENT_OPTIONS.map((opt, idx) => {
              const selected = engagementType === opt.value;
              return (
                <button
                  key={opt.value}
                  ref={idx === 0 ? (firstFieldRef as React.RefObject<HTMLButtonElement>) : null}
                  type="button"
                  onClick={() => setEngagementType(opt.value)}
                  style={{
                    background: selected ? "#f8f4f1" : "#fff",
                    border: selected ? "2px solid #7E47FF" : "1px solid #e8e0db",
                    padding: "14px 16px",
                    borderRadius: 12,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    transition: prefersReducedMotion ? "none" : "all 0.15s",
                  }}
                  aria-pressed={selected}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                    <div style={{ fontSize: 15, fontWeight: 500, color: "#111" }}>{opt.title}</div>
                    <div style={{ color: selected ? "#7E47FF" : "#ccc", fontSize: 16 }}>{selected ? "●" : "○"}</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>{opt.subtitle}</div>
                </button>
              );
            })}
          </div>
        )}

        {step === 2 && engagementType && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>Budget range</label>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${BUDGET_OPTIONS[engagementType].length}, 1fr)`, gap: 6 }}>
                {BUDGET_OPTIONS[engagementType].map((opt, idx) => {
                  const selected = budgetRange === opt;
                  return (
                    <button
                      key={opt}
                      ref={idx === 0 ? (firstFieldRef as React.RefObject<HTMLButtonElement>) : null}
                      type="button"
                      onClick={() => setBudgetRange(opt)}
                      style={{
                        background: selected ? "#f8f4f1" : "#fff",
                        border: selected ? "2px solid #7E47FF" : "1px solid #e8e0db",
                        color: selected ? "#7E47FF" : "#555",
                        padding: "10px 6px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: selected ? 500 : 400,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: prefersReducedMotion ? "none" : "all 0.15s",
                      }}
                      aria-pressed={selected}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="hire-wizard-project" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Project description
              </label>
              <textarea
                id="hire-wizard-project"
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                placeholder="Briefly describe what you need this person to do (e.g., build a SaaS landing page, manage growth campaigns, integrate APIs...)"
                rows={4}
                maxLength={5000}
                required
                aria-required="true"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #e8e0db",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  resize: "vertical",
                  fontFamily: "inherit",
                  minHeight: 80,
                }}
              />
            </div>

            <div>
              <label htmlFor="hire-wizard-timeline" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Timeline
              </label>
              <select
                id="hire-wizard-timeline"
                value={timeline}
                onChange={(e) => setTimeline(e.target.value as Timeline)}
                required
                aria-required="true"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #e8e0db",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  fontFamily: "inherit",
                }}
              >
                <option value="">Select timeline...</option>
                {TIMELINE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label htmlFor="hire-wizard-name" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Full name
              </label>
              <input
                ref={firstFieldRef as React.RefObject<HTMLInputElement>}
                id="hire-wizard-name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={100}
                placeholder="Sarah Chen"
                required
                aria-required="true"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #e8e0db",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  fontFamily: "inherit",
                }}
              />
            </div>

            <div>
              <label htmlFor="hire-wizard-email" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Work email
              </label>
              <input
                id="hire-wizard-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                maxLength={254}
                placeholder="sarah@company.com"
                required
                aria-required="true"
                aria-invalid={emailHasInlineError || undefined}
                aria-describedby={emailHasInlineError ? "hire-wizard-email-error" : undefined}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: `1px solid ${emailHasInlineError ? "#dc2626" : "#e8e0db"}`,
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  fontFamily: "inherit",
                }}
              />
              {emailHasInlineError && (
                <div
                  id="hire-wizard-email-error"
                  role="alert"
                  style={{ marginTop: 6, fontSize: 12, color: "#dc2626" }}
                >
                  Please enter a valid email address.
                </div>
              )}
            </div>

            <div>
              <label htmlFor="hire-wizard-company" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Company name
              </label>
              <input
                id="hire-wizard-company"
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={100}
                placeholder="Acme Inc."
                required
                aria-required="true"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #e8e0db",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  fontFamily: "inherit",
                }}
              />
            </div>

            <div>
              <label htmlFor="hire-wizard-notes" style={{ fontSize: 12, color: "#555", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Notes <span style={{ color: "#888", fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                id="hire-wizard-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything else you'd like us to know?"
                rows={2}
                maxLength={5000}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #e8e0db",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "#fff",
                  resize: "vertical",
                  fontFamily: "inherit",
                  minHeight: 60,
                }}
              />
            </div>

            <div style={{ background: "#EAF3DE", padding: "12px 14px", borderRadius: 10, fontSize: 12, color: "#173404", lineHeight: 1.5 }}>
              ✓ Your info stays private — only shared with our team to match you with the right talent.
            </div>
          </div>
        )}

              {error && (
                <div role="alert" style={{ background: "#fee", color: "#a23", padding: "10px 14px", borderRadius: 8, marginTop: 14, fontSize: 13 }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                {step === 1 ? (
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={submitting}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "1px solid #e8e0db",
                      color: "#555",
                      padding: 13,
                      borderRadius: 10,
                      fontWeight: 500,
                      fontSize: 14,
                      cursor: submitting ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      minHeight: 44,
                    }}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
                    disabled={submitting}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "1px solid #e8e0db",
                      color: "#555",
                      padding: 13,
                      borderRadius: 10,
                      fontWeight: 500,
                      fontSize: 14,
                      cursor: submitting ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                )}

                {step < 3 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
                    disabled={step === 1 ? !step1Valid : !step2Valid}
                    style={{
                      flex: 2,
                      background: (step === 1 ? step1Valid : step2Valid) ? "#7E47FF" : "#ccc",
                      color: "#fff",
                      border: "none",
                      padding: 13,
                      borderRadius: 10,
                      fontWeight: 500,
                      fontSize: 14,
                      cursor: (step === 1 ? step1Valid : step2Valid) ? "pointer" : "not-allowed",
                      fontFamily: "inherit",
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    Continue <ArrowRight size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!step3Valid || submitting}
                    aria-busy={submitting || undefined}
                    style={{
                      flex: 2,
                      background: step3Valid && !submitting ? "#49d7a7" : "#ccc",
                      color: "#fff",
                      border: "none",
                      padding: 13,
                      borderRadius: 10,
                      fontWeight: 500,
                      fontSize: 14,
                      cursor: step3Valid && !submitting ? "pointer" : "not-allowed",
                      fontFamily: "inherit",
                      minHeight: 44,
                    }}
                  >
                    {submitting ? "Sending..." : "Send request →"}
                  </button>
                )}
              </div>
          </>
        )}

        {step === 4 && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ width: 64, height: 64, background: "#EAF3DE", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
              <Check size={32} color="#3B6D11" strokeWidth={2.5} />
            </div>
            <div
              ref={successHeadingRef}
              tabIndex={-1}
              style={{ fontSize: 22, fontWeight: 500, color: "#111", marginBottom: 8, outline: "none" }}
            >
              Request sent!
            </div>
            <div style={{ fontSize: 14, color: "#666", lineHeight: 1.6, marginBottom: 24 }}>
              Our team will reach out to <strong>{email}</strong> within 24 hours to discuss hiring {candidate.name}.
            </div>

            <div style={{ background: "#f8f4f1", padding: "14px 18px", borderRadius: 10, marginBottom: 20, textAlign: "left" }}>
              <div style={{ fontSize: 11, color: "#7E47FF", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 8 }}>
                What happens next
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#555", lineHeight: 1.8 }}>
                <li>We review your request</li>
                <li>Match you with the right talent</li>
                <li>Schedule an intro call</li>
              </ol>
            </div>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: "#7E47FF",
                color: "#fff",
                border: "none",
                padding: "13px 24px",
                borderRadius: 10,
                fontWeight: 500,
                fontSize: 14,
                cursor: "pointer",
                width: "100%",
                fontFamily: "inherit",
                minHeight: 44,
              }}
            >
              Browse more talent
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
