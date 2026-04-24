import {
  ArrowRight,
  Award,
  Briefcase,
  Check,
  ChevronDown,
  Clock,
  Globe,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

const TRUST_STATS = [
  "50,000+ Vetted Professionals",
  "Top 1% Accepted",
  "$15–$60/hr Average Rate",
] as const;

const BENEFITS = [
  {
    icon: TrendingDown,
    title: "Lower costs by up to 70%",
    description:
      "Hire senior engineers at $15–$60/hr — a fraction of US or UK rates — without compromising on quality.",
  },
  {
    icon: Globe,
    title: "Global talent, timezone-matched",
    description:
      "Tap into 50,000+ professionals across Pakistan. Overlap with EU, US, and APAC working hours.",
  },
  {
    icon: ShieldCheck,
    title: "Rigorously vetted",
    description:
      "Only the top 1% make it in. Every profile passes technical, communication, and reference checks.",
  },
  {
    icon: Clock,
    title: "Hire in days, not months",
    description:
      "Browse live profiles with real availability. Most clients finalise a hire within 7 days.",
  },
  {
    icon: Users,
    title: "Any role, any stack",
    description:
      "Engineers, designers, PMs, marketers, finance, and ops — all specialisations covered.",
  },
  {
    icon: Award,
    title: "90-day replacement guarantee",
    description:
      "If a hire doesn't work out, we find a replacement at no extra cost on our Custom plan.",
  },
] as const;

const TALENT_PREVIEW = [
  {
    initials: "AR",
    name: "Ahmed R.",
    location: "Karachi, Pakistan",
    role: "Full Stack Developer",
    bio: "Experienced full stack developer specialising in scalable web applications and cloud infrastructure.",
    skills: ["React", "Node.js", "TypeScript", "AWS"],
    rate: "$35/hr",
    available: "Available Now",
    avatarBg: "bg-remotiv-purple-light",
  },
  {
    initials: "SK",
    name: "Sara K.",
    location: "Lahore, Pakistan",
    role: "UI/UX Designer",
    bio: "Product designer with a strong eye for detail and a passion for user-centred design systems.",
    skills: ["Figma", "Prototyping", "Design Systems", "Webflow"],
    rate: "$25/hr",
    available: "Available Now",
    avatarBg: "bg-remotiv-green",
    avatarText: "text-[#111]",
  },
  {
    initials: "UT",
    name: "Usman T.",
    location: "Islamabad, Pakistan",
    role: "Backend Engineer",
    bio: "Backend engineer focused on high-performance APIs and reliable cloud deployments.",
    skills: ["Python", "Django", "PostgreSQL", "AWS"],
    rate: "$30/hr",
    available: "Available from May 2026",
    avatarBg: "bg-remotiv-purple",
  },
  {
    initials: "BA",
    name: "Bilal A.",
    location: "Islamabad, Pakistan",
    role: "Senior Software Engineer",
    bio: "Senior engineer with a decade of experience shipping production-grade distributed systems.",
    skills: ["Go", "Kubernetes", "gRPC", "PostgreSQL"],
    rate: "$45/hr",
    available: "Available Now",
    avatarBg: "bg-[#111]",
  },
] as const;

const STEPS = [
  {
    number: "1",
    title: "Browse",
    description:
      "Filter by role, skills, rate, and availability. Every profile is vetted by Remotiv before going live.",
  },
  {
    number: "2",
    title: "Shortlist",
    description:
      "Save the candidates you like and compare rates, experience, and portfolios side by side.",
  },
  {
    number: "3",
    title: "Interview",
    description:
      "Unlock contact details and schedule interviews directly — or let our team coordinate for you.",
  },
  {
    number: "4",
    title: "Hire",
    description:
      "Sign the contract and onboard. We handle payroll, compliance, and payments in 180+ countries.",
  },
] as const;

const PLANS = [
  {
    badge: "FREE TIER",
    name: "Starter",
    price: "$0",
    priceSuffix: "/mo",
    features: [
      { text: "Browse full talent pool", included: true },
      { text: "View profiles and highlights", included: true },
      { text: "Unlock 10 contact details", included: true },
      { text: "Advanced filters", included: false },
      { text: "Save and shortlist", included: false },
      { text: "Dedicated account manager", included: false },
    ],
    cta: "Get Started Free",
    accent: false,
  },
  {
    badge: "MOST POPULAR",
    name: "Pro",
    price: "$50",
    priceSuffix: "/mo",
    features: [
      { text: "Everything in Starter", included: true },
      { text: "50 contact unlocks per month", included: true },
      { text: "Advanced filters and search", included: true },
      { text: "Save and shortlist candidates", included: true },
      { text: "Dedicated account manager", included: true },
      { text: "Priority support", included: true },
    ],
    cta: "Upgrade to Pro",
    accent: true,
  },
  {
    badge: "ENTERPRISE",
    name: "Custom",
    price: "Custom",
    priceSuffix: "",
    features: [
      { text: "Everything in Pro", included: true },
      { text: "Our recruiters find candidates", included: true },
      { text: "AI-powered matching", included: true },
      { text: "90-day replacement guarantee", included: true },
      { text: "Unlimited access", included: true },
      { text: "Dedicated success manager", included: true },
    ],
    cta: "Schedule a Demo",
    accent: false,
  },
] as const;

const TESTIMONIALS = [
  {
    quote:
      "We cut our hiring timeline from 3 months to 9 days and saved $180k in year-one salaries. Every engineer we hired through Remotiv is still on the team.",
    author: "Maya Patel",
    role: "VP Engineering, Finlytic",
  },
  {
    quote:
      "The quality of the shortlist was better than recruiters charging 10x more. The vetting really does filter for the top 1%.",
    author: "Daniel Osei",
    role: "CTO, Dashboard.io",
  },
  {
    quote:
      "Replaced an expensive agency with Remotiv and built a full design team in a quarter. Timezone overlap with our London HQ is a huge win.",
    author: "Lena Kowalski",
    role: "Head of Product, Arkade",
  },
] as const;

const FAQS = [
  {
    question: "How does Remotiv vet candidates?",
    answer:
      "Every professional goes through a multi-stage process: technical assessment, communication interview, portfolio review, and background/reference checks. Only the top 1% of applicants make it onto the platform.",
  },
  {
    question: "How fast can I hire someone?",
    answer:
      "Most clients finalise a hire within 7 days. If you use our Custom plan, our recruiters deliver a curated shortlist within 48 hours.",
  },
  {
    question: "What if a hire doesn't work out?",
    answer:
      "On our Custom plan we offer a 90-day replacement guarantee — if it's not the right fit, we'll find a replacement at no additional cost.",
  },
  {
    question: "Who handles payroll and contracts?",
    answer:
      "We do. Remotiv manages compliant contracts, payroll, taxes, and international payments in 180+ countries so you can focus on building.",
  },
  {
    question: "Can I hire for roles outside of engineering?",
    answer:
      "Yes. We have vetted talent across engineering, design, product, marketing, sales, customer support, finance, and operations.",
  },
] as const;

export default function HireRemotePage() {
  return (
    <>
      <Navbar />
      <main className="bg-remotiv-bg">
        <HeroSection />
        <BenefitsSection />
        <TalentPreviewSection />
        <ProcessSection />
        <PricingSection />
        <TestimonialsSection />
        <FaqSection />
        <BottomCta />
      </main>
      <Footer />
    </>
  );
}

function HeroSection() {
  return (
    <section className="relative isolate overflow-hidden bg-remotiv-bg px-6 pb-20 pt-20 text-center md:px-14 md:pb-[72px] md:pt-[84px]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(rgba(0,0,0,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.05)_1px,transparent_1px)] bg-[size:52px_52px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[10%] left-1/2 -z-10 h-[520px] w-[860px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.6)_0%,transparent_70%)]"
      />
      <div className="relative mx-auto max-w-[760px]">
        <span className="mb-5 inline-block rounded-full bg-remotiv-green/10 px-4 py-1.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.16em] text-remotiv-green">
          Hire Remote
        </span>
        <h1 className="mb-5 font-heading text-[clamp(2.2rem,4.2vw,3.5rem)] font-extrabold leading-[1.09] tracking-[-0.032em] text-remotiv-text-dark">
          Hire Top Remote Talent from Pakistan
        </h1>
        <p className="mx-auto mb-10 max-w-[580px] text-[1.08rem] leading-[1.68] text-remotiv-text-mid">
          Browse vetted engineers, designers, and marketers. See real rates, real skills, and real
          availability — no recruiter calls needed to start.
        </p>
        <div className="mb-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="#talent-preview"
            className="inline-flex items-center gap-2 rounded-2xl bg-remotiv-green px-8 py-[15px] font-heading text-[0.95rem] font-bold text-remotiv-text-dark shadow-[0_4px_18px_rgba(73,215,167,0.3)] transition-all hover:-translate-y-0.5 hover:bg-remotiv-green-light"
          >
            Browse Talent
          </Link>
          <Link
            href="/book-a-meeting"
            className="rounded-2xl border-[1.8px] border-black/20 px-8 py-[13px] font-heading text-[0.95rem] font-semibold text-remotiv-text-dark transition-all hover:-translate-y-0.5 hover:border-[#111] hover:bg-black/[0.04]"
          >
            Get a Quote
          </Link>
        </div>
        <div className="inline-flex flex-wrap items-center justify-center rounded-full border border-black/10 bg-white/70 px-1 py-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.05)] backdrop-blur-md">
          {TRUST_STATS.map((stat, idx) => (
            <div
              key={stat}
              className={`flex items-center gap-2 px-5 py-0.5 text-[0.84rem] font-medium text-[#555] ${
                idx < TRUST_STATS.length - 1 ? "border-r-[1.5px] border-black/10" : ""
              }`}
            >
              <span className="text-[0.78rem] text-remotiv-green">✦</span>
              {stat}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BenefitsSection() {
  return (
    <section className="bg-white px-6 py-20 md:px-14">
      <div className="mx-auto max-w-6xl">
        <div className="mb-14 text-center">
          <span className="mb-3 inline-block font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            Why Remotiv
          </span>
          <h2 className="font-heading text-[clamp(1.7rem,2.8vw,2.4rem)] font-extrabold leading-tight tracking-[-0.03em] text-remotiv-text-dark">
            A better way to hire remote
          </h2>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map((benefit) => {
            const Icon = benefit.icon;
            return (
              <div
                key={benefit.title}
                className="rounded-2xl border border-black/[0.06] bg-remotiv-bg p-7 transition-all hover:-translate-y-1 hover:shadow-[0_10px_30px_rgba(0,0,0,0.06)]"
              >
                <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-remotiv-green/15 text-remotiv-green">
                  <Icon className="size-6" />
                </div>
                <h3 className="mb-2 font-heading text-lg font-bold text-remotiv-text-dark">
                  {benefit.title}
                </h3>
                <p className="text-[0.92rem] leading-[1.6] text-remotiv-text-mid">
                  {benefit.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TalentPreviewSection() {
  return (
    <section id="talent-preview" className="bg-remotiv-bg px-4 py-20 md:px-10">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="mb-2 inline-block font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
              Featured talent
            </span>
            <h2 className="font-heading text-[1.6rem] font-extrabold tracking-[-0.02em] text-remotiv-text-dark">
              <span className="text-remotiv-green">247</span> professionals found
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FakeSelect label="All Roles" />
            <FakeSelect label="Experience" />
            <FakeSelect label="Availability" />
            <div className="flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-[0.84rem] text-remotiv-text-mid">
              <Search className="size-4 text-[#aaa]" />
              <span>Search talent…</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {TALENT_PREVIEW.map((profile) => (
            <article
              key={profile.name}
              className="group flex flex-wrap items-center gap-5 rounded-2xl border border-black/[0.08] border-l-[3px] border-l-transparent bg-white px-6 py-5 transition-all hover:translate-x-0.5 hover:border-l-remotiv-green hover:shadow-[0_6px_28px_rgba(0,0,0,0.08)]"
            >
              <div
                className={`flex size-12 shrink-0 items-center justify-center rounded-full font-heading text-[0.95rem] font-bold ${profile.avatarBg} ${
                  "avatarText" in profile && profile.avatarText
                    ? profile.avatarText
                    : "text-white"
                }`}
              >
                {profile.initials}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-heading text-[0.97rem] font-bold text-remotiv-text-dark">
                    {profile.name}
                  </span>
                  <span className="text-black/20">·</span>
                  <span className="text-[0.82rem] text-remotiv-text-light">{profile.location}</span>
                </div>
                <div className="text-[0.83rem] text-remotiv-text-mid">{profile.role}</div>
                <p className="line-clamp-2 max-w-[480px] text-[0.82rem] leading-[1.5] text-[#555]">
                  {profile.bio}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {profile.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-md bg-black/[0.06] px-2 py-0.5 text-[0.72rem] font-medium text-remotiv-text-mid"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex min-w-[140px] flex-col items-end gap-2">
                <div className="font-heading text-[1.05rem] font-extrabold tracking-[-0.02em] text-remotiv-text-dark">
                  {profile.rate}
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[0.75rem] font-semibold ${
                    profile.available.startsWith("Available Now")
                      ? "bg-remotiv-green/15 text-[#1a8a68]"
                      : "bg-black/[0.05] text-remotiv-text-light"
                  }`}
                >
                  {profile.available}
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg border-[1.5px] border-remotiv-green px-4 py-1.5 font-heading text-[0.78rem] font-bold text-remotiv-green transition-all hover:-translate-y-0.5 hover:bg-remotiv-green hover:text-remotiv-text-dark"
                >
                  View Profile
                  <ArrowRight className="size-3.5" />
                </button>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-8 flex justify-center">
          <Link
            href="/browse-talent"
            className="rounded-xl border-[1.8px] border-remotiv-green px-10 py-3 font-heading text-[0.9rem] font-bold text-remotiv-green transition-all hover:-translate-y-0.5 hover:bg-remotiv-green hover:text-remotiv-text-dark"
          >
            Browse all 247 profiles
          </Link>
        </div>
      </div>
    </section>
  );
}

function FakeSelect({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-[0.84rem] font-medium text-remotiv-text-mid">
      {label}
      <ChevronDown className="size-3.5 text-[#777]" />
    </div>
  );
}

function ProcessSection() {
  return (
    <section className="bg-white px-6 py-20 text-center md:px-14">
      <span className="mb-3 inline-block font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
        How It Works
      </span>
      <h2 className="mb-14 font-heading text-[clamp(1.7rem,2.8vw,2.4rem)] font-extrabold leading-tight tracking-[-0.03em] text-remotiv-text-dark">
        Four steps to your next hire
      </h2>
      <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <div key={step.number} className="flex flex-col items-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-white font-heading text-[0.95rem] font-extrabold text-remotiv-green shadow-[0_2px_10px_rgba(0,0,0,0.07)] ring-2 ring-black/[0.06]">
              {step.number}
            </div>
            <h3 className="mb-2 font-heading text-base font-bold text-remotiv-text-dark">
              {step.title}
            </h3>
            <p className="text-[0.88rem] leading-[1.6] text-[#555]">{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section className="bg-remotiv-bg px-6 py-20 md:px-14">
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 text-center">
          <span className="mb-3 inline-block font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            Access Plans
          </span>
          <h2 className="mb-3 font-heading text-[clamp(1.7rem,2.8vw,2.4rem)] font-extrabold leading-tight tracking-[-0.03em] text-remotiv-text-dark">
            Find the best candidates faster
          </h2>
          <p className="mx-auto max-w-xl text-[0.95rem] leading-[1.6] text-remotiv-text-mid">
            Browse our vetted talent pool and unlock contact details when you find the right fit.
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`relative flex flex-col rounded-3xl bg-white p-7 transition-all ${
                plan.accent
                  ? "border-2 border-remotiv-green shadow-[0_10px_40px_rgba(73,215,167,0.18)]"
                  : "border border-black/[0.09]"
              }`}
            >
              <span
                className={`mb-4 w-fit rounded-full px-2.5 py-1 font-heading text-[0.65rem] font-bold tracking-[0.06em] ${
                  plan.accent
                    ? "bg-remotiv-green text-white"
                    : "border-[1.5px] border-black/15 text-remotiv-text-mid"
                }`}
              >
                {plan.badge}
              </span>
              <div
                className={`mb-1 font-heading text-[0.72rem] font-bold uppercase tracking-[0.1em] ${
                  plan.accent ? "text-remotiv-green" : "text-remotiv-text-light"
                }`}
              >
                {plan.name}
              </div>
              <div
                className={`mb-5 font-heading text-[1.7rem] font-extrabold tracking-[-0.03em] ${
                  plan.accent ? "text-remotiv-green" : "text-remotiv-text-dark"
                }`}
              >
                {plan.price}
                {plan.priceSuffix && (
                  <span className="ml-1 text-base font-medium opacity-70">{plan.priceSuffix}</span>
                )}
              </div>
              <div className="mb-4 h-px bg-black/[0.07]" />
              <ul className="mb-6 flex flex-1 flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li key={feature.text} className="flex items-start gap-2 text-[0.85rem]">
                    <span
                      className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full ${
                        feature.included ? "bg-remotiv-green" : "bg-black/[0.08]"
                      }`}
                    >
                      {feature.included ? (
                        <Check className="size-2.5 text-white" strokeWidth={3} />
                      ) : (
                        <X className="size-2.5 text-[#aaa]" strokeWidth={2.5} />
                      )}
                    </span>
                    <span
                      className={
                        feature.included
                          ? "text-remotiv-text-dark"
                          : "text-[#aaa] line-through"
                      }
                    >
                      {feature.text}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href="/book-a-meeting"
                className={`mt-auto block rounded-xl px-4 py-3 text-center font-heading text-[0.85rem] font-bold transition-all ${
                  plan.accent
                    ? "bg-remotiv-green text-remotiv-text-dark shadow-[0_4px_14px_rgba(73,215,167,0.28)] hover:-translate-y-0.5 hover:bg-remotiv-green-light"
                    : plan.name === "Custom"
                      ? "border-[1.5px] border-remotiv-green text-remotiv-green hover:-translate-y-0.5 hover:bg-remotiv-green/5"
                      : "border-[1.5px] border-black/20 text-remotiv-text-dark hover:-translate-y-0.5 hover:bg-black/[0.04]"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TestimonialsSection() {
  return (
    <section className="bg-white px-6 py-20 md:px-14">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <span className="mb-3 inline-flex items-center gap-2 font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            <Sparkles className="size-3.5" />
            Loved by hiring teams
          </span>
          <h2 className="font-heading text-[clamp(1.7rem,2.8vw,2.4rem)] font-extrabold leading-tight tracking-[-0.03em] text-remotiv-text-dark">
            Results our clients talk about
          </h2>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <figure
              key={t.author}
              className="flex flex-col justify-between rounded-2xl border border-black/[0.08] bg-remotiv-bg p-7"
            >
              <blockquote className="mb-6 text-[0.95rem] leading-[1.65] text-remotiv-text-dark">
                “{t.quote}”
              </blockquote>
              <figcaption className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-remotiv-purple-light font-heading text-sm font-bold text-white">
                  {t.author
                    .split(" ")
                    .map((n) => n[0])
                    .join("")}
                </div>
                <div>
                  <div className="font-heading text-[0.9rem] font-bold text-remotiv-text-dark">
                    {t.author}
                  </div>
                  <div className="text-[0.78rem] text-remotiv-text-light">{t.role}</div>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="bg-remotiv-bg px-6 py-20 md:px-14">
      <div className="mx-auto max-w-3xl">
        <div className="mb-10 text-center">
          <span className="mb-3 inline-block font-heading text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green">
            FAQ
          </span>
          <h2 className="font-heading text-[clamp(1.7rem,2.8vw,2.4rem)] font-extrabold leading-tight tracking-[-0.03em] text-remotiv-text-dark">
            Everything you need to know
          </h2>
        </div>
        <div className="space-y-3">
          {FAQS.map((faq) => (
            <details
              key={faq.question}
              className="group rounded-2xl border border-black/[0.08] bg-white px-6 py-5 transition-shadow open:shadow-[0_6px_24px_rgba(0,0,0,0.06)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-heading text-base font-bold text-remotiv-text-dark">
                {faq.question}
                <ChevronDown className="size-5 shrink-0 text-remotiv-green transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-[0.92rem] leading-[1.6] text-remotiv-text-mid">
                {faq.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function BottomCta() {
  return (
    <section className="bg-remotiv-bg px-4 pb-16 md:px-10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 rounded-3xl bg-remotiv-lime-card px-8 py-10 md:px-14 md:py-12">
        <div className="max-w-xl">
          <h2 className="mb-2 font-heading text-[clamp(1.3rem,2vw,1.7rem)] font-extrabold tracking-[-0.025em] text-remotiv-text-dark">
            Need help finding the right person?
          </h2>
          <p className="text-[0.95rem] leading-[1.55] text-remotiv-text-mid">
            Looking for a Developer, SDR, or Customer Support professional — for a permanent role
            or part-time? We find you the right person within days.
          </p>
        </div>
        <Link
          href="/book-a-meeting"
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-[#111] px-9 py-4 font-heading text-[0.95rem] font-bold tracking-[-0.01em] text-white transition-all hover:-translate-y-0.5 hover:bg-[#222]"
        >
          <Briefcase className="size-4" />
          Get a Quote
        </Link>
      </div>
    </section>
  );
}
