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
import { useMemo, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

interface Job {
  id: number;
  title: string;
  company: string;
  rating: string;
  location: string;
  salary: string;
  tags: string[];
  posted: string;
  qualifications: string[];
  responsibilities: string[];
}

const JOBS: Job[] = [
  {
    id: 1,
    title: "UI/UX Designer",
    company: "Pixel Plus",
    rating: "4.3",
    location: "Lahore, Pakistan",
    salary: "$35,000–65,000/yr",
    tags: ["Full time", "Remote"],
    posted: "7 minutes ago",
    qualifications: [
      "Bachelor's degree in Design or related field",
      "3+ years of UX/UI design experience",
      "Proficiency in Figma and Adobe XD",
      "Strong portfolio of design projects",
    ],
    responsibilities: [
      "Lead end-to-end design for web and mobile products",
      "Conduct user research and usability testing",
      "Collaborate with product and engineering teams",
      "Create wireframes, prototypes and design systems",
    ],
  },
  {
    id: 2,
    title: "Digital Marketer",
    company: "Hugo Boss",
    rating: "5.0",
    location: "Karachi, Pakistan",
    salary: "$45,000–55,000/yr",
    tags: ["Full time", "On-site"],
    posted: "10 minutes ago",
    qualifications: [
      "Degree in Marketing or Communications",
      "Experience with Google Ads, Meta Ads and SEO",
      "Proficiency in HubSpot or similar CRM",
      "Strong analytical and reporting skills",
    ],
    responsibilities: [
      "Plan and execute digital marketing campaigns",
      "Manage social media and content calendar",
      "Analyse campaign performance and optimise ROI",
      "Coordinate with design team on creative assets",
    ],
  },
  {
    id: 3,
    title: "Senior React Developer",
    company: "Cogent Labs",
    rating: "4.8",
    location: "Islamabad, Pakistan",
    salary: "$50,000–80,000/yr",
    tags: ["Full time", "Remote"],
    posted: "1 hour ago",
    qualifications: [
      "5+ years of React and TypeScript experience",
      "Strong knowledge of Node.js and REST APIs",
      "Experience with AWS or similar cloud platforms",
      "Excellent problem-solving skills",
    ],
    responsibilities: [
      "Build scalable frontend applications with React",
      "Collaborate with product and design teams",
      "Conduct code reviews and mentor junior developers",
      "Improve performance and maintainability of codebase",
    ],
  },
  {
    id: 4,
    title: "Data Analyst",
    company: "Atlas Copco",
    rating: "4.5",
    location: "Lahore, Pakistan",
    salary: "$30,000–45,000/yr",
    tags: ["Full time", "Remote"],
    posted: "2 hours ago",
    qualifications: [
      "Degree in Statistics or related field",
      "Advanced SQL and Python or R skills",
      "Experience with Tableau or Power BI",
      "Strong business communication skills",
    ],
    responsibilities: [
      "Analyse large datasets to surface business insights",
      "Build dashboards and automated reports",
      "Collaborate with stakeholders to define KPIs",
      "Present findings to senior leadership",
    ],
  },
  {
    id: 5,
    title: "Customer Success Manager",
    company: "Taskflow Pro",
    rating: "4.2",
    location: "Karachi, Pakistan",
    salary: "$25,000–35,000/yr",
    tags: ["Full time", "Remote"],
    posted: "3 hours ago",
    qualifications: [
      "2+ years in customer success or account management",
      "Experience with Intercom or Zendesk",
      "Strong communication and empathy skills",
      "Ability to manage multiple accounts simultaneously",
    ],
    responsibilities: [
      "Onboard and retain B2B SaaS customers",
      "Drive product adoption and reduce churn",
      "Serve as voice of customer internally",
      "Conduct regular check-ins and QBRs",
    ],
  },
  {
    id: 6,
    title: "DevOps Engineer",
    company: "CloudStack HQ",
    rating: "4.7",
    location: "Islamabad, Pakistan",
    salary: "$55,000–75,000/yr",
    tags: ["Full time", "Remote"],
    posted: "5 hours ago",
    qualifications: [
      "Strong experience with AWS, Terraform and Kubernetes",
      "Proficiency in CI/CD pipelines and GitHub Actions",
      "Scripting skills in Python or Bash",
      "Experience with monitoring tools like Datadog",
    ],
    responsibilities: [
      "Manage cloud infrastructure and deployment pipelines",
      "Ensure high availability and performance of systems",
      "Automate operational tasks and reduce toil",
      "Collaborate with engineering teams on releases",
    ],
  },
  {
    id: 7,
    title: "Brand Designer",
    company: "VisualCo",
    rating: "4.4",
    location: "Lahore, Pakistan",
    salary: "$30,000–40,000/yr",
    tags: ["Part time", "Remote"],
    posted: "6 hours ago",
    qualifications: [
      "Degree in Graphic Design or Visual Arts",
      "Proficiency in Adobe Creative Suite and Figma",
      "Strong portfolio of brand identity work",
      "Excellent typography and layout skills",
    ],
    responsibilities: [
      "Create brand identities and visual systems",
      "Design marketing assets and social content",
      "Maintain brand consistency across all channels",
      "Present concepts and iterate based on feedback",
    ],
  },
  {
    id: 8,
    title: "Sales Development Rep",
    company: "TechScale Inc.",
    rating: "4.1",
    location: "Karachi, Pakistan",
    salary: "$22,000–28,000/yr",
    tags: ["Full time", "Remote"],
    posted: "8 hours ago",
    qualifications: [
      "Experience with CRM tools like HubSpot or Salesforce",
      "Strong verbal and written communication skills",
      "Ability to research and qualify leads",
      "Self-motivated and target-driven mindset",
    ],
    responsibilities: [
      "Drive outbound prospecting and pipeline generation",
      "Conduct cold outreach via email and LinkedIn",
      "Qualify inbound leads and book discovery calls",
      "Collaborate with account executives on deals",
    ],
  },
  {
    id: 9,
    title: "Python Backend Engineer",
    company: "DataStream",
    rating: "4.6",
    location: "Islamabad, Pakistan",
    salary: "$40,000–55,000/yr",
    tags: ["Full time", "Remote"],
    posted: "1 day ago",
    qualifications: [
      "4+ years of Python and FastAPI or Django experience",
      "Strong PostgreSQL and database design skills",
      "Experience with cloud services AWS or GCP",
      "Familiarity with Docker and microservices",
    ],
    responsibilities: [
      "Build data ingestion pipelines and API services",
      "Design and optimise database schemas",
      "Write clean, testable and well-documented code",
      "Participate in architecture and design discussions",
    ],
  },
];

type ExperienceLevel = "Entry" | "Intermediate" | "Expert";
type ContractType = "Permanent" | "Temporary" | "Project";

const EXPERIENCE_LEVELS: { label: ExperienceLevel; count: string }[] = [
  { label: "Entry", count: "2,389" },
  { label: "Intermediate", count: "8,281" },
  { label: "Expert", count: "1,094" },
];

const CONTRACT_TYPES: ContractType[] = ["Permanent", "Temporary", "Project"];

export default function JobsPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [experience, setExperience] = useState<Set<ExperienceLevel>>(
    new Set(["Intermediate"]),
  );
  const [contract, setContract] = useState<Set<ContractType>>(
    new Set(["Permanent", "Temporary"]),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [location, setLocation] = useState("");
  const [workMode, setWorkMode] = useState("");

  const rows = useMemo(() => chunk(JOBS, 3), []);

  const toggle = <T,>(set: Set<T>, setState: (s: Set<T>) => void, value: T) => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    setState(next);
  };

  const resetFilters = () => {
    setExperience(new Set());
    setContract(new Set());
  };

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
                9 Open Positions
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
                value={location}
                onChange={setLocation}
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
              <FilterSelect>
                <option>Select category</option>
                <option>Engineering</option>
                <option>Design</option>
                <option>Sales</option>
                <option>Marketing</option>
                <option>Data</option>
                <option>Support</option>
              </FilterSelect>
            </FilterGroup>

            <Divider />

            <FilterGroup label="Experience level">
              {EXPERIENCE_LEVELS.map(({ label, count }) => (
                <CheckItem
                  key={label}
                  label={label}
                  count={count}
                  checked={experience.has(label)}
                  onToggle={() => toggle(experience, setExperience, label)}
                />
              ))}
            </FilterGroup>

            <Divider />

            <FilterGroup label="Contract type">
              {CONTRACT_TYPES.map((label) => (
                <CheckItem
                  key={label}
                  label={label}
                  checked={contract.has(label)}
                  onToggle={() => toggle(contract, setContract, label)}
                />
              ))}
            </FilterGroup>

            <Divider />

            <FilterGroup label="Language">
              <FilterSelect>
                <option>Select language</option>
                <option>English</option>
                <option>Urdu</option>
                <option>Arabic</option>
              </FilterSelect>
            </FilterGroup>

            <button
              type="button"
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

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((row, rowIndex) => {
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
                          setActiveId((prev) => (prev === job.id ? null : job.id))
                        }
                      />
                    ))}
                    {activeJob ? (
                      <JobDetail
                        key={`detail-${rowIndex}`}
                        job={activeJob}
                        onClose={() => setActiveId(null)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
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

function FilterSelect({ children }: { children: React.ReactNode }) {
  return (
    <select
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
  count,
  checked,
  onToggle,
}: {
  label: string;
  count?: string;
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
      {count ? (
        <span className="ml-auto text-[0.75rem] text-[#aaa]">{count}</span>
      ) : null}
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
      <div className="mb-3 text-[0.72rem] text-[#aaa]">Posted {job.posted}</div>
      <div className="mb-1.5 font-heading text-[1.2rem] font-bold text-[#111]">
        {job.title}
      </div>
      <div className="mb-1 flex items-center gap-1 text-[0.82rem] text-[#777]">
        <span>{job.company}</span>
        <Star className="size-3 fill-remotiv-green text-remotiv-green" />
        <span>{job.rating}</span>
      </div>
      <div className="mb-4 text-[0.82rem] text-[#777]">{job.location}</div>
      <div className="mb-4 text-[0.9rem] font-semibold text-[#444]">
        Salary: {job.salary}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {job.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border-[1.5px] border-black/10 bg-[#FAFAFA] px-3.5 py-1 text-[0.72rem] font-semibold text-[#555]"
          >
            {tag}
          </span>
        ))}
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
        <div className="mb-2.5 text-[0.72rem] text-white/55">Posted {job.posted}</div>
        <div className="mb-1.5 font-heading text-[1.6rem] font-bold text-white">
          {job.title}
        </div>
        <div className="mb-1 flex items-center gap-1 text-[0.85rem] text-white/65">
          <span>{job.company}</span>
          <Star className="size-3.5 fill-remotiv-green text-remotiv-green" />
          <span>{job.rating}</span>
        </div>
        <div className="mb-5 text-[0.85rem] text-white/55">{job.location}</div>
        <div className="mb-6 flex flex-wrap gap-2">
          {job.tags.map((tag) => (
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
        <DetailSection title="Qualifications" items={job.qualifications} />
        <DetailSection title="Key Responsibilities" items={job.responsibilities} />
      </div>
    </div>
  );
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-5">
      <div className="mb-2.5 text-[0.78rem] font-bold uppercase tracking-[0.06em] text-white/70">
        {title}
      </div>
      <ul className="list-none p-0">
        {items.map((item) => (
          <li
            key={item}
            className="relative mb-1.5 pl-4 text-[0.85rem] leading-[1.7] text-white/75 before:absolute before:left-0 before:font-bold before:text-remotiv-green before:content-['·']"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
