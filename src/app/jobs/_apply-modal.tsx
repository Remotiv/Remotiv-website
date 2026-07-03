"use client";

import {
  IconAlertTriangle,
  IconCheck,
  IconFileText,
  IconSend,
  IconUpload,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import type { Job, ScreeningQuestion } from "@/lib/jobs";
import "./apply-modal.css";

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

const BASIC_KEYS = ["firstName", "lastName", "email", "phone", "linkedin"] as const;

// Abort the submit fetch if the network stalls for this long. Keeps the
// "Submitting…" button from sticking forever on flaky mobile connections.
const SUBMIT_TIMEOUT_MS = 30_000;

// Matching rules — string-consistent with our stored ScreeningQuestion.ideal
// (yesno "Yes"/"No"; numeric "3"; multiple = option index as a string "2").
function isAnswered(q: ScreeningQuestion, ans: string | undefined): boolean {
  if (ans === undefined || ans === null) return false;
  if (q.type === "numeric") return String(ans).trim() !== "";
  return ans !== "";
}
function isMatch(q: ScreeningQuestion, ans: string | undefined): boolean {
  if (!isAnswered(q, ans)) return false;
  if (q.type === "yesno") return ans === q.ideal;
  if (q.type === "numeric") return Number(ans) >= Number(q.ideal);
  return String(ans) === String(q.ideal); // multiple — index vs index
}

export default function ApplyModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const questions = job.screening_questions ?? [];

  const [form, setForm] = useState(EMPTY_APPLY);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Reveals inline required-field errors after a submit attempt — never
  // permanently disables the button (soft-gate, matching the design).
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Bridge token returned by /api/apply on successful submission. Drives
  // (1) the "Complete your profile" CTA in the success modal and (2) the
  // auto-close skip — we don't want the modal to vanish before the
  // candidate can click the CTA.
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  // Same-job duplicate returns { error: "duplicate_application", appliedAt }.
  const [duplicateMsg, setDuplicateMsg] = useState<{ appliedAt: string | null } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  // Focus trap + focus-restore. The hook moves initial focus into the modal,
  // cycles Tab/Shift+Tab within it, and restores focus on unmount.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  // SSR-safe mount guard — document.body isn't defined on the server, so the
  // portal target only exists after mount. Mirrors pricing/_tier-cta.tsx.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock background scroll while the modal is open. The modal only mounts when
  // open, so mount/unmount is the correct lock/unlock boundary. Restore the
  // previous value rather than hardcoding so we don't clobber another lock.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Live soft warning — any ESSENTIAL question that is answered but fails its
  // ideal. Soft only: it never blocks submit.
  const failedEssentials = useMemo(
    () => questions.filter((q) => q.essential && isAnswered(q, answers[q.id]) && !isMatch(q, answers[q.id])),
    [questions, answers],
  );

  // Auto-close after success — but only when we have nothing more to offer.
  // When a bridge token is present, the success modal renders the
  // "Complete your profile" CTA; killing the modal would yank it mid-click.
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
  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  // Fire-and-forget click counter. keepalive lets the request survive the
  // navigation to LinkedIn; we never await, never preventDefault — the <a>
  // opens LinkedIn instantly regardless of whether the insert succeeds.
  function handleFollowClick() {
    try {
      fetch("/api/track/follow-click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "apply_success_modal",
          platform: "linkedin",
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Swallow — the click MUST open LinkedIn regardless of tracking failure.
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setCvError(null);
    if (!file) {
      setCvFile(null);
      return;
    }
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

  const missingBasics = BASIC_KEYS.filter((k) => !form[k].trim());
  const unanswered = questions.filter((q) => !isAnswered(q, answers[q.id]));
  const complete = missingBasics.length === 0 && !!cvFile && unanswered.length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete) {
      setTried(true);
      if (!cvFile) setCvError("Please upload your CV (PDF).");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    try {
      const fd = new FormData();
      fd.append("job_id",       job.id);
      fd.append("first_name",   form.firstName);
      fd.append("last_name",    form.lastName);
      fd.append("email",        form.email);
      fd.append("phone",        form.phone);
      fd.append("linkedin_url", form.linkedin);
      fd.append("cv",           cvFile as File);
      // New: screening answers, normalized to strings and keyed by question id.
      // Ignored by /api/apply until its own step reads this key.
      const screeningAnswers = questions.map((q) => ({
        id: q.id,
        answer: String(answers[q.id] ?? ""),
      }));
      fd.append("screening_answers", JSON.stringify(screeningAnswers));

      let res: Response;
      try {
        res = await fetch("/api/apply", {
          method: "POST",
          body: fd,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (res.status === 409) {
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
      if (err instanceof Error && err.name === "AbortError") {
        setSubmitError(
          "Submission timed out. Please check your connection and try again.",
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      clearTimeout(timeoutId);
      setSubmitting(false);
    }
  }

  const companyInitial = (job.company || "?").charAt(0).toUpperCase();

  if (!mounted) return null;

  return createPortal(
    <div className="applymodal">
      <div
        ref={modalRef}
        className="ap-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-modal-title"
      >
        {duplicateMsg ? (
          <div className="ap-success">
            <div className="ap-success-ic purple">
              <IconCheck size={32} stroke={2} />
            </div>
            <h2 id="apply-modal-title" className="ap-success-title font-heading">
              You&apos;ve already applied to this job
            </h2>
            <p className="ap-success-sub">
              {duplicateMsg.appliedAt ? (
                <>
                  We received your application on{" "}
                  <strong>
                    {new Date(duplicateMsg.appliedAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </strong>
                  . We&apos;re reviewing it and will be in touch soon.
                </>
              ) : (
                <>We&apos;re reviewing your application and will be in touch soon.</>
              )}
            </p>
            <Link href="/jobs" onClick={onClose} className="ap-cta font-heading">
              Browse other jobs →
            </Link>
            <button type="button" onClick={onClose} className="ap-ghostbtn">
              Close
            </button>
          </div>
        ) : success ? (
          <div role="status" className="ap-success">
            <div className="ap-success-ic">
              <IconCheck size={32} stroke={2} />
            </div>
            <h2 id="apply-modal-title" className="ap-success-title font-heading">
              Application submitted
            </h2>
            {bridgeToken ? (
              <>
                <p className="ap-success-sub">
                  Take 2 minutes to complete your talent profile and be visible to
                  every Remotiv employer.
                </p>
                <Link
                  href={`/join-as-talent?token=${bridgeToken}`}
                  className="ap-cta font-heading"
                >
                  Complete your profile for more opportunities →
                </Link>
                <div className="ap-follow">
                  <h3 className="ap-follow-title font-heading">
                    Don&apos;t miss the next role
                  </h3>
                  <p className="ap-follow-sub">
                    New roles get posted to our LinkedIn first. Follow to see them
                    before anyone else.
                  </p>
                  <a
                    href="https://www.linkedin.com/company/remotiv-inc/"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={handleFollowClick}
                    className="ap-linkedin font-heading"
                    aria-label="Follow Remotiv on LinkedIn (opens in new tab)"
                  >
                    <svg
                      aria-hidden="true"
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                    </svg>
                    Follow Remotiv on LinkedIn
                  </a>
                </div>
                <button type="button" onClick={onClose} className="ap-ghostbtn">
                  Close
                </button>
              </>
            ) : (
              <p className="ap-success-sub">
                Thanks, {form.firstName || "there"}! The {job.company} team will
                review your application. Average response time is 24 hours.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="ap-head">
              <div className="ap-head-tex" />
              <button type="button" onClick={onClose} aria-label="Close" className="ap-close">
                <IconX size={18} stroke={2.5} />
              </button>
              <div className="ap-head-inner">
                <div className="ap-eyebrow font-heading">Apply now</div>
                <div className="ap-head-row">
                  <span className="ap-avatar font-heading">{companyInitial}</span>
                  <div>
                    <h2 id="apply-modal-title" className="ap-jobtitle font-heading">
                      {job.title}
                    </h2>
                    <div className="ap-jobmeta">
                      <span>{job.company}</span>
                      <span aria-hidden="true">·</span>
                      <span className="ap-mode">
                        <IconWorld size={14} /> {job.work_type}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="ap-perf">
              <span className="l" />
              <span className="r" />
            </div>

            <form onSubmit={handleSubmit} className="ap-body">
              <div className="ap-rowpair">
                <div>
                  <label htmlFor="apply-firstName" className="ap-label">
                    First name<span className="ap-req"> *</span>
                  </label>
                  <input
                    id="apply-firstName"
                    type="text"
                    placeholder="Ayesha"
                    value={form.firstName}
                    onChange={(e) => setField("firstName", e.target.value)}
                    className="ap-input"
                  />
                  {tried && !form.firstName.trim() && <div className="ap-fielderr">Required</div>}
                </div>
                <div>
                  <label htmlFor="apply-lastName" className="ap-label">
                    Last name<span className="ap-req"> *</span>
                  </label>
                  <input
                    id="apply-lastName"
                    type="text"
                    placeholder="Khan"
                    value={form.lastName}
                    onChange={(e) => setField("lastName", e.target.value)}
                    className="ap-input"
                  />
                  {tried && !form.lastName.trim() && <div className="ap-fielderr">Required</div>}
                </div>
              </div>

              <div>
                <label htmlFor="apply-email" className="ap-label">
                  Email<span className="ap-req"> *</span>
                </label>
                <input
                  id="apply-email"
                  type="email"
                  placeholder="you@email.com"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  className="ap-input"
                />
                {tried && !form.email.trim() && <div className="ap-fielderr">Required</div>}
              </div>

              <div className="ap-rowpair">
                <div>
                  <label htmlFor="apply-phone" className="ap-label">
                    Phone<span className="ap-req"> *</span>
                  </label>
                  <input
                    id="apply-phone"
                    type="tel"
                    placeholder="+92 300 1234567"
                    value={form.phone}
                    onChange={(e) => setField("phone", e.target.value)}
                    className="ap-input"
                  />
                  {tried && !form.phone.trim() && <div className="ap-fielderr">Required</div>}
                </div>
                <div>
                  <label htmlFor="apply-linkedin" className="ap-label">
                    LinkedIn<span className="ap-req"> *</span>
                  </label>
                  <input
                    id="apply-linkedin"
                    type="url"
                    placeholder="linkedin.com/in/…"
                    value={form.linkedin}
                    onChange={(e) => setField("linkedin", e.target.value)}
                    className="ap-input"
                  />
                  {tried && !form.linkedin.trim() && <div className="ap-fielderr">Required</div>}
                </div>
              </div>

              <div>
                <label htmlFor="apply-cv" id="apply-cv-label" className="ap-label">
                  CV / Resume<span className="ap-req"> *</span>
                </label>
                {cvFile ? (
                  <div className="ap-cv on">
                    <IconFileText size={18} className="ap-cv-ic" />
                    <span className="ap-cv-name">{cvFile.name}</span>
                    <button
                      type="button"
                      className="ap-cv-change"
                      onClick={() => fileRef.current?.click()}
                    >
                      Change
                    </button>
                    <IconCheck size={16} className="ap-cv-check" />
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-labelledby="apply-cv-label"
                    onClick={() => fileRef.current?.click()}
                    className={`ap-cv ap-cv-empty${tried && !cvFile ? " err" : ""}`}
                  >
                    <IconUpload size={18} className="ap-cv-ic" />
                    <span className="ap-cv-name">
                      Upload your CV <span className="ap-cv-hint">PDF, up to 5 MB</span>
                    </span>
                  </button>
                )}
                <input
                  id="apply-cv"
                  ref={fileRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {cvError && (
                  <p role="alert" className="ap-fielderr">
                    {cvError}
                  </p>
                )}
              </div>

              {questions.length > 0 && (
                <>
                  <div className="ap-divider">
                    <span className="ap-divline" />
                    <span className="ap-divtext font-heading">A few quick questions</span>
                    <span className="ap-divline" />
                  </div>

                  {questions.map((q, i) => {
                    const ans = answers[q.id];
                    const showErr = tried && !isAnswered(q, ans);
                    return (
                      <div key={q.id} className="ap-q">
                        <span className="ap-qnum font-heading">{i + 1}</span>
                        <div className="ap-qbody">
                          <div className="ap-qhead">
                            <span className="ap-qtext">
                              {q.question} <span className="ap-req">*</span>
                            </span>
                            {q.essential && <span className="ap-ess">Essential</span>}
                          </div>

                          {q.type === "yesno" && (
                            <div className="ap-yn">
                              {["Yes", "No"].map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  className={`ap-ynbtn${ans === v ? " on" : ""}`}
                                  onClick={() => setAnswer(q.id, v)}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                          )}

                          {q.type === "numeric" && (
                            <input
                              className="ap-input ap-num"
                              type="number"
                              min="0"
                              placeholder="0"
                              value={ans ?? ""}
                              onChange={(e) => setAnswer(q.id, e.target.value)}
                            />
                          )}

                          {q.type === "multiple" && (
                            <div>
                              {q.options.map((opt, oi) => (
                                <button
                                  // biome-ignore lint/suspicious/noArrayIndexKey: options are positional; index is the stored answer value
                                  key={oi}
                                  type="button"
                                  className={`ap-opt${String(ans) === String(oi) ? " on" : ""}`}
                                  onClick={() => setAnswer(q.id, String(oi))}
                                >
                                  <span className="ap-radio" /> {opt}
                                </button>
                              ))}
                            </div>
                          )}

                          {showErr && <div className="ap-fielderr">Please answer this question.</div>}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {failedEssentials.length > 0 && (
                <div className="ap-warn">
                  <IconAlertTriangle size={20} className="ap-warn-ic" />
                  <div>
                    <div className="ap-warn-title font-heading">
                      You don&apos;t meet all the preferred qualifications for this role
                    </div>
                    <div className="ap-warn-sub">
                      You can still submit your application — the team will review it.
                    </div>
                  </div>
                </div>
              )}

              {submitError && (
                <p role="alert" className="ap-errbanner">
                  {submitError}
                </p>
              )}

              <div className="ap-foot" style={{ borderTop: "none", padding: 0, marginTop: 4 }}>
                <button type="submit" disabled={submitting} className="ap-submit font-heading">
                  <IconSend size={16} stroke={2} />
                  &nbsp;{submitting ? "Submitting…" : "Submit application"}
                </button>
                {tried && !complete && (
                  <div className="ap-foot-err">Please complete all required fields above.</div>
                )}
                <div className="ap-foot-note">
                  By applying you agree to Remotiv&apos;s terms · Avg. response in 24 hours
                </div>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
