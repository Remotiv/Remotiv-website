"use client";

import { Bookmark, Briefcase, Globe, MapPin, Search, Star, X } from "lucide-react";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "@/components/navbar";
import type { Job } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import "./jobs.css";

// Re-export Job for any local consumers — type-only, no runtime cost.
export type { Job };

// ApplyModal is dynamically imported so its ~300 LOC + PDF.js boilerplate
// (~600 KB on first parse) doesn't ship in the initial /jobs bundle for
// users who never click "Apply now".
const ApplyModal = dynamic(() => import("./_apply-modal"));

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

export function JobsClient({ initialJobs }: { initialJobs: Job[] }) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  // Jobs are already populated from the server prop on mount, so we start in
  // the non-loading state. The refetch useEffect below skips its first run
  // (see isFirstRender ref) to avoid an immediate redundant client fetch.
  const [loading, setLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Skip-first-refetch guard: the refetch effect fires once on mount because
  // useEffect always runs after the initial render. Without this guard it
  // would immediately hit /api/jobs for the same default-filter list the
  // server already returned — wasted request + flash of "Loading…". The ref
  // flips false after the first run; from then on, any change to applied
  // filters triggers a real refetch.
  const isFirstRender = useRef(true);

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

  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const drawerCloseBtnRef = useRef<HTMLButtonElement>(null);

  // Restore favorites + saved search from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_FAVORITES);
      if (raw) setFavorites(new Set(JSON.parse(raw) as string[]));
    } catch {
      // localStorage unavailable (private mode / quota / disabled) — non-fatal,
      // user just won't see their previously-favorited jobs restored.
    }

    try {
      const raw = localStorage.getItem(LS_SAVED_SEARCH);
      if (raw) {
        const s = JSON.parse(raw) as SavedSearch;
        // Text filters (client-side only) — go straight into active state so
        // they filter the visible list on mount.
        setSearchQuery(s.searchQuery ?? "");
        setLocationFilter(s.locationFilter ?? "");
        setWorkMode(s.workMode ?? "");
        // Server-filters: populate BOTH pending (so sidebar shows the choices)
        // AND applied (so the list auto-filters). This makes saved-search
        // restoration fully consistent with the text-filter behaviour above.
        // The applied-filter useEffect will fire once isFirstRender flips
        // false (its first scheduled run) and then re-fire when these state
        // changes commit — naturally fetching the filtered list.
        const cat = s.pendingCategory ?? "";
        const exp = new Set(s.pendingExperience ?? []);
        const ctr = new Set(s.pendingContract ?? []);
        const lang = s.pendingLanguage ?? "";
        setPendingCategory(cat);
        setPendingExperience(exp);
        setPendingContract(ctr);
        setPendingLanguage(lang);
        setSelectedCategory(cat);
        setExperience(exp);
        setContract(ctr);
        setSelectedLanguage(lang);
      }
    } catch {
      // localStorage unavailable or saved-search JSON corrupt — non-fatal,
      // user just gets the default empty filter state.
    }
  }, []);

  // Auto-dismiss save toast
  useEffect(() => {
    if (!saveToast) return;
    const t = setTimeout(() => setSaveToast(false), 2500);
    return () => clearTimeout(t);
  }, [saveToast]);

  // Stable handler passed to every memoized JobCard. Without useCallback the
  // ref changes per parent render → memo comparison fails → all cards re-render
  // on every keystroke in the search box.
  const handleCardSelect = useCallback((id: string) => {
    setActiveId((prev) => (prev === id ? null : id));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(LS_FAVORITES, JSON.stringify([...next]));
      } catch {
        // localStorage unavailable / quota exceeded — favorite is still in
        // component state for the current session, just won't persist.
      }
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
    } catch {
      // localStorage unavailable / quota exceeded — toast still fires so the
      // user gets feedback; saved search just won't persist across sessions.
    }
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
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
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

  // Used by the empty-state branch to distinguish "filtered to nothing" from
  // "fetch failed and we have nothing to show". Only server-filters count —
  // client-side text filters (search / location / workMode) don't trigger a
  // refetch, so an empty result with text filters is a legitimate no-match.
  const hasAppliedFilters = Boolean(
    selectedCategory || experience.size || contract.size || selectedLanguage,
  );

  // ESC key closes drawer
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFiltersDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Body scroll lock (ref-counted so it stacks safely with other modals)
  useEffect(() => {
    if (!filtersDrawerOpen) return;
    const count = parseInt(document.body.dataset.scrollLocks ?? "0", 10);
    document.body.dataset.scrollLocks = String(count + 1);
    if (count === 0) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      const current = parseInt(document.body.dataset.scrollLocks ?? "1", 10);
      const next = current - 1;
      document.body.dataset.scrollLocks = String(next);
      if (next <= 0) {
        document.body.style.overflow = "";
        delete document.body.dataset.scrollLocks;
      }
    };
  }, [filtersDrawerOpen]);

  // Auto-focus the close button when drawer opens (a11y)
  useEffect(() => {
    if (filtersDrawerOpen) {
      requestAnimationFrame(() => drawerCloseBtnRef.current?.focus());
    }
  }, [filtersDrawerOpen]);

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-[#FAFAFA] font-sans">
        <div className="flex flex-col gap-2 px-5 pt-6 sm:px-6 md:px-6">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex min-h-[280px] flex-col rounded-[20px] bg-[#0e0e0e] p-6 sm:p-8 md:p-10">
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

            <div className="flex min-h-[160px] max-h-[320px] flex-col items-center justify-center gap-3 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#0e0e0e_0%,#1a1a2e_50%,#0e0e0e_100%)] md:min-h-[280px]">
              <Briefcase className="size-16 text-remotiv-green/40" strokeWidth={1.5} />
              <span className="text-xs uppercase tracking-[0.1em] text-white/30">
                {loading ? "Loading…" : `${filteredJobs.length} Open Position${filteredJobs.length !== 1 ? "s" : ""}`}
              </span>
            </div>
          </section>

          <section className="rounded-[20px] bg-remotiv-purple px-5 py-6 sm:px-8 sm:py-8 md:px-10 md:pb-9">
            <h2 className="mb-6 font-heading text-[clamp(1.2rem,2vw,1.6rem)] font-normal uppercase text-remotiv-text-dark">
              Discover your dream job
            </h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
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
                onClick={handleSaveSearch}
                className="flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-2 border-white/35 bg-transparent px-3.5 py-3 text-xs font-semibold text-white transition-colors hover:border-white/60 sm:w-auto sm:py-[5px]"
              >
                Save search
                <Bookmark className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          </section>
        </div>

        <div className="px-6 pt-2 xl:hidden">
          <button
            type="button"
            className="jobs-filters-trigger"
            onClick={() => setFiltersDrawerOpen(true)}
            aria-label="Open filters"
            aria-expanded={filtersDrawerOpen}
          >
            <span aria-hidden="true">☰</span>
            Filters
          </button>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 px-5 pb-16 pt-4 sm:px-6 xl:grid-cols-[280px_1fr]">
          <aside className="jobs-desktop-sidebar xl:sticky xl:top-20 rounded-[20px] border border-black/[0.08] bg-white p-7">
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
              className="w-full min-h-11 rounded-xl bg-[#111] px-3 py-4 font-heading text-[0.78rem] font-bold text-white"
            >
              Apply filter
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="mt-2.5 w-full min-h-11 bg-transparent px-3 py-2.5 text-[0.82rem] text-[#666]"
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
                  "flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] px-4 py-2.5 text-[0.82rem] font-semibold transition-colors",
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
                    showFavorites ? "bg-remotiv-green text-remotiv-text-dark" : "bg-gray-100 text-gray-500",
                  )}>
                    {favorites.size}
                  </span>
                )}
              </button>
            </div>

            {loading ? (
              <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#666]">
                Loading jobs…
              </div>
            ) : filteredJobs.length === 0 ? (
              showFavorites ? (
                <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#666]">
                  No favorited jobs yet. Click the bookmark icon on any job to save it.
                </div>
              ) : hasAppliedFilters ? (
                <div className="flex h-48 items-center justify-center text-[0.9rem] text-[#666]">
                  No open positions match your filters.
                </div>
              ) : (
                // No filters AND no jobs → this is almost certainly a server
                // fetch error during initial render (lib/jobs.ts swallows
                // Supabase errors and returns []). Give the user a Retry that
                // bypasses isFirstRender by directly invoking fetchJobs.
                <div className="flex h-48 flex-col items-center justify-center gap-3 text-[0.9rem] text-[#666]">
                  <p>Couldn&apos;t load positions.</p>
                  <button
                    type="button"
                    onClick={() =>
                      fetchJobs(selectedCategory, experience, contract, selectedLanguage)
                    }
                    className="rounded-full bg-[#111] px-5 py-2 text-[0.82rem] font-semibold text-white transition-opacity hover:opacity-80"
                  >
                    Retry
                  </button>
                </div>
              )
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
                          onSelect={handleCardSelect}
                          onToggleFavorite={toggleFavorite}
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

      {filtersDrawerOpen && (
        <>
          <div
            className="jobs-drawer-backdrop"
            onClick={() => setFiltersDrawerOpen(false)}
            role="presentation"
          />
          <aside
            className="jobs-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="jobs-drawer-title"
          >
            <div className="jobs-drawer-header">
              <span id="jobs-drawer-title" className="jobs-drawer-title">Filters</span>
              <button
                ref={drawerCloseBtnRef}
                type="button"
                className="jobs-drawer-close"
                onClick={() => setFiltersDrawerOpen(false)}
                aria-label="Close filters"
              >
                ×
              </button>
            </div>
            <div className="jobs-drawer-body">
              <div className="p-7">
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

              </div>
            </div>
            <div className="jobs-drawer-footer flex gap-2.5">
              <button
                type="button"
                className="jobs-drawer-reset"
                onClick={() => {
                  resetFilters();
                  setFiltersDrawerOpen(false);
                }}
              >
                Reset
              </button>
              <button
                type="button"
                className="jobs-drawer-apply"
                onClick={() => {
                  applyFilters();
                  setFiltersDrawerOpen(false);
                }}
              >
                Apply Filters
              </button>
            </div>
          </aside>
        </>
      )}

      {applyJob && (
        <ApplyModal job={applyJob} onClose={() => setApplyJob(null)} />
      )}

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
      <span className="mb-3 block text-[0.82rem] font-bold text-remotiv-text-dark">{label}</span>
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
      className="w-full cursor-pointer appearance-none rounded-[10px] border border-black/10 bg-[#FAFAFA] py-3 pl-3.5 pr-8 text-base sm:py-2.5 sm:text-[0.85rem] text-[#555] outline-none"
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
      className="-mx-2 mb-2.5 flex min-h-11 w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2 text-left"
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
          <span className="text-[0.6rem] font-extrabold text-remotiv-text-dark">✓</span>
        ) : null}
      </span>
      <span className="text-[0.85rem] text-remotiv-text-mid">{label}</span>
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
        "flex w-full min-w-[80px] items-center gap-2 rounded-full bg-white px-3 py-1.5 sm:w-auto",
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
        className="min-w-0 flex-1 border-0 bg-transparent text-base sm:text-[0.75rem] text-remotiv-text-dark outline-none placeholder:text-[#bbb]"
      />
    </div>
  );
}

// JobCard re-renders are kept O(changed-cards) via React.memo + id-based
// callback signatures from the parent. Without this, typing in the search
// box re-rendered all ~100 cards per keystroke.
const JobCard = memo(function JobCard({
  job,
  isActive,
  isFavorited,
  onSelect,
  onToggleFavorite,
}: {
  job: Job;
  isActive: boolean;
  isFavorited: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}) {
  return (
    <article
      className={cn(
        "group relative flex flex-col rounded-[20px] border border-black/[0.08] bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-remotiv-green/40 hover:shadow-[0_4px_20px_rgba(0,0,0,0.08)] sm:p-7",
        isActive && "border-remotiv-green/40 shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(job.id)}
        aria-label={`View ${job.title} job details`}
        className="absolute inset-0 z-0 rounded-[20px]"
      />

      {!isActive ? (
        <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 sm:right-5 sm:top-5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(job.id);
            }}
            aria-label={isFavorited ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorited}
            className="flex size-11 items-center justify-center rounded-full text-[#666] transition-colors hover:bg-black/5 hover:text-remotiv-text-dark"
          >
            <Bookmark
              className="size-4"
              strokeWidth={2}
              fill={isFavorited ? "currentColor" : "none"}
            />
          </button>
        </div>
      ) : null}

      <div className="pointer-events-none relative z-0">
        <div className="mb-3 text-[0.78rem] text-[#666]">
          Posted {timeAgo(job.created_at)}
        </div>
        <div className="mb-1.5 pr-24 font-heading text-[1.2rem] font-bold text-remotiv-text-dark">
          {job.title}
        </div>
        <div className="mb-1 flex items-center gap-1 text-[0.82rem] text-remotiv-text-light">
          <span>{job.company}</span>
          <Star className="size-3 fill-remotiv-green text-remotiv-green" />
          <span>{job.company_rating.toFixed(1)}</span>
        </div>
        <div className="mb-4 text-[0.82rem] text-remotiv-text-light">{job.location}</div>
        <div className="mb-4 text-[0.9rem] font-semibold text-remotiv-text-mid">
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
      </div>
    </article>
  );
});

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
    <div className="relative col-span-full grid grid-cols-1 gap-6 rounded-[20px] bg-remotiv-purple p-6 md:grid-cols-2 md:gap-10 md:p-10">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-full border-0 bg-white/15"
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
