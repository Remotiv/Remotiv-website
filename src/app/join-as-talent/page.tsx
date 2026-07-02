"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Navbar } from "@/components/navbar";
import "./join-as-talent.css";

// Phase 4 G2: one-time pdfjs worker URL setup flag. The URL assignment was
// previously inside extractPdfText, running on every call. Now configured
// at most once per session.
let pdfWorkerConfigured = false;

// Phase 5 J1: respect prefers-reduced-motion for the 6 scroll-to-top calls
// after step changes / submit safety-net. Users with vestibular triggers
// get an instant jump instead of a smooth scroll.
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Light-check LR2: extracted helper for the 6 identical scroll-to-top calls
// (was inline in goToStep ×3 and handleSubmit safety-net ×3). Defined AFTER
// prefersReducedMotion because it reads it at call-time. Behaviour
// byte-identical to the previous inline form.
const scrollToTop = (): void => {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
};

// Light-check LR1: extracted helper for the 6 identical focus-after-render
// calls added across Phase 5 Round B (focus management). Generic on the
// element type so any of HTMLHeadingElement / HTMLDivElement /
// HTMLButtonElement / HTMLInputElement refs slot in without casting.
// rAF defers until React has flushed the surrounding state update.
const focusRef = <T extends HTMLElement>(ref: RefObject<T | null>): void => {
  requestAnimationFrame(() => ref.current?.focus());
};

// ── Client-side PDF text extraction (mirrors admin bulk-upload helper)
async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // Phase 4 G2: only set the worker URL the first time.
  if (!pdfWorkerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    pdfWorkerConfigured = true;
  }

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  // Phase 4 G1a: cap at 10 pages. Server caps cv_text at 100 KB anyway, and
  // typical CVs are 1–2 pages. A 30-page document would otherwise freeze the
  // main thread for seconds while pdfjs walks every page sequentially.
  const lines: string[] = [];
  const maxPages = Math.min(doc.numPages, 10);
  try {
    for (let i = 1; i <= maxPages; i++) {
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
  } finally {
    // Phase 4 H1: free the pdfjs worker document handle (worker holds a few
    // MB of page state until destroyed). Wrapped in its own try so a
    // destroy() failure can't override the actual result. The caller of
    // extractPdfText already swallows extraction errors silently — preserve
    // that contract.
    try {
      await doc.destroy();
    } catch {
      // ignore — best-effort cleanup
    }
  }
  return lines.join("\n");
}

const WORK_TYPE_LABEL: Record<string, string> = {
  fullTime: "Full-time", partTime: "Part-time", contract: "Contract", any: "Any",
};
const NOTICE_PERIOD_LABEL: Record<string, string> = {
  immediate: "Immediate", "2weeks": "2 Weeks", "1month": "1 Month", negotiable: "Negotiable",
};
const WORK_LOCATION_LABEL: Record<string, string> = {
  remote: "Remote", hybrid: "Hybrid", onsite: "Onsite",
};
const AVAILABILITY_LABEL: Record<string, string> = {
  available: "Available Now", unavailable: "Not Available",
};

// Phase 1 R1 L1–L4: module-scope file-upload + form caps (was inline magics).
const MAX_CV_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_SKILLS = 15;
const MIN_PHONE_DIGITS = 7;
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

type WorkExperience = {
  // Phase 1 R1 L5: was `number` from Date.now(); now string from
  // crypto.randomUUID() to eliminate same-millisecond collision risk.
  // `id` is only used as a React key + for equality lookup in
  // updateExperience/removeExperience — string works identically.
  id: string;
  title: string;
  company: string;
  start: string;
  end: string;
  skills: string;
  description: string;
  currentlyWorking: boolean;
};

const makeEmptyExperience = (): WorkExperience => ({
  id: crypto.randomUUID(),
  title: "",
  company: "",
  start: "",
  end: "",
  skills: "",
  description: "",
  currentlyWorking: false,
});

type WorkType = "fullTime" | "partTime" | "contract" | "any";
type NoticePeriod = "immediate" | "2weeks" | "1month" | "negotiable";
type WorkLocation = "remote" | "hybrid" | "onsite";
type Availability = "available" | "unavailable";

const STEPS = [
  { num: 1, label: "Personal Info" },
  { num: 2, label: "Professional Info" },
  { num: 3, label: "Work Preferences" },
  { num: 4, label: "Upload CV" },
] as const;

// Phase 1 R1 H2 + H3: ROLE_CATEGORIES and INDUSTRIES constants removed —
// they were declared but never referenced anywhere. Both fields are now
// derived from the work-experience array on the API side (see L453-454
// comment in handleSubmit).

const COUNTRIES = ["Pakistan", "United States", "United Kingdom", "Canada", "Australia", "Other"];

const PERKS = [
  {
    icon: "🤖",
    title: "AI-Powered Matching",
    sub: "Our AI matches your skills to the best-fit roles from US & global companies.",
  },
  {
    icon: "🌍",
    title: "Global Opportunities",
    sub: "Access jobs from Pakistan, the US, the UK, and beyond.",
  },
  {
    icon: "💼",
    title: "Full Recruitment Support",
    sub: "Our team guides you through every step of the hiring process.",
  },
  {
    icon: "💰",
    title: "Competitive Salaries",
    sub: "Get paid in USD with transparent salary negotiation support.",
  },
];

function GridBackground() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ x: number[]; y: number[]; w: number; h: number }>({
    x: [],
    y: [],
    w: 0,
    h: 0,
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const draw = () => {
      const W = wrap.offsetWidth;
      const H = wrap.offsetHeight;
      if (!W || !H) return;
      const step = 80;
      const x: number[] = [];
      const y: number[] = [];
      for (let i = 0; i <= W; i += step) x.push(i);
      for (let i = 0; i <= H; i += step) y.push(i);
      setLines({ x, y, w: W, h: H });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Phase 0 D2: don't render the SVG until ResizeObserver has measured
  // the wrapping div. Otherwise the first paint draws an empty SVG
  // (viewBox="0 0 0 0") for ~1 frame, causing a visible flash. The
  // wrapper div + hero content render normally; only the grid lines
  // wait for measurement. Measurement completes within 1 frame on mount.
  const measured = lines.w > 0 && lines.h > 0;

  return (
    <div ref={wrapRef} className="bat-wrap">
      {measured && (
        <svg
          className="bat-grid-svg"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          viewBox={`0 0 ${lines.w} ${lines.h}`}
          preserveAspectRatio="none"
        >
          <title>Background grid</title>
          {lines.x.map((x) => (
            <line
              key={`vx-${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={lines.h}
              stroke="#ccc8c0"
              strokeWidth="0.5"
            />
          ))}
          {lines.y.map((y) => (
            <line
              key={`hy-${y}`}
              x1={0}
              y1={y}
              x2={lines.w}
              y2={y}
              stroke="#ccc8c0"
              strokeWidth="0.5"
            />
          ))}
        </svg>
      )}

      <div className="bat-content">
        <div className="bat-pill">
          <span className="bat-pill-now">Now</span>
          <span className="bat-pill-text">Hiring Globally</span>
        </div>

        {/* Phase 6 H4: single h1 (was h1 + h2 split). Crawlers and SR users
            now see the keyword-rich "Join the Remotiv Talent Network" as one
            heading; the inner span carries the purple accent + line break for
            the original two-line visual. */}
        <h1 className="bat-h1">
          Join the Remotiv{" "}
          <span className="bat-h1-accent">Talent Network</span>
        </h1>

        <p className="bat-sub">
          Connect with top companies and global employers. Submit your profile once — get matched
          automatically.
        </p>

        <div className="bat-stats">
          <div className="bat-stat">
            <div className="bat-stat-num">1M+</div>
            <div className="bat-stat-label">Active Talents</div>
          </div>
          <div className="bat-stat">
            <div className="bat-stat-num">100+</div>
            <div className="bat-stat-label">Partner Companies</div>
          </div>
          <div className="bat-stat">
            <div className="bat-stat-num">90%</div>
            <div className="bat-stat-label">Placement Rate</div>
          </div>
          <div className="bat-stat">
            <div className="bat-stat-num">
              2 <span className="bat-stat-days">weeks</span>
            </div>
            <div className="bat-stat-label">Avg. Time to Hire</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <title>Lock</title>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const FooterNote = () => (
  <div className="bta-footer-note">
    <LockIcon />
    Your data is encrypted and only shared with matched employers.
  </div>
);

export default function BecomeATalentPage() {
  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Phase 4 G3: fine-grained submit status. Empty string = generic
  // "Submitting…"; otherwise shows the current phase ("Extracting CV
  // text…", "Uploading…"). Reset to "" alongside setSubmitting(false)
  // in the finally block so a re-click after error starts clean.
  const [submitStatus, setSubmitStatus] = useState<string>("");

  const [experiences, setExperiences] = useState<WorkExperience[]>(() => [makeEmptyExperience()]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");

  const [availability, setAvailability] = useState<Availability>("available");
  const [workType, setWorkType] = useState<WorkType>("fullTime");
  const [noticePeriod, setNoticePeriod] = useState<NoticePeriod>("immediate");
  const [workLocation, setWorkLocation] = useState<WorkLocation>("remote");

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvDragOver, setCvDragOver] = useState(false);
  const cvInputRef = useRef<HTMLInputElement>(null);
  // Phase 3 M-photo-clear: ref on the photo input so the "Remove photo"
  // button can reset its .value (otherwise picking the same file again
  // wouldn't fire onChange).
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Phase 4 D1: ref that mirrors the "form is dirty" boolean — used by the
  // beforeunload handler so the listener doesn't need to re-bind per keystroke.
  const isDirtyRef = useRef(false);

  // Phase 5 Round B (focus management): refs into the rendered DOM so we can
  // move keyboard / screen-reader focus to the right element after async
  // state transitions. All headings get `tabIndex={-1}` so they're focusable
  // programmatically without entering the natural tab order.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const step1ErrorRef = useRef<HTMLDivElement>(null);
  const step2ErrorRef = useRef<HTMLDivElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const addExpBtnRef = useRef<HTMLButtonElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);
  // Skip the very first render's step-heading focus so the page doesn't yank
  // focus on initial load (user hasn't navigated yet).
  const isFirstStepRenderRef = useRef(true);

  // Form state — every text/select input is now controlled so values survive
  // step switches (each step unmounts when the user moves on).
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  // jobTitle / roleCategory / yearsExperience / industry intentionally removed —
  // these are now derived from the Work Experience entries in Step 2.
  const [degree, setDegree] = useState("");
  const [institution, setInstitution] = useState("");
  const [summary, setSummary] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  // Honeypot — bots fill this hidden input; humans leave it blank. Mirrors
  // join-as-freelancer's pattern. /api/talent checks the same field name
  // (website_url) and silently fake-succeeds when it's non-empty.
  const [websiteUrl, setWebsiteUrl] = useState("");

  const [submitState, setSubmitState] = useState<"form" | "success" | "duplicate">("form");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  // Bridge from /jobs/[id] apply → here. When a ?token=… arrives, we POST
  // /api/claim/pre-fill, populate basic-info fields, set isBridgeSubmission,
  // and (on submit) include the token so /api/talent inherits the CV
  // server-side instead of requiring a re-upload. On any pre-fill error
  // (404 / 410 / network) we surface a soft warning and let the candidate
  // fill the form from scratch — never block.
  const router = useRouter();
  const searchParams = useSearchParams();
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  const [isBridgeSubmission, setIsBridgeSubmission] = useState(false);
  const [bridgeWarning, setBridgeWarning] = useState<string | null>(null);

  useEffect(() => {
    const tok = searchParams?.get("token") ?? null;
    if (!tok || tok.length !== 64) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/claim/pre-fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tok }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          prefill?: {
            firstName?: string;
            lastName?: string;
            email?: string;
            phone?: string;
            linkedinUrl?: string;
            hasCv?: boolean;
          };
        };
        if (cancelled) return;
        if (!res.ok || !json.success || !json.prefill) {
          setBridgeWarning(
            "Your invite link couldn't be loaded. Continue filling the form from scratch.",
          );
          return;
        }
        const p = json.prefill;
        setFirstName(p.firstName ?? "");
        setLastName(p.lastName ?? "");
        setEmail(p.email ?? "");
        setPhone(p.phone ?? "");
        setLinkedinUrl(p.linkedinUrl ?? "");
        setBridgeToken(tok);
        setIsBridgeSubmission(true);
      } catch {
        if (!cancelled) {
          setBridgeWarning(
            "Your invite link couldn't be loaded. Continue filling the form from scratch.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  // Phase 1 R2 H1: pure validators — return the error string (or null when
  // valid). Single source of truth for what counts as a valid step, used by
  // (a) the Next-button handlers, (b) the step-bar forward-jump gate inside
  // goToStep, and (c) handleSubmit's safety-net pre-validation.
  const validateStep1Fields = (): string | null => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneDigits = phone.replace(/\D/g, "");

    if (!firstName.trim()) return "First name is required";
    if (!lastName.trim())  return "Last name is required";
    // Phase 3 M-trim: test against the trimmed value so a trailing space
    // doesn't false-reject (pasting from email clients often leaves one).
    if (!email.trim() || !emailRegex.test(email.trim())) {
      return "Please enter a valid email address";
    }
    if (!phone.trim() || phoneDigits.length < MIN_PHONE_DIGITS) {
      return "Please enter a valid phone number";
    }
    if (!city.trim())    return "City is required";
    if (!country.trim()) return "Country is required";

    // Phase 1 R2 M1: hardened LinkedIn URL check — was a loose
    // `.includes("linkedin.com")` which let "linkedin.com.evil.com" pass.
    // Now parses the URL and verifies the hostname is exactly linkedin.com,
    // www.linkedin.com, or a *.linkedin.com subdomain. Adds an https://
    // fallback so users can type "linkedin.com/in/foo" without a scheme.
    if (!linkedinUrl.trim()) {
      return "Please enter a valid LinkedIn URL (linkedin.com/in/...)";
    }
    const raw = linkedinUrl.trim();
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let validLinkedIn = false;
    try {
      const host = new URL(withProto).hostname.toLowerCase();
      validLinkedIn =
        host === "linkedin.com" ||
        host === "www.linkedin.com" ||
        host.endsWith(".linkedin.com");
    } catch {
      validLinkedIn = false;
    }
    if (!validLinkedIn) {
      return "Please enter a valid LinkedIn URL (linkedin.com/in/...)";
    }

    return null;
  };

  const validateStep2Fields = (): string | null => {
    if (!degree.trim())      return "Degree / qualification is required";
    if (!institution.trim()) return "Institution / university is required";

    if (experiences.length === 0) {
      return "Add at least one work experience entry";
    }

    for (let i = 0; i < experiences.length; i++) {
      const e = experiences[i];
      const n = i + 1;
      if (!e.title.trim())   return `Experience ${n}: Job title is required`;
      if (!e.company.trim()) return `Experience ${n}: Company is required`;
      if (!e.start.trim())   return `Experience ${n}: Start date is required`;
      if (!e.currentlyWorking && !e.end.trim()) {
        return `Experience ${n}: End date is required (or tick "I currently work here")`;
      }
    }
    return null;
  };

  // Phase 1 R2 H1: Step 3 (Work Preferences) has no required-field
  // validation — all four radio groups have default-selected values on
  // initial state (available / fullTime / immediate / remote), so the form
  // is always in a valid state. Helper returns null for symmetry with the
  // step-gate loop in goToStep.
  const validateStep3Fields = (): string | null => null;

  const handleStep1Next = () => {
    const err = validateStep1Fields();
    if (err) {
      setStep1Error(err);
      // Phase 5 Round B E2: move focus to the error banner so keyboard / SR
      // users land on the alert text. rAF defers until React has flushed the
      // setStep1Error update and the banner is in the DOM.
      focusRef(step1ErrorRef);
      return;
    }
    setStep1Error(null);
    goToStep(2);
  };

  const handleStep2Next = () => {
    const err = validateStep2Fields();
    if (err) {
      setStep2Error(err);
      // Phase 5 Round B E2: same pattern as Step 1.
      focusRef(step2ErrorRef);
      return;
    }
    setStep2Error(null);
    goToStep(3);
  };

  const goToStep = (target: number) => {
    const clamped = Math.min(Math.max(target, 1), 4);

    // Backward navigation OR same-step: always allowed. The user might be
    // returning to fix a field they noticed was wrong, so we don't gate.
    if (clamped <= step) {
      setStep(clamped);
      scrollToTop();
      return;
    }

    // Phase 1 R2 H1: forward-jump gate — validate every step from the
    // current up to (but not including) the target. On the first invalid
    // step we stop there, surface its error, and DON'T jump further. This
    // closes the bug where a user could click "Step 4" from Step 1 and
    // submit empty Step 2 fields. handleSubmit also re-validates as a
    // final safety net.
    for (let s = step; s < clamped; s++) {
      let stepErr: string | null = null;
      if (s === 1) stepErr = validateStep1Fields();
      else if (s === 2) stepErr = validateStep2Fields();
      else if (s === 3) stepErr = validateStep3Fields();

      if (stepErr) {
        setStep(s);
        if (s === 1) setStep1Error(stepErr);
        else if (s === 2) setStep2Error(stepErr);
        // s === 3 has no error state today (no required fields).
        scrollToTop();
        return;
      }
    }

    // All intermediate steps validated → clear stale errors and jump.
    setStep1Error(null);
    setStep2Error(null);
    setStep(clamped);
    scrollToTop();
  };

  const addExperience = () => {
    // Phase 3 L-exp-cap: client cap mirrors the Phase 2 server cap (30).
    // Without this, a user could add 100 entries client-side and have the
    // server silently truncate to 30 — saved profile loses entries.
    if (experiences.length >= 30) {
      setStep2Error("Maximum 30 work experiences reached.");
      return;
    }
    setExperiences((prev) => [...prev, makeEmptyExperience()]);
  };

  const updateExperience = (id: string, patch: Partial<WorkExperience>) => {
    setExperiences((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const removeExperience = (id: string) => {
    setExperiences((prev) => {
      const next = prev.filter((e) => e.id !== id);
      return next.length === 0 ? [makeEmptyExperience()] : next;
    });
    // Phase 5 Round B E4: focus the "+ Add Work Experience" button — a stable
    // target that survives the removal (unlike the removed row's siblings,
    // which may shift or unmount). rAF defers until React re-renders.
    focusRef(addExpBtnRef);
  };

  const handleSkillKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Phase 3 L-skill-comma: also commit a skill on the comma key so users
    // pasting "React, Node.js, Python" don't end up with one weird tag.
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      // Strip a trailing comma (in case the user typed "React,") before trim.
      const val = skillInput.replace(/,$/, "").trim();
      if (!val) return;
      // Phase 3 H1: was silent at cap; now surface a step-level error so the
      // user understands why nothing is being added.
      if (skills.length >= MAX_SKILLS) {
        setStep2Error(`Maximum ${MAX_SKILLS} skills reached. Remove one to add more.`);
        return;
      }
      if (skills.includes(val)) return;
      setSkills((prev) => [...prev, val]);
      setSkillInput("");
    }
  };

  const removeSkill = (tag: string) => {
    setSkills((prev) => prev.filter((s) => s !== tag));
    // Phase 3 H1: clear the "maximum reached" error when the user makes room.
    setStep2Error(null);
    // Phase 5 Round B E5: return focus to the skill input — the natural next
    // place a user goes after pruning a tag, and a stable target since the
    // input persists across the re-render.
    focusRef(skillInputRef);
  };

  // Phase 1 R1 L1: ALLOWED_IMAGE_TYPES hoisted to module scope (was inline
  // here, re-allocated on every render).
  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type && !ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setSubmitError(
        "Photo must be a JPG, PNG, WEBP, or GIF image.",
      );
      return;
    }
    // Phase 1 R1 M3: 2 MB photo size cap — was unbounded; matches the CV
    // size-guard pattern so users get a clear rejection on oversized files.
    if (file.size > MAX_PHOTO_BYTES) {
      setSubmitError("Photo must be under 2 MB.");
      return;
    }
    setSubmitError(null);
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleCv = (file: File | undefined) => {
    if (!file) return;
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    // Phase 1 R1 M2: was silent return; now surfaces the rejection so the
    // user understands why nothing happened after picking the wrong file.
    if (!allowed.includes(file.type)) {
      setSubmitError("File must be PDF, DOC, or DOCX.");
      return;
    }
    if (file.size > MAX_CV_BYTES) {
      setSubmitError("File must be under 5 MB.");
      return;
    }
    setSubmitError(null);
    setCvFile(file);
  };

  const handleSubmit = async () => {
    setSubmitError(null);

    // Phase 1 R2 H1: safety-net pre-validation. Even though goToStep gates
    // forward jumps, this re-runs every step's validator before submit so
    // a user who somehow bypassed the gate (or whose fields became invalid
    // after stepping forward) can't submit broken data. On failure we move
    // them BACK to the first invalid step + surface its error.
    const s1Err = validateStep1Fields();
    if (s1Err) {
      setStep(1);
      setStep1Error(s1Err);
      scrollToTop();
      return;
    }
    const s2Err = validateStep2Fields();
    if (s2Err) {
      setStep(2);
      setStep2Error(s2Err);
      scrollToTop();
      return;
    }
    const s3Err = validateStep3Fields();
    if (s3Err) {
      setStep(3);
      scrollToTop();
      return;
    }

    // Bridge inherits CV from the source job_application server-side, so
    // the client-side CV requirement is waived in that path.
    if (!cvFile && !isBridgeSubmission) {
      setSubmitError("Please upload your CV to continue");
      return;
    }

    setSubmitting(true);

    try {
      // Extract CV text in the browser when a PDF is attached.
      let cvText = "";
      if (cvFile && cvFile.type === "application/pdf") {
        // Phase 4 G3: only show the extraction label when there's actually
        // a PDF to extract. Non-PDF / no-CV paths jump straight to "Uploading…".
        setSubmitStatus("Extracting CV text…");
        try {
          cvText = await extractPdfText(cvFile);
        } catch {
          // silent — submission still proceeds without searchable text
        }
      }

      const fd = new FormData();
      // Phase 3 H2: auto-derive job_title (= title of the newest experience,
      // which is experiences[0] — users add their current role first, then
      // older roles) and years_experience (= span from earliest start year
      // to latest end year; "Present"/currentlyWorking → current year). The
      // \d{4} regex tolerates "2021", "Jan 2021", "March 2021", etc. Without
      // sending these, the API stored null and browse-talent rendered "—"
      // for every Pakistan-market candidate.
      const derivedJobTitle = experiences[0]?.title?.trim() ?? "";
      const deriveYears = (): number => {
        const currentYear = new Date().getFullYear();
        let earliest = Number.POSITIVE_INFINITY;
        let latest = 0;
        for (const e of experiences) {
          const startMatch = (e.start ?? "").match(/\d{4}/);
          const startYear = startMatch ? Number.parseInt(startMatch[0], 10) : Number.NaN;
          let endYear: number;
          if (e.currentlyWorking) {
            endYear = currentYear;
          } else {
            const endMatch = (e.end ?? "").match(/\d{4}/);
            endYear = endMatch ? Number.parseInt(endMatch[0], 10) : Number.NaN;
          }
          if (!Number.isNaN(startYear)) earliest = Math.min(earliest, startYear);
          if (!Number.isNaN(endYear))   latest   = Math.max(latest, endYear);
        }
        if (earliest === Number.POSITIVE_INFINITY || latest === 0) return 0;
        return Math.max(0, latest - earliest);
      };
      const derivedYears = deriveYears();

      fd.append("first_name",     firstName);
      fd.append("last_name",      lastName);
      fd.append("email",          email);
      fd.append("phone",          phone);
      fd.append("city",           city);
      fd.append("country",        country);
      fd.append("linkedin_url",   linkedinUrl);
      fd.append("github_url",     githubUrl);
      fd.append("website_url",    websiteUrl);
      // Phase 3 H2: send derived job_title + years_experience to populate the
      // API columns that were previously stored as null. role_category and
      // industry remain unsent (null stays — out of scope this round).
      if (derivedJobTitle) fd.append("job_title", derivedJobTitle);
      if (derivedYears > 0) fd.append("years_experience", String(derivedYears));
      fd.append("degree",         degree);
      fd.append("institution",    institution);
      fd.append("summary",        summary);
      fd.append("skills",         JSON.stringify(skills));
      // Serialize work history — strip the local `id`, derive a "dates" string
      // ("2021–Present · 3 yrs"-style format) and split the comma-separated
      // skills string into an array so the modal can render them as tags.
      const expPayload = experiences
        .filter((e) => e.title?.trim() || e.company?.trim())
        .map((e) => {
          const endValue = e.currentlyWorking ? "Present" : (e.end?.trim() ?? "");
          return {
            title:   e.title?.trim()   ?? "",
            company: e.company?.trim() ?? "",
            start:   e.start?.trim()   ?? "",
            end:     endValue,
            dates:   [e.start?.trim(), endValue].filter(Boolean).join(" – "),
            skills:  (e.skills ?? "")
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean),
            description: (e.description ?? "").trim(),
          };
        });
      fd.append("experience", JSON.stringify(expPayload));
      fd.append("availability",   AVAILABILITY_LABEL[availability]   ?? availability);
      fd.append("work_type",      WORK_TYPE_LABEL[workType]          ?? workType);
      fd.append("notice_period",  NOTICE_PERIOD_LABEL[noticePeriod]  ?? noticePeriod);
      fd.append("work_location",  WORK_LOCATION_LABEL[workLocation]  ?? workLocation);
      if (cvText.trim()) fd.append("cv_text", cvText);
      if (cvFile)        fd.append("cv",      cvFile);
      if (photoFile)     fd.append("photo",   photoFile);
      if (bridgeToken)   fd.append("bridgeToken", bridgeToken);

      // Phase 4 G3: flip to "Uploading…" so the user sees the phase change
      // (PDF extraction → network upload). For non-PDF paths this is the
      // first/only status string shown.
      setSubmitStatus("Uploading…");

      // Phase 1 R2 M4: 30s AbortController timeout — without this a stalled
      // request leaves the user stuck on "Submitting…" indefinitely.
      // Abort is surfaced as a distinct user-friendly message in the catch.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch("/api/talent", {
          method: "POST",
          body: fd,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (res.status === 409) {
        setSubmitState("duplicate");
        setSubmitted(true);
        return;
      }

      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        redirect?: boolean;
        redirectUrl?: string;
      };
      // Bridge soft-fail: email already has a talent_profile → server
      // sends 200 with redirect:true so we forward to claim-after-login
      // rather than show a "duplicate" error.
      if (json.redirect && typeof json.redirectUrl === "string") {
        router.push(json.redirectUrl);
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error ?? "Submission failed.");

      setSubmitState("success");
      setSubmitted(true);
    } catch (err) {
      // Phase 1 R2 M4: distinguish timeout/abort from other failures so
      // the user knows to retry vs. contact support.
      if (err instanceof DOMException && err.name === "AbortError") {
        setSubmitError(
          "The request took too long. Please check your connection and try again.",
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
      // Phase 4 G3: clear the phase label so a re-click after error starts
      // with the generic "Submitting…" rather than a stale phase string.
      setSubmitStatus("");
    }
  };

  // Phase 4 D1: refactored from a 16-dep effect that re-bound the
  // beforeunload listener on every keystroke. Now the dirty-check writes a
  // ref (cheap assignment, no add/removeEventListener churn) and the
  // listener binds ONCE on mount. The handler reads the latest dirty + submitted
  // state via the ref at fire-time. Field list is identical to the previous
  // dirty-check — only the binding strategy changed.
  useEffect(() => {
    isDirtyRef.current =
      Boolean(firstName) || Boolean(lastName) || Boolean(email) ||
      Boolean(phone) || Boolean(city) || Boolean(country) ||
      Boolean(linkedinUrl) || Boolean(githubUrl) ||
      Boolean(degree) || Boolean(institution) || Boolean(summary) ||
      Boolean(cvFile) || Boolean(photoFile) ||
      skills.length > 0 ||
      experiences.some((e) => e.title || e.company || e.start || e.end);
  }); // no dep array — runs after every render, just a single ref write

  // Bind the beforeunload listener ONCE per "submitted" state. Reads the
  // dirty-ref at fire-time so it stays current without re-binding on every
  // keystroke. `submitted` is the only dep because that's the "stop warning"
  // flag — when it flips true on success/duplicate, the listener silently
  // returns from the handler (effectively disabled).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (submitted || !isDirtyRef.current) return;
      e.preventDefault();
      // Setting returnValue is required for the browser to actually show
      // the prompt — the literal string is ignored by modern browsers
      // (they show a localized "Leave site?" dialog instead).
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [submitted]);

  // Phase 5 Round B E1: on step change move focus to the new step's heading.
  // Skip first render (focus would yank on page load) and skip while in the
  // submitted state (the success-heading effect below owns focus then).
  useEffect(() => {
    if (isFirstStepRenderRef.current) {
      isFirstStepRenderRef.current = false;
      return;
    }
    if (submitted) return;
    focusRef(stepHeadingRef);
  }, [step, submitted]);

  // Phase 5 Round B E3: on submit success/duplicate move focus to the
  // success/duplicate heading so SR users hear the outcome immediately.
  useEffect(() => {
    if (!submitted) return;
    focusRef(successHeadingRef);
  }, [submitted]);

  return (
    <>
      <Navbar />
      <div id="main" className="bta-root">
        <div className="bat-outer">
          <GridBackground />
        </div>

        <nav className="bta-steps-bar" aria-label="Form steps">
          {/* Phase 5 C2: always-rendered SR-only step counter so screen-reader
              users hear the current step regardless of viewport size (the
              visible .bta-step-counter is mobile-only via display:none on
              desktop in the styled-jsx CSS). */}
          <span className="bta-sr-only">Step {step} of 4: {STEPS[step - 1].label}</span>
          <div className="bta-steps-inner">
            <span className="bta-step-counter">Step {step} · {STEPS[step - 1].label}</span>
            {STEPS.map((s, idx) => (
              <div key={s.num} className="contents">
                <button
                  type="button"
                  className={`bta-step ${step === s.num ? "active" : ""} ${step > s.num ? "done" : ""}`}
                  onClick={() => goToStep(s.num)}
                  aria-current={step === s.num ? "step" : undefined}
                >
                  <span className="bta-step-circle">{s.num}</span>
                  {s.label}
                </button>
                {idx < STEPS.length - 1 && <span className="bta-step-line" />}
              </div>
            ))}
          </div>
        </nav>

        <div className="bta-layout">
          <div>
            <div className="bta-form-card">
              {/* Honeypot — hidden from humans, filled by bots */}
              <input
                type="text"
                name="website_url"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: -9999,
                  width: 0,
                  height: 0,
                  opacity: 0,
                  pointerEvents: "none",
                }}
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
              />
              {submitted ? (
                submitState === "duplicate" ? (
                  <div className="bta-success" style={{ display: "block" }}>
                    <div className="bta-success-ico">👋</div>
                    <h2 className="bta-success-title" ref={successHeadingRef} tabIndex={-1}>
                      Already in our network
                    </h2>
                    <p className="bta-success-sub">
                      You&apos;re already in our talent network! We&apos;ll reach out when the right
                      opportunity comes along.
                    </p>
                    <a
                      href="https://www.linkedin.com/company/remotiv-inc/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bta-success-btn"
                      style={{ background: "#7E47FF", color: "#fff" }}
                      aria-label="Follow us on LinkedIn (opens in new tab)"
                    >
                      Follow us on LinkedIn →
                    </a>
                    <Link
                      href="/talent/login"
                      className="bta-success-btn"
                      style={{
                        background: "#fff",
                        color: "#7E47FF",
                        border: "1.5px solid #7E47FF",
                      }}
                    >
                      Edit or manage your profile →
                    </Link>
                  </div>
                ) : (
                  <div className="bta-success" style={{ display: "block" }}>
                    <div className="bta-success-ico">🎉</div>
                    <h2 className="bta-success-title" ref={successHeadingRef} tabIndex={-1}>
                      You&apos;re in the Network!
                    </h2>
                    <p className="bta-success-sub">
                      Your profile is under review. We&apos;ll notify you once approved and matched.
                    </p>
                    <a
                      href="https://www.linkedin.com/company/remotiv-inc/"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "block",
                        marginTop: 16,
                        fontSize: ".82rem",
                        color: "#7E47FF",
                        fontWeight: 600,
                      }}
                      aria-label="Follow Remotiv on LinkedIn (opens in new tab)"
                    >
                      <span aria-hidden="true">🔗 </span>Follow Remotiv on LinkedIn
                    </a>
                    <Link
                      href="/talent/login"
                      className="bta-success-btn"
                      style={{
                        background: "#fff",
                        color: "#7E47FF",
                        border: "1.5px solid #7E47FF",
                      }}
                    >
                      Edit or manage your profile →
                    </Link>
                    <Link href="/jobs" className="bta-success-btn">
                      Browse Open Jobs →
                    </Link>
                  </div>
                )
              ) : (
                <>
                  {step === 1 && (
                    <div className="bta-form-step active">
                      {isBridgeSubmission && (
                        <div
                          style={{
                            marginBottom: 16,
                            padding: "12px 16px",
                            borderRadius: 12,
                            background: "rgba(126, 71, 255, 0.08)",
                            border: "1px solid rgba(126, 71, 255, 0.25)",
                            color: "#5a2fcf",
                            fontSize: ".88rem",
                            fontWeight: 600,
                          }}
                        >
                          ✓ Pre-filled from your job application — edit if needed.
                        </div>
                      )}
                      {bridgeWarning && (
                        <div
                          style={{
                            marginBottom: 16,
                            padding: "12px 16px",
                            borderRadius: 12,
                            background: "#fff7ed",
                            border: "1px solid #fed7aa",
                            color: "#9a3412",
                            fontSize: ".88rem",
                          }}
                        >
                          {bridgeWarning}
                        </div>
                      )}
                      <div className="bta-form-header">
                        <div className="bta-fh-icon" aria-hidden="true">👤</div>
                        <div>
                          <h2 className="bta-fh-title" ref={stepHeadingRef} tabIndex={-1}>
                            Personal Information
                          </h2>
                          <div className="bta-fh-sub">
                            Tell us who you are — this stays private until matched
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <h3 className="bta-sec-title">Basic Details</h3>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-firstName">
                              First Name <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <div className="bta-input-wrap">
                              <span className="bta-input-icon">
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <title>User</title>
                                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                  <circle cx="12" cy="7" r="4" />
                                </svg>
                              </span>
                              <input
                                id="bta-firstName"
                                type="text"
                                className="bta-input"
                                placeholder="e.g. Sarah"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                                name="given-name"
                                autoComplete="given-name"
                                aria-required="true"
                              />
                            </div>
                          </div>
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-lastName">
                              Last Name <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <input
                              id="bta-lastName"
                              type="text"
                              className="bta-input"
                              placeholder="e.g. Khan"
                              value={lastName}
                              onChange={(e) => setLastName(e.target.value)}
                              name="family-name"
                              autoComplete="family-name"
                              aria-required="true"
                            />
                          </div>
                        </div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-email">
                              Email Address <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <div className="bta-input-wrap">
                              <span className="bta-input-icon">
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <title>Email</title>
                                  <rect x="2" y="4" width="20" height="16" rx="2" />
                                  <path d="m22 7-10 7L2 7" />
                                </svg>
                              </span>
                              <input
                                id="bta-email"
                                type="email"
                                className="bta-input"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                name="email"
                                autoComplete="email"
                                aria-required="true"
                              />
                            </div>
                          </div>
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-phone">
                              Phone Number <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <div className="bta-input-wrap">
                              <span className="bta-input-icon">
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <title>Phone</title>
                                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                                </svg>
                              </span>
                              <input
                                id="bta-phone"
                                type="tel"
                                className="bta-input"
                                placeholder="+92 300 0000000"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                name="tel"
                                autoComplete="tel"
                                aria-required="true"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-city">
                              City <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <input
                              id="bta-city"
                              type="text"
                              className="bta-input"
                              placeholder="e.g. Lahore"
                              value={city}
                              onChange={(e) => setCity(e.target.value)}
                              name="address-level2"
                              autoComplete="address-level2"
                              aria-required="true"
                            />
                          </div>
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-country">
                              Country <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <select
                              id="bta-country"
                              className="bta-select"
                              value={country}
                              onChange={(e) => setCountry(e.target.value)}
                              name="country"
                              autoComplete="country-name"
                              aria-required="true"
                            >
                              <option value="" disabled>
                                Select country
                              </option>
                              {COUNTRIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-linkedin">
                              LinkedIn Profile <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <div className="bta-input-wrap">
                              <span className="bta-input-icon">
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <title>LinkedIn</title>
                                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
                                  <rect x="2" y="9" width="4" height="12" />
                                  <circle cx="4" cy="4" r="2" />
                                </svg>
                              </span>
                              <input
                                id="bta-linkedin"
                                type="url"
                                className="bta-input"
                                placeholder="linkedin.com/in/yourname"
                                value={linkedinUrl}
                                onChange={(e) => setLinkedinUrl(e.target.value)}
                                name="url"
                                autoComplete="url"
                                aria-required="true"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="bta-spacer" />
                        <h3 className="bta-sec-title">Profile Photo</h3>
                        <div className="bta-photo-wrap">
                          <label className="bta-photo-prev">
                            <input
                              ref={photoInputRef}
                              type="file"
                              accept="image/*"
                              onChange={handlePhoto}
                              aria-label="Upload profile photo"
                            />
                            {photoPreview ? (
                              // biome-ignore lint/performance/noImgElement: local preview
                              <img
                                src={photoPreview}
                                alt="Profile preview"
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  objectFit: "cover",
                                  borderRadius: "50%",
                                }}
                              />
                            ) : (
                              "😊"
                            )}
                          </label>
                          <div className="bta-photo-info">
                            <p>
                              Upload a professional headshot. This will be shown to recruiters and
                              companies browsing talent.
                            </p>
                            <span className="bta-photo-btn">Upload Photo</span>
                            {/* Phase 3 M-photo-clear: only render when a photo
                                is selected. Resets state + the file input value
                                so re-picking the same file still triggers onChange. */}
                            {photoFile && (
                              // Phase 5 Round B E5 (deferred): no explicit focus
                              // move on photo-Remove. The native <input type="file">
                              // is display:none so it can't receive focus, and the
                              // <label> wrapping it has no stable id/ref. The
                              // browser falls back to the document body, which is
                              // acceptable here — the user just clicked, so the
                              // implicit focus loss is expected. Revisit if SR
                              // testing surfaces a complaint.
                              <button
                                type="button"
                                onClick={() => {
                                  setPhotoFile(null);
                                  setPhotoPreview(null);
                                  setSubmitError(null);
                                  if (photoInputRef.current) photoInputRef.current.value = "";
                                }}
                                style={{
                                  marginLeft: 10,
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "#7E47FF",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  font: "inherit",
                                  textDecoration: "underline",
                                  fontSize: ".72rem",
                                  letterSpacing: ".06em",
                                  textTransform: "uppercase",
                                }}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      {step1Error && (
                        <div
                          className="bta-form-error"
                          role="alert"
                          ref={step1ErrorRef}
                          tabIndex={-1}
                        >
                          {step1Error}
                        </div>
                      )}
                      <div className="bta-form-footer">
                        <FooterNote />
                        <div className="bta-form-actions">
                          <Link href="/" className="bta-btn-ghost">
                            ← Back to Home
                          </Link>
                          <button
                            type="button"
                            className="bta-btn-next"
                            onClick={handleStep1Next}
                          >
                            Next: Professional Info →
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {step === 2 && (
                    <div className="bta-form-step active">
                      <div className="bta-form-header">
                        <div className="bta-fh-icon" aria-hidden="true">💼</div>
                        <div>
                          <h2 className="bta-fh-title" ref={stepHeadingRef} tabIndex={-1}>
                            Professional Information
                          </h2>
                          <div className="bta-fh-sub">
                            Your role, experience and skills — this powers AI Talent Match
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <h3 className="bta-sec-title">Education</h3>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-degree">
                              Degree / Qualification <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <input
                              id="bta-degree"
                              type="text"
                              className="bta-input"
                              placeholder="e.g. BS Computer Science"
                              value={degree}
                              onChange={(e) => setDegree(e.target.value)}
                              aria-required="true"
                            />
                          </div>
                          <div className="bta-form-group">
                            <label className="bta-label" htmlFor="bta-institution">
                              Institution / University <span className="bta-req" aria-hidden="true">*</span>
                            </label>
                            <input
                              id="bta-institution"
                              type="text"
                              className="bta-input"
                              placeholder="e.g. University"
                              value={institution}
                              onChange={(e) => setInstitution(e.target.value)}
                              aria-required="true"
                            />
                          </div>
                        </div>

                        <div className="bta-spacer" />
                        <h3 className="bta-sec-title">Work Experience</h3>
                        <div>
                          {experiences.map((exp, idx) => (
                            <div key={exp.id} className="bta-exp-entry">
                              <button
                                type="button"
                                className="bta-exp-remove"
                                onClick={() => removeExperience(exp.id)}
                                aria-label={`Remove experience ${idx + 1}`}
                              >
                                ✕
                              </button>
                              <div className="bta-grid-2">
                                <div className="bta-form-group">
                                  <label className="bta-label" htmlFor={`exp-${exp.id}-title`}>
                                    Job Title <span className="bta-req" aria-hidden="true">*</span>
                                  </label>
                                  <input
                                    id={`exp-${exp.id}-title`}
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. Senior Software Engineer"
                                    value={exp.title}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { title: e.target.value })
                                    }
                                    aria-required="true"
                                    aria-label={`Experience ${idx + 1} job title`}
                                  />
                                </div>
                                <div className="bta-form-group">
                                  <label className="bta-label" htmlFor={`exp-${exp.id}-company`}>
                                    Company <span className="bta-req" aria-hidden="true">*</span>
                                  </label>
                                  <input
                                    id={`exp-${exp.id}-company`}
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. Remotiv"
                                    value={exp.company}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { company: e.target.value })
                                    }
                                    aria-required="true"
                                    aria-label={`Experience ${idx + 1} company`}
                                  />
                                </div>
                              </div>
                              <div className="bta-grid-2">
                                <div className="bta-form-group">
                                  <label className="bta-label" htmlFor={`exp-${exp.id}-start`}>
                                    Start Date <span className="bta-req" aria-hidden="true">*</span>
                                  </label>
                                  <input
                                    id={`exp-${exp.id}-start`}
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. 2021"
                                    value={exp.start}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { start: e.target.value })
                                    }
                                    aria-required="true"
                                    aria-label={`Experience ${idx + 1} start date`}
                                  />
                                </div>
                                <div className="bta-form-group">
                                  <label className="bta-label" htmlFor={`exp-${exp.id}-end`}>End Date</label>
                                  <input
                                    id={`exp-${exp.id}-end`}
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. 2024 or Present"
                                    value={exp.end}
                                    disabled={exp.currentlyWorking}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { end: e.target.value })
                                    }
                                    style={
                                      exp.currentlyWorking
                                        ? { opacity: 0.5, cursor: "not-allowed" }
                                        : undefined
                                    }
                                    aria-label={`Experience ${idx + 1} end date`}
                                  />
                                </div>
                              </div>
                              <label
                                style={{
                                  display: "flex",
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: 8,
                                  fontSize: ".78rem",
                                  color: "#555",
                                  cursor: "pointer",
                                  fontFamily: "'DM Sans', sans-serif",
                                  marginTop: -6,
                                  marginBottom: 14,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={exp.currentlyWorking}
                                  onChange={(ev) =>
                                    // Phase 3 L-uncheck-restore: don't clear
                                    // `end` when ticking — just toggle the
                                    // flag. The end input is already visually
                                    // disabled via the existing style above;
                                    // unticking now restores the original value
                                    // (vs. forcing the user to re-type).
                                    updateExperience(exp.id, {
                                      currentlyWorking: ev.target.checked,
                                    })
                                  }
                                  style={{ width: 18, height: 18, cursor: "pointer" }}
                                />
                                I currently work here
                              </label>
                              <div className="bta-form-group">
                                <label className="bta-label" htmlFor={`exp-${exp.id}-skills`}>
                                  Skills Used in This Role <span className="bta-opt">optional</span>
                                </label>
                                <input
                                  id={`exp-${exp.id}-skills`}
                                  type="text"
                                  className="bta-input"
                                  placeholder="e.g. React, Node.js, AWS (comma separated)"
                                  value={exp.skills}
                                  onChange={(e) =>
                                    updateExperience(exp.id, { skills: e.target.value })
                                  }
                                  aria-label={`Experience ${idx + 1} skills used`}
                                />
                              </div>
                              <div className="bta-form-group">
                                <label className="bta-label" htmlFor={`exp-${exp.id}-description`}>
                                  Description <span className="bta-opt">optional</span>
                                </label>
                                <textarea
                                  id={`exp-${exp.id}-description`}
                                  className="bta-textarea"
                                  placeholder="What you owned, shipped, and the impact (metrics, scale, results)…"
                                  value={exp.description}
                                  onChange={(e) =>
                                    updateExperience(exp.id, { description: e.target.value })
                                  }
                                  maxLength={1000}
                                  aria-label={`Experience ${idx + 1} description`}
                                />
                                <p
                                  className="bta-skill-hint"
                                  aria-live="polite"
                                  style={{
                                    color: exp.description.length >= 1000 ? "#dc2626" : "#888",
                                    textAlign: "right",
                                  }}
                                >
                                  {exp.description.length} / 1000
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="bta-add-exp-btn"
                          onClick={addExperience}
                          ref={addExpBtnRef}
                        >
                          + Add Work Experience
                        </button>

                        <div className="bta-spacer" />
                        <h3 className="bta-sec-title">Skills &amp; Summary</h3>
                        <div className="bta-form-group" style={{ marginBottom: 6 }}>
                          <label className="bta-label" htmlFor="bta-skillInput">
                            Skills &amp; Expertise <span className="bta-opt">optional</span>
                          </label>
                          <div className="bta-skills-box">
                            {skills.map((tag) => (
                              <span key={tag} className="bta-stag">
                                {tag}
                                <button
                                  type="button"
                                  className="bta-stag-x"
                                  onClick={() => removeSkill(tag)}
                                  aria-label={`Remove ${tag}`}
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                            <input
                              id="bta-skillInput"
                              ref={skillInputRef}
                              className="bta-skill-inp"
                              type="text"
                              placeholder="Add a skill, press Enter..."
                              value={skillInput}
                              onChange={(e) => setSkillInput(e.target.value)}
                              onKeyDown={handleSkillKey}
                              maxLength={50}
                              aria-describedby="bta-skill-hint"
                            />
                          </div>
                          <p id="bta-skill-hint" className="bta-skill-hint">
                            Type a skill and press Enter to add. Up to 15 skills.
                          </p>
                        </div>
                        <div className="bta-spacer" />
                        <div className="bta-form-group">
                          <label className="bta-label" htmlFor="bta-summary">
                            Professional Summary <span className="bta-opt">optional</span>
                          </label>
                          <textarea
                            id="bta-summary"
                            className="bta-textarea"
                            placeholder="Write a short bio — your experience, what you specialize in, and what opportunities you're looking for."
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                            maxLength={2000}
                          />
                          {/* Phase 3 L-summary-max: visible char counter
                              mirrors the maxLength + the Phase 2 server cap.
                              Hidden until the user starts typing so the empty
                              optional field doesn't get a counter chrome. */}
                          {summary.length > 0 && (
                            <div
                              style={{
                                marginTop: 4,
                                fontSize: ".7rem",
                                color: summary.length >= 2000 ? "#dc2626" : "#888",
                                textAlign: "right",
                              }}
                              aria-live="polite"
                            >
                              {summary.length} / 2000
                            </div>
                          )}
                        </div>
                      </div>
                      {step2Error && (
                        <div
                          className="bta-form-error"
                          role="alert"
                          ref={step2ErrorRef}
                          tabIndex={-1}
                        >
                          {step2Error}
                        </div>
                      )}
                      <div className="bta-form-footer">
                        <FooterNote />
                        <div className="bta-form-actions">
                          <button
                            type="button"
                            className="bta-btn-ghost"
                            onClick={() => goToStep(1)}
                          >
                            ← Back
                          </button>
                          <button
                            type="button"
                            className="bta-btn-next"
                            onClick={handleStep2Next}
                          >
                            Next: Work Preferences →
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {step === 3 && (
                    <div className="bta-form-step active">
                      <div className="bta-form-header">
                        <div className="bta-fh-icon" aria-hidden="true">⚙️</div>
                        <div>
                          <h2 className="bta-fh-title" ref={stepHeadingRef} tabIndex={-1}>
                            Work Preferences
                          </h2>
                          <div className="bta-fh-sub">
                            How and when you want to work — helps us find your best match
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <h3 className="bta-sec-title">Availability Status</h3>
                        <div className="bta-form-group" style={{ marginBottom: 20 }}>
                          <div className="bta-label">
                            Current Availability <span className="bta-req">*</span>
                          </div>
                          <p
                            style={{
                              fontSize: ".75rem",
                              color: "#888",
                              marginBottom: 10,
                              lineHeight: 1.6,
                            }}
                          >
                            This shows the Available / Unavailable indicator on your profile card.
                          </p>
                          <div className="bta-radio-group">
                            <label
                              className={`bta-radio-opt ${availability === "available" ? "sel" : ""}`}
                            >
                              <input
                                type="radio"
                                name="bta-status"
                                checked={availability === "available"}
                                onChange={() => setAvailability("available")}
                              />
                              <span className="bta-rdot" />
                              Available Now
                            </label>
                            <label
                              className={`bta-radio-opt ${availability === "unavailable" ? "sel" : ""}`}
                            >
                              <input
                                type="radio"
                                name="bta-status"
                                checked={availability === "unavailable"}
                                onChange={() => setAvailability("unavailable")}
                              />
                              <span className="bta-rdot" />
                              Not Currently Available
                            </label>
                          </div>
                        </div>

                        <h3 className="bta-sec-title">Work Setup</h3>
                        <div className="bta-form-group" style={{ marginBottom: 20 }}>
                          <div className="bta-label">
                            Work Type <span className="bta-req">*</span>
                          </div>
                          <div className="bta-radio-group">
                            {(
                              [
                                ["fullTime", "Full-time"],
                                ["partTime", "Part-time"],
                                ["contract", "Contract"],
                                ["any", "Open to Any"],
                              ] as const
                            ).map(([val, label]) => (
                              <label
                                key={val}
                                className={`bta-radio-opt ${workType === val ? "sel" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="bta-wt"
                                  checked={workType === val}
                                  onChange={() => setWorkType(val)}
                                />
                                <span className="bta-rdot" />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="bta-form-group" style={{ marginBottom: 20 }}>
                          <div className="bta-label">
                            Notice Period <span className="bta-req">*</span>
                          </div>
                          <div className="bta-radio-group">
                            {(
                              [
                                ["immediate", "Immediate"],
                                ["2weeks", "2 Weeks"],
                                ["1month", "1 Month"],
                                ["negotiable", "Negotiable"],
                              ] as const
                            ).map(([val, label]) => (
                              <label
                                key={val}
                                className={`bta-radio-opt ${noticePeriod === val ? "sel" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="bta-av"
                                  checked={noticePeriod === val}
                                  onChange={() => setNoticePeriod(val)}
                                />
                                <span className="bta-rdot" />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="bta-form-group" style={{ marginBottom: 20 }}>
                          <div className="bta-label">
                            Work Location <span className="bta-req">*</span>
                          </div>
                          <div className="bta-radio-group">
                            {(
                              [
                                ["remote", "Remote Only"],
                                ["hybrid", "Open to Hybrid"],
                                ["onsite", "Open to Onsite"],
                              ] as const
                            ).map(([val, label]) => (
                              <label
                                key={val}
                                className={`bta-radio-opt ${workLocation === val ? "sel" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="bta-lc"
                                  checked={workLocation === val}
                                  onChange={() => setWorkLocation(val)}
                                />
                                <span className="bta-rdot" />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-footer">
                        <FooterNote />
                        <div className="bta-form-actions">
                          <button
                            type="button"
                            className="bta-btn-ghost"
                            onClick={() => goToStep(2)}
                          >
                            ← Back
                          </button>
                          <button
                            type="button"
                            className="bta-btn-next"
                            onClick={() => goToStep(4)}
                          >
                            Next: Upload CV →
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {step === 4 && (
                    <div className="bta-form-step active">
                      <div className="bta-form-header">
                        <div className="bta-fh-icon" aria-hidden="true">📄</div>
                        <div>
                          <h2 className="bta-fh-title" ref={stepHeadingRef} tabIndex={-1}>
                            CV / Resume Upload
                          </h2>
                          <div className="bta-fh-sub">
                            Upload your latest CV — reviewed by our team and matched employers
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        {isBridgeSubmission && (
                          <div
                            style={{
                              marginBottom: 16,
                              padding: "14px 18px",
                              borderRadius: 12,
                              background: "rgba(73, 215, 167, 0.10)",
                              border: "1px solid rgba(73, 215, 167, 0.35)",
                              color: "#0f6b4a",
                              fontSize: ".9rem",
                              fontWeight: 600,
                            }}
                          >
                            ✓ Your CV from your job application will be used. No re-upload needed.
                          </div>
                        )}
                        {/* Bridge mode skips the entire CV upload UI: the CV
                            from the source job_application is inherited
                            server-side (api/talent/route.ts uses
                            bridgeContext.cvPath when bridgeContext is set).
                            Replacing the inherited CV would require editing
                            the original job application — out of scope here. */}
                        {!isBridgeSubmission && (
                          <>
                            <h3 className="bta-sec-title">
                              Upload your CV <span className="bta-req" aria-hidden="true">*</span>
                            </h3>
                            {/** biome-ignore lint/a11y/noStaticElementInteractions: drag handlers on drop zone */}
                            <div
                              className={`bta-upload-zone ${cvDragOver ? "drag-over" : ""}`}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setCvDragOver(true);
                          }}
                          onDragLeave={() => setCvDragOver(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setCvDragOver(false);
                            handleCv(e.dataTransfer.files?.[0]);
                          }}
                        >
                          <input
                            ref={cvInputRef}
                            type="file"
                            accept="application/pdf"
                            onChange={(e) => handleCv(e.target.files?.[0])}
                            aria-label="Upload CV (PDF only)"
                          />
                          <div className="bta-upload-ico">📄</div>
                          <div className="bta-upload-title">
                            {cvFile ? cvFile.name : "Drag & drop your CV here"}
                          </div>
                          <div className="bta-upload-sub">
                            {cvFile ? (
                              `${(cvFile.size / 1024).toFixed(0)} KB — ready to submit`
                            ) : (
                              <>
                                or{" "}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cvInputRef.current?.click();
                                  }}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    padding: 0,
                                    margin: 0,
                                    color: "#7E47FF",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    font: "inherit",
                                    textDecoration: "underline",
                                  }}
                                >
                                  browse to upload
                                </button>
                              </>
                            )}
                          </div>
                          <div className="bta-upload-fmt">Required — PDF only (max 5 MB)</div>
                        </div>
                        {/* Phase 3 M-cv-clear (fixed): Remove button moved
                            OUTSIDE the .bta-upload-zone. The zone's child
                            <input type="file"> has position:absolute; inset:0
                            (CSS L1891) so it overlays everything inside the
                            zone — clicking ANY descendant first hits the
                            invisible input, re-opening the picker. Mirrors
                            the photo Remove pattern (sibling of the label,
                            not nested inside it). */}
                        {cvFile && (
                          <div
                            style={{
                              marginTop: 10,
                              fontSize: ".78rem",
                              color: "#888",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 10,
                            }}
                          >
                            <span>Selected: {cvFile.name}</span>
                            {/* Phase 5 Round B E5 (deferred): no explicit
                                focus move on CV-Remove. The CV <input
                                type="file"> exists in the drop-zone but is
                                covered by an absolute overlay so focusing it
                                is unreliable, and the drop-zone div is not a
                                natural focus target. The user clicked Remove
                                from a known position; letting focus fall
                                back to the body is acceptable. Revisit if SR
                                testing surfaces a complaint. */}
                            <button
                              type="button"
                              onClick={() => {
                                setCvFile(null);
                                setSubmitError(null);
                                if (cvInputRef.current) cvInputRef.current.value = "";
                              }}
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                color: "#7E47FF",
                                fontWeight: 600,
                                cursor: "pointer",
                                font: "inherit",
                                textDecoration: "underline",
                                fontSize: ".72rem",
                                letterSpacing: ".06em",
                                textTransform: "uppercase",
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                          </>
                        )}

                        <div className="bta-spacer" />
                        <h3 className="bta-sec-title">GitHub Profile</h3>
                        <div className="bta-form-group">
                          <label className="bta-label" htmlFor="bta-github">
                            GitHub URL{" "}
                            <span className="bta-opt">optional — for engineers</span>
                          </label>
                          <div className="bta-input-wrap">
                            <span className="bta-input-icon">
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden="true"
                              >
                                <title>GitHub</title>
                                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                              </svg>
                            </span>
                            <input
                              id="bta-github"
                              type="url"
                              className="bta-input"
                              placeholder="github.com/yourusername"
                              value={githubUrl}
                              onChange={(e) => setGithubUrl(e.target.value)}
                              name="github"
                              autoComplete="url"
                            />
                          </div>
                        </div>

                        <div className="bta-spacer" />
                        <div className="bta-info-box">
                          <span className="bta-info-box-ico">✦</span>
                          <div>
                            <div className="bta-info-box-title">What Happens Next</div>
                            <div className="bta-info-box-body">
                              Our team reviews your profile within 24–48 hours. If approved, you&apos;ll
                              be live in the Remotiv talent pool and our AI will start matching
                              you to relevant opportunities from 100+ partner companies.
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-footer">
                        <FooterNote />
                        <div className="bta-form-actions">
                          <button
                            type="button"
                            className="bta-btn-ghost"
                            onClick={() => goToStep(3)}
                          >
                            ← Back
                          </button>
                          {submitError && (
                            <span
                              style={{
                                fontSize: ".75rem",
                                color: "#ef4444",
                                marginRight: 12,
                                alignSelf: "center",
                              }}
                            >
                              {submitError}
                            </span>
                          )}
                          <button
                            type="button"
                            className="bta-btn-submit"
                            onClick={handleSubmit}
                            disabled={submitting}
                            aria-busy={submitting}
                          >
                            {submitting ? (submitStatus || "Submitting…") : "Submit Profile"}
                            {!submitting && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <title>Arrow</title>
                                <path d="M5 12h14" />
                                <path d="m12 5 7 7-7 7" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                      <p className="bta-tos-text">
                        By submitting your profile, you agree that your information may be shared
                        with verified companies and hiring teams on the Remotiv platform who have
                        an active subscription to access talent profiles.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <aside className="bta-sidebar">
            <div className="bta-sidebar-card">
              <div className="bta-sidebar-title">Why Join Remotiv?</div>
              {PERKS.map((perk) => (
                <div key={perk.title} className="bta-perk">
                  <div className="bta-perk-ico">{perk.icon}</div>
                  <div>
                    <div className="bta-perk-title">{perk.title}</div>
                    <div className="bta-perk-sub">{perk.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="bta-sidebar-card">
              <div className="bta-sstat-label">Talent Network</div>
              <div className="bta-sstat-num">
                <em>1M+</em>
              </div>
              <div className="bta-sstat-desc">
                Professionals already in the Remotiv network, placed with top US and global
                companies.
              </div>
              <div className="bta-divider" />
              <div className="bta-sstat-label">Average Time to Hire</div>
              <div className="bta-sstat-num">
                <em>2</em> weeks
              </div>
              <div className="bta-sstat-desc">
                From profile submission to first interview — our AI speeds up the process
                dramatically.
              </div>
            </div>
          </aside>
        </div>
      </div>

    </>
  );
}
