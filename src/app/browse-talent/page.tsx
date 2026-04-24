"use client";

import { MapPin, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

type RoleKey =
  | "All"
  | "Full-stack"
  | "Frontend"
  | "Backend"
  | "Mobile"
  | "DevOps"
  | "Cloud"
  | "AI/ML"
  | "Data"
  | "Design"
  | "QA";

type Availability = "available" | "limited";

interface Talent {
  id: number;
  name: string;
  initials: string;
  role: string;
  roleKey: Exclude<RoleKey, "All">;
  skills: string[];
  location: string;
  timezone: string;
  rate: string;
  availability: Availability;
  avatarBg: string;
  avatarText: string;
}

const ROLE_FILTERS: RoleKey[] = [
  "All",
  "Full-stack",
  "Frontend",
  "Backend",
  "Mobile",
  "DevOps",
  "Cloud",
  "AI/ML",
  "Data",
  "Design",
  "QA",
];

const TALENT: Talent[] = [
  {
    id: 1,
    name: "Sarah Khan",
    initials: "SK",
    role: "Senior React Developer",
    roleKey: "Frontend",
    skills: ["React", "TypeScript", "Next.js", "Tailwind"],
    location: "Lahore, Pakistan",
    timezone: "GMT+5",
    rate: "$45/hr",
    availability: "available",
    avatarBg: "#EDE8FF",
    avatarText: "#7E47FF",
  },
  {
    id: 2,
    name: "Ahmed Hassan",
    initials: "AH",
    role: "DevOps Engineer",
    roleKey: "DevOps",
    skills: ["AWS", "Kubernetes", "Terraform", "CI/CD"],
    location: "Karachi, Pakistan",
    timezone: "GMT+5",
    rate: "$55/hr",
    availability: "available",
    avatarBg: "#E0F7FA",
    avatarText: "#0891B2",
  },
  {
    id: 3,
    name: "Priya Nair",
    initials: "PN",
    role: "Python Backend Engineer",
    roleKey: "Backend",
    skills: ["Python", "Django", "PostgreSQL", "Redis"],
    location: "Mumbai, India",
    timezone: "GMT+5:30",
    rate: "$50/hr",
    availability: "available",
    avatarBg: "#DBEAFE",
    avatarText: "#2563EB",
  },
  {
    id: 4,
    name: "Raj Patel",
    initials: "RP",
    role: "Full-Stack Engineer",
    roleKey: "Full-stack",
    skills: ["Node.js", "React", "MongoDB", "GraphQL"],
    location: "Bangalore, India",
    timezone: "GMT+5:30",
    rate: "$60/hr",
    availability: "limited",
    avatarBg: "#D9F7ED",
    avatarText: "#1A8F65",
  },
  {
    id: 5,
    name: "Ayesha Tariq",
    initials: "AT",
    role: "Mobile Developer",
    roleKey: "Mobile",
    skills: ["React Native", "Swift", "Kotlin", "Firebase"],
    location: "Islamabad, Pakistan",
    timezone: "GMT+5",
    rate: "$48/hr",
    availability: "available",
    avatarBg: "#FFEDD5",
    avatarText: "#EA580C",
  },
  {
    id: 6,
    name: "David Chen",
    initials: "DC",
    role: "AI/ML Engineer",
    roleKey: "AI/ML",
    skills: ["PyTorch", "TensorFlow", "LLMs", "Python"],
    location: "Singapore",
    timezone: "GMT+8",
    rate: "$75/hr",
    availability: "limited",
    avatarBg: "#EDE9FE",
    avatarText: "#6D28D9",
  },
  {
    id: 7,
    name: "Maria Rodriguez",
    initials: "MR",
    role: "Frontend Engineer",
    roleKey: "Frontend",
    skills: ["Vue.js", "TypeScript", "Nuxt", "SCSS"],
    location: "Mexico City, Mexico",
    timezone: "GMT-6",
    rate: "$42/hr",
    availability: "available",
    avatarBg: "#FCE7F3",
    avatarText: "#BE185D",
  },
  {
    id: 8,
    name: "Kenji Tanaka",
    initials: "KT",
    role: "Backend Engineer",
    roleKey: "Backend",
    skills: ["Go", "gRPC", "Kubernetes", "PostgreSQL"],
    location: "Tokyo, Japan",
    timezone: "GMT+9",
    rate: "$65/hr",
    availability: "available",
    avatarBg: "#DBEAFE",
    avatarText: "#1D4ED8",
  },
  {
    id: 9,
    name: "Fatima Noor",
    initials: "FN",
    role: "Data Engineer",
    roleKey: "Data",
    skills: ["Spark", "Airflow", "Snowflake", "SQL"],
    location: "Dubai, UAE",
    timezone: "GMT+4",
    rate: "$58/hr",
    availability: "available",
    avatarBg: "#E0E7FF",
    avatarText: "#4338CA",
  },
  {
    id: 10,
    name: "Mohammed Al-Rashid",
    initials: "MA",
    role: "Cloud Architect",
    roleKey: "Cloud",
    skills: ["AWS", "Azure", "GCP", "Terraform"],
    location: "Riyadh, Saudi Arabia",
    timezone: "GMT+3",
    rate: "$70/hr",
    availability: "limited",
    avatarBg: "#CFFAFE",
    avatarText: "#0E7490",
  },
  {
    id: 11,
    name: "Anika Sharma",
    initials: "AS",
    role: "Full-Stack Developer",
    roleKey: "Full-stack",
    skills: ["Next.js", "Prisma", "tRPC", "Postgres"],
    location: "Delhi, India",
    timezone: "GMT+5:30",
    rate: "$52/hr",
    availability: "available",
    avatarBg: "#D9F7ED",
    avatarText: "#047857",
  },
  {
    id: 12,
    name: "Liam O'Brien",
    initials: "LO",
    role: "QA Automation Engineer",
    roleKey: "QA",
    skills: ["Cypress", "Playwright", "Selenium", "Jest"],
    location: "Dublin, Ireland",
    timezone: "GMT+0",
    rate: "$44/hr",
    availability: "available",
    avatarBg: "#FEE2E2",
    avatarText: "#B91C1C",
  },
  {
    id: 13,
    name: "Sophie Dubois",
    initials: "SD",
    role: "Product Designer",
    roleKey: "Design",
    skills: ["Figma", "Design Systems", "UX Research", "Webflow"],
    location: "Paris, France",
    timezone: "GMT+1",
    rate: "$55/hr",
    availability: "limited",
    avatarBg: "#FCE7F3",
    avatarText: "#DB2777",
  },
  {
    id: 14,
    name: "Olamide Adeyemi",
    initials: "OA",
    role: "Node.js Backend Engineer",
    roleKey: "Backend",
    skills: ["Node.js", "NestJS", "MongoDB", "Redis"],
    location: "Lagos, Nigeria",
    timezone: "GMT+1",
    rate: "$46/hr",
    availability: "available",
    avatarBg: "#EDFFD3",
    avatarText: "#4A7A10",
  },
  {
    id: 15,
    name: "Rohan Gupta",
    initials: "RG",
    role: "iOS Developer",
    roleKey: "Mobile",
    skills: ["Swift", "SwiftUI", "Combine", "Core Data"],
    location: "Pune, India",
    timezone: "GMT+5:30",
    rate: "$50/hr",
    availability: "available",
    avatarBg: "#FFEDD5",
    avatarText: "#C2410C",
  },
];

const HERO_CARDS: Array<{
  initials: string;
  name: string;
  role: string;
  skills: string[];
  avatarBg: string;
  avatarText: string;
  featured?: boolean;
}> = [
  {
    initials: "AK",
    name: "Ayesha Khan",
    role: "Full-Stack Engineer · 5 yrs",
    skills: ["React", "Node.js", "AWS"],
    avatarBg: "#EDE8FF",
    avatarText: "#7E47FF",
    featured: true,
  },
  {
    initials: "ZM",
    name: "Zain Malik",
    role: "Product Designer · 4 yrs",
    skills: ["Figma", "UX Research"],
    avatarBg: "#D9F7ED",
    avatarText: "#1A8F65",
  },
  {
    initials: "SR",
    name: "Sara Raza",
    role: "Data Analyst · 3 yrs",
    skills: ["Python", "SQL", "Tableau"],
    avatarBg: "#EDFFD3",
    avatarText: "#4A7A10",
  },
];

export default function BrowseTalentPage() {
  const [activeRole, setActiveRole] = useState<RoleKey>("All");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TALENT.filter((t) => {
      if (activeRole !== "All" && t.roleKey !== activeRole) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.role.toLowerCase().includes(q) ||
        t.skills.some((s) => s.toLowerCase().includes(q)) ||
        t.location.toLowerCase().includes(q)
      );
    });
  }, [activeRole, query]);

  return (
    <>
      <Navbar />
      <main className="bg-white">
        <section className="relative isolate h-[560px] w-full overflow-hidden bg-white">
          <div
            aria-hidden
            className="absolute inset-0 z-0 opacity-90"
            style={{
              backgroundImage:
                "linear-gradient(#F8F4F1 0 0), linear-gradient(#F8F4F1 0 0)",
              backgroundSize: "80px 80px, 80px 80px",
              backgroundPosition: "0 0",
              backgroundRepeat: "repeat",
              WebkitMaskImage:
                "radial-gradient(ellipse at center, rgba(0,0,0,0.85), rgba(0,0,0,0) 75%)",
              maskImage:
                "radial-gradient(ellipse at center, rgba(0,0,0,0.85), rgba(0,0,0,0) 75%)",
            }}
          />
          <div aria-hidden className="absolute inset-0 z-0">
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, #F8F4F1 6px, transparent 0)",
                backgroundSize: "86px 86px",
                opacity: 0.75,
              }}
            />
          </div>

          <div className="relative z-10 mx-auto flex h-full max-w-7xl items-center px-14">
            <div className="max-w-[620px]">
              <h1 className="font-heading text-[52px] font-bold leading-[1.08] tracking-[-1.5px] text-[#111]">
                Browse Top <span className="text-remotiv-purple-light">1%</span>
                <br />
                Global Talent
              </h1>
              <p className="mt-5 max-w-[520px] text-base leading-[1.65] text-[#888]">
                Explore 50,000+ pre-vetted engineers, designers, and operators from
                top companies — find your next hire in hours, not weeks.
              </p>
            </div>

            <div className="relative ml-auto hidden w-[300px] lg:block">
              <span className="absolute -top-3.5 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-remotiv-purple px-3.5 py-1 text-[11px] font-semibold text-white">
                Available now
              </span>
              <div className="flex flex-col gap-2.5">
                {HERO_CARDS.map((card) => (
                  <div
                    key={card.name}
                    className={cn(
                      "flex items-center gap-3 rounded-2xl bg-white px-4 py-3",
                      card.featured
                        ? "border-[1.5px] border-[#C8B5FF]"
                        : "border border-[#E5E0DA]",
                    )}
                  >
                    <div
                      className="flex size-[38px] shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                      style={{ background: card.avatarBg, color: card.avatarText }}
                    >
                      {card.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-[#1A1A1A]">
                        {card.name}
                      </div>
                      <div className="mt-px text-[11px] text-[#AAA]">{card.role}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {card.skills.map((s) => (
                          <span
                            key={s}
                            className="rounded border border-[#E5E0DA] bg-[#F8F4F1] px-1.5 py-0.5 text-[10px] text-[#777]"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#F0EBFF] px-2 py-0.5 text-[10px] font-semibold text-remotiv-purple">
                      <span className="inline-block size-1.5 rounded-full bg-remotiv-green" />
                      Open
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-black/[0.06] bg-white">
          <div className="mx-auto max-w-7xl px-14 py-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#AAA]" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, role, or skill (e.g. React, Go, Figma)…"
                  className="w-full rounded-xl border border-remotiv-purple/20 bg-white py-3 pl-10 pr-4 text-sm text-[#111] outline-none placeholder:text-[#BBB] focus:border-remotiv-purple"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {ROLE_FILTERS.map((role) => {
                const selected = activeRole === role;
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setActiveRole(role)}
                    className={cn(
                      "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                      selected
                        ? "border-remotiv-purple bg-remotiv-purple text-white"
                        : "border-black/10 bg-white text-[#444] hover:border-remotiv-purple/40 hover:text-remotiv-purple",
                    )}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-7xl px-14 py-12">
            <div className="mb-6 flex items-end justify-between">
              <p className="text-sm text-[#777]">
                Showing <strong className="text-[#111]">{filtered.length}</strong> of{" "}
                <strong className="text-[#111]">50,000+</strong> pre-vetted talents
              </p>
              <span className="text-xs text-remotiv-purple-light">
                Subscribe to unlock full contact details
              </span>
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 py-20 text-center text-sm text-[#AAA]">
                No talents match your filters. Try a different role or search.
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((t) => (
                  <TalentCard key={t.id} talent={t} />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function TalentCard({ talent }: { talent: Talent }) {
  const isAvailable = talent.availability === "available";
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white p-6 transition-all hover:-translate-y-0.5 hover:border-remotiv-green hover:shadow-[0_8px_32px_rgba(73,215,167,0.1)]">
      <div className="flex items-start gap-3">
        <div
          className="flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-bold"
          style={{ background: talent.avatarBg, color: talent.avatarText }}
        >
          {talent.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-heading text-base font-bold text-[#111]">{talent.name}</h3>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 text-[11px] font-semibold",
                isAvailable ? "text-remotiv-green" : "text-orange-500",
              )}
            >
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  isAvailable ? "bg-remotiv-green" : "bg-orange-500",
                )}
              />
              {isAvailable ? "Available" : "Limited"}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-[#777]">{talent.role}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {talent.skills.map((skill) => (
          <span
            key={skill}
            className="rounded-md border border-black/10 bg-[#F5F5F5] px-2 py-0.5 text-[11px] font-medium text-[#666] transition-colors group-hover:border-remotiv-green/40 group-hover:text-remotiv-green"
          >
            {skill}
          </span>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-[#888]">
        <MapPin className="size-3.5" />
        <span>{talent.location}</span>
        <span className="text-[#CCC]">·</span>
        <span>{talent.timezone}</span>
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-black/[0.06] pt-4">
        <div>
          <div className="font-heading text-lg font-bold text-[#111]">{talent.rate}</div>
          <div className="text-[11px] text-[#AAA]">Hourly rate</div>
        </div>
        <button
          type="button"
          className="rounded-xl bg-remotiv-green px-4 py-2.5 text-xs font-semibold text-[#111] transition-colors hover:bg-remotiv-green-light"
        >
          View Profile
        </button>
      </div>
    </article>
  );
}
