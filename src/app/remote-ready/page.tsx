"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Navbar } from "@/components/navbar";

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
      Your data is encrypted and only shared with matched employers.
    </div>
  );
}

// ── Page component ───────────────────────────────────────────

export default function RemoteReadyPage() {
  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
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

  function validateStep1(): string | null {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneDigits = phone.replace(/\D/g, "");
    const linkedinValid = linkedinUrl.toLowerCase().includes("linkedin.com");
    if (!firstName.trim()) return "First name is required";
    if (!lastName.trim())  return "Last name is required";
    if (!email.trim() || !emailRegex.test(email)) return "Please enter a valid email address";
    if (!phone.trim() || phoneDigits.length < 7) return "Please enter a valid phone number";
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
    if (bio.trim().length < 50) return "Bio must be at least 50 characters";
    if (skills.length < 3) return "Add at least 3 skill tags";
    const validEmployment = employment.filter((e) => e.title.trim() || e.company.trim());
    if (validEmployment.length === 0) return "Add at least 1 employment entry";
    if (!eduInstitution.trim() || !eduDegree.trim()) {
      return "Education institution and degree are required";
    }
    return null;
  }

  function validateStep3(): string | null {
    const rateNum = Number.parseFloat(hourlyRate);
    if (!hourlyRate.trim() || !Number.isFinite(rateNum) || rateNum < 0) {
      return "Please enter a valid hourly rate";
    }
    if (availability === "future" && !futureDate) {
      return "Please choose a future availability date";
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

  function scrollToTop() {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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
          scrollToTop();
          return;
        }
      }
    }
    setStep(target);
    scrollToTop();
  }

  function handleStep1Next() {
    const err = validateStep1();
    if (err) { setStep1Error(err); return; }
    setStep1Error(null);
    setStep(2);
    scrollToTop();
  }

  function handleStep2Next() {
    const err = validateStep2();
    if (err) { setStep2Error(err); return; }
    setStep2Error(null);
    setStep(3);
    scrollToTop();
  }

  function handleStep3Next() {
    const err = validateStep3();
    if (err) { setStep3Error(err); return; }
    setStep3Error(null);
    setStep(4);
    scrollToTop();
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
    if (!v || skills.length >= 20 || skills.includes(v)) return;
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
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.type)) {
      setStep4Error("CV must be a PDF, DOC, or DOCX file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setStep4Error("CV must be under 5 MB.");
      return;
    }
    setStep4Error(null);
    setCvFile(file);
  }

  async function handleSubmit() {
    setStep1Error(null);
    setStep2Error(null);
    setStep3Error(null);
    setStep4Error(null);

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
        scrollToTop();
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

    try {
      const res = await fetch("/api/hire-remote-profiles", {
        method: "POST",
        body: fd,
      });

      if (res.status === 409) {
        setSubmitting(false);
        setStep4Error(
          "You've already applied with this email. We'll be in touch soon.",
        );
        return;
      }

      if (!res.ok) {
        let message = "Something went wrong. Please try again.";
        try {
          const data = (await res.json()) as { message?: string; error?: string };
          if (data.message) message = data.message;
          else if (data.error && data.error !== "duplicate") message = data.error;
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
      setStep4Error("Something went wrong. Please try again.");
    }
  }

  return (
    <>
      <Navbar />
      <div className="bta-root">
        <div className="bat-outer">
          <GridBackground>
            <div className="bat-pill">
              <span className="bat-pill-now">Now</span>
              <span className="bat-pill-text">Become Remote-Ready</span>
            </div>
            <div className="bat-h1">Get hired by global companies,</div>
            <div className="bat-h2">on your terms.</div>
            <p className="bat-sub">
              Set your hourly rate. We connect you with global clients across the
              US, UK, Europe, and Middle East who need your skills.
            </p>
            <p className="bat-sub" style={{ marginTop: -32 }}>
              Join Remotiv&apos;s talent network — engineers, designers, AI
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
            {STEPS.map((s, idx) => (
              <div key={s.num} className="contents">
                <button
                  type="button"
                  className={`bta-step ${step === s.num ? "active" : ""} ${step > s.num ? "done" : ""}`}
                  onClick={() => goToStep(s.num)}
                >
                  <span className="bta-step-circle">
                    <span className="bta-step-num">{s.num}</span>
                  </span>
                  {s.label}
                </button>
                {idx < STEPS.length - 1 && <span className="bta-step-line" />}
              </div>
            ))}
          </div>
        </div>

        <div className="bta-layout" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <div className="bta-form-card">
              {submitted ? (
                <div className="bta-success" style={{ display: "block" }}>
                  <div className="bta-success-ico">🎉</div>
                  <div className="bta-success-title">You&apos;re In!</div>
                  <p className="bta-success-sub">
                    Your profile is under review. We&apos;ll notify you once
                    approved and matched with global clients.
                  </p>
                  <a
                    href="https://www.linkedin.com/company/remotiv-inc/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "block", marginTop: 16, fontSize: ".82rem", color: "#7E47FF", fontWeight: 600 }}
                  >
                    🔗 Follow Remotiv on LinkedIn
                  </a>
                  <Link href="/hire-remote" className="bta-success-btn">
                    View Hire Remote →
                  </Link>
                </div>
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

      <style jsx global>{`
        .bta-root { background:#fff; font-family:'DM Sans',sans-serif; }

        .bat-outer { background:#fff; padding:24px; box-sizing:border-box; }
        .bat-wrap {
          width:100%; background:#F5F1EC; border-radius:32px; position:relative; overflow:hidden;
          box-sizing:border-box; display:flex; flex-direction:column; align-items:center;
          justify-content:center; isolation:isolate; padding:72px 24px 48px;
        }
        .bat-grid-svg { position:absolute; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
        .bat-content {
          position:relative; z-index:2; display:flex; flex-direction:column; align-items:center;
          text-align:center; width:100%; max-width:1100px; margin:0 auto;
        }
        .bat-pill {
          display:inline-flex; align-items:center; gap:8px; background:#fff;
          border:0.5px solid #ddd8d0; border-radius:999px; padding:5px 16px 5px 6px; margin:0 0 32px;
        }
        .bat-pill-now { background:#c9ff85; color:#3a5c08; font-size:12px; font-weight:700; border-radius:999px; padding:3px 12px; line-height:1.4; }
        .bat-pill-text { font-size:13px; color:#444; font-weight:500; }
        .bat-h1, .bat-h2 {
          font-family:'Sora',sans-serif; font-size:clamp(42px,5.5vw,64px); font-weight:800;
          line-height:1.05; letter-spacing:-2px; max-width:800px; text-align:center;
        }
        .bat-h1 { color:#111; margin:0 0 4px; }
        .bat-h2 { color:#9886fe; margin:0 0 28px; }
        .bat-sub { font-size:17px; color:#777; line-height:1.7; max-width:640px; margin:0 0 48px; text-align:center; font-weight:400; }
        .bat-stats {
          display:flex; align-items:stretch; background:#7E47FF; border-radius:20px;
          overflow:hidden; width:100%; max-width:860px;
        }
        .bat-stat {
          flex:1; padding:36px 28px; text-align:center; border-right:1px solid rgba(255,255,255,.18);
          min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
        }
        .bat-stat:last-child { border-right:none; }
        .bat-stat-num { font-family:'Sora',sans-serif; font-size:36px; font-weight:800; color:#fff; line-height:1; margin:0 0 14px; letter-spacing:-1px; white-space:nowrap; }
        .bat-stat-days { font-family:'Sora',sans-serif; font-size:22px; font-weight:700; color:#c9ff85; line-height:1; margin-left:4px; }
        .bat-stat-label { font-size:11px; font-weight:600; color:rgba(255,255,255,.65); letter-spacing:.1em; text-transform:uppercase; white-space:nowrap; }

        .bta-steps-bar { background:#fff; border-bottom:1px solid rgba(0,0,0,.07); position:sticky; top:0; z-index:50; }
        .bta-steps-inner { display:flex; align-items:center; justify-content:flex-start; max-width:880px; margin:0 auto; padding:0 40px; overflow-x:auto; }
        .bta-step-counter { display: none; }
        .bta-step {
          display:flex; align-items:center; gap:10px; font-family:'DM Sans',sans-serif; font-size:.72rem;
          font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#bbb; padding:16px 20px;
          cursor:pointer; transition:color .2s; position:relative; white-space:nowrap; flex-shrink:0;
          background:none; border:none;
        }
        .bta-step.active { color:#111; }
        .bta-step.done { color:#888; }
        .bta-step.active::after { content:''; position:absolute; bottom:0; left:0; right:0; height:2.5px; background:#49D7A7; border-radius:2px; }
        .bta-step-circle {
          width:26px; height:26px; min-width:26px; border-radius:50%; border:1.5px solid rgba(0,0,0,.15);
          display:inline-flex !important; align-items:center; justify-content:center;
          color:#bbb; flex-shrink:0; transition:all .25s; box-sizing:border-box;
        }
        .bta-step-num,
        .bta-step.active .bta-step-num,
        .bta-step.done .bta-step-num {
          display:flex !important; visibility:visible !important; opacity:1 !important;
          align-items:center; justify-content:center;
          font-family:'DM Sans',sans-serif; font-size:.82rem; font-weight:700;
          line-height:1; color:inherit;
        }
        .bta-step.active .bta-step-circle { border-color:#49D7A7; background:#49D7A7; color:#111; }
        .bta-step.done .bta-step-circle { border-color:#49D7A7; color:#49D7A7; background:rgba(73,215,167,.1); }
        .bta-step-line { width:36px; height:1px; background:rgba(0,0,0,.1); flex-shrink:0; }

        .bta-layout {
          max-width:880px; margin:0 auto; padding:32px 40px 100px;
          display:grid; grid-template-columns:1fr; gap:24px; align-items:start;
        }
        .bta-form-card { background:#f8f4f1; border:1px solid rgba(0,0,0,.08); border-radius:20px; overflow:hidden; }
        .bta-form-step.active { display:block; }
        .bta-form-header { padding:24px 32px 20px; border-bottom:1px solid rgba(0,0,0,.07); display:flex; align-items:center; gap:14px; }
        .bta-fh-icon {
          width:44px; height:44px; background:rgba(73,215,167,.1); border:1px solid rgba(73,215,167,.2);
          border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0;
        }
        .bta-fh-title { font-family:'Sora',sans-serif; font-size:.95rem; font-weight:700; color:#111; }
        .bta-fh-sub { font-size:.78rem; color:#888; margin-top:3px; }
        .bta-form-body { padding:28px 32px; }
        .bta-sec-title {
          font-size:.65rem; font-weight:700; letter-spacing:.16em; text-transform:uppercase;
          color:#49D7A7; margin-bottom:18px; display:flex; align-items:center; gap:10px;
        }
        .bta-sec-title::before { content:''; width:12px; height:1px; background:#49D7A7; }
        .bta-sec-title::after { content:''; flex:1; height:1px; background:rgba(0,0,0,.06); }
        .bta-help-text { font-size:.78rem; font-style:italic; color:#666; line-height:1.6; margin:-8px 0 16px; max-width:640px; }
        .bta-grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px; }
        .bta-spacer { height:24px; }
        .bta-form-group { display:flex; flex-direction:column; gap:6px; }
        .bta-label { font-size:.72rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#555; display:flex; align-items:center; gap:6px; }
        .bta-req { color:#49D7A7; }
        .bta-opt { font-size:.62rem; color:#bbb; background:rgba(0,0,0,.04); border:1px solid rgba(0,0,0,.08); border-radius:4px; padding:1px 6px; font-weight:500; letter-spacing:.04em; text-transform:none; }
        .bta-input, .bta-select, .bta-textarea {
          width:100%; background:#fff; border:1px solid rgba(0,0,0,.1); border-radius:10px;
          padding:11px 14px; font-family:'DM Sans',sans-serif; font-size:.88rem; color:#111;
          outline:none; transition:border-color .2s; appearance:none;
        }
        .bta-input::placeholder, .bta-textarea::placeholder { color:#bbb; }
        .bta-input:focus, .bta-select:focus, .bta-textarea:focus { border-color:#49D7A7; }
        .bta-textarea { resize:vertical; min-height:110px; line-height:1.7; }
        .bta-select {
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%23999' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-repeat:no-repeat; background-position:right 12px center; padding-right:36px; cursor:pointer;
        }
        .bta-skills-box {
          background:#fff; border:1px solid rgba(0,0,0,.1); border-radius:10px;
          padding:8px 10px; display:flex; flex-wrap:wrap; gap:7px; min-height:48px; cursor:text; transition:border-color .2s;
        }
        .bta-skills-box:focus-within { border-color:#49D7A7; }
        .bta-stag {
          display:inline-flex; align-items:center; gap:6px; background:rgba(73,215,167,.1);
          color:#1d8c6b; border:1px solid rgba(73,215,167,.25); border-radius:6px; padding:3px 10px; font-size:.72rem; font-weight:600;
        }
        .bta-stag-x { cursor:pointer; opacity:.5; transition:opacity .15s; font-size:.65rem; background:none; border:none; color:#1d8c6b; padding:0; line-height:1; }
        .bta-stag-x:hover { opacity:1; }
        .bta-skill-inp { border:none; outline:none; background:transparent; font-family:'DM Sans',sans-serif; font-size:.88rem; color:#111; min-width:120px; flex:1; }
        .bta-skill-inp::placeholder { color:#bbb; }
        .bta-skill-hint { font-size:.7rem; color:#bbb; margin-top:5px; }
        .bta-radio-group { display:flex; flex-wrap:wrap; gap:8px; }
        .bta-radio-opt {
          display:flex; align-items:center; gap:8px; padding:9px 16px; border:1.5px solid rgba(0,0,0,.1);
          border-radius:10px; background:#fff; cursor:pointer; transition:all .18s;
          font-size:.78rem; font-weight:600; color:#888; user-select:none;
        }
        .bta-radio-opt input { display:none; }
        .bta-radio-opt:hover { border-color:rgba(73,215,167,.4); color:#555; }
        .bta-radio-opt.sel { border-color:#49D7A7; background:rgba(73,215,167,.08); color:#1d8c6b; }
        .bta-rdot { width:12px; height:12px; border-radius:50%; border:1.5px solid rgba(0,0,0,.2); flex-shrink:0; transition:all .18s; }
        .bta-radio-opt.sel .bta-rdot { border-color:#49D7A7; background:#49D7A7; }

        .bta-upload-zone {
          border:2px dashed rgba(0,0,0,.1); border-radius:14px; padding:40px 24px; text-align:center;
          background:#fff; cursor:pointer; transition:all .2s; position:relative;
        }
        .bta-upload-zone:hover, .bta-upload-zone.drag-over { border-color:#49D7A7; background:rgba(73,215,167,.04); }
        .bta-upload-zone input[type="file"] { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; }
        .bta-upload-ico { width:48px; height:48px; background:rgba(73,215,167,.1); border:1px solid rgba(73,215,167,.2); border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.3rem; margin:0 auto 14px; }
        .bta-upload-title { font-family:'Sora',sans-serif; font-size:.82rem; font-weight:700; color:#111; margin-bottom:6px; }
        .bta-upload-sub { font-size:.78rem; color:#888; }
        .bta-upload-sub button { color:#49D7A7; cursor:pointer; font-weight:600; background:none; border:none; padding:0; font-family:inherit; font-size:inherit; }
        .bta-upload-fmt { font-size:.68rem; color:#bbb; margin-top:8px; }

        .bta-photo-wrap { display:flex; align-items:center; gap:20px; }
        .bta-photo-prev {
          width:76px; height:76px; background:#fff; border:2px dashed rgba(0,0,0,.12);
          border-radius:50%; display:flex; align-items:center; justify-content:center;
          font-size:1.8rem; flex-shrink:0; cursor:pointer; transition:border-color .2s;
          position:relative; overflow:hidden;
        }
        .bta-photo-prev:hover { border-color:#49D7A7; }
        .bta-photo-prev input[type="file"] { position:absolute; inset:0; opacity:0; cursor:pointer; }
        .bta-photo-info p { font-size:.78rem; color:#888; line-height:1.7; }
        .bta-photo-btn {
          display:inline-block; margin-top:8px; font-size:.72rem; font-weight:700; letter-spacing:.06em;
          text-transform:uppercase; color:#49D7A7; background:rgba(73,215,167,.08);
          border:1px solid rgba(73,215,167,.25); border-radius:7px; padding:5px 14px; cursor:pointer;
        }

        .bta-info-box {
          border:1px solid rgba(73,215,167,.2); background:rgba(73,215,167,.06); border-radius:12px;
          padding:18px 20px; display:flex; align-items:flex-start; gap:12px;
        }
        .bta-info-box-ico { font-size:1rem; flex-shrink:0; }
        .bta-info-box-title { font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#49D7A7; margin-bottom:5px; }
        .bta-info-box-body { font-size:.78rem; color:#777; line-height:1.75; }

        .bta-form-footer { padding:20px 32px; border-top:1px solid rgba(0,0,0,.07); display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .bta-footer-note { font-size:.7rem; color:#bbb; display:flex; align-items:center; gap:7px; }
        .bta-form-actions { display:flex; gap:10px; align-items:center; }
        .bta-btn-ghost {
          font-family:'Sora',sans-serif; font-size:.75rem; font-weight:700; letter-spacing:.06em;
          text-transform:uppercase; color:#888; background:transparent; border:1.5px solid rgba(0,0,0,.12);
          border-radius:10px; padding:11px 22px; cursor:pointer; transition:all .18s;
          text-decoration:none; display:inline-flex; align-items:center;
        }
        .bta-btn-ghost:hover { border-color:#49D7A7; color:#49D7A7; }
        .bta-btn-next, .bta-btn-submit {
          font-family:'Sora',sans-serif; font-size:.75rem; font-weight:700; letter-spacing:.06em;
          text-transform:uppercase; background:#49D7A7; color:#111; border:none; border-radius:10px;
          padding:11px 26px; cursor:pointer; transition:background .2s; display:flex; align-items:center; gap:8px;
        }
        .bta-btn-next:hover, .bta-btn-submit:hover { background:#3bc495; }
        .bta-btn-submit:disabled { opacity:.7; cursor:not-allowed; }

        .bta-success { text-align:center; padding:80px 40px; }
        .bta-success-ico { width:68px; height:68px; background:rgba(73,215,167,.1); border:1px solid rgba(73,215,167,.3); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:1.8rem; margin:0 auto 24px; }
        .bta-success-title { font-family:'Sora',sans-serif; font-size:1.3rem; font-weight:700; color:#111; margin-bottom:12px; }
        .bta-success-sub { font-size:.88rem; color:#777; line-height:1.75; max-width:380px; margin:0 auto; }
        .bta-success-btn {
          display:inline-block; margin-top:28px; font-family:'Sora',sans-serif; font-size:.82rem;
          font-weight:700; letter-spacing:.06em; background:#49D7A7; color:#111; border:none;
          border-radius:12px; padding:14px 32px; cursor:pointer; text-decoration:none;
        }
        .bta-add-exp-btn {
          font-family:'DM Sans',sans-serif; font-size:.78rem; font-weight:600; color:#7E47FF;
          background:rgba(126,71,255,.07); border:1.5px dashed rgba(126,71,255,.3); border-radius:10px;
          padding:10px 20px; cursor:pointer; width:100%; transition:all .18s; margin-top:4px;
        }
        .bta-add-exp-btn:hover { background:rgba(126,71,255,.12); border-color:#7E47FF; }
        .bta-exp-entry { background:#fff; border:1px solid rgba(0,0,0,.09); border-radius:14px; padding:20px 20px 14px; margin-bottom:12px; position:relative; }
        .bta-exp-remove {
          position:absolute; top:14px; right:14px; width:26px; height:26px; background:rgba(0,0,0,.05);
          border:none; border-radius:6px; cursor:pointer; font-size:.75rem; color:#aaa;
          display:flex; align-items:center; justify-content:center; transition:all .15s;
        }
        .bta-exp-remove:hover { background:rgba(239,68,68,.1); color:#ef4444; }
        .bta-exp-entry .bta-grid-2 { margin-bottom:10px; }

        @media (max-width: 768px) {
          /* Layout */
          .bta-layout { padding: 24px 20px 60px; }
          .bta-grid-2 { grid-template-columns: 1fr; }

          /* Steps bar — pin below mobile navbar */
          .bta-steps-bar { top: 64px; }

          /* Single-active-step mode with caption */
          .bta-steps-inner {
            flex-direction: column;
            gap: 4px;
            padding: 8px 20px 0;
            justify-content: center;
          }
          .bta-step:not(.active) { display: none; }
          .bta-step-line { display: none; }
          .bta-step-counter {
            display: block;
            font-family: 'DM Sans', sans-serif;
            font-size: .62rem;
            font-weight: 600;
            letter-spacing: .14em;
            text-transform: uppercase;
            color: #9aa0a6;
            text-align: center;
          }

          /* Hero stats — vertical stack (3 cells, full-width each) */
          .bat-stats {
            display: flex;
            flex-direction: column;
            gap: 0;
          }
          .bat-stat {
            padding: 22px 24px;
            border-right: none;
            border-bottom: 1px solid rgba(255, 255, 255, 0.18);
            text-align: left;
          }
          .bat-stat:last-child {
            border-bottom: none;
          }
          .bat-stat-num { font-size: 28px; margin-bottom: 6px; letter-spacing: -0.5px; }
          .bat-stat-days { font-size: 22px; }
          .bat-stat-label { font-size: 10px; }

          /* iOS auto-zoom prevention */
          .bta-input,
          .bta-select,
          .bta-textarea,
          .bta-skill-inp { font-size: 16px; }

          /* Tap targets >= 44px */
          .bta-exp-remove { width: 40px; height: 40px; }
          .bta-radio-opt { padding: 12px 16px; min-height: 44px; }
          .bta-photo-btn { padding: 10px 16px; }
          .bta-stag-x { padding: 6px 8px; margin: -4px -6px -4px 0; }
          .bta-btn-ghost,
          .bta-btn-next,
          .bta-btn-submit { min-height: 44px; }
          .bta-add-exp-btn { min-height: 44px; padding: 12px 20px; }
        }

        @media (max-width: 640px) {
          /* Hero heading scale-down */
          .bat-h1,
          .bat-h2 {
            font-size: clamp(32px, 9vw, 44px);
            letter-spacing: -1px;
          }

          /* Hero wrap padding reduction */
          .bat-wrap { padding: 56px 16px 36px; }

          /* Form footer — column stack with full-width buttons */
          .bta-form-footer {
            flex-direction: column-reverse;
            gap: 12px;
            align-items: stretch;
            padding: 16px 20px;
          }
          .bta-btn-ghost,
          .bta-btn-next,
          .bta-btn-submit { width: 100%; justify-content: center; }
          .bta-footer-note { text-align: center; }
        }

        @media (max-width: 480px) {
          /* Form card padding reduction */
          .bta-form-header { padding: 20px 20px 16px; }
          .bta-form-body { padding: 20px 20px; }

          /* Photo preview — stack column */
          .bta-photo-wrap {
            flex-direction: column;
            align-items: flex-start;
            gap: 14px;
          }
          .bta-photo-prev { width: 88px; height: 88px; }
        }

        .bta-step-num,
        .bta-step.active .bta-step-num,
        .bta-step.done .bta-step-num,
        .bta-step-circle .bta-step-num {
          display:inline-flex !important;
          visibility:visible !important;
          opacity:1 !important;
          color:inherit !important;
          font-size:0.82rem !important;
          font-weight:700 !important;
        }

        .bta-step-circle::before,
        .bta-step-circle::after,
        .bta-step.active .bta-step-circle::before,
        .bta-step.active .bta-step-circle::after {
          display:none !important;
          content:none !important;
        }
      `}</style>
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
      <div className="bta-fh-icon">{icon}</div>
      <div>
        <div className="bta-fh-title">{title}</div>
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
  return (
    <div className="bta-form-group">
      <div className="bta-label">
        {label} {required && <span className="bta-req">*</span>}
      </div>
      {children}
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
        <div className="bta-sec-title">Basic Details</div>
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

      {props.error && <div role="alert" style={ERROR_BOX_STYLE}>{props.error}</div>}

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
        <div className="bta-sec-title">Headline</div>
        <Field label="Job Titles" required>
          <input
            type="text"
            className="bta-input"
            placeholder="Full Stack Developer | Backend Developer | Web Developer"
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
          />
          <p className="bta-skill-hint">{props.bio.trim().length}/50 characters minimum</p>
        </Field>

        <div className="bta-spacer" />
        <div className="bta-sec-title">Skills</div>
        <Field label="Skills & Expertise" required hint="Type a skill and press Enter. Add at least 3.">
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
        </Field>

        <div className="bta-spacer" />
        <div className="bta-sec-title">Employment History</div>
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
        <div className="bta-sec-title">Education</div>
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
        <div className="bta-sec-title">
          Portfolio
          <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(Optional)</span>
        </div>
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

      {props.error && <div role="alert" style={ERROR_BOX_STYLE}>{props.error}</div>}

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
        <div className="bta-sec-title">Rate & Hours</div>
        <div className="bta-grid-2">
          <Field label="Hourly Rate (USD)" required>
            <input
              type="number"
              className="bta-input"
              placeholder="e.g. 35"
              min={0}
              value={props.hourlyRate}
              onChange={(e) => props.setHourlyRate(e.target.value)}
            />
          </Field>
        </div>

        <div className="bta-form-group" style={{ marginTop: 18 }}>
          <div className="bta-label">Hours per Week <span className="bta-req">*</span></div>
          <div className="bta-radio-group">
            {(Object.keys(HOURS_LABEL) as HoursOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.hoursPerWeek === v ? "sel" : ""}`}>
                <input type="radio" name="brr-hours" checked={props.hoursPerWeek === v} onChange={() => props.setHoursPerWeek(v)} />
                <span className="bta-rdot" />
                {HOURS_LABEL[v]}
              </label>
            ))}
          </div>
        </div>

        <div className="bta-spacer" />
        <div className="bta-sec-title">Work Setup</div>
        <div className="bta-form-group" style={{ marginBottom: 20 }}>
          <div className="bta-label">Work Type <span className="bta-req">*</span></div>
          <div className="bta-radio-group">
            {(Object.keys(WORK_TYPE_LABEL) as WorkTypeOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.workType === v ? "sel" : ""}`}>
                <input type="radio" name="brr-wt" checked={props.workType === v} onChange={() => props.setWorkType(v)} />
                <span className="bta-rdot" />
                {WORK_TYPE_LABEL[v]}
              </label>
            ))}
          </div>
        </div>

        <div className="bta-form-group" style={{ marginBottom: 20 }}>
          <div className="bta-label">Availability <span className="bta-req">*</span></div>
          <div className="bta-radio-group">
            {(Object.keys(AVAIL_LABEL) as AvailabilityOpt[]).map((v) => (
              <label key={v} className={`bta-radio-opt ${props.availability === v ? "sel" : ""}`}>
                <input type="radio" name="brr-av" checked={props.availability === v} onChange={() => props.setAvailability(v)} />
                <span className="bta-rdot" />
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
        </div>

        <div className="bta-spacer" />
        <div className="bta-sec-title">Languages</div>
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

      {props.error && <div role="alert" style={ERROR_BOX_STYLE}>{props.error}</div>}

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
        <div className="bta-sec-title">Upload your Portfolio, CV or other Documents <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(Optional)</span></div>
        <div
          className={`bta-upload-zone ${props.cvDragOver ? "drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); props.setCvDragOver(true); }}
          onDragLeave={() => props.setCvDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            props.setCvDragOver(false);
            props.handleCv(e.dataTransfer.files?.[0]);
          }}
        >
          <input
            ref={props.cvInputRef}
            type="file"
            accept=".pdf,.doc,.docx"
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
          <div className="bta-upload-fmt">PDF, DOC, or DOCX (max 5 MB)</div>
        </div>

        <div className="bta-spacer" />
        <div className="bta-sec-title">Profile Photo <span style={{ color: "#bbb", fontSize: ".62rem", marginLeft: 6 }}>(optional)</span></div>
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

      {props.error && <div role="alert" style={ERROR_BOX_STYLE}>{props.error}</div>}

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
