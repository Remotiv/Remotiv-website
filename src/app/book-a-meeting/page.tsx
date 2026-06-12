import { Navbar } from "@/components/navbar";
import { MARKETING_STATS } from "@/lib/marketing-stats";
import BookingForm from "./_booking-form";
import CalendlyEmbed from "./_calendly-embed";
import DynamicCalendar from "./_dynamic-calendar";

export default function BookAMeetingPage() {
  return (
    <div className="min-h-screen bg-remotiv-bg font-sans">
      <Navbar />

      <section id="main" className="px-6 pt-10 pb-4 md:px-10">
        <div className="mx-auto max-w-[1100px]">
          <div className="relative flex flex-col items-stretch gap-12 overflow-hidden rounded-3xl bg-remotiv-lime-card p-6 sm:p-8 md:p-14 lg:min-h-[440px] lg:flex-row lg:items-center">
            <div className="flex flex-col gap-5 lg:w-[340px] lg:shrink-0">
              <span className="w-fit rounded-full bg-white/85 px-[18px] py-2 text-sm text-[#1a1a1a]">
                Available this week for a 30-min call
              </span>
              <h1 className="font-heading text-4xl font-bold leading-[1.15] text-remotiv-text-dark">
                Book a call in seconds, hire in days
              </h1>
              <p className="text-[15px] leading-[1.65] text-[#333]">
                Pick a time that works for you. Our team will reach out within 24
                hours to confirm your slot and understand your hiring needs.
              </p>
              <a
                href="#booking-form"
                className="inline-flex w-fit items-center gap-2 rounded-full bg-[#111] px-7 py-[14px] text-[15px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7E47FF] focus-visible:ring-offset-2"
              >
                Book My Call &rarr;
              </a>
            </div>

            <div aria-hidden="true" className="relative flex-1 lg:h-[400px]">
              <div className="relative w-full max-w-[370px] rounded-[20px] bg-white p-4 shadow-[0_4px_32px_rgba(0,0,0,0.10)] sm:p-5 lg:absolute lg:right-0 lg:top-0 lg:w-[370px] lg:max-w-full">
                <DynamicCalendar />
              </div>

              <div className="absolute right-[370px] top-[220px] hidden rounded-full bg-remotiv-purple px-4 py-[7px] text-[13px] font-medium text-white lg:block">
                Your Advisor
              </div>

              <div className="absolute right-[340px] top-[248px] hidden w-[228px] rounded-2xl bg-white p-[14px] shadow-[0_4px_24px_rgba(0,0,0,0.13)] lg:block">
                <div className="mb-[3px] font-heading text-xs font-semibold text-remotiv-text-dark">
                  Discovery Call &mdash; Remotiv
                </div>
                <div className="mb-[9px] text-[11px] text-[#888]">Sarah K.</div>
                <div className="mb-[10px] flex items-center gap-[6px] text-[11px] text-[#666]">
                  <div className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-remotiv-purple">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      aria-hidden="true"
                    >
                      <rect
                        x="1"
                        y="2"
                        width="8"
                        height="7"
                        rx="1"
                        stroke="white"
                        strokeWidth="1"
                      />
                      <path
                        d="M3 1v2M7 1v2M1 4.5h8"
                        stroke="white"
                        strokeWidth="1"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  Thu, April 10, 2026
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div className="rounded-lg bg-[#f5f5f5] px-[10px] py-[7px]">
                    <div className="flex items-center gap-1 text-[10px] text-[#aaa]">
                      <span className="inline-block size-[7px] rounded-[2px] bg-remotiv-lime-card" />
                      Duration
                    </div>
                    <div className="mt-0.5 font-heading text-xl font-bold leading-none text-remotiv-text-dark">
                      30
                    </div>
                    <div className="text-[10px] text-[#888]">min</div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-right text-[10px] text-[#aaa]">
                      Status
                    </div>
                    <div className="inline-flex items-center gap-[5px] rounded-full border border-[#a7f3d0] bg-[#d1fae5] px-3 py-[5px] text-[11px] font-bold text-[#065f46]">
                      <span className="size-[6px] shrink-0 rounded-full bg-[#10b981]" />
                      Confirmed
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-remotiv-bg py-16 md:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-5">
            <div className="lg:sticky lg:top-24 lg:col-span-2">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-remotiv-purple/20 bg-remotiv-purple/10 px-4 py-1.5">
                <span className="size-2 motion-safe:animate-pulse rounded-full bg-remotiv-green" />
                <span className="text-xs font-bold uppercase tracking-widest text-remotiv-purple">
                  Available Now
                </span>
              </div>

              <h2 className="mb-4 font-heading text-4xl font-bold leading-tight text-remotiv-text-dark md:text-5xl">
                Schedule a call{" "}
                <span className="text-remotiv-purple">that fits your timezone</span>
              </h2>

              <p className="mb-8 text-lg leading-relaxed text-gray-600">
                Pick a slot that works for you. We&apos;ll discuss your hiring
                needs, share pre-vetted candidate profiles, and outline next
                steps — no pressure, no commitments.
              </p>

              <div className="mb-8 space-y-4">
                {[
                  {
                    icon: "⚡",
                    title: "30-minute discovery call",
                    desc: "Quick, focused, no fluff",
                  },
                  {
                    icon: "🎯",
                    title: "Tailored to your roles",
                    desc: "We come prepared with candidate matches",
                  },
                  {
                    icon: "🌍",
                    title: "Any timezone works",
                    desc: "Mon–Fri, 9am–9pm PKT availability",
                  },
                  {
                    icon: "🔒",
                    title: "100% confidential",
                    desc: "NDAs available on request",
                  },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-xl shadow-sm">
                      {item.icon}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-remotiv-text-dark">
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-gray-200 pt-6">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Trusted by founders at
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="-space-x-2 flex">
                    <div className="flex size-8 items-center justify-center rounded-full bg-remotiv-purple text-xs font-bold text-white ring-2 ring-white">
                      JC
                    </div>
                    <div className="flex size-8 items-center justify-center rounded-full bg-remotiv-green text-xs font-bold text-white ring-2 ring-white">
                      SM
                    </div>
                    <div className="flex size-8 items-center justify-center rounded-full bg-remotiv-purple-light text-xs font-bold text-white ring-2 ring-white">
                      OF
                    </div>
                    <div className="flex size-8 items-center justify-center rounded-full bg-gray-700 text-[10px] font-bold text-white ring-2 ring-white">
                      +97
                    </div>
                  </div>
                  <p className="text-xs text-gray-600">
                    100+ companies hiring through Remotiv
                  </p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3">
              <div className="overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-xl">
                <div className="bg-gradient-to-r from-remotiv-purple to-remotiv-purple-light px-6 py-4 text-white">
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest opacity-80">
                    Book your slot
                  </p>
                  <p className="text-lg font-semibold">
                    Pick a date that works for you
                  </p>
                </div>
                <div className="bg-white">
                  <CalendlyEmbed />
                </div>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-4 text-center">
                <div className="rounded-2xl border border-gray-100 bg-white p-4">
                  <p className="font-heading text-2xl font-bold text-remotiv-purple">
                    24hr
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-gray-500">
                    Response Time
                  </p>
                </div>
                <div className="rounded-2xl border border-gray-100 bg-white p-4">
                  <p className="font-heading text-2xl font-bold text-remotiv-green">
                    {MARKETING_STATS.companies}
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-gray-500">
                    Active Clients
                  </p>
                </div>
                <div className="rounded-2xl border border-gray-100 bg-white p-4">
                  <p className="font-heading text-2xl font-bold text-remotiv-text-dark">
                    {MARKETING_STATS.savings}
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-gray-500">
                    Cost Savings
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-8 md:px-10">
        <div className="mx-auto flex max-w-[1100px] items-center gap-4">
          <span className="h-px flex-1 bg-black/10" />
          <span className="font-heading text-xs font-semibold uppercase tracking-[0.18em] text-[#666]">
            Prefer email? Fill out the form below
          </span>
          <span className="h-px flex-1 bg-black/10" />
        </div>
        <p className="mx-auto mt-3 max-w-[1100px] text-center text-xs text-[#666]">
          Or reach us at{" "}
          <a href="mailto:talent@remotiv.work" className="underline">
            talent@remotiv.work
          </a>
        </p>
      </section>

      <section id="booking-form" className="px-6 pt-4 pb-12 md:px-10">
        <div className="mx-auto max-w-[1100px]">
          <BookingForm />
        </div>
      </section>

    </div>
  );
}
