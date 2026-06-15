"use client";

import "./remote-ready.css";
import Link from "next/link";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isValidEmail } from "@/app/admin/lib/validators";
import { Navbar } from "@/components/navbar";

// Validation thresholds — keep client and server in agreement (server caps
// CV/photo at 5 MB via MAX_CV_BYTES / MAX_PHOTO_BYTES in the API route).
const MAX_CV_SIZE_BYTES = 5 * 1024 * 1024;
const BIO_MIN_CHARS = 50;
const SKILLS_MIN = 3;
const SKILLS_MAX = 20;
const PHONE_MIN_DIGITS = 7;
const RATE_MIN = 10;
const RATE_MAX = 999;

// ── Types ────────────────────────────────────────────────────

type EmploymentEntry = {
  id: number;
  title: string;
  company: string;
  start: string;
  end: string;
  description: string;
};

type PortfolioEntry = {
  id: number;
  projectTitle: string;
  role: string;
  url: string;
  description: string;
};

type LanguageEntry = {
  id: number;
  name: string;
  level: "Native" | "Fluent" | "Professional" | "Basic";
};

type HoursOpt = "more30" | "20to30" | "less20";
type WorkTypeOpt = "contractToHire" | "contractOnly" | "fullTime" | "partTime";
type AvailabilityOpt = "now" | "twoWeeks" | "future";

const STEPS = [
  { num: 1, label: "Personal Info" },
  { num: 2, label: "Professional Profile" },
  { num: 3, label: "Work Preferences" },
  { num: 4, label: "Verification & Documents" },
] as const;

const COUNTRIES = [
  "Pakistan",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "United Arab Emirates",
  "India",
  "Singapore",
  "Other",
];

const TIMEZONE_REGION_ORDER = [
  "Africa",
  "America",
  "Asia",
  "Atlantic",
  "Australia",
  "Europe",
  "Indian",
  "Pacific",
] as const;
type TimezoneRegion = (typeof TIMEZONE_REGION_ORDER)[number];

const ALL_TIMEZONES: string[] =
  typeof Intl !== "undefined" && Intl.supportedValuesOf
    ? Intl.supportedValuesOf("timeZone")
    : [
        "Asia/Karachi",
        "Asia/Dubai",
        "Asia/Kolkata",
        "Asia/Singapore",
        "Europe/London",
        "Europe/Berlin",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
      ];

const GROUPED_TIMEZONES = TIMEZONE_REGION_ORDER.reduce(
  (acc, region) => {
    acc[region] = ALL_TIMEZONES.filter((tz) => tz.startsWith(`${region}/`));
    return acc;
  },
  {} as Record<TimezoneRegion, string[]>,
);

const LANGUAGE_LEVELS: LanguageEntry["level"][] = ["Native", "Fluent", "Professional", "Basic"];

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
];

const HOURS_LABEL: Record<HoursOpt, string> = {
  more30: "More than 30 hrs/week",
  "20to30": "20-30 hrs/week",
  less20: "Less than 20 hrs/week",
};

const WORK_TYPE_LABEL: Record<WorkTypeOpt, string> = {
  contractToHire: "Open to contract-to-hire",
  contractOnly:   "Contract only",
  fullTime:       "Full-time",
  partTime:       "Part-time",
};

const AVAIL_LABEL: Record<AvailabilityOpt, string> = {
  now:      "Available Now",
  twoWeeks: "Available within 2 weeks",
  future:   "Available from a future date",
};

// ── Hero grid background ─────────────────────────────────────

function GridBackground({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ x: number[]; y: number[]; w: number; h: number }>({
    x: [], y: [], w: 0, h: 0,
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

  return (
    <div ref={wrapRef} className="bat-wrap">
      <svg
        className="bat-grid-svg"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        viewBox={`0 0 ${lines.w} ${lines.h}`}
        preserveAspectRatio="none"
      >
        <title>Background grid</title>
        {lines.x.map((x) => (
          <line key={`vx-${x}`} x1={x} y1={0} x2={x} y2={lines.h} stroke="#ccc8c0" strokeWidth="0.5" />
        ))}
        {lines.y.map((y) => (
          <line key={`hy-${y}`} x1={0} y1={y} x2={lines.w} y2={y} stroke="#ccc8c0" strokeWidth="0.5" />
        ))}
      </svg>
      <div className="bat-content">{children}</div>
    </div>
  );
}

function FooterNote() {
  return (
    <div className="bta-footer-note">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <title>Lock</title>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      Your data is encrypted and only shared with matched employers. Questions?
      Email <a href="mailto:talent@remotiv.work">talent@remotiv.work</a>.
    </div>
  );
}

// ── Page component ───────────────────────────────────────────

export default function RemoteReadyPage() {
  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  // Mirrors /become-a-talent's pattern — discriminated union lets the
  // submitted view branch into "Already in our network" vs. the normal
  // success card. `submitted` stays as the outer toggle for back-compat.
  type SubmitState = "form" | "success" | "duplicate";
  const [submitState, setSubmitState] = useState<SubmitState>("form");
  const [submitting, setSubmitting] = useState(false);

  const [firstName, setFirstName]   = useState("");
  const [lastName, setLastName]     = useState("");
  const [email, setEmail]           = useState("");
  const [phone, setPhone]           = useState("");
  const [city, setCity]             = useState("");
  const [country, setCountry]       = useState("");
  const [timezone, setTimezone]     = useState("Asia/Karachi");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const [jobTitles, setJobTitles] = useState("");
  const [bio, setBio]             = useState("");
  const [skills, setSkills]       = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");
  const [employment, setEmployment] = useState<EmploymentEntry[]>([]);
  const [eduInstitution, setEduInstitution] = useState("");
  const [eduDegree, setEduDegree]           = useState("");
  const [eduStart, setEduStart]             = useState("");
  const [eduEnd, setEduEnd]                 = useState("");
  const [portfolio, setPortfolio] = useState<PortfolioEntry[]>([]);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  const [hourlyRate, setHourlyRate]   = useState("");
  const [hoursPerWeek, setHoursPerWeek] = useState<HoursOpt>("more30");
  const [workType, setWorkType]       = useState<WorkTypeOpt>("contractToHire");
  const [availability, setAvailability] = useState<AvailabilityOpt>("now");
  const [futureDate, setFutureDate]   = useState("");
  const [languages, setLanguages] = useState<LanguageEntry[]>([
    { id: Date.now(), name: "English", level: "Fluent" },
  ]);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  const [cvFile, setCvFile]           = useState<File | null>(null);
  const [cvDragOver, setCvDragOver]   = useState(false);
  const cvInputRef = useRef<HTMLInputElement>(null);
  const [photoFile, setPhotoFile]     = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [step4Error, setStep4Error]   = useState<string | null>(null);

  // Honeypot — bots fill this hidden input; humans leave it blank. Mirrors
  // contact/book-a-meeting's pattern. Server also checks via the same field
  // name (website_url) and silently fake-succeeds.
  const [websiteUrl, setWebsiteUrl] = useState("");

  // M3 — synchronous double-submit lock (microsecond race with React's
  // disabled-button commit). Mirrors contact/book-a-meeting's pattern.
  const submitLockRef = useRef(false);

  // M5 — track the furthest step the user has actually advanced past via a
  // Next click. The visual "done" indicator only marks steps reached this way,
  // not steps skipped through via the step-jump button.
  const [highestStep, setHighestStep] = useState(1);

  // Inline notice for the skills field — "Skill already added" when the user
  // hits Enter on a duplicate. Auto-dismisses after 2s.
  const [skillError, setSkillError] = useState<string | null>(null);
  useEffect(() => {
    if (!skillError) return;
    const t = setTimeout(() => setSkillError(null), 2000);
    return () => clearTimeout(t);
  }, [skillError]);

  function validateStep1(): string | null {
    const phoneDigits = phone.replace(/\D/g, "");
    // Reject lookalikes (evil.tld/linkedin.com); require the canonical
    // linkedin.com/in/ profile path.
    const linkedinValid = /^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(linkedinUrl.trim());
    if (!firstName.trim()) return "First name is required";
    if (!lastName.trim())  return "Last name is required";
    if (!email.trim() || !isValidEmail(email.trim())) return "Please enter a valid email address";
    if (!phone.trim() || phoneDigits.length < PHONE_MIN_DIGITS) return "Please enter a valid phone number";
    if (!city.trim())     return "City is required";
    if (!country.trim())  return "Country is required";
    if (!timezone.trim()) return "Time zone is required";
    if (!linkedinUrl.trim() || !linkedinValid) {
      return "Please enter a valid LinkedIn URL (linkedin.com/in/...)";
    }
    return null;
  }

  function validateStep2(): string | null {
    if (!jobTitles.trim()) return "Job titles are required";
    if (bio.trim().length < BIO_MIN_CHARS) return `Bio must be at least ${BIO_MIN_CHARS} characters`;
    if (bio.trim().length > 2000) return "Bio must be 2000 characters or fewer.";
    if (skills.length < SKILLS_MIN) return `Add at least ${SKILLS_MIN} skill tags`;
    const validEmployment = employment.filter((e) => e.title.trim() || e.company.trim());
    if (validEmployment.length === 0) return "Add at least 1 employment entry";
    if (!eduInstitution.trim() || !eduDegree.trim()) {
      return "Education institution and degree are required";
    }
    for (const p of portfolio) {
      const u = p.url.trim();
      if (u && !/^https?:\/\//i.test(u)) {
        return "Portfolio URLs must start with https://";
      }
    }
    return null;
  }

  function validateStep3(): string | null {
    const rateNum = Number.parseFloat(hourlyRate);
    if (!hourlyRate.trim() || !Number.isFinite(rateNum) || rateNum < 0) {
      return "Please enter a valid hourly rate";
    }
    if (rateNum < RATE_MIN) {
      return `Hourly rate must be at least $${RATE_MIN}`;
    }
    if (rateNum > RATE_MAX) {
      return `Hourly rate must not exceed $${RATE_MAX}`;
    }
    if (availability === "future" && !futureDate) {
      return "Please choose a future availability date";
    }
    if (availability === "future" && futureDate) {
      const chosen = new Date(futureDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (chosen <= today) {
        return "Please choose a future date (tomorrow or later)";
      }
    }
    if (languages.length === 0) return "Add at least 1 language";
    if (languages.some((l) => !l.name.trim())) return "Every language entry needs a name";
    return null;
  }

  function setStepError(stepNum: number, msg: string | null) {
    if (stepNum === 1) setStep1Error(msg);
    else if (stepNum === 2) setStep2Error(msg);
    else if (stepNum === 3) setStep3Error(msg);
    else if (stepNum === 4) setStep4Error(msg);
  }

  function scrollToForm() {
    if (typeof window === "undefined") return;
    const target = document.querySelector(".bta-form-card");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Focus the new step's heading after React renders the new step. Mirrors
  // contact/book-a-meeting's focus-on-success pattern — keyboard + SR users
  // land in the new content instead of losing focus to <body>.
  function focusStepHeader() {
    if (typeof window === "undefined") return;
    setTimeout(() => {
      document.getElementById("bta-fh-title")?.focus();
    }, 50);
  }

  // Focus the error region after a validation failure so SR users hear it and
  // keyboard users can read it without hunting.
  function focusStepError() {
    if (typeof window === "undefined") return;
    setTimeout(() => {
      document.getElementById("bta-step-error")?.focus();
    }, 50);
  }

  function goToStep(target: number) {
    if (target < 1 || target > STEPS.length) return;
    if (target > step) {
      const validators = [validateStep1, validateStep2, validateStep3];
      for (let s = 1; s < target; s++) {
        const err = validators[s - 1]();
        if (err) {
          setStep1Error(null);
          setStep2Error(null);
          setStep3Error(null);
          setStepError(s, err);
          setStep(s);
          scrollToForm();
          focusStepError();
          return;
        }
      }
    }
    setStep(target);
    scrollToForm();
    focusStepHeader();
  }

  function handleStep1Next() {
    const err = validateStep1();
    if (err) { setStep1Error(err); focusStepError(); return; }
    setStep1Error(null);
    setStep(2);
    setHighestStep((prev) => Math.max(prev, 2));
    scrollToForm();
    focusStepHeader();
  }

  function handleStep2Next() {
    const err = validateStep2();
    if (err) { setStep2Error(err); focusStepError(); return; }
    setStep2Error(null);
    setStep(3);
    setHighestStep((prev) => Math.max(prev, 3));
    scrollToForm();
    focusStepHeader();
  }

  function handleStep3Next() {
    const err = validateStep3();
    if (err) { setStep3Error(err); focusStepError(); return; }
    setStep3Error(null);
    setStep(4);
    setHighestStep((prev) => Math.max(prev, 4));
    scrollToForm();
    focusStepHeader();
  }

  function addEmployment() {
    setEmployment((prev) => [
      ...prev,
      { id: Date.now(), title: "", company: "", start: "", end: "", description: "" },
    ]);
  }
  function updateEmployment(id: number, patch: Partial<EmploymentEntry>) {
    setEmployment((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function removeEmployment(id: number) {
    setEmployment((prev) => prev.filter((e) => e.id !== id));
  }

  function addPortfolio() {
    setPortfolio((prev) => [
      ...prev,
      { id: Date.now(), projectTitle: "", role: "", url: "", description: "" },
    ]);
  }
  function updatePortfolio(id: number, patch: Partial<PortfolioEntry>) {
    setPortfolio((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }
  function removePortfolio(id: number) {
    setPortfolio((prev) => prev.filter((p) => p.id !== id));
  }

  function addLanguage() {
    setLanguages((prev) => [...prev, { id: Date.now(), name: "", level: "Fluent" }]);
  }
  function updateLanguage(id: number, patch: Partial<LanguageEntry>) {
    setLanguages((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLanguage(id: number) {
    setLanguages((prev) => prev.filter((l) => l.id !== id));
  }

  function handleSkillKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = skillInput.trim();
    if (!v || skills.length >= SKILLS_MAX) return;
    if (skills.includes(v)) {
      setSkillError("Skill already added");
      return;
    }
    setSkillError(null);
    setSkills((prev) => [...prev, v]);
    setSkillInput("");
  }
  function removeSkill(tag: string) {
    setSkills((prev) => prev.filter((s) => s !== tag));
  }

  function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type && !ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setStep4Error("Photo must be a JPG, PNG, WEBP, or GIF image.");
      return;
    }
    setStep4Error(null);
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  function handleCv(file: File | undefined) {
    if (!file) return;
    const allowed = ["application/pdf"];
    if (!allowed.includes(file.type)) {
      setStep4Error("CV must be a PDF file.");
      return;
    }
    if (file.size > MAX_CV_SIZE_BYTES) {
      setStep4Error("CV must be under 5 MB.");
      return;
    }
    setStep4Error(null);
    setCvFile(file);
  }

  async function handleSubmit() {
    // M3: synchronous double-submit guard — disabled={submitting} only flips
    // after React commits, leaving a microsecond race window.
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
    setStep1Error(null);
    setStep2Error(null);
    setStep3Error(null);
    setStep4Error(null);

    // Honeypot — silently fake success for bots that filled the hidden field.
    // No network call, no validation feedback (so the bot doesn't learn it was rejected).
    if (websiteUrl.trim().length > 0) {
      setSubmitted(true);
      return;
    }

    const validators: { num: number; run: () => string | null }[] = [
      { num: 1, run: validateStep1 },
      { num: 2, run: validateStep2 },
      { num: 3, run: validateStep3 },
    ];
    for (const v of validators) {
      const err = v.run();
      if (err) {
        setStepError(v.num, err);
        setStep(v.num);
        scrollToForm();
        focusStepError();
        return;
      }
    }

    setSubmitting(true);

    const employmentHistory = employment
      .filter((e) => e.title.trim() || e.company.trim())
      .map((e) => ({
        title:       e.title.trim(),
        company:     e.company.trim(),
        dates:       [e.start.trim(), e.end.trim()].filter(Boolean).join(" — "),
        description: e.description.trim(),
      }));

    const educationObj = {
      institution: eduInstitution.trim(),
      degree:      eduDegree.trim(),
      dates:       [eduStart.trim(), eduEnd.trim()].filter(Boolean).join("–"),
    };

    const portfolioList = portfolio
      .filter(
        (p) =>
          p.projectTitle.trim() ||
          p.role.trim() ||
          p.url.trim() ||
          p.description.trim(),
      )
      .map((p) => ({
        title:       p.projectTitle.trim(),
        role:        p.role.trim(),
        url:         p.url.trim(),
        description: p.description.trim(),
      }));

    const fd = new FormData();
    fd.set("first_name", firstName.trim());
    fd.set("last_name", lastName.trim());
    fd.set("email", email.trim());
    fd.set("phone", phone.trim());
    fd.set("city", city.trim());
    fd.set("country", country.trim());
    fd.set("time_zone", timezone);
    fd.set("linkedin_url", linkedinUrl.trim());

    fd.set("job_titles", jobTitles.trim());
    fd.set("bio", bio.trim());
    fd.set("skills", JSON.stringify(skills));
    fd.set("employment_history", JSON.stringify(employmentHistory));
    fd.set("education", JSON.stringify(educationObj));
    fd.set("portfolio", JSON.stringify(portfolioList));

    fd.set("hourly_rate", String(Number.parseFloat(hourlyRate)));
    fd.set("hours_per_week", HOURS_LABEL[hoursPerWeek]);
    fd.set("work_type", WORK_TYPE_LABEL[workType]);
    fd.set(
      "availability",
      availability === "future" && futureDate
        ? `Available from ${futureDate}`
        : AVAIL_LABEL[availability],
    );
    if (availability === "future" && futureDate) {
      fd.set("available_from_date", futureDate);
    }
    fd.set(
      "languages",
      JSON.stringify(languages.map((l) => ({ name: l.name.trim(), level: l.level }))),
    );

    if (cvFile) fd.set("cv", cvFile);
    if (photoFile) fd.set("photo", photoFile);
    fd.set("website_url", websiteUrl);

    try {
      const res = await fetch("/api/hire-remote-profiles", {
        method: "POST",
        body: fd,
      });

      if (res.status === 409) {
        // Unified duplicate handling — render the friendly "Already in
        // our network" success card instead of an inline red error. The
        // email-vs-phone-vs-generic distinction wasn't actionable for the
        // user (both branches mean "use your existing account"). Mirrors
        // /become-a-talent's duplicate-state pattern.
        setSubmitState("duplicate");
        setSubmitted(true);
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        let message =
          "Something went wrong. Please email us at talent@remotiv.work if this persists.";
        try {
          const data = (await res.json()) as { message?: string; error?: string };
          if (data.message) message = data.message;
          else if (
            data.error &&
            data.error !== "duplicate" &&
            data.error !== "duplicate_email" &&
            data.error !== "duplicate_phone"
          ) {
            message = data.error;
          }
        } catch {
          // Ignore JSON parse errors and use the default message.
        }
        setSubmitting(false);
        setStep4Error(message);
        return;
      }

      setSubmitting(false);
      setSubmitted(true);
    } catch {
      setSubmitting(false);
      setStep4Error(
        "Something went wrong. Please email us at talent@remotiv.work if this persists.",
      );
    }
    } finally {
      submitLockRef.current = false;
    }
  }

  return (
    <>
      <Navbar />
      <div id="main" className="bta-root">
        <div className="bat-outer">
          <GridBackground>
            <div className="bat-pill">
              <span className="bat-pill-now">Now</span>
              <span className="bat-pill-text">Become Remote-Ready</span>
            </div>
            <h1 className="bat-h1">Get hired by global companies,</h1>
            <div className="bat-h2">on your terms.</div>
            <p className="bat-sub">
              Set your hourly rate. We connect you with global clients across the
              US, UK, Europe, and Middle East who need your skills.
            </p>
            <p className="bat-sub" style={{ marginTop: -32 }}>
              Join Remotiv talent network — engineers, designers, AI
              experts, doctors, PhDs, and domain specialists earning
              $25–$200/hr from anywhere in Pakistan.
            </p>
            <div className="bat-stats">
              <div className="bat-stat">
                <div className="bat-stat-num">$25–200<span className="bat-stat-days">/hr</span></div>
                <div className="bat-stat-label">Average Rates</div>
              </div>
              <div className="bat-stat">
                <div className="bat-stat-num">Global</div>
                <div className="bat-stat-label">Clients</div>
              </div>
              <div className="bat-stat">
                <div className="bat-stat-num">Your</div>
                <div className="bat-stat-label">Own Hours</div>
              </div>
            </div>
          </GridBackground>
        </div>

        <div className="bta-steps-bar">
          <div className="bta-steps-inner">
            <span className="bta-step-counter">Step {step} · {STEPS[step - 1].label}</span>
            {STEPS.map((s, idx) => {
              const isDone = highestStep > s.num;
              const isCurrent = step === s.num;
              const stateSuffix = isCurrent
                ? " (current)"
                : isDone
                  ? " (completed)"
                  : "";
              return (
                <div key={s.num} className="contents">
                  <button
                    type="button"
                    aria-current={isCurrent ? "step" : undefined}
                    aria-label={`Step ${s.num}: ${s.label}${stateSuffix}`}
                    className={`bta-step ${isCurrent ? "active" : ""} ${isDone ? "done" : ""}`}
                    onClick={() => goToStep(s.num)}
                  >
                    <span className="bta-step-circle" aria-hidden="true">
                      <span className="bta-step-num">{isDone ? "✓" : s.num}</span>
                    </span>
                    {s.label}
                  </button>
                  {idx < STEPS.length - 1 && <span className="bta-step-line" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </div>

        <div className="bta-layout" style={{ gridTemplateColumns: "1fr" }}>
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
                    <h2 className="bta-success-title">
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
                  <h2 className="bta-success-title">You&apos;re In!</h2>
                  <p className="bta-success-sub">
                    Your profile is under review. We typically review applications
                    within 3 business days — watch for an email from
                    talent@remotiv.work (check your spam folder too).
                  </p>
                  <a
                    href="https://www.linkedin.com/company/remotiv-inc/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "block", marginTop: 16, fontSize: ".82rem", color: "#7E47FF", fontWeight: 600 }}
                  >
                    🔗 Follow Remotiv on LinkedIn
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
                  <Link href="/hire-remote" className="bta-success-btn">
                    View Hire Remote →
                  </Link>
                </div>
                )
              ) : (
                <>
                  {step === 1 && (
                    <Step1
                      firstName={firstName}     setFirstName={setFirstName}
                      lastName={lastName}       setLastName={setLastName}
                      email={email}             setEmail={setEmail}
                      phone={phone}             setPhone={setPhone}
                      city={city}               setCity={setCity}
                      country={country}         setCountry={setCountry}
                      timezone={timezone}       setTimezone={setTimezone}
                      linkedinUrl={linkedinUrl} setLinkedinUrl={setLinkedinUrl}
                      error={step1Error}
                      onNext={handleStep1Next}
                    />
                  )}
                  {step === 2 && (
                    <Step2
                      jobTitles={jobTitles} setJobTitles={setJobTitles}
                      bio={bio}             setBio={setBio}
                      skills={skills}       skillInput={skillInput}
                      setSkillInput={setSkillInput}
                      handleSkillKey={handleSkillKey}
                      removeSkill={removeSkill}
                      skillError={skillError}
                      employment={employment}
                      addEmployment={addEmployment}
                      updateEmployment={updateEmployment}
                      removeEmployment={removeEmployment}
                      eduInstitution={eduInstitution} setEduInstitution={setEduInstitution}
                      eduDegree={eduDegree}           setEduDegree={setEduDegree}
                      eduStart={eduStart}             setEduStart={setEduStart}
                      eduEnd={eduEnd}                 setEduEnd={setEduEnd}
                      portfolio={portfolio}
                      addPortfolio={addPortfolio}
                      updatePortfolio={updatePortfolio}
                      removePortfolio={removePortfolio}
                      error={step2Error}
                      onBack={() => goToStep(1)}
                      onNext={handleStep2Next}
                    />
                  )}
                  {step === 3 && (
                    <Step3
                      hourlyRate={hourlyRate}     setHourlyRate={setHourlyRate}
                      hoursPerWeek={hoursPerWeek} setHoursPerWeek={setHoursPerWeek}
                      workType={workType}         setWorkType={setWorkType}
                      availability={availability} setAvailability={setAvailability}
                      futureDate={futureDate}     setFutureDate={setFutureDate}
                      languages={languages}
                      addLanguage={addLanguage}
                      updateLanguage={updateLanguage}
                      removeLanguage={removeLanguage}
                      error={step3Error}
                      onBack={() => goToStep(2)}
                      onNext={handleStep3Next}
                    />
                  )}
                  {step === 4 && (
                    <Step4
                      cvFile={cvFile}
                      cvDragOver={cvDragOver}
                      setCvDragOver={setCvDragOver}
                      cvInputRef={cvInputRef}
                      handleCv={handleCv}
                      photoFile={photoFile}
                      photoPreview={photoPreview}
                      handlePhoto={handlePhoto}
                      error={step4Error}
                      submitting={submitting}
                      onBack={() => goToStep(3)}
                      onSubmit={handleSubmit}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────
// Step components + helpers
// ──────────────────────────────────────────────────────────────

const ERROR_BOX_STYLE: React.CSSProperties = {
  margin: "0 32px 16px",
  padding: "10px 14px",
  background: "rgba(239,68,68,0.08)",
  border: "1px solid rgba(239,68,68,0.25)",
  borderRadius: 10,
  color: "#dc2626",
  fontSize: "0.78rem",
  fontFamily: "'DM Sans',sans-serif",
  fontWeight: 500,
};

function FormHeader({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="bta-form-header">
      <div className="bta-fh-icon" aria-hidden="true">{icon}</div>
      <div>
        <h2
          id="bta-fh-title"
          tabIndex={-1}
          className="bta-fh-title"
          style={{ outline: "none" }}
        >
          {title}
        </h2>
        <div className="bta-fh-sub">{sub}</div>
      </div>
    </div>
  );
}

function Field({
  label, required, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  // Inject id (and aria-required for required fields) into the FIRST valid
  // child element only — that's the form control. Sibling children like
  // character counters, hint <p>s, or duplicate-tag notices pass through
  // unchanged.
  let injected = false;
  const wired = Children.map(children, (child) => {
    if (!injected && isValidElement(child)) {
      injected = true;
      const extra: { id: string; "aria-required"?: boolean } = { id };
      if (required) extra["aria-required"] = true;
      return cloneElement(
        child as ReactElement<{ id?: string; "aria-required"?: boolean }>,
        extra,
      );
    }
    return child;
  });
  return (
    <div className="bta-form-group">
      <label htmlFor={id} className="bta-label">
        {label}
        {required && (
          <>
            {" "}
            <span className="bta-req" aria-hidden="true">*</span>
          </>
        )}
      </label>
      {wired}
      {hint && <p className="bta-skill-hint">{hint}</p>}
    </div>
  );
}

// ── Step 1 ───────────────────────────────────────────────────

function Step1(props: {
  firstName: string;   setFirstName: (v: string) => void;
  lastName: string;    setLastName: (v: string) => void;
  email: string;       setEmail: (v: string) => void;
  phone: string;       setPhone: (v: string) => void;
  city: string;        setCity: (v: string) => void;
  country: string;     setCountry: (v: string) => void;
  timezone: string;    setTimezone: (v: string) => void;
  linkedinUrl: string; setLinkedinUrl: (v: string) => void;
  error: string | null;
  onNext: () => void;
}) {
  return (
    <div className="bta-form-step active">
      <FormHeader icon="👤" title="Personal Information" sub="Tell us who you are — this stays private until matched" />

      <div className="bta-form-body">
        <h3 className="bta-sec-title">Basic Details</h3>
        <div className="bta-grid-2">
          <Field label="First Name" required>
            <input type="text" className="bta-input" placeholder="e.g. Sarah"
              value={props.firstName} onChange={(e) => props.setFirstName(e.target.value)} />
          </Field>
          <Field label="Last Name" required>
            <input type="text" className="bta-input" placeholder="e.g. Khan"
              value={props.lastName} onChange={(e) => props.setLastName(e.target.value)} />
          </Field>
        </div>

        <div className="bta-grid-2">
          <Field label="Email Address" required>
            <input type="email" className="bta-input" placeholder="you@example.com"
              value={props.email} onChange={(e) => props.setEmail(e.target.value)} />
          </Field>
          <Field label="Phone Number" required>
            <input type="tel" className="bta-input" placeholder="+92 300 0000000"
              value={props.phone} onChange={(e) => props.setPhone(e.target.value)} />
          </Field>
        </div>

        <div className="bta-grid-2">
          <Field label="City" required>
            <input type="text" className="bta-input" placeholder="e.g. Lahore"
              value={props.city} onChange={(e) => props.setCity(e.target.value)} />
          </Field>
          <Field label="Country" required>
            <select className="bta-select" value={props.country} onChange={(e) => props.setCountry(e.target.value)}>
              <option value="" disabled>Select country</option>
              {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <div className="bta-grid-2">
          <Field label="Time Zone" required>
            <select className="bta-select" value={props.timezone} onChange={(e) => props.setTimezone(e.target.value)}>
              <option value="" disabled>Select time zone</option>
              {TIMEZONE_REGION_ORDER.map((region) =>
                GROUPED_TIMEZONES[region].length > 0 ? (
                  <optgroup key={region} label={region}>
                    {GROUPED_TIMEZONES[region].map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </select>
          </Field>
          <Field label="LinkedIn Profile" required>
            <input type="url" className="bta-input" placeholder="linkedin.com/in/yourname"
              value={props.linkedinUrl} onChange={(e) => props.setLinkedinUrl(e.target.value)} />
          </Field>
        </div>
      </div>

      {props.error && (
        <div
          id="bta-step-error"
          role="alert"
          tabIndex={-1}
          style={{ ...ERROR_BOX_STYLE, outline: "none" }}
        >
          {props.error}
        </div>
      )}

      <div className="bta-form-footer">
        <FooterNote />
        <div className="bta-form-actions">
          <Link href="/" className="bta-btn-ghost">← Back to Home</Link>
          <button type="button" className="bta-btn-next" onClick={props.onNext}>
            Next: Professional Profile →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step 2 ───────────────────────────────────────────────────

function Step2(props: {
  jobTitles: string;  setJobTitles: (v: string) => void;
  bio: string;        setBio: (v: string) => void;
  skills: string[];   skillInput: string; setSkillInput: (v: string) => void;
  handleSkillKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  removeSkill: (tag: string) => void;
  skillError: string | null;
  employment: EmploymentEntry[];
  addEmployment: () => void;
  updateEmployment: (id: number, patch: Partial<EmploymentEntry>) => void;
  removeEmployment: (id: number) => void;
  eduInstitution: string; setEduInstitution: (v: string) => void;
  eduDegree: string;      setEduDegree: (v: string) => void;
  eduStart: string;       setEduStart: (v: string) => void;
  eduEnd: string;         setEduEnd: (v: string) => void;
  portfolio: PortfolioEntry[];
  addPortfolio: () => void;
  updatePortfolio: (id: number, patch: Partial<PortfolioEntry>) => void;
  removePortfolio: (id: number) => void;
  error: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="bta-form-step active">
      <FormHeader icon="💼" title="Professional Profile" sub="Your role, experience and skills — this powers your AI matching" />

      <div className="bta-form-body">
        <h3 className="bta-sec-title">Headline</h3>
        <Field label="Job Titles" required>
          <input
            type="text"
            className="bta-input"
            placeholder="Full Stack Developer, Backend Developer, Web Developer"
            value={props.jobTitles}
            onChange={(e) => props.setJobTitles(e.target.value)}
          />
        </Field>
        <div style={{ height: 14 }} />
        <Field label="Bio / Summary" required>
          <textarea
            className="bta-textarea"
            placeholder="Write a short bio — your experience, what you specialise in, and what opportunities you're looking for. (min 50 characters)"
            value={props.bio}
            onChange={(e) => props.setBio(e.target.value)}
            maxLength={2000}
          />
          <p className="bta-skill-hint">{props.bio.trim().length}/2000 characters (min {BIO_MIN_CHARS})</p>
        </Field>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Skills</h3>
        <Field label="Skills & Expertise" required hint={`Type a skill and press Enter. Add at least ${SKILLS_MIN}.`}>
          <div className="bta-skills-box">
            {props.skills.map((tag) => (
              <span key={tag} className="bta-stag">
                {tag}
                <button type="button" className="bta-stag-x" onClick={() => props.removeSkill(tag)} aria-label={`Remove ${tag}`}>✕</button>
              </span>
            ))}
            <input
              className="bta-skill-inp"
              type="text"
              placeholder="Add a skill, press Enter…"
              value={props.skillInput}
              onChange={(e) => props.setSkillInput(e.target.value)}
              onKeyDown={props.handleSkillKey}
            />
          </div>
          {props.skillError && (
            <p role="alert" aria-live="polite" className="bta-skill-hint">
              {props.skillError}
            </p>
          )}
        </Field>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Employment History</h3>
        {props.employment.map((exp, idx) => (
          <div key={exp.id} className="bta-exp-entry">
            <button
              type="button"
              className="bta-exp-remove"
              onClick={() => props.removeEmployment(exp.id)}
              aria-label={`Remove job ${idx + 1}`}
            >
              ✕
            </button>
            <div className="bta-grid-2">
              <Field label="Title" required>
                <input type="text" className="bta-input" placeholder="e.g. Senior Software Engineer"
                  value={exp.title} onChange={(e) => props.updateEmployment(exp.id, { title: e.target.value })} />
              </Field>
              <Field label="Company" required>
                <input type="text" className="bta-input" placeholder="e.g. US-based SaaS Startup"
                  value={exp.company} onChange={(e) => props.updateEmployment(exp.id, { company: e.target.value })} />
              </Field>
            </div>
            <div className="bta-grid-2">
              <Field label="Start Date" required>
                <input type="text" className="bta-input" placeholder="e.g. Jan 2021"
                  value={exp.start} onChange={(e) => props.updateEmployment(exp.id, { start: e.target.value })} />
              </Field>
              <Field label="End Date">
                <input type="text" className="bta-input" placeholder="e.g. Present or Dec 2023"
                  value={exp.end} onChange={(e) => props.updateEmployment(exp.id, { end: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <textarea
                className="bta-textarea"
                placeholder="What you owned, shipped, and the impact (metrics, scale, results)…"
                value={exp.description}
                onChange={(e) => props.updateEmployment(exp.id, { description: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <button type="button" className="bta-add-exp-btn" onClick={props.addEmployment}>
          + Add Employment Entry
        </button>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Education</h3>
        <div className="bta-grid-2">
          <Field label="Institution" required>
            <input type="text" className="bta-input" placeholder="e.g. FAST University"
              value={props.eduInstitution} onChange={(e) => props.setEduInstitution(e.target.value)} />
          </Field>
          <Field label="Degree" required>
            <input type="text" className="bta-input" placeholder="e.g. BSc Computer Science"
              value={props.eduDegree} onChange={(e) => props.setEduDegree(e.target.value)} />
          </Field>
        </div>
        <div className="bta-grid-2">
          <Field label="Start Year">
            <input type="text" className="bta-input" placeholder="e.g. 2013"
              value={props.eduStart} onChange={(e) => props.setEduStart(e.target.value)} />
          </Field>
          <Field label="End Year">
            <input type="text" className="bta-input" placeholder="e.g. 2017"
              value={props.eduEnd} onChange={(e) => props.setEduEnd(e.target.value)} />
          </Field>
        </div>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">
          Portfolio
          <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(Optional)</span>
        </h3>
        <p className="bta-help-text">
          Recommended for engineers, designers, and other technical roles.
          Sales, customer success, and operations candidates can skip this section.
        </p>
        {props.portfolio.map((p, idx) => (
          <div key={p.id} className="bta-exp-entry">
            <button
              type="button"
              className="bta-exp-remove"
              onClick={() => props.removePortfolio(p.id)}
              aria-label={`Remove project ${idx + 1}`}
            >
              ✕
            </button>
            <div className="bta-grid-2">
              <Field label="Project Title">
                <input type="text" className="bta-input" placeholder="e.g. E-commerce Platform"
                  value={p.projectTitle} onChange={(e) => props.updatePortfolio(p.id, { projectTitle: e.target.value })} />
              </Field>
              <Field label="Role">
                <input type="text" className="bta-input" placeholder="e.g. Full Stack Dev | React"
                  value={p.role} onChange={(e) => props.updatePortfolio(p.id, { role: e.target.value })} />
              </Field>
            </div>
            <Field label="Portfolio URL">
              <input
                type="url"
                className="bta-input"
                placeholder="https://yourproject.com or https://github.com/..."
                value={p.url}
                onChange={(e) => props.updatePortfolio(p.id, { url: e.target.value })}
              />
            </Field>
            <div style={{ height: 10 }} />
            <Field label="Description">
              <textarea
                className="bta-textarea"
                placeholder="Short description of the project, your contribution, and the outcome."
                value={p.description}
                onChange={(e) => props.updatePortfolio(p.id, { description: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <button type="button" className="bta-add-exp-btn" onClick={props.addPortfolio}>
          + Add Portfolio Entry
        </button>
      </div>

      {props.error && (
        <div
          id="bta-step-error"
          role="alert"
          tabIndex={-1}
          style={{ ...ERROR_BOX_STYLE, outline: "none" }}
        >
          {props.error}
        </div>
      )}

      <div className="bta-form-footer">
        <FooterNote />
        <div className="bta-form-actions">
          <button type="button" className="bta-btn-ghost" onClick={props.onBack}>← Back</button>
          <button type="button" className="bta-btn-next" onClick={props.onNext}>
            Next: Work Preferences →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step 3 ───────────────────────────────────────────────────

function Step3(props: {
  hourlyRate: string;        setHourlyRate: (v: string) => void;
  hoursPerWeek: HoursOpt;    setHoursPerWeek: (v: HoursOpt) => void;
  workType: WorkTypeOpt;     setWorkType: (v: WorkTypeOpt) => void;
  availability: AvailabilityOpt; setAvailability: (v: AvailabilityOpt) => void;
  futureDate: string;        setFutureDate: (v: string) => void;
  languages: LanguageEntry[];
  addLanguage: () => void;
  updateLanguage: (id: number, patch: Partial<LanguageEntry>) => void;
  removeLanguage: (id: number) => void;
  error: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="bta-form-step active">
      <FormHeader icon="⚙️" title="Work Preferences" sub="Set your rate, availability, and how you like to work" />

      <div className="bta-form-body">
        <h3 className="bta-sec-title">Rate & Hours</h3>
        <div className="bta-grid-2">
          <Field label="Hourly Rate (USD)" required hint={`Between $${RATE_MIN} and $${RATE_MAX} per hour`}>
            <input
              type="number"
              className="bta-input"
              placeholder="e.g. 35"
              min={RATE_MIN}
              max={RATE_MAX}
              value={props.hourlyRate}
              onChange={(e) => props.setHourlyRate(e.target.value)}
            />
          </Field>
        </div>

        <fieldset
          className="bta-form-group"
          style={{ marginTop: 18, border: "none", margin: 0, padding: 0 }}
        >
          <legend className="bta-label">Hours per Week <span className="bta-req" aria-hidden="true">*</span></legend>
          <div className="bta-radio-group">
            {(Object.keys(HOURS_LABEL) as HoursOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.hoursPerWeek === v ? "sel" : ""}`}>
                <input type="radio" name="brr-hours" checked={props.hoursPerWeek === v} onChange={() => props.setHoursPerWeek(v)} />
                <span className="bta-rdot" aria-hidden="true" />
                {HOURS_LABEL[v]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Work Setup</h3>
        <fieldset
          className="bta-form-group"
          style={{ marginBottom: 20, border: "none", margin: "0 0 20px", padding: 0 }}
        >
          <legend className="bta-label">Work Type <span className="bta-req" aria-hidden="true">*</span></legend>
          <div className="bta-radio-group">
            {(Object.keys(WORK_TYPE_LABEL) as WorkTypeOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.workType === v ? "sel" : ""}`}>
                <input type="radio" name="brr-wt" checked={props.workType === v} onChange={() => props.setWorkType(v)} />
                <span className="bta-rdot" aria-hidden="true" />
                {WORK_TYPE_LABEL[v]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset
          className="bta-form-group"
          style={{ marginBottom: 20, border: "none", margin: "0 0 20px", padding: 0 }}
        >
          <legend className="bta-label">Availability <span className="bta-req" aria-hidden="true">*</span></legend>
          <div className="bta-radio-group">
            {(Object.keys(AVAIL_LABEL) as AvailabilityOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.availability === v ? "sel" : ""}`}>
                <input type="radio" name="brr-av" checked={props.availability === v} onChange={() => props.setAvailability(v)} />
                <span className="bta-rdot" aria-hidden="true" />
                {AVAIL_LABEL[v]}
              </label>
            ))}
          </div>
          {props.availability === "future" && (
            <div style={{ marginTop: 10, maxWidth: 240 }}>
              <input
                type="date"
                className="bta-input"
                value={props.futureDate}
                onChange={(e) => props.setFutureDate(e.target.value)}
              />
            </div>
          )}
        </fieldset>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Languages</h3>
        {props.languages.map((lang, idx) => (
          <div key={lang.id} className="bta-exp-entry">
            <button
              type="button"
              className="bta-exp-remove"
              onClick={() => props.removeLanguage(lang.id)}
              aria-label={`Remove language ${idx + 1}`}
            >
              ✕
            </button>
            <div className="bta-grid-2">
              <Field label="Language" required>
                <input type="text" className="bta-input" placeholder="e.g. English"
                  value={lang.name} onChange={(e) => props.updateLanguage(lang.id, { name: e.target.value })} />
              </Field>
              <Field label="Level" required>
                <select
                  className="bta-select"
                  value={lang.level}
                  onChange={(e) => props.updateLanguage(lang.id, { level: e.target.value as LanguageEntry["level"] })}
                >
                  {LANGUAGE_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              </Field>
            </div>
          </div>
        ))}
        <button type="button" className="bta-add-exp-btn" onClick={props.addLanguage}>
          + Add Language
        </button>
      </div>

      {props.error && (
        <div
          id="bta-step-error"
          role="alert"
          tabIndex={-1}
          style={{ ...ERROR_BOX_STYLE, outline: "none" }}
        >
          {props.error}
        </div>
      )}

      <div className="bta-form-footer">
        <FooterNote />
        <div className="bta-form-actions">
          <button type="button" className="bta-btn-ghost" onClick={props.onBack}>← Back</button>
          <button type="button" className="bta-btn-next" onClick={props.onNext}>
            Next: Verification →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step 4 ───────────────────────────────────────────────────

function Step4(props: {
  cvFile: File | null;
  cvDragOver: boolean;
  setCvDragOver: (v: boolean) => void;
  cvInputRef: React.RefObject<HTMLInputElement | null>;
  handleCv: (file: File | undefined) => void;
  photoFile: File | null;
  photoPreview: string | null;
  handlePhoto: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="bta-form-step active">
      <FormHeader icon="📄" title="Verification & Documents" sub="Optionally upload your portfolio, CV, or other supporting documents" />

      <div className="bta-form-body">
        <h3 className="bta-sec-title">Upload your Portfolio, CV or other Documents <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(Optional)</span></h3>
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload CV — drag and drop, or press Enter to browse files"
          className={`bta-upload-zone ${props.cvDragOver ? "drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); props.setCvDragOver(true); }}
          onDragLeave={() => props.setCvDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            props.setCvDragOver(false);
            props.handleCv(e.dataTransfer.files?.[0]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              props.cvInputRef.current?.click();
            }
          }}
        >
          <input
            ref={props.cvInputRef}
            type="file"
            accept=".pdf"
            onChange={(e) => props.handleCv(e.target.files?.[0])}
          />
          <div className="bta-upload-ico">📄</div>
          <div className="bta-upload-title">
            {props.cvFile ? props.cvFile.name : "Drag & drop your CV here"}
          </div>
          <div className="bta-upload-sub">
            {props.cvFile ? (
              `${(props.cvFile.size / 1024).toFixed(0)} KB — ready to submit`
            ) : (
              <>
                or{" "}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); props.cvInputRef.current?.click(); }}
                >
                  browse to upload
                </button>
              </>
            )}
          </div>
          <div className="bta-upload-fmt">PDF only (max 5 MB)</div>
        </div>

        <div className="bta-spacer" />
        <h3 className="bta-sec-title">Profile Photo <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(optional)</span></h3>
        <div className="bta-photo-wrap">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: file input is rendered inside */}
          <label className="bta-photo-prev">
            <input type="file" accept="image/*" onChange={props.handlePhoto} />
            {props.photoPreview ? (
              // biome-ignore lint/performance/noImgElement: local preview
              <img
                src={props.photoPreview}
                alt="Profile preview"
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
              />
            ) : (
              "😊"
            )}
          </label>
          <div className="bta-photo-info">
            <p>Upload a professional headshot (JPG, PNG, WEBP, or GIF). Shown to recruiters and global clients browsing talent.</p>
            <span className="bta-photo-btn">Upload Photo</span>
          </div>
        </div>

        <div className="bta-spacer" />
        <div className="bta-info-box">
          <span className="bta-info-box-ico">✦</span>
          <div>
            <div className="bta-info-box-title">Verification</div>
            <div className="bta-info-box-body">
              Email is auto-verified once you submit. ID and Phone verifications
              will be reviewed by Remotiv after submission — we&apos;ll reach out
              if we need anything else.
            </div>
          </div>
        </div>
      </div>

      {props.error && (
        <div
          id="bta-step-error"
          role="alert"
          tabIndex={-1}
          style={{ ...ERROR_BOX_STYLE, outline: "none" }}
        >
          {props.error}
        </div>
      )}

      <div className="bta-form-footer">
        <FooterNote />
        <div className="bta-form-actions">
          <button type="button" className="bta-btn-ghost" onClick={props.onBack}>← Back</button>
          <button
            type="button"
            className="bta-btn-submit"
            onClick={props.onSubmit}
            disabled={props.submitting}
          >
            {props.submitting ? "Submitting…" : "Submit Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}
