"use client";

import Link from "next/link";
import { useState } from "react";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

const BOOKING_HREF = "/book-a-meeting";
const CALL_HREF = "https://calendly.com/waleed-izww/intro-call";

type FeatureCard = {
  badge: string;
  title: string;
  description: string;
  iconBg: string;
  icon: React.ReactNode;
  visual: React.ReactNode;
};

const FEATURE_CARDS: FeatureCard[] = [
  {
    badge: "Not software",
    title: "Dedicated Payroll Manager",
    description:
      "A real dedicated Payroll Manager who knows your team, your pay structure, and picks up the phone when you call.",
    iconBg: "bg-[#49D7A7]/15",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="size-7">
        <title>Manager</title>
        <circle cx="12" cy="8" r="4" stroke="#49D7A7" strokeWidth="1.8" />
        <path
          d="M4 20c0-4 3.582-7 8-7s8 3 8 7"
          stroke="#49D7A7"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
    visual: (
      <>
        <div className="mb-3.5 flex items-center gap-3">
          <div className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-[#49D7A7]/15 font-heading text-[0.75rem] font-extrabold text-[#1d8c6b]">
            AM
          </div>
          <div>
            <div className="font-heading text-[0.82rem] font-bold text-[#111]">Ayesha Malik</div>
            <div className="mt-0.5 text-[0.72rem] text-[#888]">Your Payroll Manager</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: "Payroll", bg: "bg-[#49D7A7]/15", color: "text-[#1d8c6b]" },
            { label: "Tax Compliance", bg: "bg-[#7E47FF]/10", color: "text-[#7E47FF]" },
            { label: "EOBI / SESSI", bg: "bg-[#c9ff85]/40", color: "text-[#5a7a10]" },
          ].map((tag) => (
            <span
              key={tag.label}
              className={cn("rounded-md px-2.5 py-0.5 text-[0.68rem] font-semibold", tag.bg, tag.color)}
            >
              {tag.label}
            </span>
          ))}
        </div>
      </>
    ),
  },
  {
    badge: "Not partial",
    title: "Full-Scope Payroll",
    description:
      "Salary processing, tax filing, EOBI, SESSI, gratuity, provident fund, payslips, leave tracking — every task, every month.",
    iconBg: "bg-[#7E47FF]/10",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="size-7">
        <title>Checklist</title>
        <rect x="3" y="3" width="18" height="18" rx="3" stroke="#7E47FF" strokeWidth="1.8" />
        <path
          d="M7 12l3 3 7-7"
          stroke="#7E47FF"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    visual: (
      <div className="flex flex-col gap-2.5">
        {[
          "Salary processing & payslips",
          "EOBI, SESSI & tax filing",
          "Gratuity & provident fund",
          "Leave tracking & compliance",
        ].map((item) => (
          <div key={item} className="flex items-center gap-2.5 text-[0.78rem] font-medium text-[#333]">
            <div className="flex size-[18px] flex-shrink-0 items-center justify-center rounded-full bg-[#49D7A7]/15">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <title>Check</title>
                <path
                  d="M2 6l3 3 5-5"
                  stroke="#49D7A7"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            {item}
          </div>
        ))}
      </div>
    ),
  },
  {
    badge: "Not slow",
    title: "Live in 24–48 Hours",
    description:
      "From discovery call to first payroll run in under two days. No new contracts, no re-entering data.",
    iconBg: "bg-[#c9ff85]/40",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="size-7">
        <title>Timer</title>
        <circle cx="12" cy="12" r="9" stroke="#5a7a10" strokeWidth="1.8" />
        <path
          d="M12 7v5l3 3"
          stroke="#5a7a10"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    visual: (
      <div className="flex flex-col">
        {[
          { label: "Discovery call", time: "Hour 0", dot: "#49D7A7" },
          { label: "Team data collected", time: "Hour 4", dot: "#49D7A7" },
          { label: "Payroll configured", time: "Hour 12", dot: "#49D7A7" },
          { label: "First payroll run ✓", time: "48 hrs", dot: "#c9ff85", bold: true },
        ].map((row, idx, arr) => (
          <div
            key={row.label}
            className={cn(
              "flex items-center gap-2.5 py-2",
              idx !== arr.length - 1 && "border-b border-black/5",
            )}
          >
            <div className="size-2 flex-shrink-0 rounded-full" style={{ background: row.dot }} />
            <span
              className={cn(
                "flex-1 text-[0.75rem] font-medium text-[#444]",
                row.bold && "font-bold text-[#111]",
              )}
            >
              {row.label}
            </span>
            <span className="font-heading text-[0.68rem] font-bold text-[#49D7A7]">{row.time}</span>
          </div>
        ))}
      </div>
    ),
  },
];

type ScopeCard = {
  title: string;
  description: string;
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
};

const SCOPE_CARDS: ScopeCard[] = [
  {
    title: "Salary Processing & Disbursement",
    description:
      "Full monthly payroll — base salaries, overtime, bonuses, increments — transferred directly to employee bank accounts on payday. Automated calculation, direct bank transfers, multi-currency support.",
    iconBg: "bg-[#49D7A7]/15",
    iconColor: "#49D7A7",
    icon: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M3 10h18" stroke="currentColor" strokeWidth="1.7" />
        <path d="M7 15h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Income Tax Deduction & Filing",
    description:
      "Monthly withholding tax calculated and deducted correctly. Annual income tax returns filed with FBR on your behalf. Employee tax certificates issued. Fully compliant with Pakistan tax law.",
    iconBg: "bg-[#7E47FF]/10",
    iconColor: "#7E47FF",
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "EOBI, SESSI & Social Security",
    description:
      "All mandatory statutory contributions calculated, deducted, and remitted on time. EOBI monthly contributions, SESSI/PESSI deductions, province-specific compliance — all managed with full digital records.",
    iconBg: "bg-[#c9ff85]/50",
    iconColor: "#5a7a10",
    icon: (
      <>
        <path
          d="M12 3l9 5v5c0 4.5-3.5 8.5-9 10-5.5-1.5-9-5.5-9-10V8l9-5z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M9 12l2 2 4-4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  {
    title: "Gratuity & Provident Fund",
    description:
      "End-of-service gratuity and provident fund tracked month by month. Individual employee benefit statements and accurate fund ledgers maintained.",
    iconBg: "bg-[#49D7A7]/15",
    iconColor: "#49D7A7",
    icon: (
      <path
        d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    title: "Payslip Generation & Delivery",
    description:
      "Every employee receives a clean, detailed digital payslip on payday — automatically, every month. Full earnings and deductions breakdown, accessible anytime.",
    iconBg: "bg-[#9886fe]/15",
    iconColor: "#9886fe",
    icon: (
      <>
        <path
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M14 2v6h6M9 13h6M9 17h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Leave, Attendance & Absence",
    description:
      "Leave and attendance feed directly into payroll. Casual, sick, unpaid absences, and overtime all reflected automatically. Leave balance reports on demand.",
    iconBg: "bg-[#49D7A7]/15",
    iconColor: "#49D7A7",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M16 2v4M8 2v4M3 10h18"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    title: "International & Remote Payroll (EOR)",
    description:
      "Remotiv acts as Employer of Record — employing your team legally in Pakistan, paying in PKR while you invoice in USD or GBP. No Pakistani company or bank account required.",
    iconBg: "bg-[#7E47FF]/10",
    iconColor: "#7E47FF",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M2 12h4M18 12h4M12 2v4M12 18v4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path d="M8 12a4 4 0 0 1 8 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Compliance & HR Documentation",
    description:
      "Employment contracts, offer letters, HR policies, onboarding and offboarding documentation — kept clean and legally sound. Labour law and SECP compliance handled.",
    iconBg: "bg-[#c9ff85]/50",
    iconColor: "#5a7a10",
    icon: (
      <>
        <path
          d="M9 11l3 3L22 4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
];

const PROCESS_STEPS = [
  {
    label: "Discovery Call (30 Minutes)",
    body: "We start with a short call to understand your team size, pay cycle, salary structure, and current payroll setup. We assign your dedicated Payroll Manager on this call.",
  },
  {
    label: "We Configure Everything (Same Day)",
    body: "Your Payroll Manager configures salary grades, tax rates, EOBI contributions, leave policies, and pay schedule. We import employee records — names, salaries, bank accounts, tax info. If you hired through Remotiv, this step takes minutes. You don't touch a single setting.",
  },
  {
    label: "First Payroll Run (Day 2)",
    body: "We process your first payroll and send a complete pre-disbursement summary for your review. You approve — we transfer salaries. You see exactly what went where and why.",
  },
  {
    label: "Autopilot (Every Month, Ongoing)",
    body: "Every month, payroll runs automatically — accounting for salary changes, new hires, leavers, and adjustments. Employees get payslips. You get a summary report. Every statutory filing is submitted on time by your Payroll Manager. Records are audit-ready.",
  },
];

const PROCESS_STATS = [
  { num: "30 min", label: "Discovery call" },
  { num: "Same day", label: "Setup complete" },
  { num: "48 hrs", label: "First payroll run" },
  { num: "Zero", label: "Setup fee" },
];

const PROCESS_BARS = [
  { step: 1, width: "100%", color: "#49D7A7", label: "30 min" },
  { step: 2, width: "80%", color: "#c9ff85", label: "Same day" },
  { step: 3, width: "55%", color: "#9886fe", label: "Day 2" },
  { step: 4, width: "35%", color: "#7E47FF", label: "Ongoing" },
];

const WHO_WE_SERVE = [
  {
    title: "US Companies Hiring Remotely in Pakistan",
    body: "You've built a remote team in Pakistan. Now you need someone to pay them correctly and keep things legally clean — without setting up a local entity or learning Pakistani tax law. Remotiv acts as Employer of Record — no local company needed. USD to PKR disbursement. Full Pakistan labour law compliance. One monthly USD invoice to you.",
  },
  {
    title: "UK & Europe Companies",
    body: "Your Pakistani team delivers great work. Managing their payroll shouldn't require a new hire in your HR department. Remotiv handles everything locally — GBP/EUR to PKR payroll management, local compliance, timezone-aware communication. Works alongside your existing HR team.",
  },
  {
    title: "Pakistani Startups & SMEs",
    body: "You're building something great — payroll spreadsheets and EOBI filings shouldn't slow you down. Remotiv gives you enterprise-grade payroll without hiring an in-house payroll team. Full payroll for 2–500+ employees. EOBI, SESSI, income tax, gratuity — all managed. Digital payslips delivered to employees.",
  },
  {
    title: "Multinational & Enterprise Clients",
    body: "Operating a Pakistan office as part of a global footprint? We serve enterprise clients with high-volume, compliance-heavy payroll — accurate, auditable, and managed by a dedicated team. 50–2,000+ employees. Full audit trail and compliance reports. Dedicated enterprise Payroll Manager.",
  },
];

type AdvantageCol = { heading: string; body: string; icon: React.ReactNode };
type AdvantageRow = { label: string; cols: AdvantageCol[] };

const ADVANTAGE_ROWS: AdvantageRow[] = [
  {
    label: "Perfect Every Month",
    cols: [
      {
        heading: "Zero Errors",
        body: "Automated calculation eliminates manual mistakes. No miscalculated deductions, no corrections.",
        icon: (
          <>
            <rect x="4" y="6" width="28" height="24" rx="4" stroke="#49D7A7" strokeWidth="1.8" />
            <path
              d="M10 18l5 5 11-10"
              stroke="#49D7A7"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ),
      },
      {
        heading: "Always On Time",
        body: "Salaries hit bank accounts on payday, every month, without exception.",
        icon: (
          <>
            <circle cx="18" cy="18" r="12" stroke="#49D7A7" strokeWidth="1.8" />
            <path
              d="M18 12v6l4 4"
              stroke="#49D7A7"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ),
      },
      {
        heading: "Audit-Ready Records",
        body: "Every calculation, approval, and disbursement logged with timestamps. Always ready for audit.",
        icon: (
          <>
            <rect x="7" y="4" width="22" height="28" rx="3" stroke="#49D7A7" strokeWidth="1.8" />
            <path d="M12 13h12M12 18h12M12 23h7" stroke="#49D7A7" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ),
      },
    ],
  },
  {
    label: "Fully Compliant",
    cols: [
      {
        heading: "Tax Filing Handled",
        body: "Monthly withholding tax and annual FBR returns filed on your behalf. No missed deadlines.",
        icon: (
          <>
            <path
              d="M18 6l10 4v8c0 6-4.5 10.5-10 12C12.5 28.5 8 24 8 18v-8l10-4z"
              stroke="#7E47FF"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M13 18l3 3 7-7"
              stroke="#7E47FF"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ),
      },
      {
        heading: "EOBI & Social Security",
        body: "All statutory contributions calculated, deducted, and remitted on time across all provinces.",
        icon: (
          <>
            <circle cx="18" cy="18" r="12" stroke="#7E47FF" strokeWidth="1.8" />
            <path
              d="M6 18h24M18 6c-3 4-4.5 8-4.5 12s1.5 8 4.5 12M18 6c3 4 4.5 8 4.5 12s-1.5 8-4.5 12"
              stroke="#7E47FF"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </>
        ),
      },
      {
        heading: "Province-Specific",
        body: "Punjab, Sindh, KPK, Balochistan — each province's rules handled correctly. Not a one-size-fits-all approach.",
        icon: (
          <>
            <rect x="4" y="14" width="6" height="14" rx="2" stroke="#7E47FF" strokeWidth="1.8" />
            <rect x="15" y="8" width="6" height="20" rx="2" stroke="#7E47FF" strokeWidth="1.8" />
            <rect x="26" y="18" width="6" height="10" rx="2" stroke="#7E47FF" strokeWidth="1.8" />
          </>
        ),
      },
    ],
  },
  {
    label: "One Partner for Everything",
    cols: [
      {
        heading: "Hire & Pay Together",
        body: "Already a Remotiv recruitment client? Add payroll in one conversation. Zero re-entry.",
        icon: (
          <>
            <path
              d="M18 6l10 4v8c0 6-4.5 10.5-10 12C12.5 28.5 8 24 8 18v-8l10-4z"
              stroke="#9886fe"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="18" cy="18" r="3" fill="#9886fe" />
          </>
        ),
      },
      {
        heading: "Dedicated Manager",
        body: "One real person accountable for every payroll run. Not a ticket system.",
        icon: (
          <>
            <circle cx="18" cy="12" r="6" stroke="#9886fe" strokeWidth="1.8" />
            <path
              d="M6 30c0-6.627 5.373-12 12-12s12 5.373 12 12"
              stroke="#9886fe"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        ),
      },
      {
        heading: "Scales Instantly",
        body: "2 employees to 2,000. No new software, no new setup. The service grows with you.",
        icon: (
          <>
            <path
              d="M18 28V8M18 8l-7 7M18 8l7 7"
              stroke="#9886fe"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8 28h20" stroke="#9886fe" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ),
      },
    ],
  },
];

const CTA_CHECKS = [
  "First payroll live within 48 hours of setup",
  "100% statutory compliance — EOBI, SESSI, FBR",
  "Dedicated Payroll Manager — one person, always",
];

const CTA_STATS = [
  { num: "48 hrs", label: "First payroll live in" },
  { num: "2–2,000+", label: "Employees managed" },
  { num: "100%", label: "Statutory filings on time" },
  { num: "Zero", label: "Errors last 12 months" },
];

const FAQS = [
  {
    q: "How fast can you set up our payroll?",
    a: "For most clients, we're fully configured and running your first payroll within 24–48 hours. Nothing to install or configure on your end.",
  },
  {
    q: "We have an in-house HR person. Do we still need this?",
    a: "Many clients have internal HR teams who focus on culture and people management while Remotiv handles the administrative complexity of payroll processing, tax filings, and statutory compliance. We work alongside your HR team, not instead of them.",
  },
  {
    q: "What taxes and statutory obligations do you manage?",
    a: "Everything — monthly income tax (withholding tax on salaries), annual FBR filings, EOBI contributions, SESSI/PESSI deductions, and gratuity fund accruals. If it's a payroll obligation in Pakistan, we cover it.",
  },
  {
    q: "Do you handle both employees and contractors?",
    a: "Yes. Full-time employees, part-time staff, and independent contractors — each classified and managed according to the correct legal and tax treatment.",
  },
  {
    q: "We're a US company. Do we need a Pakistani entity?",
    a: "No. Through our EOR service, Remotiv legally employs your Pakistani team on your behalf. No local company, no bank account, no entity registration required.",
  },
  {
    q: "What's the minimum team size?",
    a: "No minimum. We work with teams as small as 2 people. Same dedicated service, same Payroll Manager.",
  },
  {
    q: "What does it cost?",
    a: "Pricing is based on team size and service scope. No setup fees, no hidden charges. We provide a transparent cost breakdown during your discovery call. Contact us for a quote.",
  },
  {
    q: "What if I'm already a Remotiv recruitment client?",
    a: "Adding payroll is simple — just let your account manager know. Since your employee data already exists in our system, setup is significantly faster. One platform, one invoice.",
  },
];

const PrimaryButton = ({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <Link
    href={href}
    className={cn(
      "inline-flex items-center whitespace-nowrap rounded-full bg-[#49D7A7] px-8 py-3.5 font-heading text-[0.92rem] font-bold text-[#111] transition hover:-translate-y-px hover:bg-[#3bc495]",
      className,
    )}
  >
    {children}
  </Link>
);

const OutlineButton = ({
  href,
  external,
  children,
  className,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
  className?: string;
}) => (
  <a
    href={href}
    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    className={cn(
      "inline-flex items-center whitespace-nowrap rounded-full border-[1.5px] border-[#111] bg-transparent px-8 py-3 text-[0.92rem] font-semibold text-[#111] transition hover:bg-[#111] hover:text-white",
      className,
    )}
  >
    {children}
  </a>
);

const SectionPill = ({
  children,
  variant = "green",
}: {
  children: React.ReactNode;
  variant?: "green" | "dark";
}) => (
  <div
    className={cn(
      "mb-5 inline-flex items-center rounded-full border px-4 py-1 text-[0.72rem] font-bold uppercase tracking-[0.08em]",
      variant === "green"
        ? "border-[#49D7A7]/30 bg-[#49D7A7]/10 text-[#1d8c6b]"
        : "border-white/15 bg-white/10 text-white/60",
    )}
  >
    {children}
  </div>
);

export default function PayrollPage() {
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
            name: "Payroll and Compliance Services",
            serviceType: "Payroll Services",
            provider: {
              "@type": "Organization",
              name: "Remotiv",
              url: "https://www.remotiv.work",
            },
            areaServed: "Worldwide",
            url: "https://www.remotiv.work/services/payroll",
            description:
              "Hassle-free international payroll, contracts, and compliance for remote engineering hires.",
          }).replace(/</g, "\\u003c"),
        }}
      />
      <Navbar />
      <main className="flex-1 bg-white">
        {/* Hero */}
        <section className="box-border w-full bg-white p-4 md:p-6">
          <div className="mx-auto box-border flex w-full flex-col items-center rounded-[28px] bg-[#f8f4f1] px-5 pb-20 pt-20 text-center md:px-10 md:pb-28 md:pt-28">
            <h1 className="mb-6 max-w-[820px] font-heading text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-[#111]">
              You Run the Business. We Run Payroll.
            </h1>
            <p className="mx-auto mb-11 max-w-[580px] text-[1.05rem] leading-[1.7] text-[#444]">
              Salaries, tax compliance, EOBI, SESSI, gratuity — handled end-to-end by Remotiv. No
              spreadsheets, no missed deadlines, no errors. Already hired through Remotiv? Add payroll
              in one conversation.
            </p>
            <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3.5">
              <PrimaryButton href={BOOKING_HREF} className="w-full sm:w-auto">
                Set Up Payroll →
              </PrimaryButton>
              <OutlineButton href={CALL_HREF} external className="w-full sm:w-auto">
                Book a 15-Min Call
              </OutlineButton>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="box-border w-full bg-white px-5 py-12 md:px-10">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-14 text-center">
              <SectionPill>Payroll Services</SectionPill>
              <h2 className="mb-5 font-heading text-[clamp(1.9rem,3.5vw,2.8rem)] font-extrabold leading-[1.12] tracking-[-0.02em] text-[#111]">
                Payroll That Runs Itself.
                <br />
                Perfectly. Every Month.
              </h2>
              <p className="mx-auto max-w-[560px] text-base leading-[1.7] text-[#777]">
                Most payroll software still requires someone to run it. We give you a dedicated
                manager, full compliance coverage, and a setup that&apos;s live in under 48 hours.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {FEATURE_CARDS.map((card) => (
                <div
                  key={card.title}
                  className="flex flex-col overflow-hidden rounded-[20px] bg-[#f8f4f1] p-8 pb-8"
                >
                  <div
                    className={cn(
                      "mb-7 flex size-14 flex-shrink-0 items-center justify-center rounded-[14px]",
                      card.iconBg,
                    )}
                  >
                    {card.icon}
                  </div>
                  <span className="mb-2.5 text-[0.65rem] font-bold uppercase tracking-[0.1em] text-[#999]">
                    {card.badge}
                  </span>
                  <h3 className="mb-3.5 font-heading text-[1.15rem] font-bold leading-[1.25] text-[#111]">
                    {card.title}
                  </h3>
                  <p className="mb-8 flex-1 text-[0.88rem] leading-[1.72] text-[#555]">
                    {card.description}
                  </p>
                  <div className="mt-auto rounded-[14px] bg-white p-5">{card.visual}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Full Scope */}
        <section className="box-border w-full bg-white px-5 py-12 md:px-10">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-14 text-center">
              <SectionPill>Full Scope</SectionPill>
              <h2 className="mb-4 font-heading text-[clamp(1.8rem,3.2vw,2.6rem)] font-extrabold leading-[1.12] tracking-[-0.03em] text-[#111]">
                Everything Payroll. Nothing Left Out.
              </h2>
              <p className="mx-auto max-w-[560px] text-base leading-[1.7] text-[#777]">
                From the first salary run to annual tax filings — here is every task Remotiv takes
                completely off your hands.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-4">
              {SCOPE_CARDS.map((card) => (
                <div
                  key={card.title}
                  className="flex flex-col rounded-[18px] border border-transparent bg-[#f8f4f1] px-6 pb-8 pt-7 transition hover:-translate-y-0.5 hover:border-[#49D7A7]/30 hover:shadow-[0_8px_28px_rgba(73,215,167,0.1)]"
                >
                  <div
                    className={cn(
                      "mb-5 flex size-11 flex-shrink-0 items-center justify-center rounded-xl",
                      card.iconBg,
                    )}
                    style={{ color: card.iconColor }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="size-[22px]">
                      <title>{card.title}</title>
                      {card.icon}
                    </svg>
                  </div>
                  <h4 className="mb-2.5 font-heading text-[0.9rem] font-bold leading-[1.3] text-[#111]">
                    {card.title}
                  </h4>
                  <p className="text-[0.82rem] leading-[1.72] text-[#666]">{card.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Process */}
        <section className="bg-[#9886fe] px-5 pb-20 pt-16 md:px-10 md:pb-24 md:pt-20">
          <div className="mx-auto grid max-w-[1100px] items-start gap-12 md:grid-cols-2 md:gap-20">
            <div>
              <p className="mb-4 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#c9ff85]">
                Getting Started
              </p>
              <h2 className="mb-3.5 font-heading text-[clamp(1.6rem,3vw,2.2rem)] font-extrabold leading-[1.15] text-white">
                Live in 24–48 Hours. Here&apos;s How.
              </h2>
              <p className="mb-12 text-[0.97rem] leading-[1.7] text-white/75">
                No lengthy onboarding. No technical setup on your side. No disruption to your team.
              </p>

              <div className="flex flex-col">
                {PROCESS_STEPS.map((step, idx) => (
                  <div key={step.label} className="relative flex gap-5 pb-9 last:pb-0">
                    <div className="flex flex-shrink-0 flex-col items-center">
                      <div className="relative z-10 flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-white font-heading text-[0.78rem] font-bold text-[#9886fe]">
                        {idx + 1}
                      </div>
                      {idx !== PROCESS_STEPS.length - 1 && (
                        <div className="mt-1.5 w-[1.5px] flex-1 bg-white/25" />
                      )}
                    </div>
                    <div className="flex-1 pt-1">
                      <p className="mb-2 font-heading text-[0.85rem] font-bold text-[#c9ff85]">
                        {step.label}
                      </p>
                      <p className="text-[0.88rem] leading-[1.75] text-white/80">{step.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sticky top-24 flex flex-col gap-5 overflow-hidden rounded-[24px] border border-black/[0.07] bg-white px-9 py-10">
              <div className="inline-flex items-center gap-2 self-start rounded-full border border-[#49D7A7]/25 bg-[#49D7A7]/10 px-3.5 py-1.5 font-heading text-[0.72rem] font-bold text-[#49D7A7]">
                <span className="size-[7px] rounded-full bg-[#49D7A7]" />
                Live — Active Payroll Clients
              </div>
              <p className="font-heading text-[1.4rem] font-extrabold leading-[1.2] text-[#111]">
                Most clients are fully live on payroll within 48 hours of their first call.
              </p>
              <div className="mt-1 grid grid-cols-2 gap-3.5">
                {PROCESS_STATS.map((stat) => (
                  <div key={stat.label} className="rounded-[14px] bg-[#f8f4f1] px-5 py-4">
                    <div className="font-heading text-[1.5rem] font-extrabold leading-none text-[#111]">
                      {stat.num}
                    </div>
                    <div className="mt-1.5 text-[0.78rem] text-[#888]">{stat.label}</div>
                  </div>
                ))}
              </div>
              <div className="h-px bg-black/[0.06]" />
              <div className="flex flex-col gap-3">
                {PROCESS_BARS.map((bar) => (
                  <div key={bar.step} className="flex items-center gap-3">
                    <div className="flex size-[26px] flex-shrink-0 items-center justify-center rounded-full bg-[#9886fe] font-heading text-[0.68rem] font-bold text-white">
                      {bar.step}
                    </div>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.07]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: bar.width, background: bar.color }}
                      />
                    </div>
                    <div className="min-w-14 text-right text-[0.75rem] text-[#666]">{bar.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Who We Serve */}
        <section className="box-border w-full bg-white px-6 pb-20 pt-6">
          <div className="mx-auto box-border grid max-w-[1100px] items-start gap-10 rounded-[24px] bg-[#1a1a1a] p-6 md:grid-cols-[1fr_1.4fr] md:gap-[72px] md:px-[60px] md:py-16">
            <div className="md:sticky md:top-24">
              <SectionPill variant="dark">Who We Serve</SectionPill>
              <h2 className="font-heading text-[clamp(1.8rem,2.8vw,2.6rem)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
                Whether You Have 2 Employees or 2,000 — We&apos;ve Got You.
              </h2>
            </div>
            <div className="flex flex-col">
              {WHO_WE_SERVE.map((item, idx) => (
                <div
                  key={item.title}
                  className={cn(
                    "py-8",
                    idx !== 0 && "border-t border-white/10",
                    idx === 0 && "pt-0",
                    idx === WHO_WE_SERVE.length - 1 && "pb-0",
                  )}
                >
                  <h3 className="mb-3 font-heading text-base font-bold leading-[1.3] text-white">
                    {item.title}
                  </h3>
                  <p className="text-[0.88rem] leading-[1.78] text-white/55">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Advantage */}
        <section className="bg-white px-5 py-16 md:px-10 md:py-20">
          <div className="mx-auto max-w-[1100px]">
            <div className="mb-14">
              <p className="mb-3.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#49D7A7]">
                The Advantage
              </p>
              <h2 className="font-heading text-[clamp(1.75rem,3vw,2.4rem)] font-extrabold leading-[1.15] text-[#111]">
                What Changes When You Hand Payroll to Remotiv
              </h2>
            </div>

            {ADVANTAGE_ROWS.map((row, idx, arr) => (
              <div
                key={row.label}
                className={cn(
                  "grid grid-cols-1 items-start gap-10 border-t border-black/[0.08] py-10 md:grid-cols-[220px_1fr]",
                  idx === arr.length - 1 && "border-b border-black/[0.08]",
                )}
              >
                <h3 className="pt-1 font-heading text-base font-bold leading-[1.3] text-[#111]">
                  {row.label}
                </h3>
                <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 md:grid-cols-3">
                  {row.cols.map((col) => (
                    <div
                      key={col.heading}
                      className="grid grid-cols-[26px_1fr] gap-x-2.5 gap-y-2.5"
                    >
                      <svg
                        viewBox="0 0 36 36"
                        fill="none"
                        className="col-start-1 row-start-1 mt-0.5 block size-[22px] flex-shrink-0"
                      >
                        <title>{col.heading}</title>
                        {col.icon}
                      </svg>
                      <h4 className="col-start-2 row-start-1 self-center font-heading text-[0.92rem] font-bold text-[#111]">
                        {col.heading}
                      </h4>
                      <p className="col-span-full row-start-2 text-[0.85rem] leading-[1.72] text-[#555]">
                        {col.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="bg-white px-5 pb-16 pt-12 md:px-10 md:pb-20 md:pt-16">
          <div className="mx-auto grid max-w-[900px] items-center gap-8 rounded-[24px] bg-[#c9ff85] p-6 md:grid-cols-2 md:gap-14 md:p-[52px_60px]">
            <div>
              <div className="mb-4 inline-flex items-center rounded-full bg-white/45 px-3.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#111]">
                Payroll Services
              </div>
              <h2 className="mb-3 font-heading text-[clamp(1.4rem,2.2vw,1.9rem)] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#111]">
                Your Payroll Goes Live in 48 Hours.
              </h2>
              <p className="mb-6 text-[13px] leading-[1.75] text-[#111]/75">
                No spreadsheets. No missed filings. No payroll errors. Just a dedicated Payroll
                Manager, handling everything — from salary calculations to FBR filings — every single
                month.
              </p>
              <div className="mb-7 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
                <Link
                  href={BOOKING_HREF}
                  className="inline-flex w-full items-center rounded-full bg-[#49D7A7] px-6 py-3 font-heading text-[0.82rem] font-bold text-[#111] transition hover:opacity-90 sm:w-auto"
                >
                  Set Up Payroll →
                </Link>
                <OutlineButton href={CALL_HREF} external className="w-full sm:w-auto">
                  Book a 15-Min Call
                </OutlineButton>
              </div>
              <ul className="mb-7 flex flex-col gap-2.5">
                {CTA_CHECKS.map((check) => (
                  <li
                    key={check}
                    className="flex items-center gap-2 text-[13px] font-medium text-[#111]"
                  >
                    <div className="flex size-[18px] flex-shrink-0 items-center justify-center rounded-full bg-white/50">
                      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                        <title>Check</title>
                        <path
                          d="M2 6l3 3 5-5"
                          stroke="#111"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    {check}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <div className="flex">
                  {[
                    { initials: "JC", bg: "#111111", color: "#c9ff85" },
                    { initials: "SM", bg: "#7E47FF", color: "#ffffff" },
                    { initials: "OF", bg: "#333333", color: "#ffffff" },
                  ].map((av) => (
                    <div
                      key={av.initials}
                      className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-[#c9ff85] text-[9px] font-bold"
                      style={{ background: av.bg, color: av.color }}
                    >
                      {av.initials}
                    </div>
                  ))}
                </div>
                <span className="ml-3 text-xs text-[#111]/65">
                  Trusted by 100+ companies worldwide
                </span>
              </div>
            </div>

            <div className="flex flex-col rounded-2xl bg-white p-7">
              <p className="mb-5 font-heading text-sm font-bold text-[#111]">
                Payroll by the Numbers
              </p>
              <div className="mb-5 grid grid-cols-2 gap-3">
                {CTA_STATS.map((stat) => (
                  <div key={stat.label} className="rounded-xl bg-[#f8f4f1] px-4 py-4">
                    <div className="mb-1 font-heading text-[1.35rem] font-extrabold leading-none text-[#111]">
                      {stat.num}
                    </div>
                    <div className="text-[0.72rem] leading-[1.4] text-[#888]">{stat.label}</div>
                  </div>
                ))}
              </div>
              <Link
                href={BOOKING_HREF}
                className="mb-2.5 w-full rounded-[10px] bg-[#c9ff85] py-3 text-center font-heading text-xs font-bold uppercase tracking-[0.06em] text-[#111] transition hover:-translate-y-px hover:bg-[#b8f060]"
              >
                Get Started Today →
              </Link>
              <p className="flex items-center justify-center gap-1 text-[10px] text-[#bbb]">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2">
                  <title>Lock</title>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Your data is encrypted and 100% confidential
              </p>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-black/[0.06] bg-white px-5 pb-20 pt-16 md:px-10 md:pb-24 md:pt-20">
          <div className="mx-auto max-w-[1100px]">
            <div className="flex flex-col gap-10 md:flex-row md:gap-20">
              <div className="md:max-w-[35%] md:flex-[0_0_35%]">
                <h2 className="mb-5 font-heading text-[clamp(1.8rem,3vw,2.6rem)] font-extrabold leading-[1.15] text-[#111]">
                  Questions We Hear Most
                </h2>
                <p className="text-[0.95rem] leading-[1.7] text-[#777]">
                  For any unanswered questions, reach out to our team. We&apos;ll respond as soon as
                  possible.
                </p>
              </div>

              <div className="md:max-w-[58%] md:flex-[0_0_58%]">
                <div className="border-t border-black/10">
                  {FAQS.map((faq, idx) => {
                    const isOpen = openFaq === idx;
                    return (
                      <div key={faq.q} className="border-b border-black/10">
                        <button
                          type="button"
                          onClick={() => setOpenFaq(isOpen ? -1 : idx)}
                          className="flex w-full items-center justify-between gap-4 bg-transparent py-6 text-left"
                        >
                          <span className="flex-1 font-heading text-[0.97rem] font-semibold leading-[1.4] text-[#111]">
                            {faq.q}
                          </span>
                          <span className="w-6 flex-shrink-0 text-center text-[1.4rem] font-light leading-none text-[#111]">
                            {isOpen ? "−" : "+"}
                          </span>
                        </button>
                        <div
                          className={cn(
                            "overflow-hidden transition-[max-height] duration-300",
                            isOpen ? "max-h-[600px]" : "max-h-0",
                          )}
                        >
                          <p className="pb-6 text-[0.9rem] leading-[1.75] text-[#444]">{faq.a}</p>
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
    </>
  );
}
