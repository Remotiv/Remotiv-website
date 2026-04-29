"use client";

import {
  Bookmark,
  Briefcase,
  Globe,
  MapPin,
  MoreHorizontal,
  Search,
  Star,
  X,
  CheckCircle,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

interface Job {
  id: string;
  title: string;
  company: string;
  company_rating: number;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  description: string | null;
  status: string;
  created_at: string;
}

type ExperienceLevel = "Entry" | "Intermediate" | "Expert";
type ContractType = "Full time" | "Part time" | "Contract";

const EXPERIENCE_LEVELS: ExperienceLevel[] = ["Entry", "Intermediate", "Expert"];
const CONTRACT_TYPES: ContractType[] = ["Full time", "Part time", "Contract"];

const CATEGORIES = [
  "Engineering",
  "Design",
  "Sales",
  "Marketing",
  "Data",
  "Support",
];

const LANGUAGES = ["English", "Urdu", "Arabic"];

const LS_FAVORITES = "favoriteJobs";
const LS_SAVED_SEARCH = "savedJobSearch";

type SavedSearch = {
  searchQuery: string;
  locationFilter: string;
  workMode: string;
  pendingCategory: string;
  pendingExperience: ExperienceLevel[];
  pendingContract: ContractType[];
  pendingLanguage: string;
};

function fmtSalary(min: number | null, max: number | null): string {
  if (!min && !max) return "Salary not disclosed";
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (min && max) {
    if (min === max) return `${fmt(min)}/yr`;
    return `${fmt(min)} – ${fmt(max)}/yr`;
  }
  if (min) return `From ${fmt(min)}/yr`;
  return `Up to ${fmt(max!)}/yr`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [selectedCategory, setSelectedCategory] = useState("");
  const [experience, setExperience] = useState<Set<ExperienceLevel>>(new Set());
  const [contract, setContract] = useState<Set<ContractType>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [workMode, setWorkMode] = useState("");

  const [pendingCategory, setPendingCategory] = useState("");
  const [pendingExperience, setPendingExperience] = useState<Set<ExperienceLevel>>(new Set());
  const [pendingContract, setPendingContract] = useState<Set<ContractType>>(new Set());
  const [pendingLanguage, setPendingLanguage] = useState("");

  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [showFavorites, setShowFavorites] = useState(false);
  const [saveToast, setSaveToast] = useState(false);
  const [applyJob, setApplyJob] = useState<Job | null>(null);

  // Restore favorites + saved search from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_FAVORITES);
      if (raw) setFavorites(new Set(JSON.parse(raw) as string[]));
    } catch {}

    try {
      const raw = localStorage.getItem(LS_SAVED_SEARCH);
      if (raw) {
        const s = JSON.parse(raw) as SavedSearch;
        setSearchQuery(s.searchQuery ?? "");
        setLocationFilter(s.locationFilter ?? "");
        setWorkMode(s.workMode ?? "");
        setPendingCategory(s.pendingCategory ?? "");
        setPendingExperience(new Set(s.pendingExperience ?? []));
        setPendingContract(new Set(s.pendingContract ?? []));
        setPendingLanguage(s.pendingLanguage ?? "");
      }
    } catch {}
  }, []);

  // Auto-dismiss save toast
  useEffect(() => {
    if (!saveToast) return;
    const t = setTimeout(() => setSaveToast(false), 2500);
    return () => clearTimeout(t);
  }, [saveToast]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(LS_FAVORITES, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  const handleSaveSearch = () => {
    const payload: SavedSearch = {
      searchQuery,
      locationFilter,
      workMode,
      pendingCategory,
      pendingExperience: [...pendingExperience],
      pendingContract: [...pendingContract],
      pendingLanguage,
    };
    try {
      localStorage.setItem(LS_SAVED_SEARCH, JSON.stringify(payload));
    } catch {}
    setSaveToast(true);
  };

  const fetchJobs = useCallback(
    async (
      category: string,
      experienceLevels: Set<ExperienceLevel>,
      contractTypes: Set<ContractType>,
      language: string,
    ) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (experienceLevels.size > 0)
        params.set("experience_level", [...experienceLevels].join(","));
      if (contractTypes.size > 0)
        params.set("contract_type", [...contractTypes].join(","));
      if (language) params.set("language", language);

      try {
        const res = await fetch(`/api/jobs?${params.toString()}`);
        const data = await res.json();
        setJobs(Array.isArray(data) ? data : []);
      } catch {
        setJobs([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchJobs(selectedCategory, experience, contract, selectedLanguage);
  }, [fetchJobs, selectedCategory, experience, contract, selectedLanguage]);

  const applyFilters = () => {
    setSelectedCategory(pendingCategory);
    setExperience(pendingExperience);
    setContract(pendingContract);
    setSelectedLanguage(pendingLanguage);
    setActiveId(null);
  };

  const resetFilters = () => {
    setPendingCategory("");
    setPendingExperience(new Set());
    setPendingContract(new Set());
    setPendingLanguage("");
    setSelectedCategory("");
    setExperience(new Set());
    setContract(new Set());
    setSelectedLanguage("");
    setActiveId(null);
  };

  const toggleExperience = (val: ExperienceLevel) => {
    setPendingExperience((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const toggleContract = (val: ContractType) => {
    setPendingContract((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const filteredJobs = useMemo(() => {
    let result = showFavorites ? jobs.filter((j) => favorites.has(j.id)) : jobs;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (j) =>
          j.title.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q),
      );
    }
    if (locationFilter.trim()) {
      const q = locationFilter.toLowerCase();
      result = result.filter((j) => j.location.toLowerCase().includes(q));
    }
    if (workMode.trim()) {
      const q = workMode.toLowerCase();
      result = result.filter((j) => j.work_type.toLowerCase().includes(q));
    }
    return result;
  }, [jobs, searchQuery, locationFilter, workMode, showFavorites, favorites]);

  const rows = useMemo(() => chunk(filteredJobs, 3), [filteredJobs]);

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-[#FAFAFA] font-sans">
        <div className="flex flex-col gap-2 px-6 pt-6 md:px-6">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex min-h-[280px] flex-col rounded-[20px] bg-[#0e0e0e] p-8 md:p-10">
              <span className="mb-3.5 inline-flex w-fit items-center gap-2 rounded-full border border-remotiv-green/30 bg-remotiv-green/[0.08] px-4 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-remotiv-green">
                <span className="size-1.5 rounded-full bg-remotiv-green" />
                Now Hiring
              </span>
              <h1 className="m-0 flex-1 font-heading text-[clamp(2rem,4vw,3.2rem)] font-semibold uppercase leading-none tracking-[-0.02em] text-white">
                Jobs &amp;
                <br />
                <em className="not-italic text-remotiv-green">Talent</em>
              </h1>
              <p className="mt-5 text-[0.82rem] leading-[1.7] text-white/45">
                Explore our diverse range of job openings across various departments
                and locations, designed to match your skills, experience, and career
                aspirations.
              </p>
            </div>

            <div className="flex min-h-[280px] max-h-[320px] flex-col items-center justify-center gap-3 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#0e0e0e_0%,#1a1a2e_50%,#0e0e0e_100%)]">
              <Briefcase className="size-16 text-remotiv-green/40" strokeWidth={1.5} />
              <span className="text-xs uppercase tracking-[0.1em] text-white/30">
                {loading ? "Loading…" : `${filteredJobs.length} Open Position${filteredJobs.length !== 1 ? "s" : ""}`}
              </span>
            </div>
          </section>

          <section className="rounded-[20px] bg-remotiv-purple px-8 py-8 md:px-10 md:pb-9">
            <h2 className="mb-6 font-heading text-[clamp(1.2rem,2vw,1.6rem)] font-normal uppercase text-[#111]">
              Discover your dream job
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <SearchField
                icon={<Search className="size-[11px]" strokeWidth={2} />}
                placeholder="Job title, keywords, company name"
                value={searchQuery}
                onChange={setSearchQuery}
                size="lg"
              />
              <SearchField
                icon={<MapPin className="size-[11px]" strokeWidth={2} />}
                placeholder="Location"
                value={locationFilter}
                onChange={setLocationFilter}
                size="sm"
              />
              <SearchField
                icon={<Globe className="size-[11px]" strokeWidth={2} />}
                placeholder="Work mode"
                value={workMode}
                onChange={setWorkMode}
                size="sm"
              />
              <button
                type="button"
                className="shrink-0 whitespace-nowrap rounded-full bg-[#111] px-4 py-1.5 text-xs font-semibold text-white"
              >
                Advanced search
              </button>
              <button
                type="button"
                onClick={handleSaveSearch}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-white/35 bg-transparent px-3.5 py-[5px] text-xs font-semibold text-white transition-colors hover:border-white/60"
              >
                Save search
                <Bookmark className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          </section>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 px-6 pb-16 pt-4 lg:grid-cols-[280px_1fr]">
          <aside className="sticky top-20 rounded-[20px] border border-black/[0.08] bg-white p-7">
            <FilterGroup label="Category">
              <FilterSelect
                value={pendingCategory}
                onChange={setPendingCategory}
              >
                <option value="">Select category</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </FilterSelect>
            </FilterGroup>

            <Divider />

            <FilterGroup label="Experience level">
              {EXPERIENCE_LEVELS.map((label) => (
                <CheckItem
                  key={label}
                  label={label}
                  checked={pendingExperience.has(label)}
                  onToggle={() => toggleExperience(label)}
                />
              ))}
            </FilterGroup>

            <Divider />

            <FilterGroup label="Contract type">
              {CONTRACT_TYPES.map((label) => (
                <CheckItem
                  key={label}
                  label={label}
                  checked={pendingContract.has(label)}
                  onToggle={() => toggleContract(label)}
                />
              ))}
            </FilterGroup>

            <Divider />

            <FilterGroup label="Language">
              <FilterSelect
                value={pendingLanguage}
                onChange={setPendingLanguage}
              >
                <option value="">Select language</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </FilterSelect>
            </FilterGroup>

            <button
              type="button"
              onClick={applyFilters}
              className="w-full rounded-xl bg-[#111] px-3 py-3.5 font-heading text-[0.78rem] font-bold text-white"
            >
              Apply filter
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="mt-2.5 w-full bg-transparent px-3 py-1.5 text-[0.82rem] text-[#aaa]"
            >
              Reset filter
            </button>
          </aside>

          <div>
            <div className="mb-5 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => setShowFavorites((p) => !p)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] px-4 py-2.5 text-[0.82rem] font-semibold transition-colors",
                  showFavorites
                    ? "border-remotiv-green/30 bg-remotiv-green/10 text-remotiv-green"
                    : "border-black/10 bg-white text-[#555]",
                )}
              >
                <Bookmark
                  className="size-3.5"
                  strokeWidth={2}
                  fill={showFavorites ? "currentColor" : "none"}
                />
                Favorites
                {favorites.size > 0 && (
                  <span className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[10px] font-bold",
                    showFavorites ? "bg-remotiv-green text-[#111]" : "bg-gray-100 text-gray-500",
                  )}>
                    {favorites.size}
                  </span>
                )}
              </button>
            </div>

            {loading ? (
              <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#aaa]">
                Loading jobs…
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#aaa]">
                {showFavorites
                  ? "No favorited jobs yet. Click the bookmark icon on any job to save it."
                  : "No open positions match your filters."}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((row) => {
                  const activeJob = row.find((j) => j.id === activeId);
                  return (
                    <div
                      key={row.map((j) => j.id).join("-")}
                      className="contents"
                    >
                      {row.map((job) => (
                        <JobCard
                          key={job.id}
                          job={job}
                          isActive={job.id === activeId}
                          isFavorited={favorites.has(job.id)}
                          onSelect={() =>
                            setActiveId((prev) =>
                              prev === job.id ? null : job.id,
                            )
                          }
                          onToggleFavorite={(e) => {
                            e.stopPropagation();
                            toggleFavorite(job.id);
                          }}
                        />
                      ))}
                      {activeJob ? (
                        <JobDetail
                          key={`detail-${activeJob.id}`}
                          job={activeJob}
                          isFavorited={favorites.has(activeJob.id)}
                          onToggleFavorite={() => toggleFavorite(activeJob.id)}
                          onClose={() => setActiveId(null)}
                          onApply={() => setApplyJob(activeJob)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>
      <Footer />

      {applyJob && (
        <ApplyModal job={applyJob} onClose={() => setApplyJob(null)} />
      )}

      {/* Save search toast */}
      {saveToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl border border-remotiv-green/30 bg-white px-4 py-3 shadow-xl">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-remotiv-green/15 text-remotiv-green">
            <svg viewBox="0 0 12 12" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1.5 6.5 4.5 9.5 10.5 2.5" />
            </svg>
          </span>
          <p className="text-sm font-medium text-gray-700">Search saved!</p>
        </div>
      )}
    </>
  );
}

// ── Apply Modal ──────────────────────────────────────────────

const EMPTY_APPLY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
};

function ApplyModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [form, setForm] = useState(EMPTY_APPLY);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
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
    if (file.size > 5 * 1024 * 1024) {
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
      const fd = new FormData();
      fd.append("job_id",       job.id);
      fd.append("first_name",   form.firstName);
      fd.append("last_name",    form.lastName);
      fd.append("email",        form.email);
      fd.append("phone",        form.phone);
      fd.append("linkedin_url", form.linkedin);
      fd.append("cv",           cvFile);

      const res = await fetch("/api/apply", { method: "POST", body: fd });
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
    "w-full rounded-xl border border-black/10 bg-[#FAFAFA] px-4 py-3 text-[0.88rem] text-[#111] outline-none transition-all placeholder:text-[#bbb] focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/15";
  const LABEL_CLS =
    "mb-1.5 block text-[0.72rem] font-semibold uppercase tracking-widest text-[#888]";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div className="relative mx-auto my-16 flex w-full max-w-lg flex-col rounded-[20px] bg-white shadow-2xl">
        {/* Header — sticky, never scrolls away */}
        <div className="relative shrink-0 rounded-t-[20px] bg-[#7E47FF] px-7 py-8 pr-16">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-6 flex size-9 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <p className="mb-1 font-heading text-xl font-bold leading-tight text-white">
            {job.title}
          </p>
          <p className="text-sm text-white/65">{job.company}</p>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto rounded-b-[20px]">
          {success ? (
            <div className="flex flex-col items-center justify-center gap-4 px-7 py-16 text-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-remotiv-green/15">
                <CheckCircle className="size-8 text-remotiv-green" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-[#111]">Application Submitted!</h3>
              <p className="text-[0.88rem] leading-relaxed text-[#777]">
                We&apos;ll be in touch soon. This window will close automatically.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="px-7 py-6">
              <div className="grid grid-cols-2 gap-4">
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
                <label className={LABEL_CLS}>CV / Resume (PDF, max 5 MB)</label>
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
                      cvFile ? "font-medium text-[#111]" : "text-[#bbb]",
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <span className="mb-3 block text-[0.82rem] font-bold text-[#111]">{label}</span>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-5 h-px bg-black/[0.07]" />;
}

const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6,9 12,15 18,9'/%3E%3C/svg%3E\")";

function FilterSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full cursor-pointer appearance-none rounded-[10px] border border-black/10 bg-[#FAFAFA] py-2.5 pl-3.5 pr-8 text-[0.85rem] text-[#555] outline-none"
      style={{
        backgroundImage: SELECT_CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 12px center",
      }}
    >
      {children}
    </select>
  );
}

function CheckItem({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mb-2.5 flex w-full cursor-pointer select-none items-center gap-2.5 text-left"
    >
      <span
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded border-[1.5px] transition-all",
          checked
            ? "border-remotiv-green bg-remotiv-green"
            : "border-black/20 bg-white",
        )}
      >
        {checked ? (
          <span className="text-[0.6rem] font-extrabold text-[#111]">✓</span>
        ) : null}
      </span>
      <span className="text-[0.85rem] text-[#444]">{label}</span>
    </button>
  );
}

function SearchField({
  icon,
  placeholder,
  value,
  onChange,
  size,
}: {
  icon: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  size: "sm" | "lg";
}) {
  return (
    <div
      className={cn(
        "flex min-w-[80px] items-center gap-2 rounded-full bg-white px-3 py-1.5",
        size === "lg" ? "flex-[1.6]" : "flex-[0.6] min-w-[90px]",
      )}
    >
      <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[#111] text-white">
        {icon}
      </span>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 border-0 bg-transparent text-[0.75rem] text-[#111] outline-none placeholder:text-[#bbb]"
      />
    </div>
  );
}

function JobCard({
  job,
  isActive,
  isFavorited,
  onSelect,
  onToggleFavorite,
}: {
  job: Job;
  isActive: boolean;
  isFavorited: boolean;
  onSelect: () => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative cursor-pointer rounded-[20px] border border-black/[0.08] bg-white p-7 text-left transition-all hover:-translate-y-0.5 hover:border-remotiv-green/40 hover:shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
        isActive && "border-remotiv-green/40 shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
      )}
    >
      {!isActive ? (
        <div className="absolute right-5 top-5 flex gap-1.5">
          <span
            onClick={onToggleFavorite}
            className={cn(
              "flex size-[30px] cursor-pointer items-center justify-center rounded-full border transition-colors",
              isFavorited
                ? "border-remotiv-green/30 bg-remotiv-green/10 text-remotiv-green"
                : "border-black/[0.08] bg-white text-[#aaa] hover:border-remotiv-green/20 hover:text-remotiv-green/60",
            )}
          >
            <Bookmark
              className="size-3.5"
              strokeWidth={2}
              fill={isFavorited ? "currentColor" : "none"}
            />
          </span>
          <span className="flex size-[30px] items-center justify-center rounded-full border border-black/[0.08] bg-white">
            <MoreHorizontal className="size-3.5 text-[#aaa]" strokeWidth={2} />
          </span>
        </div>
      ) : null}
      <div className="mb-3 text-[0.72rem] text-[#aaa]">
        Posted {timeAgo(job.created_at)}
      </div>
      <div className="mb-1.5 font-heading text-[1.2rem] font-bold text-[#111]">
        {job.title}
      </div>
      <div className="mb-1 flex items-center gap-1 text-[0.82rem] text-[#777]">
        <span>{job.company}</span>
        <Star className="size-3 fill-remotiv-green text-remotiv-green" />
        <span>{job.company_rating.toFixed(1)}</span>
      </div>
      <div className="mb-4 text-[0.82rem] text-[#777]">{job.location}</div>
      <div className="mb-4 text-[0.9rem] font-semibold text-[#444]">
        Salary: {fmtSalary(job.salary_min, job.salary_max)}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-full border-[1.5px] border-black/10 bg-[#FAFAFA] px-3.5 py-1 text-[0.72rem] font-semibold text-[#555]">
          {job.contract_type}
        </span>
        <span className="rounded-full border-[1.5px] border-black/10 bg-[#FAFAFA] px-3.5 py-1 text-[0.72rem] font-semibold text-[#555]">
          {job.work_type}
        </span>
      </div>
    </button>
  );
}

function JobDetail({
  job,
  isFavorited,
  onToggleFavorite,
  onClose,
  onApply,
}: {
  job: Job;
  isFavorited: boolean;
  onToggleFavorite: () => void;
  onClose: () => void;
  onApply: () => void;
}) {
  return (
    <div className="relative col-span-full grid grid-cols-1 gap-10 rounded-[20px] bg-remotiv-purple p-9 md:grid-cols-2 md:p-10">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full border-0 bg-white/15"
      >
        <X className="size-4 text-white" strokeWidth={2.5} />
      </button>

      <div>
        <div className="mb-2.5 text-[0.72rem] text-white/55">
          Posted {timeAgo(job.created_at)}
        </div>
        <div className="mb-1.5 font-heading text-[1.6rem] font-bold text-white">
          {job.title}
        </div>
        <div className="mb-1 flex items-center gap-1 text-[0.85rem] text-white/65">
          <span>{job.company}</span>
          <Star className="size-3.5 fill-remotiv-green text-remotiv-green" />
          <span>{job.company_rating.toFixed(1)}</span>
        </div>
        <div className="mb-2 text-[0.85rem] text-white/55">{job.location}</div>
        <div className="mb-5 text-[0.85rem] font-semibold text-white/70">
          {fmtSalary(job.salary_min, job.salary_max)}
        </div>
        <div className="mb-6 flex flex-wrap gap-2">
          {[job.contract_type, job.work_type, job.experience_level].map((tag) => (
            <span
              key={tag}
              className="rounded-full border-[1.5px] border-white/30 px-4 py-1.5 text-[0.75rem] font-semibold text-white"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onApply}
            className="rounded-xl bg-[#111] px-8 py-3.5 font-heading text-[0.78rem] font-bold text-white"
          >
            Apply now
          </button>
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-label={isFavorited ? "Remove from favorites" : "Save job"}
            className={cn(
              "flex size-11 items-center justify-center rounded-full transition-colors",
              isFavorited ? "bg-remotiv-green/20" : "bg-white/15 hover:bg-white/25",
            )}
          >
            <Bookmark
              className={cn("size-[18px]", isFavorited ? "text-remotiv-green" : "text-white")}
              strokeWidth={2}
              fill={isFavorited ? "currentColor" : "none"}
            />
          </button>
        </div>
      </div>

      <div>
        <div className="mb-4 font-heading text-base font-bold text-white">
          Position description
        </div>
        {job.description ? (
          <p className="whitespace-pre-line text-[0.85rem] leading-[1.75] text-white/75">
            {job.description}
          </p>
        ) : (
          <p className="text-[0.85rem] text-white/45">
            No description provided.
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          <span className="rounded-full bg-white/10 px-3 py-1 text-[0.72rem] text-white/60">
            {job.category}
          </span>
          <span className="rounded-full bg-white/10 px-3 py-1 text-[0.72rem] text-white/60">
            {job.language}
          </span>
        </div>
      </div>
    </div>
  );
}
