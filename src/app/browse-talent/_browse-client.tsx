"use client";

import { useEffect, useMemo, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────

export type TalentRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  role_category: string | null;
  years_experience: number | null;
  industry: string | null;
  degree: string | null;
  institution: string | null;
  city: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  cv_url: string | null;
  skills: string[] | null;
  summary: string | null;
  availability: string | null;
  work_type: string | null;
  notice_period: string | null;
  work_location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  avatar_url: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  experience: Array<{
    title?: string;
    company?: string;
    start?: string;
    end?: string;
    dates?: string;
    skills?: string[];
  }> | null;
  approved_at: string | null;
  created_at: string | null;
};

type RoleType =
  | "Engineer" | "SDR" | "CS" | "Design" | "Data"
  | "DevOps" | "QA" | "Marketing" | "Ops" | "Finance";

type ExperienceItem = {
  title: string;
  company: string;
  dates: string;
  skills: string[];
};

type Card = {
  id: string;
  name: string;
  initials: string;
  role: string;
  type: RoleType;
  skills: string[];
  location: string;
  exp: string;                    // "7 years" or "—"
  yearsExperience?: number | null; // numeric form for "X years experience in …"
  industry?: string | null;
  available: boolean;
  score: number;
  highlights: string[];
  bio: string;
  fullTime: boolean;
  partTime: boolean;
  remote: boolean;
  contract?: boolean;
  hybrid?: boolean;
  onsite?: boolean;
  education?: string;             // demo data only ("Degree — Institution")
  degree?: string | null;         // real-DB form
  institution?: string | null;    // real-DB form
  lastActive: string;
  github: string | null;
  linkedin: string | null;
  email?: string | null;          // admin preview only
  phone?: string | null;          // admin preview only
  cvUrl?: string | null;          // admin preview only
  experience?: ExperienceItem[];  // demo data only
};

// ── BT_ROLE_CFG (verbatim from HTML) ─────────────────────────

const ROLE_CFG: Record<RoleType, { c: string; bg: string; b: string; label: string }> = {
  Engineer:  { c: "#60a5fa", bg: "rgba(96,165,250,0.08)",  b: "rgba(96,165,250,0.3)",  label: "Engineer" },
  SDR:       { c: "#a78bfa", bg: "rgba(167,139,250,0.08)", b: "rgba(167,139,250,0.3)", label: "Sales / SDR" },
  CS:        { c: "#34d399", bg: "rgba(52,211,153,0.08)",  b: "rgba(52,211,153,0.3)",  label: "Customer Success" },
  Design:    { c: "#fb923c", bg: "rgba(251,146,60,0.08)",  b: "rgba(251,146,60,0.3)",  label: "Design & UX" },
  Data:      { c: "#818cf8", bg: "rgba(129,140,248,0.08)", b: "rgba(129,140,248,0.3)", label: "Data & AI" },
  DevOps:    { c: "#22d3ee", bg: "rgba(34,211,238,0.08)",  b: "rgba(34,211,238,0.3)",  label: "DevOps & Cloud" },
  QA:        { c: "#f87171", bg: "rgba(248,113,113,0.08)", b: "rgba(248,113,113,0.3)", label: "QA" },
  Marketing: { c: "#fbbf24", bg: "rgba(251,191,36,0.08)",  b: "rgba(251,191,36,0.3)",  label: "Marketing" },
  Ops:       { c: "#c084fc", bg: "rgba(192,132,252,0.08)", b: "rgba(192,132,252,0.3)", label: "Business & Ops" },
  Finance:   { c: "#34d399", bg: "rgba(52,211,153,0.08)",  b: "rgba(52,211,153,0.3)",  label: "Finance" },
};

const ROLE_FILTERS: Array<{ key: "All" | RoleType; label: string; count: string; dot: string }> = [
  { key: "All",       label: "All Talent",            count: "50K+",  dot: "#49D7A7" },
  { key: "Engineer",  label: "Software Engineers",    count: "18.4K", dot: "#60a5fa" },
  { key: "SDR",       label: "SDR / Sales",           count: "12K",   dot: "#a78bfa" },
  { key: "CS",        label: "Customer Success",      count: "9.8K",  dot: "#34d399" },
  { key: "Design",    label: "Design & UX",           count: "6.2K",  dot: "#fb923c" },
  { key: "Data",      label: "Data & AI",             count: "5.1K",  dot: "#818cf8" },
  { key: "DevOps",    label: "DevOps & Cloud",        count: "4.8K",  dot: "#22d3ee" },
  { key: "QA",        label: "Quality Assurance",     count: "3.9K",  dot: "#f87171" },
  { key: "Marketing", label: "Marketing & Growth",    count: "4.2K",  dot: "#fbbf24" },
  { key: "Ops",       label: "Business & Ops",        count: "3.4K",  dot: "#c084fc" },
  { key: "Finance",   label: "Finance & Accounting",  count: "2.8K",  dot: "#34d399" },
];

// ── Demo fallback data (verbatim from HTML BT_ALL) ───────────

const DEMO_CARDS: Card[] = [
  { id: "demo-1",  name: "Ahmed Raza",      initials: "AR", role: "Senior Software Engineer",       type: "Engineer",  skills: ["React","Node.js","AWS","TypeScript","PostgreSQL"], location: "Lahore, Pakistan",   exp: "7 years", available: true,  score: 98, highlights: ["Ex-Arbisoft","Open to full-time & contract","Immediate joiner"], bio: "7+ years building scalable web apps. Led a team of 5 at Arbisoft delivering SaaS products for US clients.", fullTime: true,  partTime: true,  remote: true, education: "LUMS — BS Computer Science", lastActive: "Today",       github: "github.com/ahmedraza",      linkedin: "linkedin.com/in/ahmedraza",      experience: [{ title: "Senior Software Engineer", company: "Arbisoft", dates: "2020–Present · 4 yrs", skills: ["React","Node.js","AWS"] }, { title: "Software Engineer", company: "Systems Limited", dates: "2017–2020 · 3 yrs", skills: ["Vue.js","Python","MySQL"] }] },
  { id: "demo-2",  name: "Sara Khan",       initials: "SK", role: "Sales Development Representative", type: "SDR",      skills: ["HubSpot","Salesforce","Cold Calling","LinkedIn Sales Nav","Outreach.io"], location: "Karachi, Pakistan", exp: "4 years", available: true,  score: 95, highlights: ["Top 5% SDR","200+ cold calls/day","SaaS focused"], bio: "Consistently exceeded quota by 130%+ at B2B SaaS companies. Specialized in US market outreach.", fullTime: true, partTime: false, remote: true, education: "IBA Karachi — BBA Marketing", lastActive: "Today", github: null, linkedin: "linkedin.com/in/sarakhan", experience: [{ title: "SDR Team Lead", company: "Contour Software", dates: "2022–Present · 2 yrs", skills: ["Salesforce","Outreach.io"] }, { title: "Sales Development Rep", company: "10Pearls", dates: "2020–2022 · 2 yrs", skills: ["HubSpot","LinkedIn Sales Nav"] }] },
  { id: "demo-3",  name: "Usman Ali",       initials: "UA", role: "Customer Success Manager",        type: "CS",        skills: ["Zendesk","Gainsight","Churn Reduction","QBRs","Onboarding"], location: "Islamabad, Pakistan", exp: "5 years", available: true, score: 92, highlights: ["Reduced churn by 22%","Managed 80+ accounts","NPS champion"], bio: "CS professional managing $2M+ ARR portfolios for US SaaS startups. Expert in QBRs and renewal strategy.", fullTime: true, partTime: true, remote: true, education: "NUST — BS Business Administration", lastActive: "2 days ago", github: null, linkedin: "linkedin.com/in/usmanalics", experience: [{ title: "Customer Success Manager", company: "Motive (KeepTruckin)", dates: "2021–Present · 3 yrs", skills: ["Gainsight","QBRs"] }, { title: "CS Specialist", company: "Inbox Health", dates: "2019–2021 · 2 yrs", skills: ["Zendesk","Onboarding"] }] },
  { id: "demo-4",  name: "Fatima Malik",    initials: "FM", role: "Full Stack Developer",            type: "Engineer",  skills: ["Vue.js","Python","Django","PostgreSQL","Docker"], location: "Lahore, Pakistan", exp: "6 years", available: false, score: 97, highlights: ["Open source contributor","Built 3 funded products","AWS certified"], bio: "Full-stack engineer with deep experience in Python/Vue. Shipped products used by 100K+ users.", fullTime: true, partTime: false, remote: true, education: "FAST NUCES — BS Software Engineering", lastActive: "1 week ago", github: "github.com/fatimamalik", linkedin: "linkedin.com/in/fatimamalik", experience: [{ title: "Full Stack Engineer", company: "Shaukat Khanum IT", dates: "2021–Present · 3 yrs", skills: ["Django","PostgreSQL","Docker"] }, { title: "Frontend Developer", company: "Xord", dates: "2018–2021 · 3 yrs", skills: ["Vue.js","REST APIs"] }] },
  { id: "demo-5",  name: "Bilal Qureshi",   initials: "BQ", role: "SDR Team Lead",                   type: "SDR",       skills: ["Apollo.io","Salesloft","SaaS Sales","Pipeline Mgmt","Coaching"], location: "Karachi, Pakistan", exp: "6 years", available: true, score: 94, highlights: ["Managed team of 8 SDRs","Built outbound playbook","$1.2M pipeline/year"], bio: "Led SDR teams at two US-funded startups. Built repeatable outbound systems generating $1.2M pipeline annually.", fullTime: true, partTime: false, remote: true, education: "University of Karachi — MBA", lastActive: "Today", github: null, linkedin: "linkedin.com/in/bilalqureshi", experience: [{ title: "SDR Team Lead", company: "Podium (Remote)", dates: "2022–Present · 2 yrs", skills: ["Salesloft","Apollo.io"] }, { title: "Senior SDR", company: "DevRevamp", dates: "2018–2022 · 4 yrs", skills: ["SaaS Sales","Pipeline Mgmt"] }] },
  { id: "demo-6",  name: "Zara Hussain",    initials: "ZH", role: "Senior Customer Success Manager", type: "CS",        skills: ["Gainsight","Intercom","NPS","Product Adoption","Executive Relations"], location: "Lahore, Pakistan", exp: "8 years", available: true, score: 96, highlights: ["NPS from 32 to 67","C-suite relationships","Startup to enterprise"], bio: "8 years in customer success across fintech and logistics SaaS. Specializes in enterprise onboarding.", fullTime: true, partTime: true, remote: true, education: "LSE — MSc Management", lastActive: "3 days ago", github: null, linkedin: "linkedin.com/in/zarahussain", experience: [{ title: "Senior CSM", company: "Airlift Technologies", dates: "2020–Present · 4 yrs", skills: ["Gainsight","Executive Relations"] }, { title: "CSM", company: "Swyft Logistics", dates: "2016–2020 · 4 yrs", skills: ["Intercom","NPS","Onboarding"] }] },
  { id: "demo-7",  name: "Hassan Mir",      initials: "HM", role: "Backend Engineer",                type: "Engineer",  skills: ["Go","Kubernetes","Redis","gRPC","Terraform"], location: "Islamabad, Pakistan", exp: "5 years", available: true, score: 91, highlights: ["Microservices expert","Infra for 1M+ users","Open to relocate"], bio: "Backend engineer specializing in high-throughput distributed systems. Designed infra handling 50K req/sec.", fullTime: true, partTime: false, remote: true, education: "NUST — BS Computer Engineering", lastActive: "Today", github: "github.com/hassanmir", linkedin: "linkedin.com/in/hassanmir", experience: [{ title: "Backend Engineer", company: "Bazaar Technologies", dates: "2021–Present · 3 yrs", skills: ["Go","Kubernetes","gRPC"] }, { title: "Software Engineer", company: "Netsol Technologies", dates: "2019–2021 · 2 yrs", skills: ["Redis","Terraform"] }] },
  { id: "demo-8",  name: "Amna Sheikh",     initials: "AS", role: "SDR Manager",                     type: "SDR",       skills: ["Salesloft","Gong","Pipeline Review","Hiring & Training","RevOps"], location: "Lahore, Pakistan", exp: "7 years", available: false, score: 93, highlights: ["Hired & trained 15+ SDRs","RevOps certified","140% quota attainment"], bio: "Sales leader with 7 years growing outbound teams for Series A-C SaaS companies focused on US enterprise.", fullTime: true, partTime: false, remote: true, education: "LUMS — MBA Marketing", lastActive: "5 days ago", github: null, linkedin: "linkedin.com/in/amnasheikh", experience: [{ title: "SDR Manager", company: "Rolustech", dates: "2020–Present · 4 yrs", skills: ["Salesloft","Gong","RevOps"] }, { title: "Senior SDR", company: "VentureDive", dates: "2017–2020 · 3 yrs", skills: ["Pipeline Review","Hiring"] }] },
  { id: "demo-9",  name: "Kamran Iqbal",    initials: "KI", role: "DevOps Engineer",                 type: "DevOps",    skills: ["AWS","CI/CD","Jenkins","Ansible","Linux"], location: "Karachi, Pakistan", exp: "6 years", available: true, score: 89, highlights: ["AWS Solutions Architect","Zero-downtime deploys","Cut infra costs 40%"], bio: "DevOps engineer who reduced infrastructure costs by 40% while improving deployment frequency 3x.", fullTime: true, partTime: true, remote: true, education: "NED University — BS Computer Systems", lastActive: "Today", github: "github.com/kamraniqbal", linkedin: "linkedin.com/in/kamraniqbal", experience: [{ title: "DevOps Engineer", company: "Careem (Uber)", dates: "2021–Present · 3 yrs", skills: ["AWS","Kubernetes","CI/CD"] }, { title: "Systems Engineer", company: "TPS Pakistan", dates: "2018–2021 · 3 yrs", skills: ["Ansible","Jenkins","Linux"] }] },
  { id: "demo-10", name: "Nadia Farooq",    initials: "NF", role: "Customer Success Specialist",     type: "CS",        skills: ["Freshdesk","Onboarding","Retention","CSAT","Upsell"], location: "Lahore, Pakistan", exp: "3 years", available: true, score: 88, highlights: ["CSAT 4.9/5","Upsell $180K revenue","Strong communicator"], bio: "CS specialist turning at-risk accounts into expansion opportunities. Expert at onboarding new clients.", fullTime: true, partTime: true, remote: true, education: "UCP Lahore — BBA", lastActive: "Yesterday", github: null, linkedin: "linkedin.com/in/nadiafarooq", experience: [{ title: "CS Specialist", company: "Inbox Business Technologies", dates: "2022–Present · 2 yrs", skills: ["Freshdesk","CSAT","Upsell"] }, { title: "Support Specialist", company: "TalentedgeAI", dates: "2021–2022 · 1 yr", skills: ["Onboarding","Retention"] }] },
  { id: "demo-11", name: "Ali Hassan",      initials: "AH", role: "UI/UX Designer",                  type: "Design",    skills: ["Figma","Prototyping","Design Systems","User Research","Webflow"], location: "Lahore, Pakistan", exp: "5 years", available: true, score: 93, highlights: ["Redesigned 3 SaaS products","Led design system at scale","US clients exclusively"], bio: "Product designer who has shipped full redesigns for multiple US SaaS products, improving onboarding by 35%.", fullTime: true, partTime: true, remote: true, education: "NCA Lahore — BFA Visual Design", lastActive: "Today", github: null, linkedin: "linkedin.com/in/alihassan", experience: [{ title: "Senior Product Designer", company: "Zeal (Remote, US)", dates: "2021–Present · 3 yrs", skills: ["Figma","Design Systems","Prototyping"] }, { title: "UI Designer", company: "Tkxel", dates: "2019–2021 · 2 yrs", skills: ["User Research","Webflow"] }] },
  { id: "demo-12", name: "Sana Baig",       initials: "SB", role: "Data Scientist",                  type: "Data",      skills: ["Python","TensorFlow","SQL","Pandas","Tableau"], location: "Karachi, Pakistan", exp: "6 years", available: true, score: 95, highlights: ["ML models in production","$2M cost savings via ML","Published researcher"], bio: "Data scientist with 6 years building ML models that ship to production. Domain expertise in fintech and logistics.", fullTime: true, partTime: false, remote: true, education: "LUMS — MS Data Science", lastActive: "2 days ago", github: "github.com/sanabaig", linkedin: "linkedin.com/in/sanabaig", experience: [{ title: "Senior Data Scientist", company: "Jazz (Veon)", dates: "2021–Present · 3 yrs", skills: ["TensorFlow","Python","SQL"] }, { title: "Data Analyst", company: "Inbox Health", dates: "2018–2021 · 3 yrs", skills: ["Tableau","Pandas"] }] },
  { id: "demo-13", name: "Rehman Siddiqui", initials: "RS", role: "QA Automation Engineer",          type: "QA",        skills: ["Selenium","Cypress","Jest","API Testing","TestRail"], location: "Islamabad, Pakistan", exp: "5 years", available: true, score: 87, highlights: ["80% test automation coverage","Reduced bug rate 60%","CI/CD integration expert"], bio: "QA engineer who built automated test frameworks from scratch. Passionate about quality-first engineering culture.", fullTime: true, partTime: true, remote: true, education: "COMSATS — BS Computer Science", lastActive: "Today", github: "github.com/rehmansiddiqui", linkedin: "linkedin.com/in/rehmansiddiqui", experience: [{ title: "QA Automation Engineer", company: "Contour Software", dates: "2021–Present · 3 yrs", skills: ["Cypress","Selenium","API Testing"] }, { title: "QA Engineer", company: "Folio3", dates: "2019–2021 · 2 yrs", skills: ["Jest","TestRail"] }] },
  { id: "demo-14", name: "Mariam Khan",     initials: "MK", role: "Performance Marketing Manager",   type: "Marketing", skills: ["Google Ads","Meta Ads","SEO","HubSpot","Analytics"], location: "Lahore, Pakistan", exp: "5 years", available: false, score: 90, highlights: ["ROAS 4.2x avg","Cut CAC by 38%","$500K ad spend managed"], bio: "Performance marketer managing $500K+ in annual ad spend across Google and Meta for US ecommerce and SaaS brands.", fullTime: true, partTime: false, remote: true, education: "FAST NUCES — BBA Marketing", lastActive: "3 days ago", github: null, linkedin: "linkedin.com/in/mariamkhan", experience: [{ title: "Senior Performance Marketer", company: "EcommerceHive (Remote)", dates: "2021–Present · 3 yrs", skills: ["Google Ads","Meta Ads","Analytics"] }, { title: "Digital Marketing Exec", company: "Rozee.pk", dates: "2019–2021 · 2 yrs", skills: ["SEO","HubSpot"] }] },
  { id: "demo-15", name: "Omar Farhan",     initials: "OF", role: "Finance & Accounting Specialist", type: "Finance",   skills: ["QuickBooks","Xero","Financial Modeling","GAAP","Excel"], location: "Karachi, Pakistan", exp: "4 years", available: true, score: 86, highlights: ["ACCA qualified","US startup books managed","Month-end close expert"], bio: "ACCA-qualified accountant managing books for multiple US startups remotely. Expert in QuickBooks and Xero.", fullTime: true, partTime: true, remote: true, education: "ACCA — Full Member", lastActive: "Today", github: null, linkedin: "linkedin.com/in/omarfarhan", experience: [{ title: "Accounting Manager", company: "Remote CFO Services", dates: "2022–Present · 2 yrs", skills: ["QuickBooks","GAAP","Financial Modeling"] }, { title: "Accountant", company: "BDO Pakistan", dates: "2020–2022 · 2 yrs", skills: ["Xero","Excel"] }] },
  { id: "demo-16", name: "Hira Nadeem",     initials: "HN", role: "Business Operations Manager",     type: "Ops",       skills: ["Notion","Asana","Process Design","OKRs","Hiring Ops"], location: "Lahore, Pakistan", exp: "5 years", available: true, score: 88, highlights: ["Scaled ops team from 5 to 40","SOPs for 3 companies","OKR framework builder"], bio: "Operations manager who built and scaled operational systems for US-funded startups from seed to Series B.", fullTime: true, partTime: false, remote: true, education: "LUMS — BS Business Administration", lastActive: "Yesterday", github: null, linkedin: "linkedin.com/in/hiranadeem", experience: [{ title: "Operations Manager", company: "Tajir (YC S20)", dates: "2021–Present · 3 yrs", skills: ["Notion","OKRs","Process Design"] }, { title: "Business Analyst", company: "NetSol Technologies", dates: "2019–2021 · 2 yrs", skills: ["Asana","Hiring Ops"] }] },
];

const BLURRED_PREVIEW_CARDS: Card[] = [
  {
    id: "preview-1",
    name: "Bilal R.",
    initials: "BR",
    role: "Senior Software Engineer",
    type: "Engineer",
    skills: ["React", "Node.js", "TypeScript", "AWS"],
    location: "Lahore, Pakistan",
    exp: "6 years",
    available: true,
    score: 92,
    highlights: ["6 yrs experience"],
    bio: "Full-stack engineer with strong product sense.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-2",
    name: "Hira S.",
    initials: "HS",
    role: "Product Designer",
    type: "Design",
    skills: ["Figma", "Design Systems", "User Research"],
    location: "Karachi, Pakistan",
    exp: "5 years",
    available: true,
    score: 88,
    highlights: ["Design systems lead"],
    bio: "Product designer focused on B2B SaaS workflows.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-3",
    name: "Usman K.",
    initials: "UK",
    role: "Sales Development Rep",
    type: "SDR",
    skills: ["HubSpot", "Salesforce", "Cold Outreach"],
    location: "Islamabad, Pakistan",
    exp: "3 years",
    available: true,
    score: 85,
    highlights: ["Top quota attainment"],
    bio: "SDR with consistent quota attainment.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-4",
    name: "Ayesha M.",
    initials: "AM",
    role: "Customer Success Manager",
    type: "CS",
    skills: ["Gainsight", "Onboarding", "QBRs"],
    location: "Multan, Pakistan",
    exp: "4 years",
    available: true,
    score: 90,
    highlights: ["NPS uplift"],
    bio: "CS lead specializing in onboarding US SaaS clients.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "2 days ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-5",
    name: "Tariq H.",
    initials: "TH",
    role: "Data Scientist",
    type: "Data",
    skills: ["Python", "TensorFlow", "SQL"],
    location: "Faisalabad, Pakistan",
    exp: "7 years",
    available: false,
    score: 94,
    highlights: ["ML in production"],
    bio: "Data scientist shipping ML pipelines at scale.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "1 week ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-6",
    name: "Sana A.",
    initials: "SA",
    role: "DevOps Engineer",
    type: "DevOps",
    skills: ["AWS", "Terraform", "Kubernetes"],
    location: "Lahore, Pakistan",
    exp: "5 years",
    available: true,
    score: 87,
    highlights: ["Cut infra cost 35%"],
    bio: "DevOps engineer reducing infra cost via automation.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-7",
    name: "Hassan I.",
    initials: "HI",
    role: "QA Automation Engineer",
    type: "QA",
    skills: ["Cypress", "Selenium", "Jest"],
    location: "Karachi, Pakistan",
    exp: "4 years",
    available: true,
    score: 82,
    highlights: ["80% test coverage"],
    bio: "QA engineer focused on automation frameworks.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-8",
    name: "Mehwish K.",
    initials: "MK",
    role: "Performance Marketing Lead",
    type: "Marketing",
    skills: ["Google Ads", "Meta Ads", "Analytics"],
    location: "Islamabad, Pakistan",
    exp: "6 years",
    available: true,
    score: 89,
    highlights: ["ROAS 4x+"],
    bio: "Performance marketer managing 6-figure ad budgets.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "3 days ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-9",
    name: "Faisal Q.",
    initials: "FQ",
    role: "Business Operations Manager",
    type: "Ops",
    skills: ["Notion", "Process Design", "OKRs"],
    location: "Lahore, Pakistan",
    exp: "8 years",
    available: true,
    score: 91,
    highlights: ["Scaled ops 5x"],
    bio: "Ops manager scaling startups from seed to Series B.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-10",
    name: "Zainab N.",
    initials: "ZN",
    role: "Senior Accountant",
    type: "Finance",
    skills: ["QuickBooks", "Xero", "ACCA"],
    location: "Multan, Pakistan",
    exp: "5 years",
    available: true,
    score: 78,
    highlights: ["ACCA qualified"],
    bio: "ACCA-qualified accountant managing remote-client books.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
];

// ── Helpers ──────────────────────────────────────────────────

function getInitials(name: string): string {
  return name.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase() ?? "").join("") || "?";
}

function fmtDaysAgo(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function isRoleType(value: string | null | undefined): value is RoleType {
  return !!value && value in ROLE_CFG;
}

/** Pull a 4-digit year out of "2021", "Jan 2021", "2021 – 2024", etc. */
function extractYear(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = value.match(/(19|20)\d{2}/);
  return m ? Number.parseInt(m[0], 10) : null;
}

/**
 * Derive total years of experience from a JSONB experience array.
 *   - Earliest start year → latest end year
 *   - "Present" or empty end falls back to current year
 *   - Returns null when no usable years can be parsed
 */
function deriveYears(
  experience: Array<{ start?: string; end?: string; dates?: string }> | null | undefined,
): number | null {
  if (!experience || experience.length === 0) return null;
  const now = new Date().getFullYear();
  const starts: number[] = [];
  const ends: number[] = [];
  for (const e of experience) {
    const s = extractYear(e.start) ?? extractYear(e.dates?.split(/[–\-]/)[0]);
    if (s !== null) starts.push(s);
    if (e.end && /present/i.test(e.end)) {
      ends.push(now);
    } else {
      const en = extractYear(e.end) ?? extractYear(e.dates?.split(/[–\-]/)[1]) ?? now;
      ends.push(en);
    }
  }
  if (starts.length === 0) return null;
  const earliest = Math.min(...starts);
  const latest   = ends.length > 0 ? Math.max(...ends) : now;
  return Math.max(0, latest - earliest);
}

function rowToCard(r: TalentRow): Card {
  const fullName = `${r.first_name} ${r.last_name ?? ""}`.trim();
  const type: RoleType = isRoleType(r.role_category) ? r.role_category : "Engineer";
  const skills = (r.skills ?? []).slice(0, 8);

  // Derive role + years from the experience JSONB array (the form no longer
  // collects standalone job_title / years_experience / industry).
  // Latest entry = first item (form lists them top-to-bottom newest first).
  const expArr = Array.isArray(r.experience) ? r.experience : [];
  const latestExp = expArr[0];
  const derivedRole = latestExp?.title?.trim() || r.job_title || "—";
  const derivedYears = deriveYears(expArr) ?? r.years_experience ?? null;

  const score = Math.min(99, 70 + (derivedYears ?? 0) * 2 + skills.length);
  const available = (r.availability ?? "").toLowerCase().includes("available");
  const highlights = [
    r.work_type && r.work_type !== "Any" ? r.work_type : null,
    r.notice_period,
    r.work_location,
  ].filter(Boolean) as string[];
  return {
    id: r.id,
    name: fullName || "Unnamed",
    initials: getInitials(fullName),
    role: derivedRole,
    type,
    skills,
    location: [r.city, r.country].filter(Boolean).join(", ") || "—",
    exp: derivedYears != null ? `${derivedYears} years` : "—",
    yearsExperience: derivedYears,
    industry: r.industry,
    available,
    score,
    highlights,
    bio: r.summary ?? "",
    fullTime: (r.work_type ?? "").toLowerCase().includes("full"),
    partTime: (r.work_type ?? "").toLowerCase().includes("part"),
    contract: (r.work_type ?? "").toLowerCase().includes("contract"),
    remote:   (r.work_location ?? "").toLowerCase().includes("remote"),
    hybrid:   (r.work_location ?? "").toLowerCase().includes("hybrid"),
    onsite:   (r.work_location ?? "").toLowerCase().includes("onsite"),
    degree: r.degree,
    institution: r.institution,
    lastActive: fmtDaysAgo(r.created_at),
    github: r.github_url,
    linkedin: r.linkedin_url,
    email: r.email,
    phone: r.phone,
    cvUrl: r.cv_url,
    experience: Array.isArray(r.experience) && r.experience.length > 0
      ? r.experience.map((e) => ({
          title:   typeof e.title   === "string" ? e.title   : "",
          company: typeof e.company === "string" ? e.company : "",
          dates:   typeof e.dates   === "string" ? e.dates   : "",
          skills:  Array.isArray(e.skills) ? e.skills : [],
        }))
      : undefined,
  };
}

// ── Inline SVG icons (verbatim from HTML btRenderList SVGs) ──

function GhSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function LiSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// ── btScore() helper — verbatim from HTML ────────────────────

function BtMatchBadge({ score }: { score: number }) {
  const c = score >= 95 ? "#49D7A7" : score >= 90 ? "#60a5fa" : "#fb923c";
  return (
    <div
      className="bt-match-badge"
      style={{ background: `${c}12`, borderColor: `${c}40`, color: c }}
    >
      <svg width="8" height="8" viewBox="0 0 10 10" fill={c}>
        <polygon points="5,0 6.2,3.8 10,3.8 7,6.1 8.1,10 5,7.6 1.9,10 3,6.1 0,3.8 3.8,3.8" />
      </svg>
      {score}%
    </div>
  );
}

// ── Card item (matches .bt-cand-card structure exactly) ──────

function CardItem({
  c,
  saved,
  onView,
  onSave,
  onLocked,
  index,
  tier = "free",
}: {
  c: Card;
  saved: boolean;
  onView: () => void;
  onSave: () => void;
  onLocked: () => void;
  index: number;
  tier?: "free" | "subscriber";
}) {
  const cfg = ROLE_CFG[c.type];
  return (
    <div
      className="bt-cand-card"
      onClick={onView}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onView(); } }}
      style={{ animation: `btFadeIn .35s ease ${index * 0.04}s both` }}
    >
      <div className="bt-card-left">
        <div className="bt-cand-row1">
          <span className="bt-cand-name">{c.name}</span>
          <span
            className="bt-role-badge"
            style={{ color: cfg.c, borderColor: cfg.b, background: cfg.bg }}
          >
            {cfg.label}
          </span>
          <span className={c.available ? "bt-avail-yes" : "bt-avail-no"}>
            {c.available ? "● Available" : "○ Unavailable"}
          </span>
          <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#ccc", fontFamily: "'DM Sans',sans-serif" }}>
            {c.lastActive}
          </span>
        </div>
        <div className="bt-cand-row2">
          {c.role} · 📍 {c.location} · {c.exp} exp
        </div>
        {c.bio && <div className="bt-cand-bio">{c.bio}</div>}
        <div className="bt-skills-row">
          {c.skills.map((s) => (
            <span key={s} className="bt-skill-tag">{s}</span>
          ))}
        </div>
        {c.highlights.length > 0 && (
          <div className="bt-highlights-row">
            {c.highlights.map((h) => (
              <span key={h} className="bt-hl-tag">✦ {h}</span>
            ))}
          </div>
        )}
        <div className="bt-card-links" onClick={(e) => e.stopPropagation()} role="presentation">
          {c.github && (
            tier === "subscriber" ? (
              <a
                className="bt-clink"
                href={ensureHttpUrl(c.github) ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
              >
                <GhSvg />
                GitHub
              </a>
            ) : (
              <button type="button" className="bt-clink" onClick={onLocked}>
                <GhSvg />
                GitHub
              </button>
            )
          )}
          {tier === "subscriber" && c.linkedin ? (
            <a
              className="bt-clink"
              href={ensureHttpUrl(c.linkedin) ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              <LiSvg />
              LinkedIn
            </a>
          ) : (
            <button type="button" className="bt-clink" onClick={onLocked}>
              <LiSvg />
              LinkedIn
            </button>
          )}
          {tier === "subscriber" && c.cvUrl ? (
            <a
              className="bt-clink"
              href={c.cvUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Resume ✦
            </a>
          ) : (
            <button type="button" className="bt-clink" onClick={onLocked}>
              Resume ✦
            </button>
          )}
        </div>
      </div>
      <div className="bt-card-right">
        <BtMatchBadge score={c.score} />
        <button
          type="button"
          className="bt-view-btn"
          onClick={(e) => { e.stopPropagation(); onView(); }}
        >
          View Profile
        </button>
        <button
          type="button"
          className={cn("bt-save-btn", saved && "saved")}
          onClick={(e) => { e.stopPropagation(); onSave(); }}
        >
          {saved ? "♥ Saved" : "♡ Save"}
        </button>
      </div>
    </div>
  );
}

// ── Profile modal (matches .bt-modal-overlay structure) ──────

function ensureHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("http://") || url.startsWith("https://")
    ? url
    : `https://${url}`;
}

function ProfileModal({
  c,
  saved,
  tier = "free",
  onSave,
  onClose,
  onLocked,
}: {
  c: Card;
  saved: boolean;
  tier?: "free" | "subscriber";
  onSave: () => void;
  onClose: () => void;
  onLocked: () => void;
}) {
  const cfg = ROLE_CFG[c.type];

  // Resolve degree + institution from either the demo string ("Degree — School")
  // or the real-DB fields.
  let degree = "";
  let school = "";
  if (c.education) {
    const [d, s] = c.education.split("—");
    degree = d?.trim() ?? "";
    school = s?.trim() ?? "";
  } else {
    degree = c.degree ?? "";
    school = c.institution ?? "";
  }
  const hasEducation = Boolean(degree || school);
  const eduInline = c.education ?? [c.degree, c.institution].filter(Boolean).join(" — ");
  // Experience: always render the JSONB array if present. Empty array →
  // explicit "No work experience added" empty state.
  const hasExperienceArray = !!c.experience && c.experience.length > 0;

  return (
    <div
      className="bt-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="bt-modal-panel" onClick={(e) => e.stopPropagation()} role="presentation">
        {tier === "subscriber" && (
          <div className="bt-admin-banner" role="status">
            <span aria-hidden>🔓</span>
            Admin Preview — viewing unlocked content
          </div>
        )}
        <div className="bt-modal-header">
          <div>
            <div
              className="bt-modal-avatar"
              style={{ background: cfg.bg, borderColor: cfg.b, color: cfg.c }}
            >
              {c.initials}
            </div>
          </div>
          <div className="bt-modal-meta">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <div className="bt-modal-name">{c.name}</div>
              <BtMatchBadge score={c.score} />
            </div>
            <div className="bt-modal-role">{c.role}</div>
            <div className="bt-modal-info">
              📍 {c.location} · {c.exp} experience{eduInline ? ` · ${eduInline}` : ""}
            </div>
            <div className="bt-profile-links">
              {c.github && (
                tier === "subscriber" ? (
                  <a
                    className="bt-plink"
                    href={ensureHttpUrl(c.github) ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                ) : (
                  <button type="button" className="bt-plink" onClick={onLocked}>GitHub</button>
                )
              )}
              {tier === "subscriber" && c.linkedin ? (
                <a
                  className="bt-plink"
                  href={ensureHttpUrl(c.linkedin) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  LinkedIn
                </a>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>LinkedIn</button>
              )}
              {tier === "subscriber" && c.cvUrl ? (
                <a
                  className="bt-plink"
                  href={c.cvUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Resume ✦
                </a>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>Resume ✦</button>
              )}
            </div>
          </div>
          <button
            type="button"
            className="bt-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div className="bt-modal-body">
          {c.bio && (
            <>
              <div className="bt-modal-sec-title">Summary</div>
              <p
                style={{
                  margin: "0 0 20px",
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.85rem",
                  color: "#555",
                  lineHeight: 1.7,
                  whiteSpace: "pre-line",
                }}
              >
                {c.bio}
              </p>
            </>
          )}

          <div className="bt-modal-sec-title">Experience</div>
          <div style={{ marginBottom: 20 }}>
            {hasExperienceArray ? (
              c.experience?.map((exp, i) => (
                <div key={`${exp.company}-${i}`} className="bt-exp-item">
                  <div className="bt-exp-logo">🏢</div>
                  <div style={{ flex: 1 }}>
                    <div className="bt-exp-title">{exp.title}</div>
                    <div className="bt-exp-company">{exp.company}</div>
                    <div className="bt-exp-dates">{exp.dates}</div>
                    <div className="bt-exp-skills">
                      {(exp.skills ?? []).map((s, j) => (
                        <span key={`${s}-${j}`} className="bt-exp-skill">{s}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  border: "1px dashed rgba(0,0,0,0.1)",
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.82rem",
                  color: "#aaa",
                  textAlign: "center",
                }}
              >
                No work experience added
              </p>
            )}
          </div>

          {hasEducation && (
            <>
              <div className="bt-modal-sec-title">Education</div>
              <div style={{ marginBottom: 20 }}>
                <div className="bt-edu-row">
                  {degree && <div className="bt-edu-degree">{degree}</div>}
                  {school && <div className="bt-edu-school">{school}</div>}
                </div>
              </div>
            </>
          )}

          <div className="bt-modal-sec-title">Skills</div>
          <div className="bt-modal-skills">
            {c.skills.map((s) => (
              <span key={s} className="bt-modal-skill">{s}</span>
            ))}
          </div>

          <div className="bt-modal-sec-title">Open To</div>
          <div className="bt-open-to" style={{ marginBottom: 20 }}>
            {c.fullTime && (
              <span className="bt-ot-tag" style={{ color: "#49D7A7", borderColor: "rgba(73,215,167,.3)", background: "rgba(73,215,167,.08)" }}>
                Full-time
              </span>
            )}
            {c.partTime && (
              <span className="bt-ot-tag" style={{ color: "#34d399", borderColor: "rgba(52,211,153,.3)", background: "rgba(52,211,153,.07)" }}>
                Part-time
              </span>
            )}
            {c.contract && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Contract
              </span>
            )}
            {c.remote && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Remote
              </span>
            )}
            {c.hybrid && (
              <span className="bt-ot-tag" style={{ color: "#fb923c", borderColor: "rgba(251,146,60,.3)", background: "rgba(251,146,60,.07)" }}>
                Hybrid
              </span>
            )}
            {c.onsite && (
              <span className="bt-ot-tag" style={{ color: "#60a5fa", borderColor: "rgba(96,165,250,.3)", background: "rgba(96,165,250,.07)" }}>
                Onsite
              </span>
            )}
          </div>

          {tier === "subscriber" ? (
            <div className="bt-unlocked-box">
              <div className="bt-unlocked-head">
                <span aria-hidden>🔓</span>
                <div>
                  <div className="bt-unlocked-title">Contact Details</div>
                  <div className="bt-unlocked-sub">Visible to admins only</div>
                </div>
              </div>
              <div className="bt-unlocked-rows">
                {c.email && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Email</span>
                    <a href={`mailto:${c.email}`} className="bt-unlocked-link">{c.email}</a>
                  </div>
                )}
                {c.phone && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Phone</span>
                    <a href={`tel:${c.phone}`} className="bt-unlocked-link">{c.phone}</a>
                  </div>
                )}
                {c.linkedin && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">LinkedIn</span>
                    <a
                      href={ensureHttpUrl(c.linkedin) ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bt-unlocked-link"
                    >
                      {c.linkedin}
                    </a>
                  </div>
                )}
                {c.cvUrl && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">CV</span>
                    <a
                      href={c.cvUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bt-unlocked-link"
                    >
                      View CV
                    </a>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bt-locked-box">
              <div className="bt-locked-icon">🔒</div>
              <div>
                <div className="bt-locked-title">Unlock Full Contact Details</div>
                <div className="bt-locked-sub">Subscribe to view phone, email, LinkedIn, and references</div>
              </div>
            </div>
          )}

          <div className="bt-modal-actions">
            {tier !== "subscriber" && (
              <button
                type="button"
                className="bt-btn-unlock"
                onClick={() => { onClose(); onLocked(); }}
              >
                Unlock &amp; Contact
              </button>
            )}
            <button
              type="button"
              className={cn("bt-btn-save-modal", saved && "saved")}
              onClick={onSave}
            >
              {saved ? "♥ Saved" : "♡ Save Profile"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hero (mosaic background, verbatim from HTML #bth-wrap) ───

type HeroCard = {
  initials: string;
  name: string;
  role: string;
  skills: string[];
  avatarBg: string;
  avatarText: string;
  featured?: boolean;
};

const HERO_CARDS: HeroCard[] = [
  { initials: "AK", name: "Ayesha Khan", role: "Full-Stack Engineer · 5 yrs", skills: ["React", "Node.js", "AWS"], avatarBg: "#EDE8FF", avatarText: "#7E47FF", featured: true },
  { initials: "ZM", name: "Zain Malik",  role: "Product Designer · 4 yrs",   skills: ["Figma", "UX Research"],     avatarBg: "#D9F7ED", avatarText: "#1A8F65" },
  { initials: "SR", name: "Sara Raza",   role: "Data Analyst · 3 yrs",       skills: ["Python", "SQL", "Tableau"], avatarBg: "#EDFFD3", avatarText: "#4A7A10" },
];

// Mosaic constants — match the HTML's IIFE (size 80, gap 6, 7 rows).
const MOSAIC_TILE = 80;
const MOSAIC_GAP = 6;
const MOSAIC_ROWS = 7;

function Hero() {
  // Compute the number of mosaic columns based on the rendered width so the
  // pattern stretches edge-to-edge regardless of viewport. Mirrors the HTML
  // <script> at line 4129 — runs once on mount + on resize.
  const [cols, setCols] = useState(24); // SSR-safe default; recalculated on mount

  useEffect(() => {
    function recompute() {
      const w = window.innerWidth || 1440;
      setCols(Math.ceil((w + MOSAIC_GAP) / (MOSAIC_TILE + MOSAIC_GAP)));
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);

  return (
    <section id="bth-wrap">
      <div id="bth-mosaic" aria-hidden>
        {Array.from({ length: MOSAIC_ROWS }).flatMap((_, r) =>
          Array.from({ length: cols }).map((_unused, c) => (
            <div
              key={`tile-${r}-${c}`}
              style={{
                position: "absolute",
                width: MOSAIC_TILE,
                height: MOSAIC_TILE,
                borderRadius: 10,
                background: "#F8F4F1",
                left: c * (MOSAIC_TILE + MOSAIC_GAP),
                top: r * (MOSAIC_TILE + MOSAIC_GAP),
                zIndex: 0,
              }}
            />
          )),
        )}
      </div>

      <div className="bth-center">
        <h1 className="bth-heading">
          <span className="bth-accent">1M+</span> Talent Profiles,
          <br />
          Ready to Join Your Team
        </h1>
        <p className="bth-subtext">
          Browse 1M+ engineers, sales talent, and operators from best companies
          — find your next hire in hours, not weeks.
        </p>
      </div>

      <div className="bth-cards">
        <div className="bth-avail-pill">Available now</div>
        <div className="bth-cards-list">
          {HERO_CARDS.map((card) => (
            <div
              key={card.name}
              className={cn("bth-card", card.featured ? "bth-card-featured" : "bth-card-default")}
            >
              <div
                className="bth-avatar"
                style={{ background: card.avatarBg, color: card.avatarText }}
              >
                {card.initials}
              </div>
              <div className="bth-card-info">
                <div className="bth-card-name">{card.name}</div>
                <div className="bth-card-role">{card.role}</div>
                <div className="bth-card-skills">
                  {card.skills.map((s) => (
                    <span key={s} className="bth-skill-tag">{s}</span>
                  ))}
                </div>
              </div>
              <div className="bth-open-badge">
                <span className="bth-open-dot" />
                Open
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Main client component ────────────────────────────────────

export function BrowseClient({
  realProfiles,
  tier = "free",
}: {
  realProfiles: TalentRow[];
  tier?: "free" | "subscriber";
}) {
  const cards: Card[] = useMemo(() => {
    if (realProfiles.length === 0) return DEMO_CARDS;
    return realProfiles.map(rowToCard);
  }, [realProfiles]);

  const [activeRole, setActiveRole] = useState<"All" | RoleType>("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"match" | "name">("match");
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [openCard, setOpenCard] = useState<Card | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ESC closes the modal
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenCard(null);
        setDrawerOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Body scroll lock when modal open
  useEffect(() => {
    if (!openCard) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [openCard]);

  // Body scroll lock when drawer open
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let l = cards.filter((c) => {
      if (activeRole !== "All" && c.type !== activeRole) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.role.toLowerCase().includes(q) ||
        c.skills.some((s) => s.toLowerCase().includes(q))
      );
    });
    l = sort === "match"
      ? [...l].sort((a, b) => b.score - a.score)
      : [...l].sort((a, b) => a.name.localeCompare(b.name));
    return l;
  }, [cards, activeRole, query, sort]);

  function toggleSave(id: string) {
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function lockedAction() {
    setToast("🔒 Subscribe to unlock full access — payment setup in progress.");
  }

  const renderSidebarContent = (onSelect?: () => void) => (
    <>
      <div className="bt-sbox">
        <div className="bt-sbox-title">Talent Pool</div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Total Candidates</span>
          <span className="bt-pool-val" style={{ color: "#49D7A7" }}>50,000+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Engineers</span>
          <span className="bt-pool-val" style={{ color: "#60a5fa" }}>18,400+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">SDR / Sales</span>
          <span className="bt-pool-val" style={{ color: "#a78bfa" }}>12,000+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Customer Success</span>
          <span className="bt-pool-val" style={{ color: "#34d399" }}>9,800+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Designers</span>
          <span className="bt-pool-val" style={{ color: "#fb923c" }}>6,200+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Available Now</span>
          <span className="bt-pool-val" style={{ color: "#49D7A7" }}>31,200+</span>
        </div>
      </div>

      <div className="bt-sbox">
        <div className="bt-sbox-title">Role Type</div>
        {ROLE_FILTERS.map((r) => (
          <button
            key={r.key}
            type="button"
            className={cn("bt-role-chip", activeRole === r.key && "sel")}
            onClick={() => { setActiveRole(r.key); onSelect?.(); }}
          >
            <div className="bt-rc-left">
              <span className="bt-rc-dot" style={{ background: r.dot }} />
              <span className="bt-rc-name">{r.label}</span>
            </div>
            <span className="bt-rc-count">{r.count}</span>
          </button>
        ))}
      </div>
    </>
  );

  const isFiltered = activeRole !== "All" || query.trim() !== "";
  const visibleCards = filtered.slice(0, 15);
  const shouldShowPaywall = tier === "free" && realProfiles.length > 0;

  return (
    <>
      <Navbar />
      <main className="bg-white">
        <Hero />

        <div className="bt-page-wrap">
          {/* ── SIDEBAR ── */}
          <aside className="bt-sidebar">
            {renderSidebarContent()}
          </aside>

          {/* ── MAIN ── */}
          <div className="bt-main">
            <div className="bt-mobile-toolbar">
              <button
                type="button"
                className="bt-filters-trigger"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open filters"
              >
                <span aria-hidden="true">☰</span>
                Filters
              </button>
            </div>
            <div className="bt-search-bar">
              <div className="bt-search-wrap">
                <span className="bt-search-icon">⌕</span>
                <input
                  className="bt-search-input"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, role, or skill (e.g. React, Salesforce, Gainsight)..."
                />
              </div>
              <select
                className="bt-sort-select"
                value={sort}
                onChange={(e) => setSort(e.target.value as "match" | "name")}
              >
                <option value="match">Sort: Match Score</option>
                <option value="name">Name A-Z</option>
              </select>
            </div>

            <div className="bt-result-meta">
              <p className="bt-result-count">
                Showing <strong>{filtered.length}</strong> candidates out of <strong>50,000+</strong> total
                {isFiltered && <span className="bt-filtered-tag">(filtered)</span>}
              </p>
              <span className="bt-unlock-hint">🔒 Subscribe to unlock contact details</span>
            </div>

            <div className="bt-cand-list">
              {filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px 20px", color: "#bbb", fontFamily: "'DM Sans',sans-serif" }}>
                  No candidates found. Try a different search or filter.
                </div>
              ) : (
                <>
                  {visibleCards.map((c, i) => (
                    <CardItem
                      key={c.id}
                      c={c}
                      saved={savedIds.has(c.id)}
                      onView={() => setOpenCard(c)}
                      onSave={() => toggleSave(c.id)}
                      onLocked={lockedAction}
                      index={i}
                      tier={tier}
                    />
                  ))}
                  {shouldShowPaywall && (
                    <div className="bt-blurred-section">
                      <div
                        className="bt-blurred-cards"
                        aria-hidden="true"
                        inert
                      >
                        {BLURRED_PREVIEW_CARDS.map((c, i) => (
                          <CardItem
                            key={`blur-${c.id}`}
                            c={c}
                            saved={false}
                            onView={() => {}}
                            onSave={() => {}}
                            onLocked={() => {}}
                            index={i + 15}
                            tier={tier}
                          />
                        ))}
                      </div>
                      <div
                        className="bt-paywall-overlay"
                        role="region"
                        aria-label="Subscription required"
                      >
                        <div className="bt-paywall-icon" aria-hidden="true">🔒</div>
                        <div className="bt-paywall-title">10+ more candidates</div>
                        <div className="bt-paywall-sub">
                          Subscribe to unlock the full talent pool
                        </div>
                        <button
                          type="button"
                          className="bt-paywall-cta"
                          onClick={lockedAction}
                        >
                          Subscribe to View
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>
      </main>
      <Footer />

      {drawerOpen && (
        <>
          <div
            className="bt-drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
            role="presentation"
          />
          <aside className="bt-drawer" role="dialog" aria-label="Filters">
            <div className="bt-drawer-header">
              <span className="bt-drawer-title">Filters</span>
              <button
                type="button"
                className="bt-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close filters"
              >
                ×
              </button>
            </div>
            <div className="bt-drawer-body">
              {renderSidebarContent(() => setDrawerOpen(false))}
            </div>
            <div className="bt-drawer-footer">
              <button
                type="button"
                className="bt-drawer-apply"
                onClick={() => setDrawerOpen(false)}
              >
                Apply Filters
              </button>
            </div>
          </aside>
        </>
      )}

      {openCard && (
        <ProfileModal
          c={openCard}
          saved={savedIds.has(openCard.id)}
          tier={tier}
          onSave={() => toggleSave(openCard.id)}
          onClose={() => setOpenCard(null)}
          onLocked={lockedAction}
        />
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 1000,
            background: "#111",
            color: "#fff",
            padding: "12px 16px",
            borderRadius: 12,
            fontFamily: "'DM Sans',sans-serif",
            fontSize: ".85rem",
            fontWeight: 500,
            boxShadow: "0 8px 32px rgba(0,0,0,.15)",
          }}
        >
          {toast}
        </div>
      )}

      {/* ─────────── Verbatim CSS from HTML <style> block ─────────── */}
      <style jsx global>{`
        /* ── Hero (mosaic background) — verbatim from HTML #page-browse ── */
        #bth-wrap {
          width: 100%;
          min-height: 596px;
          background: #FFFFFF;
          position: relative;
          overflow: hidden;
          box-sizing: border-box;
          isolation: isolate;
          z-index: 1;
        }
        #bth-mosaic {
          position: absolute;
          inset: 0;
          z-index: 0;
        }
        .bth-center {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .bth-heading {
          font-family: 'Sora', sans-serif;
          font-size: 52px;
          font-weight: 700;
          line-height: 1.08;
          color: #111;
          margin-bottom: 20px;
          letter-spacing: -1.5px;
        }
        .bth-heading .bth-accent { color: #9886FE; }
        .bth-subtext {
          font-family: 'DM Sans', sans-serif;
          font-size: 16px;
          color: #888;
          line-height: 1.65;
          max-width: 520px;
          font-weight: 400;
          margin: 0;
        }
        .bth-cards {
          position: absolute;
          top: 50%;
          right: 40px;
          transform: translateY(-50%);
          width: 280px;
          z-index: 2;
        }
        .bth-avail-pill {
          position: absolute;
          top: -14px;
          left: 50%;
          transform: translateX(-50%);
          background: #7E47FF;
          color: #fff;
          font-size: 11px;
          font-family: 'DM Sans', sans-serif;
          font-weight: 600;
          border-radius: 20px;
          padding: 4px 14px;
          white-space: nowrap;
          z-index: 4;
        }
        .bth-cards-list { display: flex; flex-direction: column; gap: 10px; }
        .bth-card {
          background: #fff;
          border-radius: 14px;
          padding: 13px 15px;
          display: flex;
          align-items: center;
          gap: 11px;
        }
        .bth-card.bth-card-featured { border: 1.5px solid #c8b5ff; }
        .bth-card.bth-card-default  { border: 0.5px solid #e5e0da; }
        .bth-avatar {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          flex-shrink: 0;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-info { flex: 1; min-width: 0; }
        .bth-card-name {
          font-size: 13px;
          font-weight: 600;
          color: #1a1a1a;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-role {
          font-size: 11px;
          color: #aaa;
          margin-top: 1px;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-skills {
          display: flex;
          gap: 4px;
          margin-top: 5px;
          flex-wrap: wrap;
        }
        .bth-skill-tag {
          font-size: 10px;
          background: #F8F4F1;
          color: #777;
          border-radius: 4px;
          padding: 2px 6px;
          border: 0.5px solid #e5e0da;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-open-badge {
          display: flex;
          align-items: center;
          gap: 4px;
          background: #F0EBFF;
          color: #7E47FF;
          font-size: 10px;
          font-weight: 600;
          border-radius: 20px;
          padding: 3px 9px;
          flex-shrink: 0;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-open-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #49D7A7;
          display: inline-block;
        }
        .bt-filters-trigger { display: none; }
        .bt-drawer-backdrop { display: none; }
        .bt-drawer { display: none; }
        @keyframes bt-drawer-in {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @media (max-width: 1024px) {
          .bth-cards { display: none; }
          .bth-heading { font-size: 40px; }
        }

        .bt-page-wrap { display: grid; grid-template-columns: 240px 1fr; min-height: 80vh; background: #ffffff; position: relative; z-index: 1; }
        .bt-sidebar { border-right: 1px solid rgba(126,71,255,0.12); position: sticky; top: 80px; height: calc(100vh - 80px); overflow-y: auto; scrollbar-width: none; background: #ffffff; }
        .bt-sidebar::-webkit-scrollbar { display: none; }
        .bt-sbox { border-bottom: 1px solid rgba(126,71,255,0.08); padding: 16px 18px; }
        .bt-sbox-title { font-family: "DM Sans",sans-serif; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7E47FF; padding: 10px 0; display: flex; align-items: center; gap: 8px; }
        .bt-sbox-title::before { content: ""; width: 12px; height: 1px; background: #7E47FF; }
        .bt-pool-stat { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid rgba(0,0,0,0.04); }
        .bt-pool-stat:last-child { border-bottom: none; }
        .bt-pool-label { font-family: "DM Sans",sans-serif; font-size: 0.72rem; color: #777; }
        .bt-pool-val { font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 700; }
        .bt-role-chip { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border: none; background: none; cursor: pointer; transition: background 0.15s; margin-bottom: 1px; border-radius: 8px; }
        .bt-role-chip:hover { background: rgba(126,71,255,0.07); }
        .bt-role-chip.sel { background: rgba(126,71,255,0.1); }
        .bt-rc-left { display: flex; align-items: center; gap: 8px; }
        .bt-rc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
        .bt-rc-name { font-family: "DM Sans",sans-serif; font-size: 0.78rem; color: #555; }
        .bt-role-chip.sel .bt-rc-name { color: #7E47FF; font-weight: 600; }
        .bt-rc-count { font-family: "DM Sans",sans-serif; font-size: 0.65rem; color: #aaa; background: rgba(0,0,0,0.04); padding: 1px 6px; border-radius: 4px; }
        .bt-role-chip.sel .bt-rc-count { color: #7E47FF; background: rgba(126,71,255,0.1); }
        .bt-main { padding: 28px 32px 80px; min-width: 0; background: #ffffff; }
        .bt-search-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(126,71,255,0.1); padding-bottom: 16px; }
        .bt-search-wrap { flex: 1; position: relative; }
        .bt-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #aaa; pointer-events: none; font-size: 1rem; }
        .bt-search-input { width: 100%; padding: 11px 12px 11px 36px; border: 1px solid rgba(126,71,255,0.18); border-radius: 10px; background: #fff; color: #111; font-family: "DM Sans",sans-serif; font-size: 0.88rem; outline: none; transition: border-color 0.2s; }
        .bt-search-input:focus { border-color: #7E47FF; }
        .bt-search-input::placeholder { color: #bbb; }
        .bt-sort-select { padding: 11px 14px; border: 1px solid rgba(126,71,255,0.18); border-radius: 10px; background: #fff; color: #555; font-family: "DM Sans",sans-serif; font-size: 0.84rem; cursor: pointer; outline: none; }
        .bt-result-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .bt-result-count { font-family: "DM Sans",sans-serif; font-size: 0.82rem; color: #777; }
        .bt-result-count strong { color: #111; }
        .bt-filtered-tag {
          margin-left: 6px;
          font-family: "DM Sans",sans-serif;
          font-size: 0.75rem;
          font-style: italic;
          color: #9886fe;
        }
        .bt-unlock-hint { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #9886fe; }
        .bt-cand-list { display: flex; flex-direction: column; gap: 10px; }
        .bt-blurred-section {
          position: relative;
          margin-top: 12px;
        }
        .bt-blurred-cards {
          display: flex;
          flex-direction: column;
          gap: 10px;
          filter: blur(8px);
          opacity: 0.6;
          pointer-events: none;
          user-select: none;
        }
        .bt-paywall-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.5) 0%,
            rgba(255,255,255,0.95) 35%,
            rgba(255,255,255,0.95) 65%,
            rgba(255,255,255,0.5) 100%
          );
          padding: 24px;
          text-align: center;
          border-radius: 16px;
        }
        .bt-paywall-icon { font-size: 28px; margin-bottom: 8px; }
        .bt-paywall-title {
          font-family: "Sora",sans-serif;
          font-size: 1.05rem;
          font-weight: 700;
          color: #111;
          margin-bottom: 4px;
        }
        .bt-paywall-sub {
          font-family: "DM Sans",sans-serif;
          font-size: 0.85rem;
          color: #555;
          margin-bottom: 14px;
          max-width: 280px;
        }
        .bt-paywall-cta {
          padding: 11px 22px;
          background: #7E47FF;
          color: #fff;
          border: none;
          border-radius: 10px;
          font-family: "DM Sans",sans-serif;
          font-size: 0.88rem;
          font-weight: 700;
          cursor: pointer;
        }
        .bt-paywall-cta:hover { background: #6f3aef; }
        .bt-cand-card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 16px; padding: 22px 24px; display: grid; grid-template-columns: 1fr auto; gap: 20px; cursor: pointer; transition: border-color 0.2s, box-shadow 0.2s, transform 0.18s; position: relative; overflow: hidden; }
        .bt-cand-card::before { content: ""; position: absolute; top: 0; left: 0; width: 3px; height: 0; background: #49D7A7; border-radius: 0 0 3px 3px; transition: height 0.28s; }
        .bt-cand-card:hover { border-color: #49D7A7; box-shadow: 0 8px 32px rgba(73,215,167,0.1); transform: translateY(-1px); }
        .bt-cand-card:hover::before { height: 100%; }
        .bt-card-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; min-width: 140px; flex-shrink: 0; }
        .bt-cand-row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
        .bt-cand-name { font-family: "Sora",sans-serif; font-size: 1rem; font-weight: 700; color: #111; }
        .bt-role-badge { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 9px; border: 1px solid; border-radius: 999px; }
        .bt-avail-yes { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; color: #49D7A7; }
        .bt-avail-no { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; color: #aaa; }
        .bt-cand-row2 { font-family: "DM Sans",sans-serif; font-size: 0.8rem; color: #888; margin-bottom: 8px; }
        .bt-cand-bio { font-size: 0.85rem; color: #555; line-height: 1.7; margin-bottom: 10px; }
        .bt-skills-row { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
        .bt-skill-tag { font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 500; padding: 3px 9px; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; color: #666; background: #f5f5f5; transition: all 0.15s; cursor: default; }
        .bt-skill-tag:hover { border-color: #49D7A7; color: #49D7A7; background: rgba(73,215,167,0.07); }
        .bt-highlights-row { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }
        .bt-hl-tag { font-family: "DM Sans",sans-serif; font-size: 0.68rem; font-weight: 600; color: #49D7A7; background: rgba(73,215,167,0.08); border: 1px solid rgba(73,215,167,0.25); padding: 2px 9px; border-radius: 6px; }
        .bt-card-links { display: flex; gap: 6px; flex-wrap: wrap; }
        .bt-clink { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 600; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; color: #888; background: transparent; transition: all 0.15s; cursor: pointer; }
        .bt-clink:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-clink svg { width: 11px; height: 11px; flex-shrink: 0; }
        .bt-match-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 700; border: 1px solid; border-radius: 8px; }
        .bt-view-btn { font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; padding: 9px 18px; background: #49D7A7; color: #111; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; white-space: nowrap; }
        .bt-view-btn:hover { background: #3bc495; }
        .bt-save-btn { font-family: "DM Sans",sans-serif; font-size: 0.75rem; font-weight: 500; color: #bbb; border: none; background: none; cursor: pointer; transition: color 0.18s; padding: 4px; }
        .bt-save-btn:hover { color: #49D7A7; }
        .bt-save-btn.saved { color: #49D7A7; }
        .bt-load-more { text-align: center; margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(126,71,255,0.1); }
        .bt-load-btn { font-family: "DM Sans",sans-serif; font-size: 0.82rem; font-weight: 600; padding: 12px 32px; border: 1.5px solid rgba(126,71,255,0.3); border-radius: 10px; background: transparent; color: #7E47FF; cursor: pointer; transition: all 0.18s; }
        .bt-load-btn:hover { border-color: #7E47FF; background: rgba(126,71,255,0.06); color: #7E47FF; }
        .bt-load-note { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #bbb; margin-top: 10px; }
        .bt-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 500; padding: 20px; }
        .bt-modal-panel { background: #fff; border: 1px solid rgba(0,0,0,0.1); border-radius: 20px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.15); }
        .bt-modal-panel::-webkit-scrollbar { width: 4px; }
        .bt-modal-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }
        .bt-modal-header { padding: 24px 28px 20px; border-bottom: 1px solid rgba(0,0,0,0.07); display: flex; gap: 16px; align-items: flex-start; }
        .bt-modal-avatar { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-family: "Sora",sans-serif; font-size: 1rem; font-weight: 700; flex-shrink: 0; border: 1px solid; }
        .bt-modal-meta { flex: 1; }
        .bt-modal-name { font-family: "Sora",sans-serif; font-size: 1.15rem; font-weight: 700; color: #111; }
        .bt-modal-role { font-family: "DM Sans",sans-serif; font-size: 0.82rem; color: #777; margin-bottom: 4px; }
        .bt-modal-info { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #aaa; }
        .bt-modal-close { width: 32px; height: 32px; background: rgba(0,0,0,0.05); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; cursor: pointer; font-size: 1.1rem; color: #888; display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
        .bt-modal-close:hover { background: rgba(0,0,0,0.1); color: #111; }
        .bt-profile-links { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
        .bt-plink { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 600; border: 1px solid rgba(0,0,0,0.1); border-radius: 7px; color: #888; background: transparent; transition: all 0.15s; cursor: pointer; }
        .bt-plink:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-modal-body { padding: 22px 28px; }
        .bt-modal-sec-title { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #49D7A7; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .bt-modal-sec-title::before { content: ""; width: 12px; height: 1px; background: #49D7A7; }
        .bt-exp-item { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
        .bt-exp-item:last-child { border-bottom: none; }
        .bt-exp-logo { width: 36px; height: 36px; background: #f5f5f5; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0; }
        .bt-exp-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #111; margin-bottom: 2px; }
        .bt-exp-company { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #777; }
        .bt-exp-dates { font-family: "DM Sans",sans-serif; font-size: 0.68rem; color: #bbb; margin-top: 2px; }
        .bt-exp-skills { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
        .bt-exp-skill { font-family: "DM Sans",sans-serif; font-size: 0.65rem; padding: 2px 7px; border: 1px solid rgba(0,0,0,0.1); border-radius: 5px; color: #888; background: #f8f8f8; }
        .bt-edu-row { padding: 10px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
        .bt-edu-row:last-child { border-bottom: none; }
        .bt-edu-degree { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #111; }
        .bt-edu-school { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #777; margin-top: 3px; }
        .bt-modal-skills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 20px; }
        .bt-modal-skill { font-family: "DM Sans",sans-serif; font-size: 0.75rem; padding: 4px 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 7px; color: #666; background: #f8f8f8; }
        .bt-open-to { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
        .bt-ot-tag { font-family: "DM Sans",sans-serif; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 3px 10px; border: 1px solid; border-radius: 6px; }
        .bt-locked-box { border: 1px solid rgba(73,215,167,0.25); background: rgba(73,215,167,0.05); padding: 16px 18px; border-radius: 12px; margin-bottom: 18px; display: flex; gap: 14px; align-items: center; }
        .bt-locked-icon { font-size: 1.5rem; flex-shrink: 0; }
        .bt-locked-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #49D7A7; margin-bottom: 3px; }
        .bt-locked-sub { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #888; }

        .bt-admin-banner { display: flex; align-items: center; gap: 8px; padding: 10px 18px; font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; color: #1a4f3a; background: linear-gradient(90deg, rgba(73,215,167,0.18), rgba(73,215,167,0.08)); border-bottom: 1px solid rgba(73,215,167,0.3); }
        .bt-unlocked-box { border: 1px solid rgba(73,215,167,0.35); background: rgba(73,215,167,0.05); padding: 16px 18px; border-radius: 12px; margin-bottom: 18px; }
        .bt-unlocked-head { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px dashed rgba(73,215,167,0.3); }
        .bt-unlocked-head > span { font-size: 1.25rem; }
        .bt-unlocked-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #1a9e73; }
        .bt-unlocked-sub { font-family: "DM Sans",sans-serif; font-size: 0.7rem; color: #888; margin-top: 2px; }
        .bt-unlocked-rows { display: flex; flex-direction: column; gap: 8px; }
        .bt-unlocked-row { display: flex; gap: 14px; align-items: baseline; font-family: "DM Sans",sans-serif; font-size: 0.78rem; }
        .bt-unlocked-label { flex: 0 0 64px; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #999; }
        .bt-unlocked-link { color: #1a9e73; font-weight: 600; word-break: break-all; }
        .bt-unlocked-link:hover { text-decoration: underline; }
        .bt-modal-actions { display: flex; gap: 8px; }
        .bt-btn-unlock { flex: 1; padding: 13px; font-family: "DM Sans",sans-serif; font-size: 0.82rem; font-weight: 700; background: #49D7A7; color: #111; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; }
        .bt-btn-unlock:hover { background: #3bc495; }
        .bt-btn-save-modal { padding: 13px 20px; font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; background: transparent; color: #888; border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; cursor: pointer; transition: all 0.18s; }
        .bt-btn-save-modal:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-btn-save-modal.saved { color: #49D7A7; border-color: #49D7A7; }
        @keyframes btFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @media (max-width: 1024px) {
          .bt-page-wrap { grid-template-columns: 1fr; }
          .bt-sidebar { position: relative; top: 0; height: auto; border-right: none; border-bottom: 1px solid rgba(0,0,0,0.08); }
          .bt-sidebar { display: none; }
          .bt-mobile-toolbar { padding: 14px 0 10px; }
          .bt-filters-trigger {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background: #7E47FF;
            color: #fff;
            border: none;
            border-radius: 10px;
            font-family: "DM Sans",sans-serif;
            font-size: 0.85rem;
            font-weight: 600;
            cursor: pointer;
            min-height: 40px;
          }
          .bt-filters-trigger:hover {
            background: #6f3aef;
          }
          .bt-drawer-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 400;
          }
          .bt-drawer {
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            height: 100vh;
            height: 100dvh;
            width: 78%;
            max-width: 320px;
            background: #fff;
            z-index: 401;
            flex-direction: column;
            box-shadow: 4px 0 24px rgba(0,0,0,0.18);
            animation: bt-drawer-in 0.22s ease-out;
          }
          .bt-drawer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 18px;
            border-bottom: 1px solid rgba(126,71,255,0.12);
          }
          .bt-drawer-title {
            font-family: "Sora",sans-serif;
            font-size: 0.95rem;
            font-weight: 700;
            color: #111;
          }
          .bt-drawer-close {
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.05);
            border: 1px solid rgba(0,0,0,0.1);
            border-radius: 8px;
            cursor: pointer;
            font-size: 1.1rem;
            color: #888;
          }
          .bt-drawer-body {
            flex: 1;
            overflow-y: auto;
          }
          .bt-drawer-footer {
            padding: 12px 18px;
            border-top: 1px solid rgba(126,71,255,0.12);
          }
          .bt-drawer-apply {
            width: 100%;
            padding: 13px;
            background: #7E47FF;
            color: #fff;
            border: none;
            border-radius: 10px;
            font-family: "DM Sans",sans-serif;
            font-size: 0.85rem;
            font-weight: 700;
            cursor: pointer;
          }
          .bt-drawer-apply:hover { background: #6f3aef; }
        }
        @media (max-width: 768px) {
          .bt-main { padding: 20px; }
          .bt-search-bar { flex-direction: column; }
          .bt-search-wrap { width: 100%; }
          .bt-cand-card { grid-template-columns: 1fr; }
          .bt-card-right { align-items: flex-start; flex-direction: row; flex-wrap: wrap; }
          #bth-wrap { min-height: 420px; }
          .bt-search-input { font-size: 16px; }
          .bt-sort-select { font-size: 16px; width: 100%; }
          .bt-result-meta { flex-direction: column; align-items: flex-start; gap: 6px; }
          .bt-role-chip { padding: 10px 8px; }
          .bt-save-btn { padding: 8px 12px; min-height: 40px; }
        }
        @media (max-width: 480px) {
          .bth-heading { font-size: 32px; letter-spacing: -1px; }
          .bt-cand-card { padding: 18px; }
          .bt-modal-header { padding: 18px 18px 16px; }
          .bt-modal-body { padding: 18px; }
          .bt-modal-close { width: 36px; height: 36px; }
          .bt-profile-links { flex-wrap: wrap; }
        }
      `}</style>
    </>
  );
}
