"use client";

import {
  ClipboardList,
  Cloud,
  Code,
  Database,
  DollarSign,
  Megaphone,
  Package,
  Palette,
  Scale,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

const STATS = [
  { number: "1 Day", label: "Shortlist in your inbox" },
  { number: "2 Weeks", label: "Average full placement" },
  { number: "1M+", label: "Profiles in our database" },
  { number: "90-Day", label: "Free replacement guarantee" },
] as const;

const SERVICE_CARDS = [
  {
    title: "Not a Job Board",
    desc: "Every candidate is sourced, screened, and verified before you see them.",
  },
  {
    title: "Not a Body Shop",
    desc: "We match on culture, timezone, and growth stage — not just keywords.",
  },
  {
    title: "Success-Based",
    desc: "You only pay when you make a hire. Zero upfront fees.",
  },
] as const;

const WHY_ROWS = [
  {
    heading: "1-Day Shortlist. 7-Day Placement.",
    body: "Traditional agencies take 4–8 weeks. Companies promise 'prescreened candidates in 3 working days.' Remotiv delivers a shortlist in 1 business day and completes full placement in 2 weeks.",
    stat: "2 Weeks",
    statLabel: "Average full placement",
    flip: false,
  },
  {
    heading: "AI Precision + Human Judgment",
    body: "Our matching engine scans 1M+ profiles in seconds and scores candidates on technical fit, cultural alignment, timezone overlap, and communication quality. Then our recruiters call every shortlisted candidate personally. You get algorithmic speed with human context — not a raw database dump.",
    stat: "1M+",
    statLabel: "Profiles in our database",
    flip: true,
  },
  {
    heading: "You Only Pay When You Hire",
    body: "Our fee is charged only after your hire has started work. If no one joins, you pay nothing.",
    stat: "Zero Risk",
    statLabel: "Until you hire",
    flip: false,
  },
  {
    heading: "A Dedicated Recruiter Owns Your Search",
    body: "Every role gets a single dedicated recruiter who owns the search end-to-end. No hand-offs between team members, no miscommunication, no dropped balls. Your recruiter knows your company, your culture, and your hiring bar — and they're accountable for the result.",
    stat: "1 Recruiter",
    statLabel: "Dedicated to your search",
    flip: true,
  },
  {
    heading: "90-Day Replacement Guarantee",
    body: "If any hire doesn't stay or quits within the first 90 days, we restart the search at zero cost. No justification paperwork. No renegotiation. We replace and move on.",
    stat: "90 Days",
    statLabel: "Free replacement guarantee",
    flip: false,
  },
] as const;

const PROCESS_STEPS = [
  {
    counter: "1/4",
    title: "You Brief Us",
    body: "Share role requirements, skills, timezone, budget, and culture notes. We assign a dedicated recruiter who owns the entire search from here.",
    label: "15 Minutes",
    activeColor: "#C9FF85",
  },
  {
    counter: "2/4",
    title: "We Source, Screen & Shortlist",
    body: "Our AI scans 1M+ profiles for the strongest fits. Recruiters call, screen, and verify each candidate. You receive 3–5 shortlisted candidates with fit scores and vetting summaries.",
    label: "1 Business Day",
    activeColor: "#7E47FF",
  },
  {
    counter: "3/4",
    title: "You Interview & Select",
    body: "Interview on your schedule. We handle all coordination, candidate comms, and structured interview guides. We manage offer negotiations using live salary benchmarks.",
    label: null,
    activeColor: "#49D7A7",
  },
  {
    counter: "4/4",
    title: "Reference Check, Offer & Onboarding",
    body: "Every hire includes a verified reference check report. We manage the offer, handle contract paperwork, and support onboarding. Your 90-day guarantee begins on day one.",
    label: null,
    activeColor: "#FB923C",
  },
] as const;

const WHO_WE_WORK_WITH = [
  {
    title: "Startups & Scale-ups",
    desc: "YC-backed and Series A–C companies that need to hire fast, stay lean, and avoid enterprise process overhead. We move at startup speed — your shortlist arrives before your next sprint planning meeting.",
  },
  {
    title: "Mid-Market Companies",
    desc: "Growing US and UK companies scaling remote teams across engineering, sales, marketing, and operations. Remotiv gives you a dedicated recruitment pipeline without building an in-house talent acquisition function.",
  },
  {
    title: "Enterprise & Multinationals",
    desc: "Fortune 500 and global corporations building cost-effective offshore teams with senior-level talent. We handle compliance, contracts, and cross-border employment requirements so your procurement team doesn't have to.",
  },
  {
    title: "SaaS & Tech Companies",
    desc: "Product teams that need specialised technical talent — React engineers, ML specialists, DevOps leads, data engineers. Our AI matching is built for technical roles where precision matters more than volume.",
  },
  {
    title: "Non-Profits & NGOs",
    desc: "Mission-driven organisations operating under tight budget constraints. Remotiv's success-based model and Pakistan's cost advantage make world-class talent accessible to organisations that couldn't otherwise afford it.",
  },
  {
    title: "Pakistani Companies",
    desc: "Local companies that want access to the same vetted talent pipeline and structured recruitment process used by our global clients. Same quality bar, same speed, same guarantee.",
  },
] as const;

const ADVANTAGE_ROWS = [
  {
    label: "Candidates Tomorrow, Not Next Month",
    color: "#49D7A7",
    cols: [
      { title: "Shortlist in 24 Hours", body: "Submit your role today, receive 3–5 pre-screened candidates by tomorrow morning." },
      { title: "AI-Matched Precision", body: "Every candidate is scored for technical fit, timezone, and cultural alignment before reaching you." },
      { title: "No Chasing Required", body: "Your dedicated recruiter manages the pipeline. No follow-ups, no status requests, no waiting." },
    ],
  },
  {
    label: "Pre-Vetted, Not Pre-Filtered",
    color: "#7E47FF",
    cols: [
      { title: "Recruiter Screened", body: "Every shortlisted candidate is personally called, interviewed, and verified by our recruitment team." },
      { title: "Skills Validated", body: "For technical roles, candidates complete in-house assessments before they reach your inbox." },
      { title: "Interview-Ready Profiles", body: "You receive fit scores, vetting summaries, and salary expectations — not raw resumes to sort through." },
    ],
  },
  {
    label: "Zero Upfront Cost",
    color: "#49D7A7",
    cols: [
      { title: "Success-Based Model", body: "You pay nothing until you've hired someone and they've started. Zero risk until you've found the right person." },
      { title: "No Hidden Fees", body: "No retainers, no deposits, no subscription charges. One placement fee — one month's gross salary." },
      { title: "We Earn When We Deliver", body: "Our fee is charged only after your hire has started work. If no one joins, you pay nothing." },
    ],
  },
  {
    label: "Your Budget Goes Further",
    color: "#7E47FF",
    cols: [
      { title: "60–80% Cost Savings", body: "Pakistan's talent market delivers senior-calibre professionals at a fraction of US or UK rates." },
      { title: "Double Your Team", body: "Hire two senior engineers for the price of one US equivalent — same quality, same timezone overlap." },
      { title: "Extend Your Runway", body: "The savings compound annually. Every hire through Remotiv stretches your budget by quarters, not weeks." },
    ],
  },
  {
    label: "One Recruiter, One Search, Zero Hand-Offs",
    color: "#49D7A7",
    cols: [
      { title: "Dedicated Ownership", body: "A single recruiter owns your search from brief to placement. They know your company inside out." },
      { title: "No Rotating Contacts", body: "No explaining your requirements twice. No account manager handoffs. One person, one relationship." },
      { title: "Culture-Aware Matching", body: "Your recruiter learns your hiring bar, your team dynamics, and your culture — and matches accordingly." },
    ],
  },
  {
    label: "Guaranteed for 90 Days",
    color: "#7E47FF",
    cols: [
      { title: "Free Replacement", body: "If any hire leaves or doesn't work out within 90 days, we restart the search at zero cost." },
      { title: "No Paperwork", body: "No justification forms, no renegotiation, no rebooking fees. We replace and move on." },
      { title: "Risk Sits with Us", body: "You hire with confidence knowing the guarantee covers you from day one. The downside is ours." },
    ],
  },
] as const;

const ROLES = [
  { name: "Engineering", icon: Code, tags: "React, Node.js, Python, Go, Java, iOS, Android, Full Stack, Ruby, PHP, .NET" },
  { name: "Sales & Revenue", icon: TrendingUp, tags: "SDR, BDR, AE, RevOps, Sales Manager, VP Sales" },
  { name: "Customer Success", icon: Users, tags: "CSM, Onboarding Specialist, Renewals, Technical Support, CS Manager" },
  { name: "Design & UX", icon: Palette, tags: "Product Designer, UX Researcher, UI Designer, Design Systems Lead" },
  { name: "Data & AI", icon: Database, tags: "Data Scientist, ML Engineer, Data Analyst, Data Engineer, LLM Specialist" },
  { name: "DevOps & Cloud", icon: Cloud, tags: "DevOps, SRE, Cloud Architect, Platform Engineer, AWS, GCP, Azure" },
  { name: "Marketing", icon: Megaphone, tags: "Performance, Content, SEO, Growth, Brand, Email, Demand Gen" },
  { name: "Finance & Accounting", icon: DollarSign, tags: "Controller, CFO, Accountant, FP&A, Payroll, Financial Analyst" },
  { name: "QA & Testing", icon: ShieldCheck, tags: "QA Engineer, SDET, Automation, Manual Testing" },
  { name: "Operations", icon: ClipboardList, tags: "Operations Manager, COO, Chief of Staff, BizOps, Project Manager" },
  { name: "Product", icon: Package, tags: "Product Manager, Product Lead, Product Analyst, Scrum Master" },
  { name: "Legal & HR", icon: Scale, tags: "HR Manager, Recruiter, Legal Counsel, Compliance Officer" },
] as const;

const FAQS = [
  {
    q: "How fast do I actually get candidates?",
    a: "Within 1 business day. You'll receive a shortlist of 3–5 AI-matched, pre-screened candidates with fit scores and vetting summaries. Full placement is completed within 2 weeks.",
  },
  {
    q: "What's the difference between Remotiv and posting on other platforms?",
    a: "Platforms wait for people to apply — and most won't be a fit. Remotiv's AI proactively scans 1M+ profiles of pre-screened professionals, and our recruiters personally call and verify every shortlisted candidate. You receive a curated shortlist, not a pile of CVs.",
  },
  {
    q: "What if the hire doesn't work out?",
    a: "Every placement comes with a 90-day free replacement guarantee. We restart the search at zero cost, no questions asked.",
  },
  {
    q: "Do you only recruit from Pakistan?",
    a: "Our primary talent pool is Pakistan — 500,000+ IT graduates annually and one of the world's top emerging tech markets. For highly specialised or executive roles, we extend regionally across South and Southeast Asia.",
  },
  {
    q: "Is your 1 million profile database fully vetted?",
    a: "The full database is our sourcing foundation — it includes all profiles we've sourced and aggregated. From this pool, our AI identifies the strongest matches, and our recruiters personally screen and verify the shortlisted candidates. The shortlist you receive is thoroughly vetted; the database is the raw talent universe we search from.",
  },
] as const;

const CheckIcon = () => (
  <svg
    aria-hidden="true"
    className="mt-0.5 size-4 shrink-0"
    fill="none"
    viewBox="0 0 16 16"
  >
    <path
      d="M3 8l3.5 3.5L13 5"
      stroke="#49D7A7"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
    />
  </svg>
);

const ArrowUpRight = () => (
  <svg
    aria-hidden="true"
    className="size-4 stroke-white"
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
  >
    <path d="M7 17L17 7M7 7h10v10" />
  </svg>
);

export default function RecruitmentPage() {
  const [activeStep, setActiveStep] = useState(0);
  const [openWho, setOpenWho] = useState(0);
  const [openFaq, setOpenFaq] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveStep((i) => (i + 1) % PROCESS_STEPS.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Service",
            name: "Engineering Recruitment Services",
            serviceType: "Recruitment Services",
            provider: {
              "@type": "Organization",
              name: "Remotiv",
              url: "https://remotiv-website-m3jo.vercel.app",
            },
            areaServed: "Worldwide",
            url: "https://remotiv-website-m3jo.vercel.app/services/recruitment",
            description:
              "End-to-end senior engineering recruitment. Pre-vetted candidates, 24-hour shortlists.",
          }),
        }}
      />
      <Navbar />
      <main className="flex-1 bg-white font-body">
        {/* HERO */}
        <section className="relative flex min-h-[360px] sm:min-h-[520px] items-start sm:items-center justify-center overflow-hidden bg-white px-5 sm:px-8 pt-14 pb-6 sm:pt-20 sm:pb-10">
          <div
            aria-hidden="true"
            className="absolute inset-0 grid grid-cols-[repeat(7,1fr)] auto-rows-min sm:grid-cols-[repeat(10,1fr)] sm:grid-rows-[repeat(8,1fr)] sm:auto-rows-auto md:grid-cols-[repeat(12,1fr)] md:grid-rows-[repeat(7,1fr)] lg:grid-cols-[repeat(18,1fr)] lg:grid-rows-[repeat(7,1fr)] gap-1.5 p-1.5"
            style={{
              maskImage:
                "linear-gradient(to right, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.15) 65%, rgba(0,0,0,0.04) 100%)",
              WebkitMaskImage:
                "linear-gradient(to right, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.15) 65%, rgba(0,0,0,0.04) 100%)",
            }}
          >
            {Array.from({ length: 18 * 7 }).map((_, i) => (
              <div key={i} className="aspect-square sm:aspect-auto rounded-md bg-[#f8f4f1]" />
            ))}
          </div>
          <div className="relative z-10 w-full max-w-[860px] text-center">
            <h1 className="mb-7 font-heading text-[clamp(1.65rem,7vw,4.2rem)] font-extrabold leading-[1.1] tracking-tight">
              <span className="text-[#111]">Hire</span>
              <br />
              <span className="text-[#49D7A7]">Exceptional Talent.</span>
              <br />
              <span className="text-[#7E47FF]">Interview Tomorrow</span>
            </h1>
            <p className="mx-auto mb-6 sm:mb-10 max-w-[620px] text-[0.9rem] sm:text-[1.05rem] leading-[1.55] sm:leading-[1.7] text-[#444]">
              Submit your role today, receive 3–5 pre-screened candidates by tomorrow morning.
              Remotiv combines AI-powered matching with human expertise to place hires in 2 weeks
              — not 4–5 weeks. You only pay when you hire.
            </p>
            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-center gap-2.5 sm:gap-3.5">
              <Link
                className="w-auto self-center text-center rounded-full bg-[#49D7A7] px-7 sm:px-8 py-[12px] sm:py-[15px] font-heading text-[0.9rem] sm:text-base font-bold text-[#111] transition-opacity hover:opacity-90"
                href="/contact"
              >
                Submit a Role →
              </Link>
              <Link
                className="hidden sm:inline-block w-full sm:w-auto text-center rounded-full border-[1.5px] border-[#111] bg-transparent px-6 sm:px-8 py-[11px] sm:py-[14px] text-[0.9rem] sm:text-base font-semibold text-[#111] transition-colors hover:bg-[#111] hover:text-white"
                href="/book-a-meeting"
              >
                Book a 15-Min Call
              </Link>
            </div>
          </div>
        </section>

        {/* TRUST & STATS */}
        <section className="bg-white px-5 sm:px-10 pt-12 sm:pt-[52px] pb-12 sm:pb-16">
          <div className="mx-auto max-w-[1100px] text-center">
            <h2 className="mb-6 font-heading text-[clamp(1.8rem,4vw,3rem)] font-extrabold leading-[1.2] text-[#111]">
              Trusted by 100+ companies from{" "}
              <span className="text-[#7E47FF]">YC startups</span> to{" "}
              <span className="text-[#49D7A7]">Fortune-level multinationals.</span>
            </h2>
            <p className="mx-auto mb-10 sm:mb-14 max-w-[560px] text-base leading-[1.7] text-[#777]">
              We match you with pre-vetted remote specialists — fast, affordable, and ready to
              deliver from day one.
            </p>
            <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
              {STATS.map((s) => (
                <div
                  key={s.label}
                  className="rounded-2xl border border-black/10 bg-[#f8f4f1] px-6 py-5 text-center"
                >
                  <div className="mb-2.5 font-heading text-[clamp(1.8rem,3vw,2.4rem)] font-extrabold leading-none text-[#111]">
                    {s.number}
                  </div>
                  <div className="text-[0.88rem] font-semibold leading-[1.4] text-[#49D7A7]">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SERVICES */}
        <section className="bg-white px-5 sm:px-10 pb-12 sm:pb-16">
          <div className="mx-auto w-full max-w-[1400px] overflow-hidden rounded-3xl bg-[#9886fe] px-6 sm:px-10 md:px-14 pt-12 sm:pt-16 md:pt-[72px] pb-10 sm:pb-14">
            <div className="relative z-10 mb-12 max-w-[680px]">
              <h2 className="mb-3 font-heading text-[clamp(2rem,4vw,3.2rem)] font-extrabold leading-[1.1] tracking-tight text-white">
                Recruitment Services
              </h2>
              <p className="mb-5 text-[1.05rem] font-medium leading-[1.4] text-white/85">
                The Fastest Path from Role Brief to Signed Offer
              </p>
              <p className="text-[0.88rem] leading-[1.8] text-white/70">
                Remotiv connects global companies with pre-vetted professionals from Pakistan —
                one of the world&apos;s fastest-growing talent markets. Our AI scans 1M+ profiles
                instantly, and our recruiters personally screen every match before they reach
                you. You receive 3–5 interview-ready candidates within 1 business day, full
                placement in 2 weeks, at 60–80% less than Western rates — backed by a 90-day
                replacement guarantee.
              </p>
            </div>
            <div className="relative z-10 grid grid-cols-1 gap-4 md:grid-cols-3">
              {SERVICE_CARDS.map((c) => (
                <div
                  key={c.title}
                  className="flex flex-col rounded-[20px] bg-white px-6 pt-6 pb-7"
                >
                  <div className="mb-10 flex justify-end">
                    <div className="flex size-9 items-center justify-center rounded-full bg-[#111]">
                      <ArrowUpRight />
                    </div>
                  </div>
                  <h3 className="mb-2.5 font-heading text-[1.1rem] font-bold text-[#111]">
                    {c.title}
                  </h3>
                  <p className="text-[0.88rem] leading-[1.7] text-[#444]">{c.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* WHY REMOTIV (alt cards) */}
        <section className="bg-white px-5 sm:px-10 py-10 sm:py-12">
          <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
            <div className="mb-9 text-center">
              <h2 className="mb-2.5 font-heading text-[clamp(1.6rem,2.8vw,2.2rem)] font-extrabold leading-[1.15] text-[#111]">
                Why Remotiv
              </h2>
              <p className="text-base leading-[1.5] text-[#777]">
                What Makes Us Different from Every Other Option
              </p>
            </div>

            {WHY_ROWS.map((r) => (
              <div
                key={r.heading}
                className={cn(
                  "grid gap-3",
                  r.flip
                    ? "sm:grid-cols-[1fr_3.1fr]"
                    : "sm:grid-cols-[3.1fr_1fr]"
                )}
              >
                {r.flip && (
                  <div className="flex flex-col justify-end rounded-[20px] bg-[#c9ff85] p-6 sm:p-8">
                    <div className="mb-2 font-heading text-[clamp(1.4rem,2.4vw,2rem)] font-extrabold leading-none text-[#111]">
                      {r.stat}
                    </div>
                    <p className="text-[0.82rem] font-medium text-black/55">{r.statLabel}</p>
                  </div>
                )}
                <div className="flex flex-col justify-center rounded-[20px] bg-[#F7F8F8] px-6 sm:px-9 py-6 sm:py-8">
                  <h3 className="mb-2.5 font-heading text-base font-bold leading-[1.3] text-[#111]">
                    {r.heading}
                  </h3>
                  <p className="text-[0.85rem] leading-[1.7] text-[#444]">{r.body}</p>
                </div>
                {!r.flip && (
                  <div className="flex flex-col justify-end rounded-[20px] bg-[#c9ff85] p-6 sm:p-8">
                    <div className="mb-2 font-heading text-[clamp(1.4rem,2.4vw,2rem)] font-extrabold leading-none text-[#111]">
                      {r.stat}
                    </div>
                    <p className="text-[0.82rem] font-medium text-black/55">{r.statLabel}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* PROCESS */}
        <section className="bg-white px-5 sm:px-10 pt-10 pb-12 sm:pb-14">
          <div className="mx-auto mb-9 max-w-[1400px]">
            <p className="mb-3 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#49D7A7]">
              Our Process
            </p>
            <h2 className="mb-2.5 font-heading text-[clamp(1.6rem,2.8vw,2.2rem)] font-extrabold leading-[1.15] text-[#111]">
              From Role Brief to Hired — in 2 Weeks
            </h2>
            <p className="text-base leading-[1.6] text-[#777]">
              We&apos;ve compressed what normally takes agencies 4–8 weeks into a repeatable 2-week
              process.
            </p>
          </div>
          <div className="mx-auto w-full max-w-[1400px] overflow-hidden rounded-3xl bg-[#2a2426]">
            <div className="grid grid-cols-1 border-b border-white/10 md:grid-cols-[1fr_1.8fr]">
              <div className="flex items-start border-white/10 p-7 sm:p-11 md:border-r">
                <p className="text-[0.85rem] leading-[1.7] text-white">
                  Four steps. One dedicated recruiter. Zero hand-offs. Your new hire starts
                  within seven days of your brief.
                </p>
              </div>
              <ProcessStep step={PROCESS_STEPS[0]} active={activeStep === 0} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {PROCESS_STEPS.slice(1).map((s, i) => (
                <ProcessStep
                  key={s.counter}
                  active={activeStep === i + 1}
                  bordered={i < 2}
                  step={s}
                />
              ))}
            </div>
          </div>
        </section>

        {/* WHO WE WORK WITH */}
        <section className="bg-white px-5 sm:px-10 pt-10 sm:pt-14 pb-8">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-8 sm:mb-14 text-center">
              <h2 className="mb-3 font-heading text-[clamp(1.75rem,3vw,2.4rem)] font-extrabold leading-[1.15] text-[#111]">
                Who We Work With
              </h2>
              <p className="text-base text-[#777]">
                Global Businesses. Local Talent. One Platform.
              </p>
            </div>
            <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                {WHO_WE_WORK_WITH.map((w, i) => {
                  const open = openWho === i;
                  return (
                    <div
                      key={w.title}
                      className={cn(
                        "cursor-pointer overflow-hidden rounded-2xl transition-colors",
                        open ? "bg-[#120A0B]" : "bg-[#f5f5f5]"
                      )}
                    >
                      <button
                        className="flex w-full items-center justify-between gap-3 px-5 py-[18px] text-left"
                        onClick={() => setOpenWho(i)}
                        type="button"
                      >
                        <span
                          className={cn(
                            "text-[0.95rem] font-medium transition-colors",
                            open ? "text-white" : "text-[#111]"
                          )}
                        >
                          {w.title}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2.5 py-0.5 text-[0.78rem] transition-colors",
                            open
                              ? "border-white/15 text-white/40"
                              : "border-[#ccc] text-[#aaa]"
                          )}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                      </button>
                      <div
                        className={cn(
                          "overflow-hidden px-5 transition-[max-height,padding] duration-300",
                          open ? "max-h-[300px] pb-5" : "max-h-0"
                        )}
                      >
                        <p className="text-[0.88rem] leading-[1.75] text-white/65">{w.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="sticky top-20 h-full">
                <div className="relative min-h-[200px] md:min-h-[400px] overflow-hidden rounded-[18px] bg-[#f8f4f1]">
                  <Image
                    src="/recruitment/3570.webp"
                    alt="Remotiv team collaborating with clients"
                    fill
                    sizes="(max-width: 768px) 100vw, 50vw"
                    className="object-cover"
                    priority={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ADVANTAGE */}
        <section className="bg-white px-5 sm:px-10 py-10 sm:py-12">
          <div className="mx-auto max-w-[1200px]">
            <div className="mb-10 sm:mb-14">
              <p className="mb-3.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#49D7A7]">
                The Advantage
              </p>
              <h2 className="font-heading text-[clamp(1.75rem,3vw,2.6rem)] font-extrabold leading-[1.15] text-[#111]">
                What Changes When You Recruit Through Remotiv
              </h2>
            </div>
            {ADVANTAGE_ROWS.map((row, idx) => (
              <div
                key={row.label}
                className={cn(
                  "grid gap-6 sm:gap-10 border-t border-black/10 py-8 sm:py-10 md:grid-cols-[200px_repeat(3,1fr)]",
                  idx === ADVANTAGE_ROWS.length - 1 && "border-b"
                )}
              >
                <h3 className="pt-0.5 font-heading text-[0.95rem] font-bold leading-[1.3] text-[#111]">
                  {row.label}
                </h3>
                {row.cols.map((c) => (
                  <div
                    key={c.title}
                    className="grid grid-cols-[22px_1fr] gap-x-2.5 gap-y-2"
                  >
                    <div
                      className="mt-0.5 size-5 rounded-full"
                      style={{ backgroundColor: row.color, opacity: 0.2 }}
                    />
                    <h4 className="self-center font-heading text-[0.9rem] font-bold text-[#111]">
                      {c.title}
                    </h4>
                    <p className="col-span-2 text-[0.84rem] leading-[1.7] text-[#555]">
                      {c.body}
                    </p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* PRICING */}
        <section className="bg-white px-5 sm:px-10 pt-10 sm:pt-12 pb-12 sm:pb-16">
          <div className="mb-10 sm:mb-14 text-center">
            <h2 className="mb-3 font-heading text-[clamp(1.75rem,3vw,2.4rem)] font-extrabold leading-[1.15] text-[#111]">
              Simple, Transparent Pricing
            </h2>
            <p className="text-base text-[#777]">
              No retainers. No advance payments. You only pay when you hire.
            </p>
          </div>
          <div className="mx-auto grid max-w-[1100px] grid-cols-1 items-stretch gap-5 md:grid-cols-3">
            <PricingCard
              badge={{ label: "Free", className: "bg-[#f8f4f1] text-[#444]" }}
              btn={{ label: "Submit a Role", href: "/contact", variant: "lime" }}
              features={[
                "AI-powered candidate sourcing",
                "Recruiter screening & verification",
                "3–5 shortlisted candidates in 1 day",
                "Interview coordination & scheduling",
                "Offer negotiation with market data",
              ]}
              featuresLabel="Before you hire:"
              price={{ main: "$0", sub: "Zero upfront cost" }}
              title="Before You Hire"
            />
            <PricingCard
              badge={{ label: "Success-Based", className: "bg-[#111] text-white" }}
              btn={{ label: "Book a Call", href: "/book-a-meeting", variant: "dark" }}
              features={[
                "Success-based placement fee",
                "Paid only after candidate starts work",
                "No recurring charges or hidden markups",
                "No retainer or deposits required",
                "Reference checks included",
              ]}
              featuresLabel="When you hire:"
              highlight
              price={{ sub: "Pay only when you hire" }}
              title="When You Hire"
            />
            <PricingCard
              badge={{
                label: "Covered",
                className: "border border-[#444] bg-transparent text-[#444]",
              }}
              btn={{ label: "Learn More", href: "/contact", variant: "outline" }}
              features={[
                "90-day free replacement guarantee",
                "Full restart at zero additional cost",
                "No justification paperwork",
                "No renegotiation needed",
                "Complete peace of mind",
              ]}
              featuresLabel="After you hire:"
              price={{ main: "$0", mainSuffix: "extra", sub: "90-day guarantee included" }}
              title="After You Hire"
            />
          </div>
        </section>

        {/* WHAT WE RECRUIT */}
        <section className="relative bg-[#9886fe] px-5 sm:px-8 md:px-14 pt-10 sm:pt-12 pb-14 sm:pb-20">
          <p className="mb-3.5 text-[0.72rem] font-bold uppercase tracking-[0.16em] text-white/65">
            Roles We Place
          </p>
          <h2 className="mb-3.5 max-w-[680px] font-heading text-[clamp(1.6rem,2.8vw,2.2rem)] font-bold leading-[1.2] tracking-tight text-white">
            What We Recruit
          </h2>
          <p className="mb-12 max-w-[680px] text-[0.95rem] leading-[1.7] text-white/75">
            Every Function. Every Level. Remotiv&apos;s database covers the full spectrum of
            professional roles — from early-career specialists to C-suite executives. If the
            skill exists in Pakistan&apos;s talent market, we can source it.
          </p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {ROLES.map((r) => {
              const Icon = r.icon;
              return (
                <div
                  key={r.name}
                  className="flex min-h-[150px] sm:min-h-[180px] cursor-default flex-col items-center justify-center rounded-2xl border border-[#252525] bg-white px-3 sm:px-5 py-5 sm:py-8 text-center transition-all hover:-translate-y-0.5 hover:border-[#7E47FF] hover:bg-[#f9f8ff]"
                >
                  <Icon
                    className="mb-3 size-7 fill-[#111] text-[#111] opacity-[0.85]"
                    strokeWidth={2}
                  />
                  <div className="mb-1 font-heading text-[0.88rem] font-semibold leading-[1.3] text-[#111]">
                    {r.name}
                  </div>
                  <div className="text-[0.7rem] sm:text-[0.75rem] leading-snug text-[#666]">
                    {r.tags}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* CTA / INQUIRY */}
        <section className="bg-white px-4 sm:px-10 pt-10 pb-12">
          <div className="mx-auto grid max-w-[900px] grid-cols-1 items-center gap-8 md:gap-14 rounded-3xl bg-[#c9ff85] px-5 sm:px-8 md:px-[60px] py-8 sm:py-10 md:py-[52px] md:grid-cols-2">
            <div>
              <h2 className="mb-3 font-heading text-[clamp(1.4rem,2.2vw,1.9rem)] font-extrabold leading-[1.1] tracking-tight text-[#111]">
                Your Next Hire Is a Week Away.
              </h2>
              <p className="mb-6 text-[13px] leading-[1.75] text-[#111]/75">
                Tell us what you need. Remotiv delivers a screened, AI-matched shortlist — backed
                by a free replacement guarantee and an outcome-based engagement model.
              </p>
              <div className="mb-7 flex flex-wrap gap-2.5">
                <Link
                  className="rounded-full bg-[#49D7A7] px-6 py-[13px] sm:py-3 font-heading text-[0.82rem] font-bold text-[#111] transition-opacity hover:opacity-90"
                  href="/contact"
                >
                  Submit a Role →
                </Link>
                <a
                  className="rounded-full border-[1.5px] border-[#111] bg-transparent px-6 py-[13px] sm:py-[11px] text-[0.82rem] font-semibold text-[#111] transition-colors hover:bg-[#111] hover:text-white"
                  href="https://calendly.com/waleed-izww/intro-call"
                  rel="noreferrer"
                  target="_blank"
                >
                  Book a 15-Min Call
                </a>
              </div>
              <ul className="flex flex-col gap-2.5">
                {[
                  "Shortlist delivered within 24 hours",
                  "Free replacement guarantee included",
                  "100% confidential — your data stays private",
                ].map((t) => (
                  <li
                    key={t}
                    className="flex items-center gap-2 text-[13px] font-medium text-[#111]"
                  >
                    <span className="flex size-[18px] items-center justify-center rounded-full bg-white/50">
                      <svg
                        aria-hidden="true"
                        fill="none"
                        height="9"
                        viewBox="0 0 12 12"
                        width="9"
                      >
                        <path
                          d="M2 6l3 3 5-5"
                          stroke="#111"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <InquiryForm />
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-black/5 bg-white px-5 sm:px-10 pt-12 sm:pt-16 pb-16 sm:pb-24">
          <div className="mx-auto max-w-[1100px]">
            <div className="flex w-full flex-col gap-10 md:flex-row md:gap-20">
              <div className="md:w-[35%]">
                <h2 className="mb-5 font-heading text-[clamp(1.8rem,3vw,2.6rem)] font-extrabold leading-[1.15] text-[#111]">
                  Questions We Hear Most
                </h2>
                <p className="text-[0.95rem] leading-[1.7] text-[#777]">
                  For any unanswered questions, reach out to our team. We&apos;ll respond as soon as
                  possible.
                </p>
              </div>
              <div className="md:w-[58%]">
                <div className="border-t border-black/10">
                  {FAQS.map((f, i) => {
                    const open = openFaq === i;
                    return (
                      <div key={f.q} className="border-b border-black/10">
                        <button
                          className="flex w-full cursor-pointer items-center justify-between gap-4 py-6 text-left"
                          onClick={() => setOpenFaq(open ? -1 : i)}
                          type="button"
                        >
                          <span className="flex-1 font-heading text-[0.97rem] font-semibold leading-[1.4] text-[#111]">
                            {f.q}
                          </span>
                          <span className="w-6 text-center text-xl font-light text-[#111]">
                            {open ? "−" : "+"}
                          </span>
                        </button>
                        <div
                          className={cn(
                            "overflow-hidden transition-[max-height] duration-300",
                            open ? "max-h-[400px]" : "max-h-0"
                          )}
                        >
                          <p className="pb-6 text-[0.9rem] leading-[1.75] text-[#444]">{f.a}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

type ProcessStepData = (typeof PROCESS_STEPS)[number];

function ProcessStep({
  step,
  active,
  bordered,
}: {
  step: ProcessStepData;
  active: boolean;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col px-6 sm:px-9 pt-7 sm:pt-8 pb-7 sm:pb-9 transition-colors duration-500",
        bordered && "border-white/10 lg:border-r"
      )}
      style={active ? { backgroundColor: step.activeColor } : undefined}
    >
      <span
        className={cn(
          "mb-auto pb-6 sm:pb-12 font-heading text-[clamp(1.8rem,3.5vw,2.8rem)] font-bold leading-none transition-colors duration-500",
          active ? "text-black/30" : "text-white/20"
        )}
      >
        {step.counter}
      </span>
      <h3
        className={cn(
          "mb-2 font-heading text-base font-bold leading-[1.25] transition-colors duration-500",
          active ? "text-[#111]" : "text-white/85"
        )}
      >
        {step.title}
      </h3>
      <p
        className={cn(
          "mb-3 text-[0.8rem] leading-[1.7] transition-colors duration-500",
          active ? "text-black/55" : "text-white/40"
        )}
      >
        {step.body}
      </p>
      {step.label && (
        <span
          className={cn(
            "self-start rounded-full border px-3 py-0.5 font-heading text-[0.6rem] font-bold uppercase tracking-[0.1em] transition-colors duration-500",
            active
              ? "border-black/25 text-black/50"
              : "border-white/20 text-white/35"
          )}
        >
          {step.label}
        </span>
      )}
    </div>
  );
}

type PricingCardProps = {
  title: string;
  badge: { label: string; className: string };
  price: { main?: string; mainSuffix?: string; sub: string };
  btn: { label: string; href: string; variant: "lime" | "dark" | "outline" };
  featuresLabel: string;
  features: readonly string[];
  highlight?: boolean;
};

function PricingCard({
  title,
  badge,
  price,
  btn,
  featuresLabel,
  features,
  highlight,
}: PricingCardProps) {
  const btnClass =
    btn.variant === "lime"
      ? "bg-[#c9ff85] text-[#111]"
      : btn.variant === "dark"
        ? "bg-[#111] text-white"
        : "border-[1.5px] border-[#111] bg-transparent text-[#111]";
  return (
    <div
      className={cn(
        "flex flex-col rounded-[20px] border border-black/10 bg-white px-6 sm:px-7 py-7 sm:py-8",
        highlight && "border-[#111]"
      )}
    >
      <div className="mb-6 flex items-center gap-2.5">
        <h3 className="font-heading text-[1.05rem] font-bold text-[#111]">{title}</h3>
        <span
          className={cn("rounded-md px-2.5 py-0.5 text-[0.72rem] font-semibold", badge.className)}
        >
          {badge.label}
        </span>
      </div>
      <div className="mb-6">
        {price.main && (
          <div className="mb-1.5 font-heading text-[2.2rem] sm:text-[2.8rem] font-extrabold leading-none text-[#111]">
            {price.main}
            {price.mainSuffix && (
              <span className="text-[1.4rem]"> {price.mainSuffix}</span>
            )}
          </div>
        )}
        <p
          className={cn(
            "text-[0.88rem] text-[#777]",
            !price.main && "mt-2 text-[0.95rem] text-[#444]"
          )}
        >
          {price.sub}
        </p>
      </div>
      <Link
        className={cn(
          "mb-7 block w-full rounded-full px-5 py-3.5 text-center text-[0.95rem] font-semibold transition-opacity hover:opacity-85",
          btnClass
        )}
        href={btn.href}
      >
        {btn.label}
      </Link>
      <p className="mb-3.5 text-[0.88rem] font-medium text-[#444]">{featuresLabel}</p>
      <ul className="flex flex-col gap-2.5">
        {features.map((f) => (
          <li
            key={f}
            className="flex items-start gap-2.5 text-[0.88rem] leading-[1.5] text-[#444]"
          >
            <CheckIcon />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InquiryForm() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    name: "",
    company: "",
    email: "",
    role: "",
    message: "",
  });
  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    if (!form.name || !form.email) {
      alert("Please enter your name and email.");
      return;
    }
    const subject = encodeURIComponent(
      `Recruitment Inquiry from ${form.name}${form.company ? ` — ${form.company}` : ""}`
    );
    const body = encodeURIComponent(
      `Name: ${form.name}\nCompany: ${form.company}\nEmail: ${form.email}\nRole Needed: ${form.role}\n\nMessage:\n${form.message}`
    );
    window.location.href = `mailto:waleed@remotiv.work?subject=${subject}&body=${body}`;
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="rounded-2xl bg-white px-6 py-7 text-center">
        <div className="mb-3 text-4xl">✅</div>
        <h3 className="mb-2 font-heading text-base font-bold text-[#111]">Inquiry Sent!</h3>
        <p className="text-[13px] text-[#666]">We&apos;ll get back to you within 48 hours.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white px-5 sm:px-6 py-6 sm:py-7">
      <p className="mb-4 font-heading text-sm font-bold text-[#111]">Send an Inquiry</p>
      <div className="mb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5">
        <FormField label="Full Name" onChange={update("name")} placeholder="Your name" value={form.name} />
        <FormField label="Company" onChange={update("company")} placeholder="Company name" value={form.company} />
      </div>
      <FormField
        label="Work Email"
        onChange={update("email")}
        placeholder="you@company.com"
        type="email"
        value={form.email}
      />
      <FormField
        label="Role Needed"
        onChange={update("role")}
        placeholder="e.g. Senior React Developer"
        value={form.role}
      />
      <label className="mb-2.5 block">
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]">
          Message
        </span>
        <textarea
          className="box-border min-h-[68px] w-full resize-none rounded-lg border-none bg-[#f5f5f5] px-3 py-2.5 text-base sm:text-xs text-[#333] outline-none focus:bg-[#efefef]"
          onChange={update("message")}
          placeholder="Tell us about the role, skills needed, and timeline..."
          value={form.message}
        />
      </label>
      <button
        className="mb-2.5 w-full cursor-pointer rounded-[10px] border-none bg-[#c9ff85] px-3 py-3.5 font-heading text-xs font-bold uppercase tracking-[0.06em] text-[#111] transition-all hover:-translate-y-px hover:bg-[#b8f060]"
        onClick={submit}
        type="button"
      >
        Send Inquiry →
      </button>
      <p className="text-center text-[10px] text-[#bbb]">
        Your data is encrypted and 100% confidential
      </p>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]">
        {label}
      </span>
      <input
        className="box-border w-full rounded-lg border-none bg-[#f5f5f5] px-3 py-2.5 text-base sm:text-xs text-[#333] outline-none focus:bg-[#efefef]"
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}
