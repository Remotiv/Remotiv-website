"use client";

import {
  Bookmark,
  Briefcase,
  ChevronDown,
  Globe,
  MapPin,
  MoreHorizontal,
  Search,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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

function fmtSalary(min: number | null, max: number | null): string {
  if (!min && !max) return "Salary not disclosed";
  const fmt = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`;
  if (min && max) return `${fmt(min)}–${fmt(max)}/yr`;
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
    let result = jobs;
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
  }, [jobs, searchQuery, locationFilter, workMode]);

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
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-white/35 bg-transparent px-3.5 py-[5px] text-xs font-semibold text-white"
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
              <TopButton icon={<Bookmark className="size-3.5" strokeWidth={2} />}>
                Favorites
              </TopButton>
              <TopButton>
                <SavedSearchIcon />
                Saved search results
              </TopButton>
              <button
                type="button"
                className="ml-auto flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] border-black/10 bg-white px-4 py-2.5 text-[0.82rem] font-semibold text-[#555]"
              >
                Sort by
                <ChevronDown className="size-3.5" strokeWidth={2} />
              </button>
            </div>

            {loading ? (
              <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#aaa]">
                Loading jobs…
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#aaa]">
                No open positions match your filters.
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
                          onSelect={() =>
                            setActiveId((prev) =>
                              prev === job.id ? null : job.id,
                            )
                          }
                        />
                      ))}
                      {activeJob ? (
                        <JobDetail
                          key={`detail-${activeJob.id}`}
                          job={activeJob}
                          onClose={() => setActiveId(null)}
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
    </>
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

function TopButton({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] border-black/10 bg-white px-4 py-2.5 text-[0.82rem] font-semibold text-[#555]"
    >
      {icon}
      {children}
    </button>
  );
}

function SavedSearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      role="img"
      aria-label="Saved searches"
    >
      <title>Saved searches</title>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function JobCard({
  job,
  isActive,
  onSelect,
}: {
  job: Job;
  isActive: boolean;
  onSelect: () => void;
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
          <span className="flex size-[30px] items-center justify-center rounded-full border border-black/[0.08] bg-white">
            <Bookmark className="size-3.5 text-[#aaa]" strokeWidth={2} />
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

function JobDetail({ job, onClose }: { job: Job; onClose: () => void }) {
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
            className="rounded-xl bg-[#111] px-8 py-3.5 font-heading text-[0.78rem] font-bold text-white"
          >
            Apply now
          </button>
          <button
            type="button"
            aria-label="Save job"
            className="flex size-11 items-center justify-center rounded-full bg-white/15"
          >
            <Bookmark className="size-[18px] text-white" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div>
        <div className="mb-4 font-heading text-base font-bold text-white">
          Position description
        </div>
        {job.description ? (
          <p className="text-[0.85rem] leading-[1.75] text-white/75 whitespace-pre-line">
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
