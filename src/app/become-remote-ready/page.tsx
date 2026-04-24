import {
  ArrowRight,
  Briefcase,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FolderGit2,
  Globe2,
  Sparkles,
  User,
} from "lucide-react";
import Link from "next/link";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

const STATS = [
  "Active Talents",
  "Access to Global Companies",
  "Reviewed within 2–3 Days",
  "Set your Average Rate $15–$60/hr",
];

const BENEFITS = [
  {
    title: "Work with global companies",
    desc: "Get discovered by US, EU and APAC teams hiring for remote roles.",
  },
  {
    title: "Earn in USD",
    desc: "Set your own rate between $15–$60/hr and get paid on time, every time.",
  },
  {
    title: "Keep full flexibility",
    desc: "Full-time, part-time or contract — pick the availability that fits your life.",
  },
  {
    title: "Skip the endless interviews",
    desc: "One profile, reviewed once. Then companies come to you through Remotiv.",
  },
  {
    title: "Stay remote-first",
    desc: "Every role on Remotiv is fully remote. No commute, no relocation.",
  },
  {
    title: "Grow your career",
    desc: "Join a vetted community of Pakistan's top engineers, designers and marketers.",
  },
];

const STEPS = [
  {
    icon: User,
    title: "Personal Info",
    desc: "Share your name, city and phone so we can verify your identity.",
  },
  {
    icon: Briefcase,
    title: "Professional Details",
    desc: "Your role, hourly rate, availability and hours per week.",
  },
  {
    icon: Sparkles,
    title: "Summary & Skills",
    desc: "A short bio, top skills, languages and your LinkedIn / portfolio.",
  },
  {
    icon: FolderGit2,
    title: "Portfolio",
    desc: "Showcase 1–5 of your best projects with links and results.",
  },
  {
    icon: Building2,
    title: "Experience & Education",
    desc: "Your employment history and academic background.",
  },
  {
    icon: ClipboardCheck,
    title: "Review & Submit",
    desc: "Confirm everything looks right and send your profile for review.",
  },
];

export default function BecomeRemoteReadyPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1 bg-white">
        {/* Hero */}
        <section className="relative overflow-hidden bg-[#f8f4f1] px-6 pt-20 pb-0 sm:pt-24">
          <div className="mx-auto max-w-4xl text-center">
            <h1 className="font-heading text-4xl font-extrabold tracking-tight text-remotiv-text-dark sm:text-5xl md:text-6xl">
              <span className="block">Join the</span>
              <span className="block text-[#9886fe]">Remote Talent Network</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-remotiv-text-mid sm:text-lg">
              Create your profile and join Remotiv talent network. Top professionals from Pakistan —
              hired by global companies.
            </p>
          </div>

          {/* Purple stats card */}
          <div className="mx-auto mt-10 max-w-5xl">
            <div className="grid grid-cols-2 gap-4 rounded-t-3xl bg-[#7E47FF] px-6 py-8 sm:grid-cols-4 sm:gap-0 sm:px-10">
              {STATS.map((label, i) => (
                <div
                  key={label}
                  className={`flex items-center justify-center px-4 text-center ${
                    i < STATS.length - 1 ? "sm:border-r sm:border-white/15" : ""
                  }`}
                >
                  <span className="font-heading text-xs font-bold uppercase tracking-wider text-white/90 sm:text-sm">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="bg-white px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 text-center">
              <div className="mb-3 inline-block rounded-full bg-remotiv-green/10 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-remotiv-green">
                Why Join
              </div>
              <h2 className="font-heading text-3xl font-bold text-remotiv-text-dark sm:text-4xl">
                Built for talent. Trusted by companies.
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-remotiv-text-mid">
                Everything you need to land remote roles with vetted, global employers — without
                the recruiter runaround.
              </p>
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {BENEFITS.map((b) => (
                <div
                  key={b.title}
                  className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm transition-transform hover:-translate-y-1"
                >
                  <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-remotiv-green/10 text-remotiv-green">
                    <CheckCircle2 className="size-5" />
                  </div>
                  <h3 className="mb-1 font-heading text-lg font-bold text-remotiv-text-dark">
                    {b.title}
                  </h3>
                  <p className="text-sm text-remotiv-text-mid">{b.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Process / Timeline */}
        <section className="bg-[#f8f4f1] px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 text-center">
              <div className="mb-3 inline-block rounded-full bg-[#7E47FF]/10 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-[#7E47FF]">
                How it works
              </div>
              <h2 className="font-heading text-3xl font-bold text-remotiv-text-dark sm:text-4xl">
                Six steps to a live profile
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-remotiv-text-mid">
                Fill out your profile once. We review it within 2–3 business days and your profile
                goes live for hiring companies to discover.
              </p>
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((s, i) => (
                <div
                  key={s.title}
                  className="relative rounded-2xl border border-black/5 bg-white p-6"
                >
                  <div className="absolute -top-3 -right-3 flex size-9 items-center justify-center rounded-full bg-remotiv-green font-heading text-sm font-bold text-remotiv-text-dark shadow-md">
                    {i + 1}
                  </div>
                  <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-[#7E47FF]/10 text-[#7E47FF]">
                    <s.icon className="size-5" />
                  </div>
                  <h3 className="mb-1 font-heading text-lg font-bold text-remotiv-text-dark">
                    {s.title}
                  </h3>
                  <p className="text-sm text-remotiv-text-mid">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Application form */}
        <section id="apply" className="bg-white px-6 py-20">
          <div className="mx-auto max-w-3xl">
            <div className="mb-8 text-center">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#c9ff85] px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-remotiv-text-dark">
                <Globe2 className="size-3.5" /> Applications open
              </div>
              <h2 className="font-heading text-3xl font-bold text-remotiv-text-dark sm:text-4xl">
                Start your profile
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-remotiv-text-mid">
                The quick version. Fill this in and a Remotiv reviewer will reach out within 2–3
                business days.
              </p>
            </div>

            <form className="rounded-3xl border border-black/5 bg-[#f8f4f1] p-8 shadow-sm">
              <div className="grid gap-5 md:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">First name</span>
                  <input
                    type="text"
                    required
                    placeholder="First name"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">Last name</span>
                  <input
                    type="text"
                    required
                    placeholder="Last name"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">Email</span>
                  <input
                    type="email"
                    required
                    placeholder="you@example.com"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">City</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Lahore"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">Role title</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Full Stack Developer"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">Hourly rate</span>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-remotiv-text-mid">
                      $
                    </span>
                    <input
                      type="number"
                      min={1}
                      placeholder="35"
                      className="w-full rounded-xl border border-black/10 bg-white py-3 pr-12 pl-7 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-remotiv-text-mid">
                      /hr
                    </span>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">Availability</span>
                  <select
                    required
                    defaultValue=""
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  >
                    <option value="" disabled>
                      Select availability
                    </option>
                    <option value="full-time">Full-time</option>
                    <option value="part-time">Part-time</option>
                    <option value="contract">Contract</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-remotiv-text-mid">
                    Hours per week
                  </span>
                  <select
                    required
                    defaultValue=""
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  >
                    <option value="" disabled>
                      Select hours
                    </option>
                    <option value="lt20">Less than 20 hrs/week</option>
                    <option value="20-30">20–30 hrs/week</option>
                    <option value="gt30">More than 30 hrs/week</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className="text-sm font-semibold text-remotiv-text-mid">LinkedIn URL</span>
                  <input
                    type="url"
                    required
                    placeholder="https://linkedin.com/in/yourprofile"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className="text-sm font-semibold text-remotiv-text-mid">
                    Professional summary
                  </span>
                  <textarea
                    required
                    rows={4}
                    maxLength={300}
                    placeholder="Short summary about yourself, your expertise, and what makes you stand out..."
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-remotiv-text-dark outline-none focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                  />
                </label>
              </div>

              <label className="mt-6 flex items-start gap-3 rounded-xl border border-black/5 bg-white p-4 text-sm text-remotiv-text-mid">
                <input
                  type="checkbox"
                  required
                  className="mt-0.5 size-4 accent-remotiv-green"
                />
                <span>
                  I consent to identity verification as part of the Remotiv vetting process. Our
                  team may contact me to verify my identity after profile review.
                </span>
              </label>

              <button
                type="submit"
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-remotiv-green px-8 py-4 font-heading font-bold text-remotiv-text-dark shadow-[0_4px_18px_rgba(73,215,167,0.28)] transition-transform hover:-translate-y-0.5 hover:bg-[#3bc495]"
              >
                Submit Profile
                <ArrowRight className="size-4" />
              </button>
            </form>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="bg-white px-6 pb-20">
          <div className="mx-auto flex max-w-3xl flex-col items-start justify-between gap-5 rounded-3xl bg-[#111] p-10 sm:flex-row sm:items-center sm:gap-7">
            <div>
              <h2 className="font-heading text-xl font-extrabold text-white sm:text-2xl">
                Already hiring? Find vetted remote talent now.
              </h2>
              <p className="mt-1 text-sm text-white/60">
                Browse Pakistan&apos;s top professionals — engineers, designers, marketers and more.
              </p>
            </div>
            <Link
              href="/browse-talent"
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-remotiv-green px-7 py-3.5 font-heading text-sm font-bold text-remotiv-text-dark shadow-[0_4px_14px_rgba(73,215,167,0.25)] transition-transform hover:-translate-y-0.5 hover:bg-[#3bc495]"
            >
              Browse Talent
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
