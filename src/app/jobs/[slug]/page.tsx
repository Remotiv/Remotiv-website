import {
  IconAward,
  IconBeach,
  IconBrandLinkedin,
  IconBriefcase,
  IconCalendarClock,
  IconChartLine,
  IconCircleCheckFilled,
  IconClock,
  IconCoin,
  IconConfetti,
  IconDeviceLaptop,
  IconGlobe,
  IconHeartHandshake,
  IconLink,
  IconMail,
  IconMapPin,
  IconRocket,
  IconSchool,
  IconStar,
  IconTrendingUp,
  IconUserHeart,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { Navbar } from "@/components/navbar";
import { type Job, getJobBySlug } from "@/lib/jobs";
import { canonicalUrl } from "@/lib/seo";
import { createServiceClient } from "@/lib/supabase/server";
import ApplyButton from "./_apply-button";
import "./job-detail.css";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

// ── Local formatting helpers (own copies — the list-client versions are
//    unexported + USD-only, so we don't import them) ──────────────
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function fmtSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
): string {
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const k = (n: number) => {
    if (n >= 1000) {
      const v = n / 1000;
      return `${Number.isInteger(v) ? v : v.toFixed(1)}k`;
    }
    return n.toLocaleString("en-US");
  };
  if (min != null && max != null) {
    return min === max ? `${cur} ${k(min)}` : `${cur} ${k(min)}–${k(max)}`;
  }
  if (min != null) return `${cur} from ${k(min)}`;
  if (max != null) return `${cur} up to ${k(max)}`;
  return "Competitive";
}

function splitLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Brand chrome — the perks marquee is the same regardless of the job (per the
// design handoff). Verbatim 12 perks + their Tabler icons.
const PERKS = [
  { label: "Competitive salary", Icon: IconCoin },
  { label: "Remote / Hybrid", Icon: IconWorld },
  { label: "Flexible hours", Icon: IconCalendarClock },
  { label: "Learning budget", Icon: IconSchool },
  { label: "Company laptop (if applicable)", Icon: IconDeviceLaptop },
  { label: "Paid time off", Icon: IconBeach },
  { label: "Health insurance (if offered)", Icon: IconHeartHandshake },
  { label: "Career growth", Icon: IconTrendingUp },
  { label: "Mentorship", Icon: IconUserHeart },
  { label: "Team events", Icon: IconConfetti },
  { label: "Performance bonus", Icon: IconAward },
  { label: "International team", Icon: IconGlobe },
];

// Brand chrome — the "how hiring works" timeline is fixed copy per the design.
const TIMELINE = [
  { n: "1", title: "Apply in 2 minutes", sub: "One form, no cover letter required.", dot: "#D9F972", ink: "#2c3d05" },
  { n: "2", title: "AI + human screen", sub: "Remotiv vets your skills within 24 hours.", dot: "#49D7A7", ink: "#ffffff" },
  { n: "3", title: "Interview tomorrow", sub: "Meet the hiring team — usually next day.", dot: "#9886FE", ink: "#ffffff" },
  { n: "4", title: "Offer within 2 weeks", sub: "From application to signed — two weeks.", dot: "#ffffff", ink: "#241f38" },
];

const CITY_CHIPS = [
  { label: "San Francisco", flag: "🇺🇸", circle: "#F5E0DC", bob: "jp-bob" },
  { label: "London", flag: "🇬🇧", circle: "#E8C8D0", bob: "jp-bob-2" },
  { label: "Pakistan", flag: "🇵🇰", circle: "#C9FF85", bob: "jp-bob-3" },
];

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const job = await getJobBySlug(slug);

  if (!job) {
    return { title: "Job not found — Remotiv", robots: { index: false, follow: false } };
  }

  const title = `${job.title} — ${job.company} | Remotiv`;
  const description = job.description
    ? `${job.description.slice(0, 150).replace(/\s+/g, " ").trim()}…`
    : `${job.title} at ${job.company}. Apply on Remotiv — remote roles for Pakistan's top vetted talent, hired by companies worldwide.`;
  const url = `/jobs/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Remotiv", locale: "en_US", type: "website" },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

async function fetchCounts(jobId: string): Promise<{ total: number; thisWeek: number }> {
  try {
    const supabase = createServiceClient();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [totalRes, weekRes] = await Promise.all([
      supabase
        .from("job_applications")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId),
      supabase
        .from("job_applications")
        .select("*", { count: "exact", head: true })
        .eq("job_id", jobId)
        .gte("created_at", weekAgo),
    ]);
    return { total: totalRes.count ?? 0, thisWeek: weekRes.count ?? 0 };
  } catch {
    // Counts are decorative — never crash the page on a transient error.
    return { total: 0, thisWeek: 0 };
  }
}

const HERO_CHIP =
  "inline-flex items-center gap-1.5 rounded-full bg-white/[0.16] px-3.5 py-2 text-[0.8rem] font-semibold text-white";
const TAG_CLS =
  "inline-flex items-center rounded-full bg-[#f1ede6] px-3 py-1.5 text-[0.78rem] font-medium text-[#6a6478]";

function SectionBar({
  label,
  color,
  size = "lg",
}: {
  label: string;
  color: string;
  size?: "lg" | "md";
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="h-5 w-[5px] rounded-[3px]" style={{ background: color }} />
      <h2 className={`font-heading font-bold text-[#241F38] ${size === "lg" ? "text-[17px]" : "text-[15px]"}`}>
        {label}
      </h2>
    </div>
  );
}

export default async function JobDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const job: Job | null = await getJobBySlug(slug);
  if (!job) notFound();

  const { total, thisWeek } = await fetchCounts(job.id);
  const responsibilities = splitLines(job.responsibilities);
  const requirements = splitLines(job.requirements);
  const salary = fmtSalary(job.salary_min, job.salary_max, job.salary_currency);
  const companyInitial = job.company.charAt(0).toUpperCase();
  const shareUrl = canonicalUrl(`/jobs/${slug}`);

  const flipCards = [
    {
      num: "01",
      title: "Remote-first",
      sub: "Work from anywhere",
      Icon: IconWorld,
      vars: { "--bg": "#c9ff85", "--ink": "#2c3d05", "--ink2": "#5a7012" } as CSSProperties,
    },
    {
      num: "02",
      title: "Fast-growing",
      sub: "Early-stage energy",
      Icon: IconRocket,
      vars: { "--bg": "#bff0df", "--ink": "#0a4a3a", "--ink2": "#0F6E56" } as CSSProperties,
    },
    {
      num: "03",
      title: job.positions > 1 ? `${job.positions} openings` : "Open role",
      sub: "Join the team",
      Icon: IconUsers,
      vars: { "--bg": "#e2dbfb", "--ink": "#3a3185", "--ink2": "#534AB7" } as CSSProperties,
    },
  ];

  const facts = [
    { Icon: IconBriefcase, label: "Type", value: job.contract_type },
    { Icon: IconWorld, label: "Work mode", value: job.work_type },
    { Icon: IconChartLine, label: "Experience", value: job.experience_level },
    { Icon: IconUsers, label: "Applicants", value: `${total} so far` },
  ];

  const jobPostingLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: job.description ?? `${job.title} at ${job.company} via Remotiv.`,
    datePosted: job.created_at,
    employmentType: job.contract_type,
    hiringOrganization: { "@type": "Organization", name: job.company },
    jobLocationType: job.work_type === "Remote" ? "TELECOMMUTE" : undefined,
    applicantLocationRequirements: { "@type": "Country", name: job.location },
    url: shareUrl,
  };

  return (
    <div className="jobpage font-sans text-[#241F38]">
      <Navbar />

      {/* ── HERO (full-bleed, flush under navbar) ──────────── */}
      <section className="jp-grid-light relative w-full overflow-hidden bg-remotiv-purple text-white">
        <div className="mx-auto grid max-w-[1200px] items-stretch gap-10 px-6 py-12 sm:px-10 sm:py-14 lg:grid-cols-[1.85fr_1fr]">
          {/* Left */}
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-remotiv-lime px-3.5 py-1.5 text-[0.78rem] font-bold uppercase tracking-wider text-[#2c3d05]">
              <span className="jp-dot" />
              Now hiring
            </span>
            <h1 className="mt-4 font-heading text-[clamp(2.2rem,5vw,3.4rem)] font-extrabold leading-[0.98] tracking-[-0.04em]">
              {job.title}
            </h1>

            {/* Company glass bar */}
            <div className="mt-5 inline-flex flex-wrap items-center gap-3 rounded-[15px] border border-white/[0.18] bg-white/[0.12] px-4 py-2.5 backdrop-blur">
              <span className="flex size-9 items-center justify-center rounded-[9px] bg-white font-heading text-base font-bold text-remotiv-purple">
                {companyInitial}
              </span>
              <span className="font-heading text-base font-bold">{job.company}</span>
              <span className="h-[22px] w-px bg-white/25" />
              <span className="inline-flex items-center gap-1 text-sm">
                <IconStar size={15} className="fill-remotiv-lime text-remotiv-lime" />
                {job.company_rating.toFixed(1)}
              </span>
              <span className="h-[22px] w-px bg-white/25" />
              <span className="inline-flex items-center gap-1 text-[13.5px] text-[#e6dbff]">
                <IconClock size={15} /> Posted {timeAgo(job.created_at)}
              </span>
            </div>

            {/* Chips */}
            <div className="mt-[18px] flex flex-wrap gap-2.5">
              <span className={HERO_CHIP}>
                <IconWorld size={15} /> {job.work_type}
              </span>
              <span className={HERO_CHIP}>
                <IconBriefcase size={15} /> {job.contract_type}
              </span>
              <span className={HERO_CHIP}>
                <IconMapPin size={15} /> {job.location}
              </span>
            </div>

            {/* CTA + salary */}
            <div className="mt-6 flex flex-wrap items-center gap-5">
              <ApplyButton job={job} variant="hero" />
              <div>
                <span className="font-heading text-[1.45rem] font-bold text-white">{salary}</span>
                <span className="text-[13px] text-[#d6c8ff]"> / month</span>
                {thisWeek > 0 && (
                  <div className="mt-0.5 text-xs text-[#cdb9ff]">
                    <span className="font-bold text-white">{thisWeek}</span>{" "}
                    {thisWeek === 1 ? "person" : "people"} applied this week
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right — tagline + bobbing city chips (brand chrome) */}
          <div className="hidden flex-col items-end justify-center gap-[18px] text-right lg:flex lg:pr-6 xl:pr-10">
            <p className="self-end text-left font-heading text-[1.6rem] font-extrabold leading-[1.18] tracking-[-0.02em]">
              Pakistan&apos;s
              <br />
              talent. Hired by
              <br />
              <span className="jp-mark">the world.</span>
            </p>
            <div className="flex flex-col items-end gap-2.5">
              {CITY_CHIPS.map((c) => (
                <div
                  key={c.label}
                  className={`${c.bob} inline-flex items-center gap-2 self-end rounded-full bg-white/95 py-1.5 pl-2 pr-3.5 shadow-[0_8px_22px_rgba(0,0,0,0.18)]`}
                >
                  <span
                    className="flex size-6 items-center justify-center rounded-full text-xs"
                    style={{ background: c.circle }}
                  >
                    {c.flag}
                  </span>
                  <span className="font-heading text-[0.8rem] font-bold text-[#241f38]">{c.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── PERKS MARQUEE (full-bleed) ─────────────────────── */}
      <section className="w-full py-4">
        <div className="jp-marquee">
          <div className="jp-marquee-track">
            {[0, 1].flatMap((dup) =>
              PERKS.map(({ label, Icon }) => (
                <span key={`${dup}-${label}`} aria-hidden={dup === 1} className="jp-perk">
                  <Icon size={16} className="text-remotiv-purple" />
                  {label}
                </span>
              )),
            )}
          </div>
        </div>
      </section>

      {/* ── FLIP CARDS ─────────────────────────────────────── */}
      <section className="mx-auto grid max-w-[1200px] grid-cols-3 gap-3 px-6 pb-2 pt-2 sm:px-10">
        {flipCards.map(({ num, title, sub, Icon, vars }) => (
          <div key={num} style={vars} className="jp-flip">
            <span className="jp-flip-num font-heading">{num}</span>
            <Icon size={23} className="jp-flip-ic" stroke={1.75} />
            <h3 className="jp-flip-title mt-2 font-heading text-[15px] font-bold">{title}</h3>
            <p className="jp-flip-sub mt-0.5 text-[11.5px]">{sub}</p>
          </div>
        ))}
      </section>

      {/* ── MAIN GRID ──────────────────────────────────────── */}
      <section className="mx-auto grid max-w-[1200px] items-start gap-4 px-6 py-5 sm:px-10 lg:grid-cols-[1.65fr_1fr]">
        {/* LEFT */}
        <div className="flex flex-col gap-4">
          {/* About */}
          <div className="rounded-[18px] border border-[#ece6df] bg-white p-6">
            <SectionBar label="About this role" color="#D9F972" />
            <p className="mb-5 whitespace-pre-line text-sm leading-[1.7] text-[#56506a]">
              {job.description?.trim() || "No description provided for this role yet."}
            </p>

            {responsibilities.length > 0 && (
              <>
                <SectionBar label="What you'll do" color="#49D7A7" size="md" />
                <ul className="mb-5 flex flex-col gap-2.5">
                  {responsibilities.map((line) => (
                    <li key={line} className="flex gap-2.5 text-sm leading-[1.55] text-[#4b4660]">
                      <IconCircleCheckFilled size={19} className="shrink-0 text-remotiv-mint" style={{ color: "#49D7A7" }} />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {requirements.length > 0 && (
              <>
                <SectionBar label="What we're looking for" color="#7E47FF" size="md" />
                <ul className="mb-5 flex flex-col gap-2.5">
                  {requirements.map((line) => (
                    <li key={line} className="flex gap-2.5 text-sm leading-[1.55] text-[#4b4660]">
                      <IconCircleCheckFilled size={19} className="shrink-0" style={{ color: "#49D7A7" }} />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="flex flex-wrap gap-2 border-t border-[#efeae3] pt-4">
              <span className={TAG_CLS}>{job.category}</span>
              <span className={TAG_CLS}>{job.experience_level}</span>
              <span className={TAG_CLS}>{job.language}</span>
            </div>
          </div>

          {/* Hiring timeline (dark, brand chrome) */}
          <div className="jp-grid-light relative overflow-hidden rounded-[18px] bg-[#241f38] p-6">
            <div className="relative">
              <p className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.15em] text-[#9886FE]">
                How hiring works
              </p>
              <h3 className="mb-5 font-heading text-[21px] font-extrabold tracking-[-0.02em] text-white">
                Apply today. <span className="text-remotiv-lime">Interview tomorrow.</span>
              </h3>
              {TIMELINE.map((s) => (
                <div key={s.n} className="jp-tstep">
                  <span className="jp-tdot font-heading" style={{ background: s.dot, color: s.ink }}>
                    {s.n}
                  </span>
                  <p className="font-heading text-[14.5px] font-bold text-white">{s.title}</p>
                  <p className="mt-0.5 text-[12.5px] text-[#a59dc4]">{s.sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT — boarding-pass apply ticket */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="jp-ticket">
            <div className="p-[22px]">
              <div className="mb-3.5 flex items-center justify-between">
                <span className="font-heading text-[11px] font-bold uppercase tracking-[0.14em] text-[#bcb6a8]">
                  Boarding pass
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e4f7ef] px-2.5 py-1 text-[11px] font-bold text-[#1D9E75]">
                  <span className="jp-dot" /> Open
                </span>
              </div>

              <p className="mb-1 text-[11.5px] font-bold uppercase tracking-[0.05em] text-[#a59f93]">
                Monthly compensation
              </p>
              <p className="font-heading text-[27px] font-extrabold tracking-[-0.03em] text-[#241f38]">{salary}</p>
              <p className="mb-[18px] text-[12.5px] text-[#9a9488]">Paid monthly in USD or PKR</p>

              <div>
                {facts.map(({ Icon, label, value }) => (
                  <div key={label} className="flex items-center gap-3 border-b border-[#efeae3] py-3 last:border-b-0">
                    <Icon size={20} className="w-6 shrink-0 text-remotiv-purple" />
                    <div>
                      <div className="text-[11px] text-[#a59f93]">{label}</div>
                      <div className="text-[13.5px] font-semibold text-[#3a3550]">{value}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="jp-perf">
              <span className="l" />
              <span className="r" />
            </div>

            <div className="px-[22px] pb-[22px] pt-5">
              <ApplyButton job={job} variant="ticket" />
              <p className="mt-3 flex items-center justify-center gap-2 text-xs text-[#9a9488]">
                <IconClock size={14} style={{ color: "#49D7A7" }} /> Avg. response in 24 hours
              </p>

              <div className="mt-3.5 flex items-center justify-center gap-[18px] border-t border-[#efeae3] pt-3.5">
                <span className="text-[12.5px] text-[#9a9488]">Share</span>
                <a
                  href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Share on LinkedIn"
                  className="text-remotiv-purple transition-opacity hover:opacity-70"
                >
                  <IconBrandLinkedin size={19} />
                </a>
                <a
                  href={shareUrl}
                  aria-label="Open job link"
                  className="text-[#6a6478] transition-opacity hover:opacity-70"
                >
                  <IconLink size={19} />
                </a>
                <a
                  href={`mailto:?subject=${encodeURIComponent(`${job.title} at ${job.company}`)}&body=${encodeURIComponent(shareUrl)}`}
                  aria-label="Share by email"
                  className="text-[#6a6478] transition-opacity hover:opacity-70"
                >
                  <IconMail size={19} />
                </a>
              </div>
            </div>
          </div>
        </aside>
      </section>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jobPostingLd) }}
      />
    </div>
  );
}
