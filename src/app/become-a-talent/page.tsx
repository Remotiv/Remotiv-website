"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

// ── Client-side PDF text extraction (mirrors admin bulk-upload helper)
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

type WorkExperience = {
  id: number;
  title: string;
  company: string;
  start: string;
  end: string;
  skills: string;
};

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

const ROLE_CATEGORIES = [
  { value: "Engineer", label: "Engineer" },
  { value: "SDR", label: "SDR / Sales" },
  { value: "CS", label: "Customer Success" },
  { value: "Design", label: "Design & UX" },
  { value: "Data", label: "Data & AI" },
  { value: "DevOps", label: "DevOps & Cloud" },
  { value: "QA", label: "Quality Assurance" },
  { value: "Marketing", label: "Marketing & Growth" },
  { value: "Ops", label: "Business & Ops" },
  { value: "Finance", label: "Finance & Accounting" },
  { value: "Other", label: "Other" },
];

const INDUSTRIES = [
  "Software & Technology",
  "Design & Creative",
  "Marketing & Growth",
  "Finance & Accounting",
  "Sales & Business Development",
  "Customer Support",
  "Data & Analytics",
  "Other",
];

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
    sub: "Access jobs from the Pakistan, US, UK, and beyond.",
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

      <div className="bat-content">
        <div className="bat-pill">
          <span className="bat-pill-now">Now</span>
          <span className="bat-pill-text">Hiring Globally</span>
        </div>

        <div className="bat-h1">Join the Remotiv</div>
        <div className="bat-h2">Talent Network</div>

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

  const [experiences, setExperiences] = useState<WorkExperience[]>([]);
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

  const [submitState, setSubmitState] = useState<"form" | "success" | "duplicate">("form");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const handleStep1Next = () => {
    setStep1Error(null);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneDigits = phone.replace(/\D/g, "");
    const linkedinValid = linkedinUrl.toLowerCase().includes("linkedin.com");

    if (!firstName.trim()) { setStep1Error("First name is required"); return; }
    if (!lastName.trim())  { setStep1Error("Last name is required"); return; }
    if (!email.trim() || !emailRegex.test(email)) {
      setStep1Error("Please enter a valid email address"); return;
    }
    if (!phone.trim() || phoneDigits.length < 7) {
      setStep1Error("Please enter a valid phone number"); return;
    }
    if (!city.trim())    { setStep1Error("City is required"); return; }
    if (!country.trim()) { setStep1Error("Country is required"); return; }
    if (!linkedinUrl.trim() || !linkedinValid) {
      setStep1Error("Please enter a valid LinkedIn URL (linkedin.com/in/...)");
      return;
    }
    goToStep(2);
  };

  const goToStep = (target: number) => {
    if (target < 1 || target > 4) return;
    setStep(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const addExperience = () => {
    setExperiences((prev) => [
      ...prev,
      { id: Date.now(), title: "", company: "", start: "", end: "", skills: "" },
    ]);
  };

  const updateExperience = (id: number, patch: Partial<WorkExperience>) => {
    setExperiences((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const removeExperience = (id: number) => {
    setExperiences((prev) => prev.filter((e) => e.id !== id));
  };

  const handleSkillKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = skillInput.trim();
      if (!val) return;
      if (skills.length >= 15) return;
      if (skills.includes(val)) return;
      setSkills((prev) => [...prev, val]);
      setSkillInput("");
    }
  };

  const removeSkill = (tag: string) => {
    setSkills((prev) => prev.filter((s) => s !== tag));
  };

  const ALLOWED_IMAGE_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type && !ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setSubmitError(
        "Photo must be a JPG, PNG, WEBP, or GIF image.",
      );
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
    if (!allowed.includes(file.type)) return;
    if (file.size > 5 * 1024 * 1024) return;
    setCvFile(file);
  };

  const handleSubmit = async () => {
    setSubmitError(null);

    if (!cvFile) {
      setSubmitError("Please upload your CV to continue");
      return;
    }

    setSubmitting(true);

    try {
      // Extract CV text in the browser when a PDF is attached.
      let cvText = "";
      if (cvFile && cvFile.type === "application/pdf") {
        try {
          cvText = await extractPdfText(cvFile);
        } catch {
          // silent — submission still proceeds without searchable text
        }
      }

      const fd = new FormData();
      fd.append("first_name",     firstName);
      fd.append("last_name",      lastName);
      fd.append("email",          email);
      fd.append("phone",          phone);
      fd.append("city",           city);
      fd.append("country",        country);
      fd.append("linkedin_url",   linkedinUrl);
      fd.append("github_url",     githubUrl);
      // job_title / role_category / years_experience / industry are no longer
      // collected directly — the API derives them from the experience array.
      fd.append("degree",         degree);
      fd.append("institution",    institution);
      fd.append("summary",        summary);
      fd.append("skills",         JSON.stringify(skills));
      // Serialize work history — strip the local `id`, derive a "dates" string
      // ("2021–Present · 3 yrs"-style format) and split the comma-separated
      // skills string into an array so the modal can render them as tags.
      const expPayload = experiences
        .filter((e) => e.title?.trim() || e.company?.trim())
        .map((e) => ({
          title:   e.title?.trim()   ?? "",
          company: e.company?.trim() ?? "",
          start:   e.start?.trim()   ?? "",
          end:     e.end?.trim()     ?? "",
          dates:   [e.start?.trim(), e.end?.trim()].filter(Boolean).join(" – "),
          skills:  (e.skills ?? "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        }));
      fd.append("experience", JSON.stringify(expPayload));
      fd.append("availability",   AVAILABILITY_LABEL[availability]   ?? availability);
      fd.append("work_type",      WORK_TYPE_LABEL[workType]          ?? workType);
      fd.append("notice_period",  NOTICE_PERIOD_LABEL[noticePeriod]  ?? noticePeriod);
      fd.append("work_location",  WORK_LOCATION_LABEL[workLocation]  ?? workLocation);
      if (cvText.trim()) fd.append("cv_text", cvText);
      if (cvFile)        fd.append("cv",      cvFile);
      if (photoFile)     fd.append("photo",   photoFile);

      const res = await fetch("/api/talent", { method: "POST", body: fd });

      if (res.status === 409) {
        setSubmitState("duplicate");
        setSubmitted(true);
        return;
      }

      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Submission failed.");

      setSubmitState("success");
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />
      <div className="bta-root">
        <div className="bat-outer">
          <GridBackground />
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
                  <span className="bta-step-circle">{s.num}</span>
                  {s.label}
                </button>
                {idx < STEPS.length - 1 && <span className="bta-step-line" />}
              </div>
            ))}
          </div>
        </div>

        <div className="bta-layout">
          <div>
            <div className="bta-form-card">
              {submitted ? (
                submitState === "duplicate" ? (
                  <div className="bta-success" style={{ display: "block" }}>
                    <div className="bta-success-ico">👋</div>
                    <div className="bta-success-title">Already in our network</div>
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
                    >
                      Follow us on LinkedIn →
                    </a>
                  </div>
                ) : (
                  <div className="bta-success" style={{ display: "block" }}>
                    <div className="bta-success-ico">🎉</div>
                    <div className="bta-success-title">You&apos;re in the Network!</div>
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
                    >
                      🔗 Follow Remotiv on LinkedIn
                    </a>
                    <Link href="/jobs" className="bta-success-btn">
                      Browse Open Jobs →
                    </Link>
                  </div>
                )
              ) : (
                <>
                  {step === 1 && (
                    <div className="bta-form-step active">
                      <div className="bta-form-header">
                        <div className="bta-fh-icon">👤</div>
                        <div>
                          <div className="bta-fh-title">Personal Information</div>
                          <div className="bta-fh-sub">
                            Tell us who you are — this stays private until matched
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <div className="bta-sec-title">Basic Details</div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <div className="bta-label">
                              First Name <span className="bta-req">*</span>
                            </div>
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
                                type="text"
                                className="bta-input"
                                placeholder="e.g. Sarah"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                              />
                            </div>
                          </div>
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Last Name <span className="bta-req">*</span>
                            </div>
                            <input
                              type="text"
                              className="bta-input"
                              placeholder="e.g. Khan"
                              value={lastName}
                              onChange={(e) => setLastName(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Email Address <span className="bta-req">*</span>
                            </div>
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
                                type="email"
                                className="bta-input"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                              />
                            </div>
                          </div>
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Phone Number <span className="bta-req">*</span>
                            </div>
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
                                type="tel"
                                className="bta-input"
                                placeholder="+92 300 0000000"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <div className="bta-label">
                              City <span className="bta-req">*</span>
                            </div>
                            <input
                              type="text"
                              className="bta-input"
                              placeholder="e.g. Lahore"
                              value={city}
                              onChange={(e) => setCity(e.target.value)}
                            />
                          </div>
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Country <span className="bta-req">*</span>
                            </div>
                            <select
                              className="bta-select"
                              value={country}
                              onChange={(e) => setCountry(e.target.value)}
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
                            <div className="bta-label">
                              LinkedIn Profile <span className="bta-req">*</span>
                            </div>
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
                                type="url"
                                className="bta-input"
                                placeholder="linkedin.com/in/yourname"
                                value={linkedinUrl}
                                onChange={(e) => setLinkedinUrl(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                        <div className="bta-spacer" />
                        <div className="bta-sec-title">Profile Photo</div>
                        <div className="bta-photo-wrap">
                          <label className="bta-photo-prev">
                            <input type="file" accept="image/*" onChange={handlePhoto} />
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
                          </div>
                        </div>
                      </div>
                      {step1Error && (
                        <div
                          role="alert"
                          style={{
                            margin: "0 32px 16px",
                            padding: "10px 14px",
                            background: "rgba(239,68,68,0.08)",
                            border: "1px solid rgba(239,68,68,0.25)",
                            borderRadius: 10,
                            color: "#dc2626",
                            fontSize: "0.78rem",
                            fontFamily: "'DM Sans',sans-serif",
                            fontWeight: 500,
                          }}
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
                        <div className="bta-fh-icon">💼</div>
                        <div>
                          <div className="bta-fh-title">Professional Information</div>
                          <div className="bta-fh-sub">
                            Your role, experience and skills — this powers your AI matching
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <div className="bta-sec-title">Education</div>
                        <div className="bta-grid-2">
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Degree / Qualification <span className="bta-req">*</span>
                            </div>
                            <input
                              type="text"
                              className="bta-input"
                              placeholder="e.g. BS Computer Science"
                              value={degree}
                              onChange={(e) => setDegree(e.target.value)}
                            />
                          </div>
                          <div className="bta-form-group">
                            <div className="bta-label">
                              Institution / University <span className="bta-req">*</span>
                            </div>
                            <input
                              type="text"
                              className="bta-input"
                              placeholder="e.g. University"
                              value={institution}
                              onChange={(e) => setInstitution(e.target.value)}
                            />
                          </div>
                        </div>

                        <div className="bta-spacer" />
                        <div className="bta-sec-title">Work Experience</div>
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
                                  <div className="bta-label">
                                    Job Title <span className="bta-req">*</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. Senior Software Engineer"
                                    value={exp.title}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { title: e.target.value })
                                    }
                                  />
                                </div>
                                <div className="bta-form-group">
                                  <div className="bta-label">
                                    Company <span className="bta-req">*</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. Remotiv"
                                    value={exp.company}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { company: e.target.value })
                                    }
                                  />
                                </div>
                              </div>
                              <div className="bta-grid-2">
                                <div className="bta-form-group">
                                  <div className="bta-label">
                                    Start Date <span className="bta-req">*</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. 2021"
                                    value={exp.start}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { start: e.target.value })
                                    }
                                  />
                                </div>
                                <div className="bta-form-group">
                                  <div className="bta-label">End Date</div>
                                  <input
                                    type="text"
                                    className="bta-input"
                                    placeholder="e.g. 2024 or Present"
                                    value={exp.end}
                                    onChange={(e) =>
                                      updateExperience(exp.id, { end: e.target.value })
                                    }
                                  />
                                </div>
                              </div>
                              <div className="bta-form-group">
                                <div className="bta-label">
                                  Skills Used <span className="bta-opt">optional</span>
                                </div>
                                <input
                                  type="text"
                                  className="bta-input"
                                  placeholder="e.g. React, Node.js, AWS (comma separated)"
                                  value={exp.skills}
                                  onChange={(e) =>
                                    updateExperience(exp.id, { skills: e.target.value })
                                  }
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="bta-add-exp-btn"
                          onClick={addExperience}
                        >
                          + Add Work Experience
                        </button>

                        <div className="bta-spacer" />
                        <div className="bta-sec-title">Skills & Summary</div>
                        <div className="bta-form-group" style={{ marginBottom: 6 }}>
                          <div className="bta-label">
                            Skills & Expertise <span className="bta-opt">optional</span>
                          </div>
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
                              className="bta-skill-inp"
                              type="text"
                              placeholder="Add a skill, press Enter..."
                              value={skillInput}
                              onChange={(e) => setSkillInput(e.target.value)}
                              onKeyDown={handleSkillKey}
                            />
                          </div>
                          <p className="bta-skill-hint">
                            Type a skill and press Enter to add. Up to 15 skills.
                          </p>
                        </div>
                        <div className="bta-spacer" />
                        <div className="bta-form-group">
                          <div className="bta-label">
                            Professional Summary <span className="bta-opt">optional</span>
                          </div>
                          <textarea
                            className="bta-textarea"
                            placeholder="Write a short bio — your experience, what you specialise in, and what opportunities you're looking for."
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                          />
                        </div>
                      </div>
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
                            onClick={() => goToStep(3)}
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
                        <div className="bta-fh-icon">⚙️</div>
                        <div>
                          <div className="bta-fh-title">Work Preferences</div>
                          <div className="bta-fh-sub">
                            How and when you want to work — helps us find your best match
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <div className="bta-sec-title">Availability Status</div>
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

                        <div className="bta-sec-title">Work Setup</div>
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
                        <div className="bta-fh-icon">📄</div>
                        <div>
                          <div className="bta-fh-title">CV / Resume Upload</div>
                          <div className="bta-fh-sub">
                            Upload your latest CV — reviewed by our team and matched employers
                          </div>
                        </div>
                      </div>
                      <div className="bta-form-body">
                        <div className="bta-sec-title">
                          Upload your CV <span className="bta-req">*</span>
                        </div>
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
                                >
                                  browse to upload
                                </button>
                              </>
                            )}
                          </div>
                          <div className="bta-upload-fmt">Required — PDF, DOC, or DOCX (max 5 MB)</div>
                        </div>

                        <div className="bta-spacer" />
                        <div className="bta-sec-title">GitHub Profile</div>
                        <div className="bta-form-group">
                          <div className="bta-label">
                            GitHub URL{" "}
                            <span className="bta-opt">optional — for engineers</span>
                          </div>
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
                              type="url"
                              className="bta-input"
                              placeholder="github.com/yourusername"
                              value={githubUrl}
                              onChange={(e) => setGithubUrl(e.target.value)}
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
                          >
                            {submitting ? "Submitting..." : "Submit Profile"}
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
                      <p
                        style={{
                          fontFamily: "'DM Sans',sans-serif",
                          fontSize: "0.72rem",
                          color: "#777",
                          textAlign: "center",
                          padding: "12px 32px 0",
                          lineHeight: 1.65,
                        }}
                      >
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
      <Footer />

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
        .bat-sub { font-size:17px; color:#777; line-height:1.7; max-width:520px; margin:0 0 48px; text-align:center; font-weight:400; }
        .bat-stats {
          display:flex; align-items:stretch; background:#7E47FF; border-radius:20px;
          overflow:hidden; width:100%; max-width:1040px;
        }
        .bat-stat { flex:1; padding:36px 32px; text-align:left; border-right:1px solid rgba(255,255,255,.18); }
        .bat-stat:last-child { border-right:none; }
        .bat-stat-num { font-family:'Sora',sans-serif; font-size:42px; font-weight:800; color:#fff; line-height:1; margin:0 0 14px; letter-spacing:-1px; }
        .bat-stat-days { font-family:'Sora',sans-serif; font-size:36px; font-weight:800; color:#c9ff85; line-height:1; margin-left:4px; }
        .bat-stat-label { font-size:11px; font-weight:600; color:rgba(255,255,255,.65); letter-spacing:.1em; text-transform:uppercase; }

        .bta-steps-bar { background:#fff; border-bottom:1px solid rgba(0,0,0,.07); position:sticky; top:0; z-index:50; }
        .bta-steps-inner { display:flex; align-items:center; justify-content:center; max-width:800px; margin:0 auto; padding:0 40px; overflow-x:auto; }
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
          width:24px; height:24px; border-radius:50%; border:1.5px solid rgba(0,0,0,.15);
          display:flex; align-items:center; justify-content:center; font-size:.65rem; font-weight:700;
          color:#bbb; flex-shrink:0; transition:all .25s;
        }
        .bta-step.active .bta-step-circle { border-color:#49D7A7; background:#49D7A7; color:#111; }
        .bta-step.done .bta-step-circle { border-color:#49D7A7; color:#49D7A7; background:rgba(73,215,167,.1); }
        .bta-step-line { width:36px; height:1px; background:rgba(0,0,0,.1); flex-shrink:0; }
        .bta-step-counter { display: none; }

        .bta-layout {
          max-width:1100px; margin:0 auto; padding:32px 40px 100px;
          display:grid; grid-template-columns:1fr 280px; gap:24px; align-items:start;
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
        .bta-input-wrap { position:relative; }
        .bta-input-icon { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#bbb; pointer-events:none; display:flex; align-items:center; }
        .bta-input-icon + .bta-input { padding-left:36px; }
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
        .bta-upload-sub span { color:#49D7A7; cursor:pointer; font-weight:600; }
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
        .bta-form-actions { display:flex; gap:10px; }
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

        .bta-sidebar { display:flex; flex-direction:column; gap:16px; position:sticky; top:80px; }
        .bta-sidebar-card { background:#f8f4f1; border:1px solid rgba(0,0,0,.08); border-radius:18px; padding:24px; }
        .bta-sidebar-title {
          font-family:'Sora',sans-serif; font-size:.65rem; font-weight:700; letter-spacing:.14em;
          text-transform:uppercase; color:#49D7A7; margin-bottom:20px; display:flex; align-items:center; gap:8px;
        }
        .bta-sidebar-title::before { content:''; width:12px; height:1px; background:#49D7A7; }
        .bta-perk { display:flex; gap:12px; margin-bottom:16px; }
        .bta-perk:last-child { margin-bottom:0; }
        .bta-perk-ico {
          width:36px; height:36px; background:rgba(73,215,167,.1); border:1px solid rgba(73,215,167,.2);
          border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:.9rem; flex-shrink:0;
        }
        .bta-perk-title { font-size:.8rem; font-weight:700; color:#111; margin-bottom:3px; }
        .bta-perk-sub { font-size:.75rem; color:#888; line-height:1.6; }
        .bta-divider { height:1px; background:rgba(0,0,0,.07); margin:16px 0; }
        .bta-sstat-label { font-size:.65rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:#bbb; margin-bottom:6px; }
        .bta-sstat-num { font-family:'Sora',sans-serif; font-size:1.9rem; font-weight:800; color:#111; line-height:1; }
        .bta-sstat-num em { color:#49D7A7; font-style:normal; }
        .bta-sstat-desc { font-size:.75rem; color:#888; margin-top:6px; line-height:1.65; }

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
        .bta-avail-toggle-wrap { display:flex; flex-wrap:wrap; gap:8px; }

        @media (max-width:1024px) {
          .bta-layout { grid-template-columns:1fr; }
          .bta-sidebar { display:none; }
        }
        @media (max-width:768px) {
          .bta-layout { padding:24px 20px 60px; }
          .bta-grid-2 { grid-template-columns:1fr; }
          .bta-form-footer { flex-direction:column; align-items:flex-start; }

          /* Steps bar — pin below mobile navbar (mobile-only) */
          .bta-steps-bar { top: 64px; }

          /* Single-active-step mode */
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

          /* Hero stats — 2x2 grid */
          .bat-stats { display: grid; grid-template-columns: 1fr 1fr; }
          .bat-stat {
            padding: 24px 18px;
            border-right: none;
            border-bottom: 1px solid rgba(255, 255, 255, 0.18);
          }
          .bat-stat:nth-last-child(-n+2) { border-bottom: none; }
          .bat-stat:nth-child(odd) { border-right: 1px solid rgba(255, 255, 255, 0.18); }
          .bat-stat-num { font-size: 28px; margin-bottom: 8px; letter-spacing: -0.5px; }
          .bat-stat-days { font-size: 24px; }
          .bat-stat-label { font-size: 10px; }

          /* Tap targets ≥ 44px */
          .bta-exp-remove { width: 40px; height: 40px; top: 10px; right: 10px; }
          .bta-radio-opt { padding: 12px 16px; min-height: 44px; }
          .bta-photo-btn { padding: 10px 16px; }

          /* Skill chip ✕ — invisible hit-area boost via negative margins */
          .bta-stag-x { padding: 6px 8px; margin: -4px -6px -4px 0; }
        }

        @media (max-width: 640px) {
          /* Hero heading scale-down */
          .bat-h1, .bat-h2 { font-size: clamp(32px, 9vw, 44px); letter-spacing: -1px; }
          .bat-sub { font-size: 15px; margin-bottom: 32px; }
          .bat-wrap { padding: 56px 20px 36px; border-radius: 24px; }
          .bat-outer { padding: 16px; }

          /* Form-footer buttons — Primary on top, full-width */
          .bta-form-footer { padding: 18px 20px; gap: 12px; }
          .bta-form-actions {
            width: 100%;
            flex-direction: column-reverse;
            gap: 10px;
          }
          .bta-btn-ghost,
          .bta-btn-next,
          .bta-btn-submit {
            width: 100%;
            justify-content: center;
            padding: 14px 18px;
          }
        }

        @media (max-width: 480px) {
          /* Form card padding ease-up */
          .bta-form-header { padding: 20px 20px 16px; }
          .bta-form-body { padding: 20px 20px; }

          /* Photo preview — stack + 88px */
          .bta-photo-wrap { flex-direction: column; align-items: flex-start; gap: 14px; }
          .bta-photo-prev { width: 88px; height: 88px; }

          /* Skill input — allow tighter wrap when many tags */
          .bta-skill-inp { min-width: 80px; }
        }

        @media (max-width: 430px) {
          .bat-stat { padding: 18px 14px; }
          .bat-stat-num { font-size: 24px; }
          .bat-stat-days { font-size: 20px; }
        }
      `}</style>
    </>
  );
}
