"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import type { CSSPropertiesWithVars } from "@/lib/css-types";

const HERO_STATS: readonly { num: string; em: string; label: string }[] = [
  { num: "2 ", em: "weeks", label: "Team Ready to Start" },
  { num: "60–", em: "80%", label: "Cost Savings vs US Hiring" },
  { num: "$", em: "271K", label: "Avg. Annual Savings (5-person team)" },
  { num: "1M", em: "+", label: "Active Talents" },
];

const HOW_IT_WORKS: readonly { em: string; body: string }[] = [
  {
    em: "Not outsourcing",
    body: "You own the roadmap, the priorities, and every line of code. No project manager layer. No external vendor directing the work.",
  },
  {
    em: "Not freelancers",
    body: "Your team is full-time, exclusive to you, and building deep product context over months and years — not rotating between clients.",
  },
  {
    em: "Not DIY offshore",
    body: "No legal entity in Pakistan, no local HR function, no payroll headaches. Remotiv is your infrastructure.",
  },
];

const WHY_REMOTIV_TOP: readonly { badge: string; heading: string; body: string }[] = [
  {
    badge: "Speed",
    heading: "Operational in 2 Weeks",
    body: "Companies onboarding takes weeks. Firms ramp-up is measured in sprints. Remotiv gets your team recruited, contracted, and working in 2 weeks — because we've already built the infrastructure to move that fast.",
  },
  {
    badge: "Cost",
    heading: "60–80% Less Than Hiring in the US",
    body: "Pakistan produces 500,000+ STEM graduates annually and is home to engineers who've shipped products at multiple companies and US-based startups. Remotiv gives you this talent at a fraction of Western rates — a 5-person team that costs $460K in the US costs approximately $189K through Remotiv.",
  },
];

const WHY_REMOTIV_BOTTOM: readonly { badge: string; heading: string; body: string }[] = [
  {
    badge: "Flexibility",
    heading: "Scale Without Friction",
    body: "Add a new role next month. Replace an underperformer next week. Scale from 3 to 8 when your Series B closes. No severance, no long notice periods, no re-procurement. Your team size tracks your business reality.",
  },
  {
    badge: "Context",
    heading: "Deep Product Context Over Time",
    body: "Unlike staff augmentation where specialists rotate, your dedicated team builds deep institutional knowledge of your product, codebase, and customers. By month three, they're as fluent in your product as any in-house hire.",
  },
  {
    badge: "Guarantee",
    heading: "Replacement Guarantee",
    body: "If any team member leaves or doesn't work, Remotiv restarts the search and places a replacement at zero cost. No paperwork, no rebooking fee. We fix it.",
  },
];

const PROCESS_STEPS: readonly { n: number; tag: string; heading: string; body: string }[] = [
  {
    n: 1,
    tag: "Day 1",
    heading: "Define Your Team",
    body: "Tell us the roles, skills, timezone overlap, culture fit, and budget. We assign a dedicated account manager who will coordinate every step from here. This conversation takes 30 minutes and triggers recruitment immediately.",
  },
  {
    n: 2,
    tag: "Day 1–4",
    heading: "We Recruit & You Select",
    body: "Our AI scans 1M+ profiles while our recruiters source, screen, and shortlist the strongest matches. You receive 3–5 pre-vetted candidates per role — with fit scores, skills assessments, and vetting summaries. You interview and make the final hiring decision. No one joins your team without your approval.",
  },
  {
    n: 3,
    tag: "Day 5–11",
    heading: "Contracts & Onboarding",
    body: "Remotiv handles all contracts, NDAs, IP assignment, payroll setup, tool access, and day-one documentation. Your legal team never needs to understand Pakistani employment law. Your team arrives fully prepared.",
  },
  {
    n: 4,
    tag: "Day 14",
    heading: "They Start. You Lead.",
    body: "Your team joins your Slack, your standup, your codebase. They're contributing from day one. Remotiv manages payroll, HR, performance support, and compliance permanently in the background — you never see it. You just lead.",
  },
];

type AdvantageIcon = "clock" | "user" | "check" | "owner" | "card" | "shield" | "arrow" | "dot" | "bars";

const ADVANTAGE_ROWS: readonly {
  label: string;
  color: "purple-light" | "purple";
  cols: readonly { icon: AdvantageIcon; heading: string; body: string }[];
}[] = [
  {
    label: "Operational in Days, Not Months",
    color: "purple-light",
    cols: [
      {
        icon: "clock",
        heading: "Team Ready in 2 Weeks",
        body: "Recruitment, screening, contracts, and onboarding completed within two weeks of your brief.",
      },
      {
        icon: "user",
        heading: "No Recruitment Overhead",
        body: "Remotiv handles sourcing, vetting, and hiring. You just interview and approve.",
      },
      {
        icon: "check",
        heading: "Productive from Week One",
        body: "Your team arrives with contracts signed, tools configured, and NDAs in place. Day one is work day one.",
      },
    ],
  },
  {
    label: "Full Control, Zero Admin",
    color: "purple",
    cols: [
      {
        icon: "owner",
        heading: "You Own the Roadmap",
        body: "Priorities, sprint planning, and daily direction stay 100% with you. No intermediary.",
      },
      {
        icon: "card",
        heading: "Invisible Operations Layer",
        body: "Payroll, tax compliance, HR, and contracts managed permanently by Remotiv. You never see it.",
      },
      {
        icon: "shield",
        heading: "100% IP Ownership",
        body: "Every line of code, every design, every deliverable belongs to you. Legally enforced from day one.",
      },
    ],
  },
  {
    label: "Built to Scale",
    color: "purple-light",
    cols: [
      {
        icon: "arrow",
        heading: "Add Roles Anytime",
        body: "Need a designer next month? A QA engineer next quarter? We recruit and onboard them into your existing team.",
      },
      {
        icon: "dot",
        heading: "Replace Without Friction",
        body: "If someone leaves or underperforms, we replace them at zero cost. No paperwork.",
      },
      {
        icon: "bars",
        heading: "Team Size Tracks Your Business",
        body: "Scale from 2 to 10 when funding closes. Scale back to 5 when the sprint wraps. No penalties.",
      },
    ],
  },
];

const COST_ROWS: readonly {
  role: string;
  badgeLabel: string;
  badgeBg: string;
  badgeColor: string;
  us: string;
  remotiv: string;
  savings: string;
}[] = [
  {
    role: "Senior Software Engineer",
    badgeLabel: "Engineering",
    badgeBg: "rgba(152,134,254,0.2)",
    badgeColor: "#9886fe",
    us: "$120,000/yr",
    remotiv: "$52,000/yr",
    savings: "$68,000",
  },
  {
    role: "SDR / Sales Rep",
    badgeLabel: "Sales",
    badgeBg: "rgba(73,215,167,0.15)",
    badgeColor: "#49D7A7",
    us: "$65,000/yr",
    remotiv: "$28,000/yr",
    savings: "$37,000",
  },
  {
    role: "Customer Success Manager",
    badgeLabel: "Success",
    badgeBg: "rgba(201,255,133,0.15)",
    badgeColor: "#8ab527",
    us: "$75,000/yr",
    remotiv: "$32,000/yr",
    savings: "$43,000",
  },
  {
    role: "UI/UX Designer",
    badgeLabel: "Design",
    badgeBg: "rgba(126,71,255,0.2)",
    badgeColor: "#9886fe",
    us: "$90,000/yr",
    remotiv: "$35,000/yr",
    savings: "$55,000",
  },
  {
    role: "DevOps Engineer",
    badgeLabel: "Engineering",
    badgeBg: "rgba(152,134,254,0.2)",
    badgeColor: "#9886fe",
    us: "$110,000/yr",
    remotiv: "$42,000/yr",
    savings: "$68,000",
  },
];

const DIY_ROWS: readonly { label: string; remotiv: string; diy: string; both?: boolean }[] = [
  { label: "Time to first hire", remotiv: "2 weeks", diy: "6–12 weeks" },
  { label: "Recruitment", remotiv: "Fully managed", diy: "You source, screen & interview" },
  { label: "Contracts & compliance", remotiv: "Included", diy: "Your legal team figures it out" },
  { label: "Monthly payroll", remotiv: "Processed for you", diy: "You manage local payroll rules" },
  { label: "HR & performance", remotiv: "Handled", diy: "You build from scratch" },
  { label: "Cost vs US market", remotiv: "60–80% lower", diy: "Lower but setup costs are high" },
  { label: "Scalability", remotiv: "Add / remove anytime", diy: "Slow and legally complex" },
  { label: "Replacement guarantee", remotiv: "Free, no paperwork", diy: "None — restart from zero" },
  { label: "IP ownership", remotiv: "100% yours", diy: "100% yours", both: true },
];

const WHAT_WE_BUILD: readonly { name: string; tags: string; iconPath: string }[] = [
  {
    name: "Engineering",
    tags: "React · Node.js · Python · Go · Full Stack · Mobile · Backend",
    iconPath:
      "M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z",
  },
  {
    name: "Sales & SDR",
    tags: "SDRs · BDRs · AEs · Sales Leads · RevOps",
    iconPath:
      "M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm-7 12H5v-2h8v2zm4-4H5v-2h12v2zm3-4H4V6h16v2z",
  },
  {
    name: "Customer Success",
    tags: "CSMs · Onboarding · Renewals · Support · CS Managers",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  },
  {
    name: "Design",
    tags: "Product Designers · UX Researchers · Design Leads",
    iconPath:
      "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7-3.14 7-7 7zm1-11h-2v3H8v2h3v3h2v-3h3v-2h-3z",
  },
  {
    name: "DevOps & Cloud",
    tags: "DevOps · SRE · Cloud Architects · Platform Engineers",
    iconPath:
      "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  },
  {
    name: "Data & AI",
    tags: "Data Scientists · ML Engineers · Analysts · Data Engineers",
    iconPath:
      "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z",
  },
  {
    name: "Marketing",
    tags: "Performance · Content · SEO · Growth · Brand · Email",
    iconPath:
      "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  },
  {
    name: "Finance & Ops",
    tags: "Controller · FP&A · Accountant · Operations Manager",
    iconPath:
      "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
  },
  {
    name: "QA & Testing",
    tags: "QA Engineer · SDET · Automation · Manual Testing",
    iconPath: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  },
  {
    name: "Product",
    tags: "Product Manager · Product Lead · Product Analyst",
    iconPath:
      "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z",
  },
];

const FAQS: readonly { q: string; a: string }[] = [
  {
    q: "What's the minimum team size?",
    a: "No strict minimum — many clients start with 2 people and grow. For a single role, our Recruitment or Staff Augmentation service is usually a better fit.",
  },
  {
    q: "Do I get to interview people before they join?",
    a: "Yes. You interview every candidate and make the final hiring decision. No one joins your team without your approval.",
  },
  {
    q: "How is this different from Staff Augmentation?",
    a: "Staff Augmentation fills specific skill gaps with individual specialists on a flexible basis. A Dedicated Team is a purpose-built group — multiple roles, ongoing engagement — with Remotiv managing HR and payroll permanently. It's the difference between adding one person and building a team.",
  },
  {
    q: "Can I scale up or down after we start?",
    a: "Yes. Add roles, replace members, or grow the team as your needs change. Remotiv handles all recruitment and transitions. No penalty for scaling down.",
  },
  {
    q: "Who manages the team day-to-day?",
    a: "You do. They report to you, use your tools, follow your processes. Remotiv manages payroll, HR, and compliance in the background but never directs the work.",
  },
  {
    q: "What does it cost?",
    a: "Remotiv pricing is based on the team composition and roles required. There is no setup fee. We provide a transparent cost breakdown during the initial consultation so you know exactly what you're paying before you commit.",
  },
  {
    q: "Do I own the work and IP?",
    a: "100%. All work produced by your dedicated team belongs entirely to you. Contracts include full IP assignment clauses.",
  },
];

const PURPLE_LIGHT = "#9886fe";
const PURPLE = "#7E47FF";
const LIME = "#c9ff85";
const GREEN = "#49D7A7";

const ICON_SVG_CLASS = "mt-0.5 h-[22px] w-[22px]";

function AdvantageIconSvg({ icon, color }: { icon: AdvantageIcon; color: string }) {
  const stroke = color;
  switch (icon) {
    case "clock":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <circle cx="18" cy="18" r="12" stroke={stroke} strokeWidth="1.8" />
          <path d="M18 12v6l4 4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "user":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <circle cx="18" cy="12" r="6" stroke={stroke} strokeWidth="1.8" />
          <path d="M6 30c0-6.627 5.373-12 12-12s12 5.373 12 12" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "check":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <rect x="4" y="6" width="28" height="24" rx="4" stroke={stroke} strokeWidth="1.8" />
          <path d="M10 18l5 5 11-10" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "owner":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <circle cx="18" cy="10" r="5" stroke={stroke} strokeWidth="1.8" />
          <path d="M8 28c0-5.523 4.477-10 10-10s10 4.477 10 10" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M14 20l4-4 4 4" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "card":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <rect x="6" y="10" width="24" height="16" rx="3" stroke={stroke} strokeWidth="1.8" />
          <path d="M6 16h24" stroke={stroke} strokeWidth="1.5" />
          <path d="M12 22h4" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "shield":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <path d="M18 6l10 4v8c0 6-4.5 10.5-10 12C12.5 28.5 8 24 8 18v-8l10-4z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M13 18l3 3 7-7" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "arrow":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <path d="M18 28V8M18 8l-7 7M18 8l7 7" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 28h20" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "dot":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <path d="M18 6l10 4v8c0 6-4.5 10.5-10 12C12.5 28.5 8 24 8 18v-8l10-4z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
          <circle cx="18" cy="18" r="3" fill={stroke} />
        </svg>
      );
    case "bars":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={ICON_SVG_CLASS} aria-hidden="true">
          <rect x="4" y="14" width="6" height="14" rx="2" stroke={stroke} strokeWidth="1.8" />
          <rect x="15" y="8" width="6" height="20" rx="2" stroke={stroke} strokeWidth="1.8" />
          <rect x="26" y="18" width="6" height="10" rx="2" stroke={stroke} strokeWidth="1.8" />
        </svg>
      );
  }
}

export default function DedicatedTeamPage() {
  const [openFaq, setOpenFaq] = useState<number>(0);

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Service",
            name: "Dedicated Engineering Teams",
            serviceType: "Dedicated Team Services",
            provider: {
              "@type": "Organization",
              name: "Remotiv",
              url: "https://remotiv-website-m3jo.vercel.app",
            },
            areaServed: "Worldwide",
            url: "https://remotiv-website-m3jo.vercel.app/services/dedicated-team",
            description:
              "Build a dedicated remote engineering team. Hand-picked, managed, retained.",
          }),
        }}
      />
      <Navbar />
      <main className="flex-1 bg-white font-[DM_Sans,sans-serif] text-[#111]">
        {/* HERO */}
        <section className="box-border w-full bg-white p-6 max-md:p-4">
          <div
            className="relative isolate mx-auto flex w-full flex-col items-center justify-center overflow-hidden rounded-[32px] px-6 pt-18 pb-20 max-md:px-5 max-md:pt-12 max-md:pb-12"
            style={{ background: "#F5F1EC" }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-0"
              style={{
                backgroundImage:
                  "linear-gradient(to right, #ccc8c0 0.5px, transparent 0.5px), linear-gradient(to bottom, #ccc8c0 0.5px, transparent 0.5px)",
                backgroundSize: "80px 80px",
              }}
            />
            <div className="relative z-10 mx-auto flex w-full max-w-[1100px] flex-col items-center text-center">
              <h1
                className="m-0 max-w-[860px] text-center font-[Sora,sans-serif] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#111]"
                style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)" }}
              >
                Your Dedicated Team. Recruited,
              </h1>
              <div
                className="mt-1 mb-7 max-w-[860px] text-center font-[Sora,sans-serif] font-extrabold leading-[1.1] tracking-[-0.02em]"
                style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)", color: PURPLE_LIGHT }}
              >
                Onboarded, and Working in 2 Weeks.
              </div>
              <p className="mb-12 max-w-[580px] text-center text-[1.1rem] leading-[1.65] text-[#777]">
                You define the roles. Remotiv recruits, onboards, and manages your dedicated team
                — HR, payroll, contracts, and compliance handled silently in the background. They
                work exclusively for you, on your tools, your timezone, your culture.
              </p>

              <div
                className="flex w-full max-w-[1040px] items-stretch overflow-hidden rounded-[20px] max-md:flex-col"
                style={{ background: PURPLE }}
              >
                {HERO_STATS.map((stat, i) => (
                  <div
                    key={stat.label}
                    className={`flex-1 px-8 py-9 text-left ${
                      i < HERO_STATS.length - 1
                        ? "border-r border-white/[0.18] max-md:border-r-0 max-md:border-b max-md:border-white/[0.18]"
                        : ""
                    }`}
                  >
                    <div className="mb-3.5 font-[Sora,sans-serif] text-[38px] font-extrabold leading-none tracking-[-1px] text-white max-md:text-[28px]">
                      {stat.num}
                      <em className="not-italic" style={{ color: LIME }}>
                        {stat.em}
                      </em>
                    </div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white/65">
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="box-border w-full bg-white px-14 pt-12 pb-10 max-md:px-6 max-md:py-14">
          <div className="mx-auto max-w-[1100px]">
            <span
              className="mb-4 block text-center text-[0.72rem] font-bold uppercase tracking-[0.14em]"
              style={{ color: PURPLE_LIGHT }}
            >
              How It Works
            </span>
            <h2
              className="m-0 mb-5 text-center font-[Sora,sans-serif] font-extrabold leading-[1.1] tracking-[-0.03em] text-[#111]"
              style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)" }}
            >
              A Full Team That Works Only for You
            </h2>
            <p className="mx-auto mb-14 max-w-[640px] text-center text-base leading-[1.7] text-[#777]">
              A dedicated team is a group of full-time remote professionals recruited and employed
              exclusively for your company. They join your Slack, attend your standups, commit to
              your repo, and report to you. From the outside, they are indistinguishable from your
              in-house team.
            </p>
            <div
              className="grid grid-cols-3 gap-0 rounded-3xl p-10 max-md:grid-cols-1 max-md:p-6"
              style={{ background: PURPLE_LIGHT }}
            >
              {HOW_IT_WORKS.map((card, i) => (
                <div
                  key={card.em}
                  className={`relative flex flex-col gap-3 px-10 py-8 max-md:px-4 max-md:py-7 ${
                    i < HOW_IT_WORKS.length - 1
                      ? "max-md:border-b max-md:border-white/20 md:after:absolute md:after:top-[20%] md:after:right-0 md:after:h-[60%] md:after:w-px md:after:bg-white/25 md:after:content-['']"
                      : ""
                  }`}
                >
                  <div className="mb-1 font-[Sora,sans-serif] text-[1.05rem] font-bold text-white">
                    <em className="not-italic" style={{ color: LIME }}>
                      {card.em}
                    </em>
                  </div>
                  <div className="h-px w-full bg-white/20" />
                  <p className="text-[0.88rem] leading-[1.75] text-white/80">{card.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* WHY REMOTIV */}
        <section className="box-border w-full bg-white px-14 py-12 max-md:px-6 max-md:py-14">
          <div className="mx-auto max-w-[1100px]">
            <span
              className="mb-4 block text-center text-[0.72rem] font-bold uppercase tracking-[0.14em]"
              style={{ color: PURPLE_LIGHT }}
            >
              Why Remotiv
            </span>
            <h2
              className="m-0 mb-12 text-center font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
              style={{ fontSize: "clamp(1.75rem, 3vw, 2.4rem)" }}
            >
              What Separates Us from Every Other Option
            </h2>

            <div className="flex flex-col gap-3.5 md:hidden">
              {[...WHY_REMOTIV_TOP, ...WHY_REMOTIV_BOTTOM].map((card, i) => (
                <WhyCard key={card.heading} {...card} index={i} />
              ))}
            </div>

            <div className="hidden md:block">
              <div className="mb-3.5 grid grid-cols-2 gap-3.5">
                {WHY_REMOTIV_TOP.map((card) => (
                  <WhyCard key={card.badge} {...card} index={-1} />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-3.5">
                {WHY_REMOTIV_BOTTOM.map((card) => (
                  <WhyCard key={card.badge} {...card} index={-1} />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* OUR PROCESS */}
        <section className="box-border w-full bg-white px-14 py-12 max-md:px-6 max-md:pt-14 max-md:pb-18">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-16 text-center">
              <span
                className="mb-4 block text-[0.72rem] font-bold uppercase tracking-[0.14em]"
                style={{ color: PURPLE_LIGHT }}
              >
                Our Process
              </span>
              <h2
                className="m-0 mb-4 font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
                style={{ fontSize: "clamp(1.75rem, 3vw, 2.4rem)" }}
              >
                From Brief to Fully Operational in 2 Weeks
              </h2>
              <p className="mx-auto max-w-[580px] text-base leading-[1.7] text-[#777]">
                We&apos;ve built a process that gets your dedicated team recruited, onboarded, and
                productive faster than any other provider in the market.
              </p>
            </div>

            <div className="hidden md:flex md:flex-col md:gap-0">
              {PROCESS_STEPS.map((step, i) => {
                const isEven = i % 2 === 1;
                const isFirst = i === 0;
                const isLast = i === PROCESS_STEPS.length - 1;
                return (
                  <div
                    key={step.n}
                    className="grid min-h-[180px] grid-cols-[1fr_56px_1fr] items-stretch"
                  >
                    {isEven ? <div /> : <ProcessCard step={step} />}
                    <div className="relative flex flex-col items-center">
                      <div
                        className="w-[1.5px] flex-1"
                        style={{ background: isFirst ? "transparent" : "rgba(152,134,254,0.25)" }}
                      />
                      <div
                        className="z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-[Sora,sans-serif] text-[0.9rem] font-extrabold text-white"
                        style={{
                          background: PURPLE,
                          boxShadow: "0 0 0 6px rgba(152,134,254,0.15)",
                        }}
                      >
                        {step.n}
                      </div>
                      <div
                        className="w-[1.5px] flex-1"
                        style={{ background: isLast ? "transparent" : "rgba(152,134,254,0.25)" }}
                      />
                    </div>
                    {isEven ? <ProcessCard step={step} /> : <div />}
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-[44px_1fr] gap-x-4 md:hidden">
              {PROCESS_STEPS.map((step, i) => (
                <Fragment key={step.n}>
                  <div className="flex flex-col items-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-remotiv-purple text-base font-bold text-white">
                      {i + 1}
                    </div>
                    {i < PROCESS_STEPS.length - 1 && (
                      <div className="my-2 w-[1.5px] flex-1 bg-[#111]/15" />
                    )}
                  </div>
                  <div className="pb-8">
                    <ProcessCard step={step} />
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        </section>

        {/* THE ADVANTAGE */}
        <section className="box-border w-full bg-white px-10 py-12 max-md:px-6 max-md:py-16">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-14">
              <span
                className="mb-3.5 block text-[0.72rem] font-bold uppercase tracking-[0.14em]"
                style={{ color: PURPLE_LIGHT }}
              >
                The Advantage
              </span>
              <h2
                className="m-0 font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
                style={{ fontSize: "clamp(1.75rem, 3vw, 2.4rem)" }}
              >
                What Changes When You Build with Remotiv
              </h2>
            </div>

            {ADVANTAGE_ROWS.map((row, i) => (
              <div
                key={row.label}
                className={`grid grid-cols-[220px_1fr] items-start gap-10 border-t border-black/[0.08] py-10 max-md:grid-cols-1 max-md:gap-6 ${
                  i === ADVANTAGE_ROWS.length - 1 ? "border-b" : ""
                }`}
              >
                <h3 className="m-0 pr-1 font-[Sora,sans-serif] text-base font-bold leading-[1.3] text-[#111]">
                  {row.label}
                </h3>
                <div className="grid grid-cols-3 gap-8 max-md:grid-cols-2 max-md:gap-6 max-[560px]:grid-cols-1">
                  {row.cols.map((col) => (
                    <div
                      key={col.heading}
                      className="grid grid-cols-[26px_1fr] gap-x-2.5 gap-y-2.5"
                    >
                      <AdvantageIconSvg
                        icon={col.icon}
                        color={row.color === "purple" ? PURPLE : PURPLE_LIGHT}
                      />
                      <h4 className="col-start-2 row-start-1 m-0 self-center font-[Sora,sans-serif] text-[0.92rem] font-bold text-[#111]">
                        {col.heading}
                      </h4>
                      <p className="col-span-2 row-start-2 m-0 text-[0.85rem] leading-[1.72] text-[#555]">
                        {col.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* COST COMPARISON */}
        <section className="box-border w-full bg-white px-10 py-12 max-md:px-5 max-md:py-16">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-14 text-center">
              <span
                className="mb-4 block text-[0.72rem] font-bold uppercase tracking-[0.14em]"
                style={{ color: PURPLE_LIGHT }}
              >
                The Numbers
              </span>
              <h2
                className="m-0 mb-4 font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
                style={{ fontSize: "clamp(1.75rem, 3vw, 2.4rem)" }}
              >
                What a 5-Person Team Actually Costs
              </h2>
              <p className="mx-auto max-w-[540px] text-base leading-[1.7] text-[#777]">
                Same quality. Same timezone overlap. Same standup culture. The only difference is
                the number on the invoice.
              </p>
            </div>

            <div
              className="overflow-hidden rounded-[28px] bg-[#111]"
              style={{ boxShadow: "0 24px 80px rgba(0,0,0,0.18)" }}
            >
              <div className="grid grid-cols-[1.8fr_1fr_1fr_1fr] bg-[#111] px-10 max-md:grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr] max-md:px-5 max-[600px]:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr] max-[600px]:gap-x-2 max-[600px]:px-2.5">
                <div className="pt-7 pb-5 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-white/40 max-[600px]:pt-4 max-[600px]:pb-3 max-[600px]:text-[0.58rem] max-[600px]:tracking-[0.06em]">
                  Role
                </div>
                <div className="pt-7 pb-5 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-white/40 max-[600px]:pt-4 max-[600px]:pb-3 max-[600px]:text-[0.58rem] max-[600px]:tracking-[0.06em]">
                  US Market
                </div>
                <div
                  className="pt-7 pb-5 text-[0.68rem] font-bold uppercase tracking-[0.14em] max-[600px]:pt-4 max-[600px]:pb-3 max-[600px]:text-[0.58rem] max-[600px]:tracking-[0.06em]"
                  style={{ color: LIME }}
                >
                  Via Remotiv
                </div>
                <div
                  className="pt-7 pb-5 text-[0.68rem] font-bold uppercase tracking-[0.14em] max-[600px]:pt-4 max-[600px]:pb-3 max-[600px]:text-[0.58rem] max-[600px]:tracking-[0.06em]"
                  style={{ color: GREEN }}
                >
                  You Save
                </div>
              </div>

              <div className="flex flex-col">
                {COST_ROWS.map((row) => (
                  <CostRow key={row.role} {...row} />
                ))}
                <div
                  className="grid grid-cols-[1.8fr_1fr_1fr_1fr] px-10 transition-colors hover:bg-white/[0.04] max-md:grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr] max-md:px-5 max-[600px]:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr] max-[600px]:gap-x-2 max-[600px]:px-2.5"
                  style={{ background: PURPLE }}
                >
                  <div className="flex items-center py-5.5 max-[600px]:py-3.5">
                    <span className="font-[Sora,sans-serif] text-base font-extrabold text-white max-[600px]:text-[0.78rem]">
                      5-Person Team Total
                    </span>
                  </div>
                  <div className="flex items-center py-5.5 max-[600px]:py-3.5">
                    <span
                      className="font-[Sora,sans-serif] text-base font-semibold line-through max-[600px]:text-[0.7rem] max-[600px]:no-underline"
                      style={{ color: "rgba(255,255,255,0.5)" }}
                    >
                      $460,000/yr
                    </span>
                  </div>
                  <div className="flex items-center py-5.5 max-[600px]:py-3.5">
                    <span className="font-[Sora,sans-serif] text-base font-extrabold text-white max-[600px]:text-[0.7rem]">
                      $189,000/yr
                    </span>
                  </div>
                  <div className="flex items-center py-5.5 max-[600px]:py-3.5">
                    <span
                      className="inline-flex items-center gap-1.5 font-[Sora,sans-serif] text-base font-extrabold max-[600px]:text-[0.7rem]"
                      style={{ color: LIME }}
                    >
                      <span className="text-[0.7rem] opacity-70">↓</span>$271,000
                    </span>
                  </div>
                </div>
              </div>

              <div
                className="flex flex-wrap items-center justify-between gap-6 px-10 py-8 max-md:px-5 max-md:py-6"
                style={{
                  background: `linear-gradient(135deg, ${GREEN} 0%, ${PURPLE_LIGHT} 100%)`,
                }}
              >
                <div className="flex flex-col gap-1">
                  <span className="text-[0.72rem] font-bold uppercase tracking-[0.12em] text-white/75">
                    Annual savings on a 5-person team
                  </span>
                  <span
                    className="font-[Sora,sans-serif] font-extrabold leading-none tracking-[-0.03em] text-white"
                    style={{ fontSize: "clamp(2rem, 4vw, 3rem)" }}
                  >
                    $<em className="not-italic text-[#111]">271,000</em>
                  </span>
                </div>
                <p className="max-w-[340px] text-[0.88rem] leading-[1.6] text-white/85">
                  That&apos;s $271K back into product, marketing, or runway. Every year. Without
                  reducing headcount or compromising output.
                </p>
              </div>
            </div>

            <p className="mt-5 text-center text-[0.75rem] leading-[1.65] text-[#aaa]">
              * Remotiv rates are estimates based on mid-to-senior level Pakistani talent. Actual
              rates vary by role, experience, and team composition. All figures in USD annually.
            </p>
          </div>
        </section>

        {/* WHY NOT DIY */}
        <section className="box-border w-full bg-white px-10 py-12 max-md:px-5 max-md:py-16">
          <div className="mx-auto max-w-[900px]">
            <div className="mb-14 text-center">
              <span
                className="mb-4 block text-[0.72rem] font-bold uppercase tracking-[0.14em]"
                style={{ color: PURPLE_LIGHT }}
              >
                Why Not DIY?
              </span>
              <h2
                className="m-0 mb-4 font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
                style={{ fontSize: "clamp(1.75rem, 3vw, 2.4rem)" }}
              >
                Remotiv vs Hiring in Pakistan Yourself
              </h2>
              <p className="mx-auto max-w-[600px] text-base leading-[1.7] text-[#777]">
                Setting up your own offshore team sounds simple — until you factor in legal entity
                registration, Pakistani employment law, local HR management, and cross-border
                payroll. Here&apos;s the real comparison.
              </p>
            </div>

            <div
              className="w-full overflow-hidden rounded-3xl border border-black/[0.08]"
              style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.07)" }}
            >
              <div className="grid grid-cols-[1.4fr_1fr_1fr] bg-[#111] max-[720px]:grid-cols-2">
                <div className="px-7 py-5.5 font-[Sora,sans-serif] text-[0.72rem] font-bold uppercase tracking-[0.12em] text-white/40 max-[720px]:hidden" />
                <div
                  className="flex items-center gap-2.5 rounded-tr-xl px-7 py-5.5 font-[Sora,sans-serif] text-[0.72rem] font-bold uppercase tracking-[0.12em] text-white max-[720px]:rounded-tl-xl max-[720px]:rounded-tr-none"
                  style={{ background: PURPLE }}
                >
                  <span>Remotiv</span>
                  <span
                    className="rounded px-2 py-0.5 text-[0.6rem] font-extrabold uppercase tracking-[0.06em] text-[#111]"
                    style={{ background: LIME }}
                  >
                    Recommended
                  </span>
                </div>
                <div className="px-7 py-5.5 font-[Sora,sans-serif] text-[0.72rem] font-bold uppercase tracking-[0.12em] text-white/40">
                  DIY Offshore
                </div>
              </div>

              <div className="flex flex-col">
                {DIY_ROWS.map((row, i) => (
                  <div
                    key={row.label}
                    className={`grid grid-cols-[1.4fr_1fr_1fr] transition-colors max-[720px]:grid-cols-2 ${
                      i > 0 ? "border-t border-black/[0.06]" : ""
                    } ${row.both ? "" : "hover:bg-[#faf8ff]"}`}
                    style={row.both ? { background: "rgba(73,215,167,0.04)" } : undefined}
                  >
                    <div className="flex items-center gap-2.5 px-7 py-5 max-[720px]:col-span-2 max-[720px]:border-b max-[720px]:border-black/[0.05] max-[720px]:pb-2 max-[720px]:font-semibold max-[720px]:text-[0.95rem]">
                      <span className="font-[Sora,sans-serif] text-[0.88rem] font-semibold text-[#111]">
                        {row.label}
                      </span>
                    </div>
                    <div
                      className="flex items-center gap-2.5 border-x-2 px-7 py-5"
                      style={{
                        background: row.both
                          ? "rgba(73,215,167,0.08)"
                          : "rgba(126,71,255,0.04)",
                        borderColor: "rgba(126,71,255,0.15)",
                      }}
                    >
                      <CheckBadge />
                      <span className="text-[0.85rem] font-medium leading-[1.4] text-[#333]">
                        {row.remotiv}
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 px-7 py-5">
                      {row.both ? <CheckBadge /> : <CrossBadge />}
                      <span
                        className={`text-[0.85rem] leading-[1.4] ${
                          row.both ? "font-medium text-[#333]" : "font-normal text-[#999]"
                        }`}
                      >
                        {row.diy}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div
                className="flex flex-wrap items-center justify-between gap-5 px-8 py-7"
                style={{ background: `linear-gradient(135deg, ${PURPLE} 0%, ${PURPLE_LIGHT} 100%)` }}
              >
                <div>
                  <div className="font-[Sora,sans-serif] text-base font-bold text-white">
                    Ready to skip the complexity?
                  </div>
                  <div className="mt-1 text-[0.82rem] text-white/75">
                    Your team ready in 2 weeks. Zero legal overhead. Zero setup cost.
                  </div>
                </div>
                <Link
                  href="/book-a-meeting"
                  className="shrink-0 whitespace-nowrap rounded-[10px] px-6 py-3 font-[Sora,sans-serif] text-[0.82rem] font-bold text-[#111] transition-transform hover:-translate-y-0.5"
                  style={{ background: LIME }}
                >
                  Book a Free Call →
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* WHAT WE BUILD */}
        <section className="box-border w-full px-14 pt-16 pb-20 max-md:px-6 max-md:pt-12 max-md:pb-16" style={{ background: PURPLE_LIGHT }}>
          <div className="mx-auto max-w-[1100px]">
            <span className="mb-3.5 block text-[0.72rem] font-bold uppercase tracking-[0.16em] text-white/65">
              What We Build
            </span>
            <h2
              className="m-0 mb-3.5 max-w-[680px] font-[Sora,sans-serif] font-bold leading-[1.2] tracking-[-0.02em] text-white"
              style={{ fontSize: "clamp(1.6rem, 2.8vw, 2.2rem)" }}
            >
              Every Function. Every Level.
            </h2>
            <p className="m-0 mb-12 max-w-[680px] text-[0.95rem] leading-[1.7] text-white/75">
              We build dedicated teams across the full spectrum of professional roles — from
              individual contributors to team leads and managers.
            </p>

            <div className="grid grid-cols-5 gap-2.5 max-[1100px]:grid-cols-4 max-[800px]:grid-cols-3 max-[560px]:grid-cols-2">
              {WHAT_WE_BUILD.map((item) => (
                <div
                  key={item.name}
                  className="flex min-h-[180px] cursor-default flex-col items-center justify-center gap-4 rounded-2xl border border-white/20 bg-white p-5 py-8 text-center transition-all hover:-translate-y-0.5 hover:border-[#7E47FF] hover:bg-[#f9f8ff]"
                >
                  <div className="flex h-7 w-7 items-center justify-center opacity-85">
                    <svg viewBox="0 0 24 24" className="h-7 w-7 fill-[#111]" aria-hidden="true">
                      <path d={item.iconPath} />
                    </svg>
                  </div>
                  <div>
                    <div className="font-[Sora,sans-serif] text-[0.88rem] font-bold leading-[1.3] text-[#111]">
                      {item.name}
                    </div>
                    <div className="text-[0.75rem] leading-[1.5] text-[#555]">{item.tags}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA INQUIRY */}
        <section className="bg-white px-10 py-12 max-md:px-5">
          <div
            className="mx-auto grid max-w-[900px] grid-cols-2 items-center gap-14 rounded-3xl p-14 max-[900px]:grid-cols-1 max-[900px]:gap-8 max-[900px]:p-7"
            style={{ background: LIME }}
          >
            <div>
              <div className="mb-[18px] inline-flex items-center rounded-full bg-white/45 px-3.5 py-[5px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[#111]">
                • Dedicated Teams
              </div>
              <h2
                className="m-0 mb-3 font-[Sora,sans-serif] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#111]"
                style={{ fontSize: "clamp(1.4rem, 2.2vw, 1.9rem)" }}
              >
                Your Dedicated Team is a Week Away.
              </h2>
              <p className="m-0 mb-6 text-[13px] leading-[1.75] text-[#111] opacity-75">
                Tell us the roles you need. Remotiv recruits, onboards, and manages your full
                dedicated team — HR, payroll, contracts, and compliance handled permanently in the
                background.
              </p>
              <div className="mb-7 flex flex-wrap gap-2.5">
                <Link
                  href="/book-a-meeting"
                  className="inline-flex items-center rounded-full px-6 py-3 font-[Sora,sans-serif] text-[0.82rem] font-bold text-white transition-opacity hover:opacity-90"
                  style={{ background: PURPLE }}
                >
                  Build Your Dedicated Team →
                </Link>
                <a
                  href="https://calendly.com/waleed-izww/intro-call"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-full border-[1.5px] border-[#111] bg-transparent px-6 py-[11px] text-[0.82rem] font-semibold text-[#111] transition-colors hover:bg-[#111] hover:text-white"
                >
                  Book a 30-Min Call
                </a>
              </div>
              <ul className="m-0 mb-7 flex list-none flex-col gap-2.5 p-0">
                {[
                  "Team recruited and operational within 2 weeks",
                  "Free replacement guarantee on every placement",
                  "HR, payroll & compliance handled entirely by Remotiv",
                ].map((item) => (
                  <li
                    key={item}
                    className="flex items-center gap-2 text-[13px] font-medium text-[#111]"
                  >
                    <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/50">
                      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path
                          d="M2 6l3 3 5-5"
                          stroke="#111"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <div className="flex">
                  {[
                    { bg: "#7E47FF", color: "#ffffff", label: "JC" },
                    { bg: "#111111", color: "#c9ff85", label: "SM" },
                    { bg: "#49D7A7", color: "#111111", label: "OF" },
                  ].map((av) => (
                    <div
                      key={av.label}
                      className="-mr-[7px] flex h-7 w-7 items-center justify-center rounded-full border-2 text-[9px] font-bold"
                      style={{ background: av.bg, color: av.color, borderColor: LIME }}
                    >
                      {av.label}
                    </div>
                  ))}
                </div>
                <span className="ml-3 text-xs text-[#111] opacity-65">
                  Trusted by 100+ companies worldwide
                </span>
              </div>
            </div>

            <InquiryForm />
          </div>
        </section>

        {/* FAQ */}
        <section className="box-border w-full border-t border-black/[0.06] bg-white px-10 pt-10 pb-20 max-md:px-6 max-md:pt-14 max-md:pb-18">
          <div className="mx-auto flex max-w-[1100px] flex-row items-start gap-20 max-[900px]:flex-col max-[900px]:gap-10">
            <div className="box-border max-w-[35%] flex-[0_0_35%] max-[900px]:max-w-full max-[900px]:flex-auto">
              <h2
                className="m-0 mb-5 font-[Sora,sans-serif] font-extrabold leading-[1.15] text-[#111]"
                style={{ fontSize: "clamp(1.8rem, 3vw, 2.6rem)" }}
              >
                Questions We Hear Most
              </h2>
              <p className="m-0 text-[0.95rem] leading-[1.7] text-[#777]">
                For any unanswered questions, reach out to our team. We&apos;ll respond as soon as
                possible.
              </p>
            </div>

            <div className="box-border max-w-[58%] flex-[0_0_58%] max-[900px]:max-w-full max-[900px]:flex-auto">
              <div className="border-t border-black/10">
                {FAQS.map((faq, i) => {
                  const isOpen = openFaq === i;
                  return (
                    <div key={faq.q} className="border-b border-black/10">
                      <button
                        type="button"
                        onClick={() => setOpenFaq(isOpen ? -1 : i)}
                        className="flex w-full cursor-pointer items-center justify-between gap-4 border-none bg-transparent py-6 text-left"
                      >
                        <span className="flex-1 font-[Sora,sans-serif] text-[0.97rem] font-semibold leading-[1.4] text-[#111]">
                          {faq.q}
                        </span>
                        <span className="w-6 shrink-0 text-center text-[1.4rem] font-light leading-none text-[#111]">
                          {isOpen ? "−" : "+"}
                        </span>
                      </button>
                      <div
                        className="overflow-hidden transition-[max-height] duration-300"
                        style={{ maxHeight: isOpen ? 400 : 0 }}
                      >
                        <p className="m-0 pb-6 text-[0.9rem] leading-[1.75] text-[#444]">
                          {faq.a}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function WhyCard({
  badge,
  heading,
  body,
  index,
}: {
  badge: string;
  heading: string;
  body: string;
  index: number;
}) {
  const isSticky = index >= 0;
  return (
    <div
      className={`group relative flex cursor-default flex-col rounded-[20px] border border-black/[0.08] bg-white px-8 pt-9 pb-10 transition-all hover:border-[#7E47FF] hover:bg-[#7E47FF]${
        isSticky ? " sticky [top:var(--card-top)]" : ""
      }`}
      style={
        isSticky
          ? ({
              boxShadow: "0 2px 12px rgba(0,0,0,0.05)",
              "--card-top": `${(index + 1) * 12}px`,
              zIndex: index + 1,
            } as CSSPropertiesWithVars)
          : { boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }
      }
    >
      <span
        className="mb-5 inline-block self-start rounded-md border px-3 py-1 font-[Sora,sans-serif] text-[0.68rem] font-bold tracking-[0.06em] transition-colors group-hover:border-white/25"
        style={{
          background: "rgba(152,134,254,0.12)",
          color: PURPLE,
          borderColor: "rgba(152,134,254,0.25)",
        }}
      >
        <span className="group-hover:hidden">{badge}</span>
        <span className="hidden group-hover:inline" style={{ color: LIME }}>
          {badge}
        </span>
      </span>
      <h3 className="m-0 mb-4 font-[Sora,sans-serif] text-[1.1rem] font-bold leading-[1.3] text-[#111] transition-colors group-hover:text-white">
        {heading}
      </h3>
      <div className="mb-4 h-px w-full bg-black/[0.07] transition-colors group-hover:bg-white/20" />
      <p className="m-0 text-[0.86rem] leading-[1.75] text-[#555] transition-colors group-hover:text-white/80">
        {body}
      </p>
    </div>
  );
}

function ProcessCard({
  step,
}: {
  step: { n: number; tag: string; heading: string; body: string };
}) {
  return (
    <div
      className="my-3 rounded-[20px] border border-black/[0.08] bg-white px-9 py-8 transition-all hover:-translate-y-0.5 hover:border-[rgba(152,134,254,0.4)]"
      style={{ boxShadow: "0 2px 16px rgba(0,0,0,0.05)" }}
    >
      <div
        className="mb-3 inline-flex items-center gap-1.5 font-[Sora,sans-serif] text-[0.68rem] font-bold uppercase tracking-[0.08em]"
        style={{ color: PURPLE_LIGHT }}
      >
        <span
          className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ background: PURPLE_LIGHT }}
        />
        {step.tag}
      </div>
      <h3 className="m-0 mb-3.5 font-[Sora,sans-serif] text-[1.05rem] font-bold leading-[1.3] text-[#111]">
        {step.heading}
      </h3>
      <div
        className="mb-3.5 h-0.5 w-10 rounded-sm opacity-40"
        style={{ background: PURPLE_LIGHT }}
      />
      <p className="m-0 text-[0.88rem] leading-[1.78] text-[#555]">{step.body}</p>
    </div>
  );
}

function CostRow({
  role,
  badgeLabel,
  badgeBg,
  badgeColor,
  us,
  remotiv,
  savings,
}: {
  role: string;
  badgeLabel: string;
  badgeBg: string;
  badgeColor: string;
  us: string;
  remotiv: string;
  savings: string;
}) {
  return (
    <div className="grid grid-cols-[1.8fr_1fr_1fr_1fr] border-t border-white/[0.06] px-10 transition-colors hover:bg-white/[0.04] max-md:grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr] max-md:px-5 max-[600px]:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr] max-[600px]:gap-x-2 max-[600px]:px-2.5">
      <div className="flex items-center py-5.5 max-[600px]:py-3">
        <span className="font-[Sora,sans-serif] text-[0.92rem] font-semibold text-white max-[600px]:text-[0.7rem] max-[600px]:leading-tight">
          {role}
        </span>
        <span
          className="ml-2.5 inline-block rounded px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.06em] max-md:hidden max-[600px]:hidden"
          style={{ background: badgeBg, color: badgeColor }}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="flex items-center py-5.5 max-[600px]:py-3">
        <span
          className="font-[Sora,sans-serif] text-[0.92rem] font-semibold line-through max-[600px]:text-[0.7rem] max-[600px]:no-underline"
          style={{ color: "rgba(255,255,255,0.45)", textDecorationColor: "rgba(255,255,255,0.2)" }}
        >
          {us}
        </span>
      </div>
      <div className="flex items-center py-5.5 max-[600px]:py-3">
        <span
          className="font-[Sora,sans-serif] text-[0.92rem] font-bold max-[600px]:text-[0.7rem]"
          style={{ color: LIME }}
        >
          {remotiv}
        </span>
      </div>
      <div className="flex items-center py-5.5 max-[600px]:py-3">
        <span
          className="inline-flex items-center gap-1.5 font-[Sora,sans-serif] text-[0.88rem] font-bold max-[600px]:text-[0.72rem] max-[600px]:font-bold"
          style={{ color: GREEN }}
        >
          <span className="text-[0.7rem] opacity-70">↓</span>
          {savings}
        </span>
      </div>
    </div>
  );
}

function CheckBadge() {
  return (
    <div
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-extrabold"
      style={{
        background: "rgba(73,215,167,0.15)",
        border: "1.5px solid rgba(73,215,167,0.4)",
        color: GREEN,
      }}
    >
      ✓
    </div>
  );
}

function CrossBadge() {
  return (
    <div
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-extrabold"
      style={{
        background: "rgba(239,68,68,0.08)",
        border: "1.5px solid rgba(239,68,68,0.2)",
        color: "#ef4444",
      }}
    >
      ✕
    </div>
  );
}

function InquiryForm() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: "", company: "", email: "", size: "", message: "" });

  const handleSubmit = () => {
    if (!form.name || !form.email) {
      alert("Please enter your name and email.");
      return;
    }
    const subject = encodeURIComponent(
      `Dedicated Team Inquiry from ${form.name}${form.company ? ` — ${form.company}` : ""}`,
    );
    const body = encodeURIComponent(
      `Name: ${form.name}\nCompany: ${form.company}\nEmail: ${form.email}\nTeam Size: ${form.size}\n\nMessage:\n${form.message}`,
    );
    window.location.href = `mailto:waleed@remotiv.work?subject=${subject}&body=${body}`;
    setSubmitted(true);
  };

  const inputClass =
    "w-full rounded-lg border-none bg-[#f5f5f5] px-3 py-[9px] text-base sm:text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef]";

  if (submitted) {
    return (
      <div className="rounded-2xl bg-white p-7">
        <div className="py-6 text-center">
          <div className="mb-3 text-4xl">✅</div>
          <h3 className="m-0 mb-2 font-[Sora,sans-serif] text-base font-bold text-[#111]">
            Inquiry Sent!
          </h3>
          <p className="m-0 text-[13px] text-[#666]">We&apos;ll get back to you within 48 hours.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-7">
      <p className="m-0 mb-4 font-[Sora,sans-serif] text-sm font-bold text-[#111]">
        Send an Inquiry
      </p>
      <div className="mb-2.5 grid grid-cols-2 gap-2.5">
        <div>
          <label
            htmlFor="dt-inq-name"
            className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]"
          >
            Full Name
          </label>
          <input
            id="dt-inq-name"
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Your name"
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor="dt-inq-company"
            className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]"
          >
            Company
          </label>
          <input
            id="dt-inq-company"
            type="text"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
            placeholder="Company name"
            className={inputClass}
          />
        </div>
      </div>
      <div className="mb-2.5">
        <label
          htmlFor="dt-inq-email"
          className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]"
        >
          Work Email
        </label>
        <input
          id="dt-inq-email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="you@company.com"
          className={inputClass}
        />
      </div>
      <div className="mb-2.5">
        <label
          htmlFor="dt-inq-size"
          className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]"
        >
          Team Size Needed
        </label>
        <select
          id="dt-inq-size"
          value={form.size}
          onChange={(e) => setForm({ ...form, size: e.target.value })}
          className={inputClass}
        >
          <option value="" disabled>
            Select team size
          </option>
          <option>1–2 people</option>
          <option>3–5 people</option>
          <option>6–10 people</option>
          <option>10+ people</option>
        </select>
      </div>
      <div className="mb-2.5">
        <label
          htmlFor="dt-inq-message"
          className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]"
        >
          Message
        </label>
        <textarea
          id="dt-inq-message"
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          placeholder="Tell us about the roles, skills needed, and timeline..."
          className={`${inputClass} min-h-[68px] resize-none`}
        />
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        className="mb-2.5 w-full cursor-pointer rounded-[10px] border-none py-3 font-[Sora,sans-serif] text-xs font-bold uppercase tracking-[0.06em] text-white transition-all hover:-translate-y-px"
        style={{ background: PURPLE }}
      >
        Send Inquiry →
      </button>
      <p className="m-0 text-center text-[10px] text-[#bbb]">
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#bbb"
          strokeWidth="2"
          className="mr-1 inline-block align-middle"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Your data is encrypted and 100% confidential
      </p>
    </div>
  );
}
