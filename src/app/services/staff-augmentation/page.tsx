"use client";

import { track } from "@vercel/analytics";
import Link from "next/link";
import { useRef, useState } from "react";
import { submitContact } from "@/app/contact/actions";
import { Navbar } from "@/components/navbar";
import { MARKETING_STATS } from "@/lib/marketing-stats";
import { CalendarIcon, CheckBadge, ShieldIcon, TeamIcon } from "./_icons";

const STATS: readonly { value: string; label: string }[] = [
  { value: "24 hrs", label: "First screened candidate in your inbox" },
  { value: MARKETING_STATS.savings, label: "Less than equivalent US hires" },
  { value: "Free", label: "Replacement guarantee" },
  { value: MARKETING_STATS.talentPool, label: "Profiles in our database" },
];

const TI_POINTS: readonly {
  title: string;
  body: string;
  icon: React.ReactNode;
}[] = [
  {
    title: "Not outsourcing",
    body: "You manage the work directly. No intermediary.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className="size-14 sm:size-16">
        <rect x="8" y="10" width="38" height="46" rx="4" stroke="#111" strokeWidth="2" />
        <line x1="8" y1="20" x2="46" y2="20" stroke="#111" strokeWidth="2" />
        <CheckBadge />
        <line x1="16" y1="30" x2="36" y2="30" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="16" y1="37" x2="30" y2="37" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Not permanent hiring",
    body: "No 6-week recruitment cycle. No severance risk.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className="size-14 sm:size-16">
        <rect x="10" y="14" width="36" height="36" rx="5" stroke="#111" strokeWidth="2" />
        <CheckBadge />
        <line x1="18" y1="24" x2="26" y2="24" stroke="#111" strokeWidth="2" strokeLinecap="round" />
        <line x1="18" y1="32" x2="38" y2="32" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="18" y1="39" x2="32" y2="39" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
        <rect x="24" y="8" width="8" height="12" rx="2" stroke="#111" strokeWidth="2" />
      </svg>
    ),
  },
  {
    title: "Not freelancing",
    body: "Every specialist is vetted, contracted, and backed by our free replacement guarantee.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className="size-14 sm:size-16">
        <path
          d="M20 32 C20 32 14 32 14 26 C14 20 20 20 20 20 L26 20 L26 44 L20 44 Z"
          stroke="#111"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="26" y="20" width="16" height="24" stroke="#111" strokeWidth="2" />
        <rect x="42" y="20" width="8" height="24" rx="4" fill="#49D7A7" />
      </svg>
    ),
  },
];

const REASONS: readonly {
  badge: { label: string; tone: "lime" | "dark" };
  title: string;
  body: string;
}[] = [
  {
    badge: { label: "Speed", tone: "lime" },
    title: "Matched in 24 Hours, Not Weeks",
    body: "Submit your requirement and receive a shortlist of 3–5 screened, AI-matched candidates within 24 hours. Most clients have their specialist working by day seven. Traditional agencies take 1–2 weeks for the same result.",
  },
  {
    badge: { label: "AI + Human", tone: "dark" },
    title: "AI Finds Them. Recruiters Validate Them",
    body: `Our matching engine scans ${MARKETING_STATS.talentPool} profiles in seconds to surface the best technical fits. Then our recruiters call every shortlisted candidate personally — verifying skills, communication, and availability — before you see a single profile. No raw database dumps. No unvetted resumes.`,
  },
];

const STEPS: readonly { label: string; body: string }[] = [
  {
    label: "Brief Us — 15 Minutes",
    body: "Tell us the role, required skills, timezone overlap, and engagement duration. The more context you share, the sharper the match. Your brief triggers our AI search immediately.",
  },
  {
    label: "We Match & Vet — 24–48 Hours",
    body: `Our AI scans ${MARKETING_STATS.talentPool} profiles and surfaces the strongest technical fits. Our recruiters then call each candidate personally to verify skills, communication quality, and availability. For technical roles, candidates complete an in-house skills assessment before they ever reach your inbox. You receive a shortlist of 3–5 validated candidates.`,
  },
  {
    label: "You Interview & Choose",
    body: "Interview your shortlist on your schedule. Remotiv coordinates everything — calendar scheduling, interview guides, and all candidate communications. You make the final call.",
  },
  {
    label: "They Start. We Handle Everything.",
    body: "Your specialist joins your Slack, your standup, your codebase. They're contributing on day one. Remotiv manages payroll, contracts, NDAs and cross-border compliance silently in the background. You never file a single piece of paperwork.",
  },
];

const STEP_METRICS: readonly { value: string; label: string }[] = [
  { value: "24 hrs", label: "First shortlist delivered" },
  { value: "Day 7", label: "Specialist starts work" },
  { value: "Free", label: "Replacement guarantee" },
  { value: MARKETING_STATS.talentPool, label: "Vetted profiles" },
];

const STEP_BARS: readonly { fill: string; width: string; day: string }[] = [
  { fill: "#49D7A7", width: "100%", day: "Day 0" },
  { fill: "#7E47FF", width: "72%", day: "24–48 hrs" },
  { fill: "#9886fe", width: "52%", day: "Day 3–5" },
  { fill: "#c9ff85", width: "35%", day: "Day 7" },
];

type AdvColor = "green" | "purple";
type AdvCol = { heading: string; body: string; icon: React.ReactNode };

const ADVANTAGES: readonly { label: string; color: AdvColor; cols: AdvCol[] }[] = [
  {
    label: "Productive on Day One",
    color: "green",
    cols: [
      {
        heading: "Technical Ready",
        body: "Your specialist has already passed technical vetting before their first standup with your team.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="4" y="6" width="28" height="24" rx="4" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M10 18l5 5 11-10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
      {
        heading: "Paperwork Done",
        body: "NDAs are fully signed and completed before day one. You never touch a single document.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="7" y="4" width="22" height="28" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M12 13h12M12 18h12M12 23h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        ),
      },
      {
        heading: "Arrives to Contribute",
        body: "No 6-week onboarding. No HR delays. They integrate into your tools and workflow immediately.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <circle cx="18" cy="12" r="6" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M6 30c0-6.627 5.373-12 12-12s12 5.373 12 12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M22 20l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "Elastic Team Size",
    color: "purple",
    cols: [
      {
        heading: "Scale Up Fast",
        body: "Go from 1 specialist to 10 in a matter of days when project demand spikes.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <path
              d="M18 28V8M18 8l-7 7M18 8l7 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8 28h20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        heading: "Scale Back Clean",
        body: "No severance conversations, no contract penalties, no awkward performance reviews when the project wraps.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <path
              d="M18 8v20M18 28l-7-7M18 28l7-7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8 8h20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        heading: "Headcount Flexibility",
        body: "Your team size flexes with your workload, not the other way around.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="4" y="14" width="6" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <rect x="15" y="8" width="6" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <rect x="26" y="18" width="6" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        ),
      },
    ],
  },
  {
    label: "You Stay in the Driver's Seat",
    color: "green",
    cols: [
      {
        heading: "Direct Reporting",
        body: "Your specialist reports directly to you. No project manager layer between you and your team.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <circle cx="18" cy="10" r="5" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M8 28c0-5.523 4.477-10 10-10s10 4.477 10 10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M14 20l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
      {
        heading: "Your Tools, Your Process",
        body: "They follow your processes and work inside your existing tools from day one.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="5" y="8" width="26" height="20" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5 14h26" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="10" cy="11" r="1.5" fill="currentColor" />
            <circle cx="15" cy="11" r="1.5" fill="currentColor" />
          </svg>
        ),
      },
      {
        heading: "Full Control",
        body: "You retain complete control over priorities, quality, and direction at all times.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <path
              d="M18 6l3.09 6.26L28 13.27l-5 4.87 1.18 6.88L18 21.77l-6.18 3.25L13 18.14 8 13.27l6.91-1.01L18 6z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "Zero Administrative Burden",
    color: "purple",
    cols: [
      {
        heading: "Payroll & Contracts",
        body: "Remotiv manages payroll, employment contracts, and tax withholding for every specialist placed.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="6" y="10" width="24" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M6 16h24" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 22h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        heading: "Cross-Border Compliance",
        body: "We handle Pakistani employment law, currency conversion, and tax filings. You never interact with any of it.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <circle cx="18" cy="18" r="12" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M6 18h24M18 6c-3 4-4.5 8-4.5 12s1.5 8 4.5 12M18 6c3 4 4.5 8 4.5 12s-1.5 8-4.5 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        ),
      },
      {
        heading: "Benefits Managed",
        body: "Specialist benefits are fully managed by Remotiv. Zero administrative overhead on your side.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <path
              d="M18 6l2.5 7.5H28l-6.5 4.5 2.5 7.5L18 21l-6 4.5 2.5-7.5L8 13.5h7.5L18 6z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "Access Niche Expertise",
    color: "green",
    cols: [
      {
        heading: `${MARKETING_STATS.talentPool} Profile Database`,
        body: "Our database surfaces niche specialists that local hiring simply cannot produce on a 3-week timeline.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <circle cx="16" cy="16" r="9" stroke="currentColor" strokeWidth="1.8" />
            <path d="M23 23l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        heading: "Rare Skill Sets",
        body: "ML engineers with RAG pipeline experience, RevOps leads with HubSpot enterprise configuration — we find them.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <path
              d="M10 26l6-6m0 0l4-8 4 4-8 4zm6-6l4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="28" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        ),
      },
      {
        heading: "3-Week Turnaround",
        body: "Expertise that doesn't exist locally, delivered to your team within weeks, not months.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <circle cx="18" cy="18" r="12" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M18 12v6l4 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "Protected by a Guarantee",
    color: "purple",
    cols: [
      {
        heading: "Free Replacement",
        body: "If the specialist underperforms, we replace them at zero cost. No justification required.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <ShieldIcon />
            <path
              d="M13 18l3 3 7-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
      {
        heading: "No Rebooking Fees",
        body: "No paperwork, no rebooking fees, no penalty for requesting a replacement.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <rect x="7" y="4" width="22" height="28" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 14h12M12 19h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M12 24h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        heading: "Risk Sits With Us",
        body: "The placement guarantee means the risk is entirely ours, not yours.",
        icon: (
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" className="size-[22px]">
            <ShieldIcon />
            <circle cx="18" cy="18" r="3" fill="currentColor" />
          </svg>
        ),
      },
    ],
  },
];

const ROLES: readonly { name: string; tags: string; icon: React.ReactNode }[] = [
  {
    name: "Engineering",
    tags: "React · Node.js · Python · Go · Ruby · PHP · iOS · Android · Full Stack",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
      </svg>
    ),
  },
  {
    name: "DevOps & Cloud",
    tags: "AWS · GCP · Azure · Kubernetes · Terraform · SRE · Platform Engineering",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
      </svg>
    ),
  },
  {
    name: "AI & Data",
    tags: "ML Engineers · Data Scientists · LLM Specialists · Data Engineers · dbt · Airflow",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
      </svg>
    ),
  },
  {
    name: "Cybersecurity",
    tags: "DevSecOps · Penetration Testing · SOC2 · GDPR Compliance · Cloud Security",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
      </svg>
    ),
  },
  {
    name: "Sales & Revenue",
    tags: "SDR · BDR · Account Executive · RevOps · Sales Manager · VP Sales",
    icon: (
      <CalendarIcon className="size-7 fill-[#111]" />
    ),
  },
  {
    name: "Customer Success",
    tags: "CSM · Onboarding Specialist · Renewals · Technical Support",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
    ),
  },
  {
    name: "Design & UX",
    tags: "Product Designer · UX Researcher · Design Systems Lead · UI Engineer",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7-3.14 7-7 7zm1-11h-2v3H8v2h3v3h2v-3h3v-2h-3z" />
      </svg>
    ),
  },
  {
    name: "Marketing",
    tags: "Performance Marketing · SEO · Content Strategy · Growth · Brand · Email",
    icon: (
      <TeamIcon className="size-7 fill-[#111]" />
    ),
  },
  {
    name: "Finance & Ops",
    tags: "Financial Controller · FP&A · Accountant · Payroll · Operations Manager",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z" />
      </svg>
    ),
  },
  {
    name: "QA & Testing",
    tags: "QA Engineer · SDET · Automation Testing · Manual QA",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
      </svg>
    ),
  },
  {
    name: "Product",
    tags: "Product Manager · Product Lead · Product Analyst · Scrum Master",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z" />
      </svg>
    ),
  },
  {
    name: "Fractional Leadership",
    tags: "CTO · VP Sales · CMO · CFO · Lead Architect",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    ),
  },
  {
    name: "HR & People Ops",
    tags: "HR Manager · Talent Acquisition · L&D Specialist · People Operations · HRBP",
    icon: (
      <TeamIcon className="size-7 fill-[#111]" />
    ),
  },
  {
    name: "Sales Enablement & CRM",
    tags: "HubSpot Admin · Salesforce Admin · CRM Specialist · Sales Ops Analyst",
    icon: (
      <CalendarIcon className="size-7 fill-[#111]" />
    ),
  },
  {
    name: "Video & Content Production",
    tags: "Video Editor · Motion Designer · Podcast Producer · Content Creator",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7 fill-[#111]">
        <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
      </svg>
    ),
  },
];

const FAQS: readonly { q: string; a: string }[] = [
  {
    q: "How quickly can I get a specialist?",
    a: "Within 24 hours you'll receive a shortlist of 3–5 screened, AI-matched candidates. Most clients complete interviews within 5–7 days and have their specialist starting the following week.",
  },
  {
    q: "How is this different from a dedicated team?",
    a: "Staff augmentation fills specific skill gaps with one or two specialists on a flexible basis. A dedicated team is a full group — multiple roles, ongoing engagement — built exclusively for your company with Remotiv managing HR and payroll permanently.",
  },
  {
    q: "What's the minimum commitment?",
    a: "Two months recommended. Sprint engagements as short as 3–4 weeks are possible for defined project scopes. No long-term lock-in.",
  },
  {
    q: "Who manages the specialist?",
    a: "You do. They report to you, use your tools, follow your processes. Remotiv manages payroll, HR, and compliance in the background but never directs the work.",
  },
  {
    q: "Can I convert them to permanent?",
    a: "Yes. Many clients do. The specialist already has full context of your product and team, so conversion is fast and low-risk. Remotiv facilitates the transition.",
  },
  {
    q: "What if the specialist underperforms?",
    a: "Free replacement guarantee covers you. We restart the search and place a replacement at zero cost. No justification required.",
  },
];

const CHECK_ITEMS: readonly string[] = [
  "Shortlist delivered within 24 hours",
  "Free replacement guarantee included",
  "100% confidential — your data stays private",
];

function Hero() {
  return (
    <section className="bg-white px-4 sm:px-6 py-14 md:py-20">
      <div className="relative isolate flex w-full items-center justify-center overflow-hidden rounded-[32px] bg-remotiv-bg px-5 pt-12 pb-12 sm:px-6 sm:pt-[72px] sm:pb-20 text-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(0,0,0,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.07)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_60%_100%_at_50%_50%,black_20%,transparent_80%)]"
        />
        <div className="relative z-10">
          <h1 className="mb-6 font-heading text-[clamp(1.9rem,6.5vw,4rem)] font-extrabold leading-[1.1] tracking-[-0.02em] text-remotiv-text-dark">
            <span>Ship Faster.</span>{" "}
            <span className="text-remotiv-green">Spend Less.</span>{" "}
            <span className="text-remotiv-purple">Stay in Control.</span>
          </h1>
          <p className="mx-auto mb-6 sm:mb-10 max-w-[620px] text-[1.1rem] leading-[1.65] text-[#444]">
            Plug vetted specialists into your team in 24 hours. They join your standup, use your
            tools, and report to you — while Remotiv handles payroll, contracts, and compliance
            behind the scenes.
          </p>
          <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-center gap-2.5 sm:gap-3.5">
            <Link
              href="/hire-remote"
              className="w-full sm:w-auto text-center rounded-full bg-remotiv-green px-8 py-[12px] sm:py-[15px] font-heading text-base font-bold text-remotiv-text-dark transition-opacity hover:opacity-[0.88]"
            >
              Get Your First Specialist →
            </Link>
            <Link
              href="/ai-matching"
              className="w-full sm:w-auto text-center rounded-full border-[1.5px] border-[#111] px-8 py-[11px] sm:py-3.5 text-base font-semibold text-remotiv-text-dark transition-colors hover:bg-[#111] hover:text-white"
            >
              Try AI Talent Match
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stats() {
  return (
    <section className="border-t border-black/[0.06] bg-white px-5 sm:px-8 py-12 md:py-[72px]">
      <h2 className="mx-auto mb-4 max-w-[700px] text-center font-heading text-[clamp(1.75rem,3.5vw,2.6rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
        Trusted by 100+ companies from{" "}
        <span className="text-remotiv-purple">YC startups</span> to{" "}
        <span className="text-remotiv-green">Fortune-level multinationals</span>
      </h2>
      <p className="mx-auto mb-8 sm:mb-12 max-w-[580px] text-center text-[1.05rem] leading-[1.65] text-[#444]">
        We match you with pre-vetted remote specialists — fast, affordable, and ready to deliver
        from day one.
      </p>
      <div className="mx-auto max-w-[1120px] rounded-[28px] bg-remotiv-purple-light p-5 sm:p-7">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
          {STATS.map((s) => (
            <div
              key={s.label}
              className="flex flex-col items-center gap-2.5 rounded-[18px] bg-white px-5 pt-7 pb-6 sm:px-7 sm:pt-10 sm:pb-9 text-center"
            >
              <div className="font-heading text-[clamp(2rem,3.5vw,3rem)] font-extrabold leading-none text-remotiv-text-dark">
                {s.value}
              </div>
              <div className="text-[0.95rem] font-semibold leading-snug text-[#555]">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TeamIntegration() {
  return (
    <section className="bg-remotiv-bg px-5 sm:px-6 md:px-10 py-12 md:py-[72px]">
      <div className="mx-auto grid max-w-[1120px] grid-cols-1 items-start gap-12 md:grid-cols-2 md:gap-20">
        <div>
          <h2 className="mb-5 sm:mb-7 font-heading text-[clamp(1.75rem,3vw,2.5rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
            Your Team, Plus the Exact Specialist You&apos;re Missing
          </h2>
          <p className="text-base leading-[1.8] text-[#444]">
            Staff augmentation adds a skilled professional directly to your existing team. They
            join your Slack, attend your standups, commit to your repo, and report to you. You keep
            full control. Remotiv handles everything else — sourcing, vetting, payroll, contracts,
            and compliance. It&apos;s not outsourcing. You never hand off a project to an external
            vendor. You never lose visibility. You simply get the missing skill your team needs,
            deployed in days instead of months, with the flexibility to scale back when the work is
            done.
          </p>
        </div>
        <div className="flex flex-col gap-12 md:gap-14">
          {TI_POINTS.map((pt) => (
            <div key={pt.title}>
              <div className="mb-5 block">{pt.icon}</div>
              <h3 className="mb-2.5 font-heading text-[1.15rem] font-bold text-remotiv-text-dark">
                {pt.title}
              </h3>
              <p className="text-[0.95rem] leading-[1.7] text-[#555]">{pt.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FiveReasons() {
  const badgeClass = (tone: "lime" | "dark") =>
    tone === "lime"
      ? "bg-remotiv-lime-card text-remotiv-text-dark"
      : "bg-[#111] text-white";

  return (
    <section className="bg-remotiv-bg px-5 sm:px-8 py-12 md:py-[72px]">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-8 sm:mb-12 text-center">
          <h2 className="font-heading text-[clamp(1.75rem,3vw,2.4rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
            Five Reasons Companies Switch to Remotiv
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1.5fr]">
          {REASONS.map((r) => (
            <div
              key={r.title}
              className="flex min-h-[260px] sm:min-h-[340px] flex-col rounded-2xl border border-black/[0.08] bg-white p-6 sm:p-7"
            >
              <span
                className={`mb-[18px] self-start rounded-[5px] px-2.5 py-1 font-heading text-[0.7rem] font-bold ${badgeClass(r.badge.tone)}`}
              >
                {r.badge.label}
              </span>
              <h3 className="mb-0 font-heading text-[1.2rem] font-bold leading-tight text-remotiv-text-dark">
                {r.title}
              </h3>
              <p className="mt-auto pt-6 text-[0.86rem] leading-[1.72] text-[#555]">{r.body}</p>
            </div>
          ))}

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-1 flex-col rounded-2xl border border-black/[0.08] bg-white p-6 sm:p-7">
              <h3 className="mb-0 font-heading text-[1.2rem] font-bold leading-tight text-remotiv-text-dark">
                The Right Specialist, Not the Nearest Generalist
              </h3>
              <p className="mt-auto pt-6 text-[0.86rem] leading-[1.72] text-[#555]">
                We don&apos;t send you &apos;a developer.&apos; We send you the exact niche skill your project
                needs — an ML engineer with RAG pipeline experience, a DevSecOps lead with SOC2
                certification, a fractional CTO who has scaled two SaaS products past $10M ARR.
                Precision matters.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div className="flex flex-col rounded-2xl border border-black/[0.08] bg-white p-5 sm:p-6">
                <h3 className="mb-2.5 font-heading text-[0.93rem] font-bold leading-[1.3] text-remotiv-text-dark">
                  World-Class Output at {MARKETING_STATS.savings} Less
                </h3>
                <p className="text-[0.82rem] leading-[1.68] text-[#555]">
                  Pakistan produces 25,000+ STEM graduates annually. Remotiv gives you access to
                  this talent pool at a fraction of Western rates — without compromising on quality,
                  timezone coverage, or English fluency.
                </p>
              </div>
              <div className="flex flex-col rounded-2xl border border-black/[0.08] bg-white p-5 sm:p-6">
                <h3 className="mb-2.5 font-heading text-[0.93rem] font-bold leading-[1.3] text-remotiv-text-dark">
                  30 Days. Risk-Free
                </h3>
                <p className="text-[0.82rem] leading-[1.68] text-[#555]">
                  If your specialist doesn&apos;t meet expectations within 30 days, Remotiv restarts the
                  search and places a replacement at zero cost. No paperwork. No rebooking fee.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProcessSteps() {
  return (
    <section id="process" className="bg-remotiv-bg px-5 sm:px-6 md:px-10 py-12 md:py-[72px]">
      <div className="mx-auto grid max-w-[1100px] grid-cols-1 items-start gap-12 md:grid-cols-2 md:gap-12 lg:gap-20">
        <div>
          <p className="mb-4 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            The Process
          </p>
          <h2 className="mb-3.5 font-heading text-[clamp(1.6rem,3vw,2.2rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
            Request to Deployment in 4 Steps
          </h2>
          <p className="mb-8 sm:mb-12 text-[0.97rem] leading-[1.7] text-[#444]">
            We&apos;ve compressed the traditional 6–12 week hiring cycle into a repeatable 7-day
            process.
          </p>

          <ol className="flex flex-col">
            {STEPS.map((step, i) => (
              <li key={step.label} className="relative flex gap-5 pb-9 last:pb-0">
                <div className="flex flex-shrink-0 flex-col items-center">
                  <div className="z-10 flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-remotiv-purple font-heading text-[0.78rem] font-bold text-white">
                    {i + 1}
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className="mt-1.5 w-[1.5px] flex-1 bg-remotiv-purple/20" />
                  )}
                </div>
                <div className="flex-1 pt-1">
                  <p className="mb-2 font-heading text-[0.85rem] font-bold text-remotiv-purple">
                    {step.label}
                  </p>
                  <p className="text-[0.88rem] leading-[1.75] text-[#444]">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <aside className="flex flex-col gap-5 rounded-3xl border border-black/[0.07] bg-white p-6 sm:p-9 lg:sticky lg:top-24">
          <div className="inline-flex items-center gap-2 self-start rounded-full border border-remotiv-green/25 bg-remotiv-green/10 px-3.5 py-1.5 font-heading text-[0.72rem] font-bold text-remotiv-green">
            <span className="size-[7px] rounded-full bg-remotiv-green" />
            Live — Active Placements
          </div>
          <p className="font-heading text-[1.4rem] font-extrabold leading-tight text-remotiv-text-dark">
            Most clients have their specialist working within 7 days of their first brief.
          </p>
          <div className="mt-1 grid grid-cols-2 gap-3.5">
            {STEP_METRICS.map((m) => (
              <div key={m.label} className="rounded-2xl bg-remotiv-bg px-5 py-[18px]">
                <div className="font-heading text-2xl font-extrabold leading-none text-remotiv-text-dark">
                  {m.value}
                </div>
                <div className="mt-1.5 text-[0.78rem] text-remotiv-text-mid">{m.label}</div>
              </div>
            ))}
          </div>
          <div className="h-px bg-black/[0.06]" />
          <div className="flex flex-col gap-3">
            {STEP_BARS.map((bar, i) => (
              <div key={bar.day} className="flex items-center gap-3">
                <div className="flex size-[26px] flex-shrink-0 items-center justify-center rounded-full bg-remotiv-purple font-heading text-[0.68rem] font-bold text-white">
                  {i + 1}
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.07]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: bar.width, background: bar.fill }}
                  />
                </div>
                <div className="min-w-12 text-right text-[0.75rem] text-[#666]">{bar.day}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function Advantage() {
  return (
    <section className="bg-white px-5 sm:px-6 md:px-10 py-12 md:py-[72px]">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-10 sm:mb-14">
          <p className="mb-3.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            The Advantage
          </p>
          <h2 className="font-heading text-[clamp(1.75rem,3vw,2.4rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
            What Changes When You Augment with Remotiv
          </h2>
        </div>

        {ADVANTAGES.map((row, idx) => (
          <div
            key={row.label}
            className={`grid grid-cols-1 items-start gap-5 py-8 border-t border-black/[0.08] sm:gap-6 sm:py-10 md:grid-cols-[220px_1fr] md:gap-10 ${
              idx === ADVANTAGES.length - 1 ? "border-b border-black/[0.08]" : ""
            }`}
          >
            <h3 className="pt-1 font-heading text-base font-bold leading-tight text-remotiv-text-dark">
              {row.label}
            </h3>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:gap-8 lg:grid-cols-3">
              {row.cols.map((col) => (
                <div
                  key={col.heading}
                  className={`grid grid-cols-[26px_1fr] gap-x-2.5 gap-y-2.5 ${
                    row.color === "green" ? "text-remotiv-green" : "text-remotiv-purple"
                  }`}
                >
                  <div className="mt-0.5">{col.icon}</div>
                  <h4 className="self-center font-heading text-[0.92rem] font-bold text-remotiv-text-dark">
                    {col.heading}
                  </h4>
                  <p className="col-span-2 text-[0.85rem] leading-[1.72] text-[#555]">{col.body}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WhatWeStaff() {
  return (
    <section className="bg-remotiv-purple-light px-5 sm:px-8 md:px-14 py-14 md:py-20">
      <p className="mb-3.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.16em] text-white/85">
        What We Staff
      </p>
      <h2 className="mb-3.5 max-w-[680px] font-heading text-[clamp(1.6rem,2.8vw,2.2rem)] font-bold leading-[1.2] tracking-[-0.02em] text-white">
        Specialists Across Every Function and Seniority Level
      </h2>
      <p className="mb-8 sm:mb-12 max-w-[680px] text-[0.95rem] leading-[1.7] text-white/85">
        From individual contributors to fractional C-suite leaders, Remotiv covers the full
        spectrum. These are the categories our clients request most — but if your role isn&apos;t
        listed, ask us. If the skill exists in Pakistan&apos;s talent market, we can source it.
      </p>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {ROLES.map((role) => (
          <div
            key={role.name}
            className="flex min-h-[150px] sm:min-h-[180px] cursor-default flex-col items-center justify-center rounded-2xl border border-[#252525] bg-white px-3 sm:px-5 py-5 sm:py-8 text-center transition-all hover:-translate-y-0.5 hover:border-remotiv-purple hover:bg-[#f9f8ff]"
          >
            <div className="mb-3 flex size-7 items-center justify-center opacity-85">{role.icon}</div>
            <div className="mb-1 font-heading text-[0.88rem] font-semibold leading-[1.3] text-remotiv-text-dark">
              {role.name}
            </div>
            <div className="text-[0.7rem] sm:text-[0.75rem] leading-snug text-[#666]">
              {role.tags}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaInquiry() {
  const [status, setStatus] = useState<"idle" | "sending" | "success">("idle");
  const [errors, setErrors] = useState<{ name?: boolean; email?: boolean }>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const [form, setForm] = useState({
    name: "",
    company: "",
    email: "",
    role: "",
    message: "",
    companyUrl: "",
  });

  function update(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === "name" || key === "email") {
      setErrors((prev) => ({ ...prev, [key]: false }));
    }
    if (errorMessage) setErrorMessage(null);
  }

  function resetForm() {
    setForm({
      name: "",
      company: "",
      email: "",
      role: "",
      message: "",
      companyUrl: "",
    });
    setErrors({});
    setErrorMessage(null);
    setStatus("idle");
  }

  async function submit() {
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    const nextErrors = {
      name: !form.name.trim(),
      email: !form.email.trim(),
    };
    if (nextErrors.name || nextErrors.email) {
      setErrors(nextErrors);
      setErrorMessage("Please fill in your name and work email.");
      submitLockRef.current = false;
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email.trim())) {
      setErrors({ email: true });
      setErrorMessage("Please enter a valid email address.");
      submitLockRef.current = false;
      return;
    }
    setErrors({});
    setErrorMessage(null);
    setStatus("sending");

    const composedMessage = form.role.trim()
      ? `Role Needed: ${form.role.trim()}\n\n${form.message.trim()}`
      : form.message.trim();

    try {
      const timeoutPromise = new Promise<{ success: false; error: string }>(
        (resolve) =>
          setTimeout(
            () =>
              resolve({
                success: false,
                error:
                  "The request is taking too long. Please try again in a moment.",
              }),
            15000,
          ),
      );

      const result = await Promise.race([
        submitContact({
          name: form.name,
          company: form.company,
          email: form.email,
          service: "Staff Augmentation",
          message: composedMessage,
          companyUrl: form.companyUrl,
        }),
        timeoutPromise,
      ]);

      if (result.success) {
        track("inquiry_submitted", {
          source: "staff_augmentation_page",
          service: "Staff Augmentation",
        });
        setStatus("success");
      } else {
        setStatus("idle");
        setErrorMessage(result.error);
      }
    } catch {
      setStatus("idle");
      setErrorMessage(
        "Something went wrong. Please try again or email us at talent@remotiv.work.",
      );
    } finally {
      submitLockRef.current = false;
    }
  }

  return (
    <section id="inquiry" className="bg-white px-4 sm:px-5 md:px-10 py-14 md:py-20">
      <div className="mx-auto grid max-w-[900px] grid-cols-1 items-center gap-8 md:gap-14 rounded-3xl bg-remotiv-lime-card px-5 py-8 sm:px-7 sm:py-10 md:grid-cols-2 md:px-[60px] md:py-[52px]">
        <div>
          <h2 className="mb-3 font-heading text-[clamp(1.4rem,2.2vw,1.9rem)] font-extrabold leading-[1.1] tracking-[-0.02em] text-remotiv-text-dark">
            Your Next Hire Is a Week Away
          </h2>
          <p className="mb-6 text-[13px] leading-[1.75] text-remotiv-text-dark opacity-75">
            Tell us what you need. Remotiv delivers a screened, AI-matched shortlist — backed by a
            free replacement guarantee and an outcome-based engagement model.
          </p>
          <div className="mb-7 flex flex-wrap gap-2.5">
            <Link
              href="/hire-remote"
              className="inline-flex items-center rounded-full bg-remotiv-green px-6 py-[13px] sm:py-3 font-heading text-[0.82rem] font-bold text-remotiv-text-dark transition-opacity hover:opacity-[0.88]"
            >
              Get Your First Specialist →
            </Link>
            <a
              href="https://calendly.com/waleed-izww/intro-call"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-full border-[1.5px] border-[#111] px-6 py-[13px] sm:py-[11px] text-[0.82rem] font-semibold text-remotiv-text-dark transition-colors hover:bg-[#111] hover:text-white"
            >
              Book a 15-Min Call
            </a>
          </div>
          <ul className="mb-7 flex flex-col gap-2.5">
            {CHECK_ITEMS.map((item) => (
              <li key={item} className="flex items-center gap-2 text-[13px] font-medium text-remotiv-text-dark">
                <span className="flex size-[18px] flex-shrink-0 items-center justify-center rounded-full bg-white/50">
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2 6l3 3 5-5"
                      stroke="#111"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {item}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <div className="flex">
              <span className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-remotiv-lime-card bg-[#111] text-[9px] font-bold text-remotiv-lime-card">
                JC
              </span>
              <span className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-remotiv-lime-card bg-remotiv-purple text-[9px] font-bold text-white">
                SM
              </span>
              <span className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-remotiv-lime-card bg-[#333] text-[9px] font-bold text-white">
                OF
              </span>
            </div>
            <span className="ml-3 text-xs text-remotiv-text-dark opacity-65">
              Trusted by 100+ companies worldwide
            </span>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 sm:p-6 md:p-7">
          {status === "success" ? (
            <div role="status" aria-live="polite" className="py-6 text-center">
              <div className="mb-3 text-4xl">✅</div>
              <h3 className="mb-2 font-heading text-base font-bold text-remotiv-text-dark">Inquiry Sent!</h3>
              <p className="mb-4 text-[13px] text-[#666]">
                Thanks for reaching out. We&apos;ll get back to you within 24 hours.
              </p>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-full bg-[#111] px-5 py-3.5 font-heading text-[0.85rem] font-bold text-white transition-opacity hover:opacity-90"
              >
                Submit Another Inquiry
              </button>
            </div>
          ) : (
            <>
              <p className="mb-4 font-heading text-sm font-bold text-remotiv-text-dark">Send an Inquiry</p>
              {errorMessage ? (
                <p
                  id="sa-form-error"
                  role="alert"
                  aria-live="assertive"
                  className="mb-3 text-[13px] text-red-600"
                >
                  {errorMessage}
                </p>
              ) : null}
              <div className="mb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5">
                <InquiryField
                  id="sa-inq-name"
                  label="Full Name"
                  name="name"
                  placeholder="Your name"
                  value={form.name}
                  onChange={(v) => update("name", v)}
                  maxLength={80}
                  error={errors.name ? "Required" : undefined}
                  errorId={errorMessage ? "sa-form-error" : undefined}
                />
                <InquiryField
                  id="sa-inq-company"
                  label="Company"
                  name="company"
                  placeholder="Company name"
                  value={form.company}
                  onChange={(v) => update("company", v)}
                  maxLength={80}
                />
              </div>
              <InquiryField
                id="sa-inq-email"
                label="Work Email"
                name="email"
                type="email"
                placeholder="you@company.com"
                value={form.email}
                onChange={(v) => update("email", v)}
                maxLength={120}
                error={errors.email ? "Required" : undefined}
                errorId={errorMessage ? "sa-form-error" : undefined}
              />
              <InquiryField
                id="sa-inq-role"
                label="Role Needed"
                name="role"
                placeholder="e.g. Senior React Developer"
                value={form.role}
                onChange={(v) => update("role", v)}
                maxLength={120}
              />
              <div className="mb-2.5">
                <label
                  htmlFor="sa-inq-message"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-remotiv-text-mid"
                >
                  Message
                </label>
                <textarea
                  id="sa-inq-message"
                  name="message"
                  maxLength={2000}
                  aria-describedby={errorMessage ? "sa-form-error" : undefined}
                  placeholder="Tell us about the role, skills needed, and timeline..."
                  className="box-border min-h-[68px] w-full resize-none rounded-lg bg-[#f5f5f5] px-3 py-2.5 text-base sm:text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef]"
                  value={form.message}
                  onChange={(e) => update("message", e.target.value)}
                />
              </div>
              <div
                style={{
                  position: "absolute",
                  left: "-9999px",
                  width: "1px",
                  height: "1px",
                  overflow: "hidden",
                }}
                aria-hidden="true"
              >
                <label htmlFor="sa-company-url">Company URL</label>
                <input
                  id="sa-company-url"
                  type="text"
                  name="company_url"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.companyUrl}
                  onChange={(e) => update("companyUrl", e.target.value)}
                />
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={status === "sending"}
                className="mb-2.5 w-full rounded-[10px] bg-remotiv-lime-card py-3.5 font-heading text-xs font-bold uppercase tracking-[0.06em] text-remotiv-text-dark transition-all hover:-translate-y-px hover:bg-[#b8f060] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "sending" ? "Sending..." : "Send Inquiry →"}
              </button>
              <p className="m-0 flex items-center justify-center gap-1 text-center text-[10px] text-remotiv-text-light">
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#bbb"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Your data is encrypted and 100% confidential
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function InquiryField({
  label,
  placeholder,
  value,
  onChange,
  type = "text",
  name,
  id,
  maxLength,
  error,
  errorId,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  name?: string;
  id?: string;
  maxLength?: number;
  error?: string;
  errorId?: string;
}) {
  const inputId = id ?? (name ? `sa-inq-${name}` : undefined);
  return (
    <div className="mb-2.5">
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-remotiv-text-mid"
      >
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        name={name}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          error
            ? "box-border w-full rounded-lg border border-red-500 bg-[#f5f5f5] px-3 py-2.5 text-base sm:text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef] focus:border-red-500"
            : "box-border w-full rounded-lg border border-transparent bg-[#f5f5f5] px-3 py-2.5 text-base sm:text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef]"
        }
      />
      {error ? <p className="mt-1 text-[0.78rem] text-red-600">{error}</p> : null}
    </div>
  );
}

function Faq() {
  const [openIdx, setOpenIdx] = useState(0);

  return (
    <section id="faq" className="border-t border-black/[0.06] bg-white px-5 sm:px-6 md:px-10 py-14 md:py-20">
      <div className="mx-auto max-w-[1100px]">
        <div className="flex w-full flex-col items-start gap-10 md:flex-row md:gap-20">
          <div className="w-full md:basis-[35%]">
            <h2 className="mb-5 font-heading text-[clamp(1.8rem,3vw,2.6rem)] font-extrabold leading-[1.15] text-remotiv-text-dark">
              Questions We Hear Most
            </h2>
            <p className="text-[0.95rem] leading-[1.7] text-[#777]">
              For any unanswered questions, reach out to our team. We&apos;ll respond as soon as
              possible.
            </p>
          </div>

          <div className="w-full md:basis-[58%]">
            <div className="border-t border-black/10">
              {FAQS.map((item, i) => {
                const open = openIdx === i;
                return (
                  <div key={item.q} className="border-b border-black/10">
                    <button
                      type="button"
                      onClick={() => setOpenIdx(open ? -1 : i)}
                      className="flex w-full items-center justify-between gap-4 bg-transparent py-6 text-left"
                      id={`sa-faq-button-${i}`}
                      aria-expanded={open}
                      aria-controls={`sa-faq-panel-${i}`}
                    >
                      <span className="flex-1 font-heading text-[0.97rem] font-semibold leading-[1.4] text-remotiv-text-dark">
                        {item.q}
                      </span>
                      <span
                        className={`w-6 flex-shrink-0 text-center text-[1.4rem] font-light leading-none text-remotiv-text-dark transition-transform duration-200 ${
                          open ? "rotate-45" : ""
                        }`}
                      >
                        +
                      </span>
                    </button>
                    <div
                      id={`sa-faq-panel-${i}`}
                      role="region"
                      aria-labelledby={`sa-faq-button-${i}`}
                      className={`overflow-hidden transition-[max-height] duration-300 ease-out ${
                        open ? "max-h-[400px]" : "max-h-0"
                      }`}
                    >
                      <p className="pb-6 text-[0.9rem] leading-[1.75] text-[#444]">{item.a}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function StaffAugmentationPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Service",
            name: "Staff Augmentation Services",
            serviceType: "Staff Augmentation",
            provider: {
              "@type": "Organization",
              name: "Remotiv",
              url: "https://www.remotiv.work",
            },
            areaServed: "Worldwide",
            url: "https://www.remotiv.work/services/staff-augmentation",
            description:
              "Augment your team with pre-vetted senior specialists across engineering, sales, design, data, marketing, operations, and more. Matched in 24 hours, deployed in days, backed by a free replacement guarantee.",
          }),
        }}
      />
      <Navbar />
      <main id="main" className="flex-1 bg-white">
        <Hero />
        <Stats />
        <TeamIntegration />
        <FiveReasons />
        <ProcessSteps />
        <Advantage />
        <WhatWeStaff />
        <CtaInquiry />
        <Faq />
      </main>
    </>
  );
}
