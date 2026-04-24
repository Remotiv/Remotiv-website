import Link from "next/link";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

const HERO_STATS = [
  { num: "200", suffix: "+", label: "Professionals placed with global teams" },
  { num: "24", suffix: "hrs", label: "From brief to shortlist delivered" },
  { num: "85", suffix: "%", label: "Client retention after first hire" },
  { num: "1M", suffix: "+", label: "Talent profiles in our network" },
];

const IMPACT_STATS = [
  {
    stat: "200+",
    label: "Professionals placed",
    body: "From engineers to operators — every hire we've made has been pre-vetted, AI-matched, and backed by our 90-day replacement guarantee.",
  },
  {
    stat: "85%",
    label: "Client retention rate",
    body: "The majority of companies that hire through Remotiv return for their next role. That's not a coincidence — it's the result of getting the first hire right.",
  },
  {
    stat: "24hrs",
    label: "Shortlist delivery",
    body: "From the moment you share your brief, our AI and senior recruiters work in parallel to deliver a curated candidate shortlist within 24 hours.",
  },
];

const VALUES = [
  {
    title: "Quality without compromise",
    body: "We only present candidates who have passed our 4-stage vetting process — AI-screened, human-verified, and ready from day one. Every placement comes with a 90-day guarantee for your peace of mind.",
    iconBg: "bg-[#ede9fe]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-[26px]">
        <path
          d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z"
          fill="#7E47FF"
          opacity="0.2"
        />
        <path
          d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z"
          stroke="#7E47FF"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9 12l2 2 4-4"
          stroke="#7E47FF"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "People over process",
    body: "Behind every placement is a human conversation. We take the time to understand your team, your culture, and what success actually looks like for your business.",
    iconBg: "bg-[#d1fae5]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-[26px]">
        <circle cx="9" cy="7" r="3" stroke="#49D7A7" strokeWidth="1.8" />
        <circle cx="15" cy="7" r="3" stroke="#49D7A7" strokeWidth="1.8" />
        <path
          d="M3 19c0-3.314 2.686-5 6-5h6c3.314 0 6 1.686 6 5"
          stroke="#49D7A7"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "Speed that doesn't cut corners",
    body: "We move fast because we've already done the hard work upfront. Pre-vetted talent means your shortlist arrives in 24 hours — ready to interview, not just available.",
    iconBg: "bg-[#fef9c3]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-[26px]">
        <path
          d="M13 2L4.5 13.5H12L11 22L19.5 10.5H12L13 2Z"
          stroke="#ca8a04"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="#fef08a"
        />
      </svg>
    ),
  },
];

const TEAM = [
  { name: "Alex Chen", role: "CEO & Co-founder", initials: "AC" },
  { name: "Sarah Miller", role: "CTO & Co-founder", initials: "SM" },
  { name: "James Wilson", role: "Head of Talent", initials: "JW" },
  { name: "Priya Patel", role: "Head of Operations", initials: "PP" },
];

const SECTION_HEADING = "text-center font-heading text-[clamp(2rem,4vw,3.2rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-[#111]";
const SECTION_SUB = "mx-auto mb-14 mt-5 max-w-[580px] text-center text-base leading-[1.7] text-[#777]";

export default function AboutPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1 bg-white">
        {/* Hero */}
        <section className="bg-[#f8f4f1] px-6 py-16 md:px-14 md:pt-[72px] md:pb-20">
          <div className="mx-auto w-full max-w-[1280px]">
            <div className="text-center">
              <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#7E47FF]/20 bg-[#7E47FF]/[0.09] px-5 py-[7px] text-[0.78rem] font-bold uppercase tracking-[0.08em] text-remotiv-purple">
                <span className="size-1.5 rounded-full bg-remotiv-purple" />
                Our Story
              </span>
            </div>

            <h1 className="mb-5 text-center font-heading text-[clamp(2.8rem,5.5vw,4.8rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#111]">
              About Our Company
            </h1>

            <p className="mx-auto mb-14 max-w-[640px] text-center text-[1.05rem] leading-[1.7] text-[#777]">
              Remotiv was built to solve a real problem — the global talent gap. We connect
              companies with Pakistan&apos;s top 1% of pre-vetted professionals, delivering faster
              hires, stronger teams, and zero hiring risk.
            </p>

            <div className="grid items-stretch gap-5 md:grid-cols-2">
              {/* Left: image placeholder */}
              <div className="relative flex min-h-[280px] flex-col items-center justify-center gap-3.5 overflow-hidden rounded-3xl border border-dashed border-black/15 bg-[#e8e4e1] md:min-h-[480px]">
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-remotiv-green/[0.06] to-remotiv-purple/[0.06]" />
                <div className="relative z-10 flex size-16 items-center justify-center rounded-[20px] bg-black/[0.07]">
                  <svg
                    viewBox="0 0 40 40"
                    fill="none"
                    aria-hidden="true"
                    className="size-[30px] opacity-40"
                  >
                    <rect x="4" y="4" width="32" height="32" rx="6" stroke="#111" strokeWidth="1.8" />
                    <circle cx="20" cy="16" r="5.5" stroke="#111" strokeWidth="1.8" />
                    <path
                      d="M9 34c0-6.075 4.925-9 11-9s11 2.925 11 9"
                      stroke="#111"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="relative z-10 text-[0.78rem] font-semibold uppercase tracking-[0.06em] text-black/35">
                  Image coming soon
                </div>
              </div>

              {/* Right: dark content card */}
              <div className="flex flex-col rounded-3xl bg-[#111] p-10 md:p-[52px_48px]">
                <div className="mb-[22px] flex items-center gap-2.5 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-remotiv-green">
                  <span className="h-px w-6 bg-remotiv-green" />
                  Who We Are
                </div>
                <h2 className="mb-5 font-heading text-[clamp(1.6rem,2.6vw,2.2rem)] font-extrabold leading-[1.1] tracking-[-0.025em] text-white">
                  Empowering teams to
                  <br />
                  <em className="not-italic text-remotiv-green">achieve more</em>
                </h2>
                <p className="mb-9 text-[0.95rem] leading-[1.8] text-white/65">
                  Remotiv is a talent recruitment and staffing platform built for companies that
                  refuse to compromise on quality. We source, vet, and place top engineers,
                  designers, and operators with startups, agencies, and enterprises — at a fraction
                  of the traditional cost.
                </p>

                <div className="mb-7 h-px bg-white/10" />

                <div className="grid grid-cols-2 gap-5">
                  {HERO_STATS.map((s) => (
                    <div key={s.label} className="flex flex-col gap-1">
                      <div className="font-heading text-[1.8rem] font-black leading-none tracking-[-0.03em] text-white">
                        {s.num}
                        <span className="text-[1.1rem] text-remotiv-green">{s.suffix}</span>
                      </div>
                      <div className="text-[0.8rem] leading-[1.4] text-white/45">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Story / Mission */}
        <section className="bg-white px-6 py-20 md:px-14">
          <div className="mx-auto max-w-[900px] text-center">
            <h2 className={SECTION_HEADING}>Why Remotiv exists</h2>
            <p className="mx-auto mt-5 max-w-[720px] text-base leading-[1.8] text-[#555]">
              Hiring world-class engineering talent is slow, expensive, and full of risk. Companies
              wait weeks for shortlists, pay inflated agency fees, and still end up with hires
              that don&apos;t work out. We started Remotiv to fix that — by combining rigorous human
              vetting with AI-powered matching, we deliver pre-vetted candidates in 24 hours, at a
              fraction of the traditional cost, with a 90-day replacement guarantee.
            </p>
          </div>
        </section>

        {/* Success by the numbers */}
        <section className="bg-white px-6 py-12 md:px-14 md:py-12">
          <div className="mx-auto max-w-[1100px]">
            <h2 className={SECTION_HEADING}>Our success by the numbers</h2>
            <p className={SECTION_SUB}>
              Built on results, not promises. Every number below reflects a real placement, a
              retained client, or a hire made faster than the industry standard.
            </p>

            <div className="grid gap-0 rounded-3xl bg-[#f8f4f1] p-8 md:grid-cols-3 md:p-[48px_40px]">
              {IMPACT_STATS.map((s, i) => (
                <div
                  key={s.label}
                  className={`relative flex flex-col gap-3 p-7 md:p-[32px_40px] ${
                    i < IMPACT_STATS.length - 1
                      ? "border-b border-black/10 md:border-b-0 md:after:absolute md:after:right-0 md:after:top-[20%] md:after:h-[60%] md:after:w-px md:after:bg-black/10 md:after:content-['']"
                      : ""
                  }`}
                >
                  <div className="font-heading text-[clamp(2.8rem,5vw,4rem)] font-extrabold leading-none tracking-[-0.04em] text-[#111]">
                    {s.stat}
                  </div>
                  <div className="mb-5 text-base font-semibold text-[#111]">{s.label}</div>
                  <div className="mb-5 h-px w-full bg-black/[0.08]" />
                  <p className="text-[0.88rem] leading-[1.75] text-[#777]">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Values */}
        <section className="bg-white px-6 pb-20 pt-10 md:px-14">
          <div className="mx-auto max-w-[1100px]">
            <h2 className={SECTION_HEADING}>Our company values</h2>
            <p className={SECTION_SUB}>
              Everything we build, every hire we make, and every relationship we form is guided by
              a set of principles we don&apos;t compromise on.
            </p>

            <div className="grid gap-5 md:grid-cols-3">
              {VALUES.map((v) => (
                <div
                  key={v.title}
                  className="group flex flex-col items-start rounded-3xl border border-black/[0.08] bg-white p-9 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_40px_rgba(0,0,0,0.08)]"
                >
                  <div
                    className={`mb-7 flex size-14 items-center justify-center rounded-2xl ${v.iconBg}`}
                  >
                    {v.icon}
                  </div>
                  <h3 className="mb-3.5 font-heading text-[1.05rem] font-bold text-[#111]">
                    {v.title}
                  </h3>
                  <p className="text-[0.9rem] leading-[1.75] text-[#777]">{v.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Leadership team */}
        <section className="bg-[#f8f4f1] px-6 py-20 md:px-14">
          <div className="mx-auto max-w-[1100px]">
            <h2 className={SECTION_HEADING}>Leadership team</h2>
            <p className={SECTION_SUB}>
              The operators, engineers, and recruiters who make every placement possible.
            </p>

            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {TEAM.map((m) => (
                <div
                  key={m.name}
                  className="flex flex-col items-center rounded-3xl border border-black/[0.08] bg-white p-7 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_40px_rgba(0,0,0,0.08)]"
                >
                  <div className="mb-5 flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-remotiv-purple-light to-remotiv-purple font-heading text-xl font-bold text-white">
                    {m.initials}
                  </div>
                  <h3 className="font-heading font-bold text-[#111]">{m.name}</h3>
                  <p className="mt-1 text-sm text-[#777]">{m.role}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="bg-white px-6 py-20 md:px-14">
          <div className="mx-auto max-w-[980px] overflow-hidden rounded-[32px] bg-[#111] p-10 text-center md:p-16">
            <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-remotiv-green/25 bg-remotiv-green/10 px-5 py-[7px] text-[0.78rem] font-bold uppercase tracking-[0.08em] text-remotiv-green">
              <span className="size-1.5 rounded-full bg-remotiv-green" />
              Join the mission
            </div>
            <h2 className="mx-auto max-w-[680px] font-heading text-[clamp(1.8rem,3.5vw,2.6rem)] font-extrabold leading-[1.15] tracking-[-0.025em] text-white">
              Ready to build your team with Remotiv?
            </h2>
            <p className="mx-auto mt-5 max-w-[560px] text-[0.98rem] leading-[1.7] text-white/65">
              Whether you&apos;re hiring your first engineer or scaling to 50, we&apos;ll deliver a
              pre-vetted shortlist in 24 hours.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/book-a-meeting"
                className="rounded-[14px] bg-remotiv-green px-7 py-[13px] font-heading text-[0.95rem] font-semibold text-[#111] transition-all hover:-translate-y-0.5 hover:bg-remotiv-green-light"
              >
                Book a meeting
              </Link>
              <Link
                href="/contact"
                className="rounded-[14px] border border-white/15 px-7 py-[13px] font-heading text-[0.95rem] font-semibold text-white transition-colors hover:bg-white/5"
              >
                Talk to the team
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
