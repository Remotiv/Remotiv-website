"use client";

import { Check, Lock } from "lucide-react";
import { cloneElement, type ReactElement, useEffect, useId, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { submitBooking } from "./actions";

const CALENDLY_URL =
  "https://calendly.com/waleed-izww/intro-call?hide_event_type_details=1&hide_gdpr_banner=1";

function CalendlyEmbed() {
  useEffect(() => {
    const id = "calendly-widget-script";
    if (document.getElementById(id)) return;
    const s = document.createElement("script");
    s.id = id;
    s.src = "https://assets.calendly.com/assets/external/widget.js";
    s.async = true;
    document.body.appendChild(s);
  }, []);

  return (
    <div
      className="calendly-inline-widget overflow-hidden rounded-3xl bg-white shadow-[0_4px_24px_rgba(0,0,0,0.08)]"
      data-url={CALENDLY_URL}
      style={{ minWidth: 320, height: 700 }}
    />
  );
}

type DayKind = "green" | "orange" | "red" | "plain" | "empty";
type CalendarDay = { num: number | null; kind: DayKind };

const CALENDAR_DAYS: CalendarDay[] = [
  { num: null, kind: "empty" },
  { num: null, kind: "empty" },
  { num: null, kind: "empty" },
  { num: 1, kind: "orange" },
  { num: 2, kind: "green" },
  { num: 3, kind: "green" },
  { num: 4, kind: "plain" },
  { num: 5, kind: "plain" },
  { num: 6, kind: "green" },
  { num: 7, kind: "green" },
  { num: 8, kind: "red" },
  { num: 9, kind: "green" },
  { num: 10, kind: "orange" },
  { num: 11, kind: "plain" },
  { num: 12, kind: "plain" },
  { num: 13, kind: "green" },
  { num: 14, kind: "green" },
  { num: 15, kind: "plain" },
  { num: 16, kind: "orange" },
  { num: 17, kind: "green" },
  { num: null, kind: "empty" },
  { num: 19, kind: "plain" },
  { num: 20, kind: "green" },
  { num: 21, kind: "orange" },
  { num: 22, kind: "green" },
  { num: 23, kind: "plain" },
  { num: 24, kind: "green" },
  { num: null, kind: "empty" },
  { num: 26, kind: "plain" },
  { num: 27, kind: "green" },
  { num: 28, kind: "plain" },
  { num: 29, kind: "green" },
  { num: 30, kind: "orange" },
  { num: null, kind: "empty" },
  { num: null, kind: "empty" },
];

const BENEFITS = [
  "We respond within 24 hours",
  "No retainer — you only pay when you hire",
  "Curated shortlist within 24 hours of your brief",
  "90-day replacement guarantee on every placement",
  "Dedicated point of contact throughout",
] as const;

const DAY_STYLES: Record<DayKind, string> = {
  green: "bg-[#c9ff85] text-[#2a5c00]",
  orange: "bg-[#FFD97A] text-[#7a4800]",
  red: "bg-[#ff6b6b] font-semibold text-white",
  plain: "text-[#333]",
  empty: "pointer-events-none opacity-0",
};

type BookingFormState = {
  full_name: string;
  company: string;
  email: string;
  service: string;
  message: string;
  preferred_time: string;
  // Honeypot — kept blank by humans; bots fill it. See actions.ts.
  companyUrl: string;
};

const EMPTY_BOOKING: BookingFormState = {
  full_name: "",
  company: "",
  email: "",
  service: "",
  message: "",
  preferred_time: "",
  companyUrl: "",
};

export default function BookAMeetingPage() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [form, setForm] = useState<BookingFormState>(EMPTY_BOOKING);

  function setField<K extends keyof BookingFormState>(
    key: K,
    value: BookingFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!form.full_name.trim() || !form.email.trim()) {
      setErrorMsg("Name and work email are required.");
      return;
    }
    setSubmitting(true);
    const result = await submitBooking(form);
    setSubmitting(false);
    if (!result.success) {
      setErrorMsg(result.error);
      return;
    }
    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bg-[#f8f4f1] font-sans">
      <Navbar />

      {/* Calendar preview section */}
      <section className="px-6 pt-10 pb-4 md:px-10">
        <div className="mx-auto max-w-[1100px]">
          <div className="relative flex min-h-[440px] flex-col items-stretch gap-12 overflow-hidden rounded-3xl bg-[#c9ff85] p-8 md:flex-row md:items-center md:p-14">
            {/* Left */}
            <div className="flex flex-col gap-5 md:w-[340px] md:shrink-0">
              <span className="w-fit rounded-full bg-white/85 px-[18px] py-2 text-sm text-[#1a1a1a]">
                Available this week for a 30-min call
              </span>
              <h2 className="font-heading text-4xl font-bold leading-[1.15] text-[#111]">
                Book a call in seconds, hire in days
              </h2>
              <p className="text-[15px] leading-[1.65] text-[#333]">
                Pick a time that works for you. Our team will reach out within 24
                hours to confirm your slot and understand your hiring needs.
              </p>
              <a
                href="#booking-form"
                className="inline-flex w-fit items-center gap-2 rounded-full bg-[#111] px-7 py-[14px] text-[15px] font-medium text-white"
              >
                Book My Call &rarr;
              </a>
            </div>

            {/* Right */}
            <div className="relative h-[400px] flex-1">
              {/* Calendar card */}
              <div className="absolute right-0 top-0 w-[370px] max-w-full rounded-[20px] bg-white p-5 shadow-[0_4px_32px_rgba(0,0,0,0.10)]">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-[10px]">
                    <div className="flex size-9 items-center justify-center rounded-[10px] bg-[#7E47FF]">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 18 18"
                        fill="none"
                        aria-hidden="true"
                      >
                        <rect
                          x="2"
                          y="4"
                          width="14"
                          height="12"
                          rx="2"
                          stroke="white"
                          strokeWidth="1.5"
                        />
                        <path
                          d="M6 2v3M12 2v3M2 8h14"
                          stroke="white"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                    <div>
                      <div className="font-heading text-[15px] font-semibold text-[#111]">
                        April
                      </div>
                      <div className="mt-px text-xs text-[#888]">2026</div>
                    </div>
                  </div>
                  <div className="font-heading text-[22px] font-bold text-[#111]">
                    Availability
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-1">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <div
                      key={`${d}-${i}`}
                      className="pb-1.5 text-center text-[11px] font-medium text-[#aaa]"
                    >
                      {d}
                    </div>
                  ))}
                  {CALENDAR_DAYS.map((day, i) => (
                    <div
                      key={i}
                      className={`mx-auto flex size-9 items-center justify-center rounded-full text-[13px] ${DAY_STYLES[day.kind]}`}
                    >
                      {day.num ?? ""}
                    </div>
                  ))}
                </div>
              </div>

              {/* Your Advisor pill */}
              <div className="absolute right-[370px] top-[220px] hidden rounded-full bg-[#7E47FF] px-4 py-[7px] text-[13px] font-medium text-white md:block">
                Your Advisor
              </div>

              {/* Task card */}
              <div className="absolute right-[340px] top-[248px] hidden w-[228px] rounded-2xl bg-white p-[14px] shadow-[0_4px_24px_rgba(0,0,0,0.13)] md:block">
                <div className="mb-[3px] font-heading text-xs font-semibold text-[#111]">
                  Discovery Call &mdash; Remotiv
                </div>
                <div className="mb-[9px] text-[11px] text-[#888]">Sarah K.</div>
                <div className="mb-[10px] flex items-center gap-[6px] text-[11px] text-[#666]">
                  <div className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-[#7E47FF]">
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
                      <span className="inline-block size-[7px] rounded-[2px] bg-[#c9ff85]" />
                      Duration
                    </div>
                    <div className="mt-0.5 font-heading text-xl font-bold leading-none text-[#111]">
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

      <section className="bg-[#f8f4f1] py-16 md:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-5">
            <div className="lg:sticky lg:top-24 lg:col-span-2">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#7E47FF]/20 bg-[#7E47FF]/10 px-4 py-1.5">
                <span className="size-2 animate-pulse rounded-full bg-[#49D7A7]" />
                <span className="text-xs font-bold uppercase tracking-widest text-[#7E47FF]">
                  Available Now
                </span>
              </div>

              <h2 className="mb-4 font-heading text-4xl font-bold leading-tight text-[#111] md:text-5xl">
                Schedule a call{" "}
                <span className="text-[#7E47FF]">that fits your timezone</span>
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
                    desc: "Mon-Fri, 9am-9pm PKT availability",
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
                      <p className="text-sm font-semibold text-[#111]">
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
                    <div className="flex size-8 items-center justify-center rounded-full bg-[#7E47FF] text-xs font-bold text-white ring-2 ring-white">
                      JC
                    </div>
                    <div className="flex size-8 items-center justify-center rounded-full bg-[#49D7A7] text-xs font-bold text-white ring-2 ring-white">
                      SM
                    </div>
                    <div className="flex size-8 items-center justify-center rounded-full bg-[#9886FE] text-xs font-bold text-white ring-2 ring-white">
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
                <div className="bg-gradient-to-r from-[#7E47FF] to-[#9886FE] px-6 py-4 text-white">
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
                  <p className="font-heading text-2xl font-bold text-[#7E47FF]">
                    48hr
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-gray-500">
                    Response Time
                  </p>
                </div>
                <div className="rounded-2xl border border-gray-100 bg-white p-4">
                  <p className="font-heading text-2xl font-bold text-[#49D7A7]">
                    100+
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-gray-500">
                    Active Clients
                  </p>
                </div>
                <div className="rounded-2xl border border-gray-100 bg-white p-4">
                  <p className="font-heading text-2xl font-bold text-[#111]">
                    60%
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

      {/* Divider — sends user down to the email form alternative */}
      <section className="px-6 py-8 md:px-10">
        <div className="mx-auto flex max-w-[1100px] items-center gap-4">
          <span className="h-px flex-1 bg-black/10" />
          <span className="font-heading text-xs font-semibold uppercase tracking-[0.18em] text-[#666]">
            Prefer email? Fill out the form below
          </span>
          <span className="h-px flex-1 bg-black/10" />
        </div>
      </section>

      {/* Booking form */}
      <section id="booking-form" className="px-6 pt-4 pb-12 md:px-10">
        <div className="mx-auto max-w-[1100px]">
          {submitted ? (
            <div className="rounded-3xl bg-[#9886fe] p-10 text-center text-white">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-white/20">
                <Check className="size-7" />
              </div>
              <h2 className="font-heading text-3xl font-bold">Request received</h2>
              <p className="mt-3 text-white/80">
                We&apos;ll reach out within 24 hours to confirm your slot.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {/* Left panel */}
              <div className="rounded-3xl bg-[#9886fe] p-10">
                <div className="mb-5 inline-flex w-fit items-center gap-[7px] rounded-full bg-white/20 px-4 py-1.5 font-heading text-[11px] font-semibold tracking-[0.08em] text-white">
                  <span className="size-[7px] shrink-0 rounded-full bg-[#c9ff85]" />
                  BOOK A MEETING
                </div>
                <h2 className="mb-4 font-heading text-[44px] font-bold leading-[1.08] text-white">
                  Let&apos;s Find Your
                  <br />
                  Next Hire
                </h2>
                <p className="mb-6 text-[15px] leading-[1.6] text-white/80">
                  Tell us what you&apos;re looking for. We&apos;ll set up a quick
                  30-minute call and match you with the right talent — fast.
                </p>
                <ul className="mb-7 flex flex-col gap-[13px]">
                  {BENEFITS.map((b) => (
                    <li
                      key={b}
                      className="flex items-center gap-[11px] text-[14.5px] leading-[1.4] text-white/90"
                    >
                      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-white/50">
                        <Check
                          className="size-3 text-white"
                          strokeWidth={2.5}
                        />
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>
                <div className="rounded-2xl bg-black/20 px-6 py-[22px]">
                  <p className="mb-2.5 font-heading text-[10px] font-semibold uppercase tracking-[0.12em] text-[#c9ff85]">
                    Our Guarantee
                  </p>
                  <p className="mb-[7px] font-heading text-base font-bold text-white">
                    &ldquo;You only pay when you hire successfully.&rdquo;
                  </p>
                  <p className="text-[13px] text-white/60">
                    No placement, no invoice. Zero risk to your budget.
                  </p>
                </div>
              </div>

              {/* Right form panel */}
              <form
                onSubmit={handleSubmit}
                className="rounded-3xl bg-[#9886fe] p-10"
              >
                {/* Honeypot — hidden from humans, filled by bots */}
                <input
                  type="text"
                  name="company_url"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
                  value={form.companyUrl}
                  onChange={(e) => setField("companyUrl", e.target.value)}
                />
                <p className="mb-[22px] font-heading text-2xl font-bold text-white">
                  Schedule Your Call
                </p>
                <div className="flex flex-col gap-[14px]">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Full Name">
                      <input
                        type="text"
                        required
                        placeholder="Your name"
                        className={inputClass}
                        value={form.full_name}
                        onChange={(e) => setField("full_name", e.target.value)}
                      />
                    </Field>
                    <Field label="Company">
                      <input
                        type="text"
                        placeholder="Company name"
                        className={inputClass}
                        value={form.company}
                        onChange={(e) => setField("company", e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="Work Email">
                    <input
                      type="email"
                      required
                      placeholder="you@company.com"
                      className={inputClass}
                      value={form.email}
                      onChange={(e) => setField("email", e.target.value)}
                    />
                  </Field>
                  <Field label="What Are You Looking For?">
                    <select
                      required
                      className={selectClass}
                      value={form.service}
                      onChange={(e) => setField("service", e.target.value)}
                    >
                      <option value="" disabled>
                        Select a service
                      </option>
                      <option>Recruitment</option>
                      <option>Staff Augmentation</option>
                      <option>Dedicated Team Build</option>
                      <option>Payroll</option>
                      <option>Other</option>
                    </select>
                  </Field>
                  <Field label="Tell Us About the Role">
                    <textarea
                      placeholder="Describe the role, tech stack, seniority level, and timeline..."
                      className={`${inputClass} h-24 resize-none leading-relaxed`}
                      value={form.message}
                      onChange={(e) => setField("message", e.target.value)}
                    />
                  </Field>
                  <Field label="Preferred Call Time">
                    <select
                      required
                      className={selectClass}
                      value={form.preferred_time}
                      onChange={(e) => setField("preferred_time", e.target.value)}
                    >
                      <option value="" disabled>
                        Select a time
                      </option>
                      <option>This week</option>
                      <option>Next week</option>
                    </select>
                  </Field>
                  {errorMsg && (
                    <p className="rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-white">
                      {errorMsg}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="mt-1.5 w-full rounded-xl bg-[#111] px-4 py-[17px] font-heading text-[15px] font-bold tracking-wide text-white transition-colors hover:bg-[#222] active:scale-[0.985] disabled:opacity-60"
                  >
                    {submitting ? "Booking…" : "Book My Call →"}
                  </button>
                  <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-xs text-white/50">
                    <Lock className="size-3" />
                    Your information is encrypted and 100% confidential
                  </p>
                </div>
              </form>
            </div>
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}

const inputClass =
  "w-full rounded-[10px] border-[1.5px] border-white/30 bg-white/20 px-[15px] py-3 text-sm text-white outline-none placeholder:text-white/45 transition-colors focus:border-white/70";

const selectClass = `${inputClass} cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%228%22 viewBox=%220 0 12 8%22><path fill=%22rgba(255,255,255,0.55)%22 d=%22M6 8L0 0h12z%22/></svg>')] bg-[length:10px] bg-[position:right_14px_center] bg-no-repeat pr-9 text-white/80 [&>option]:bg-white [&>option]:text-[#111]`;

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-[5px]">
      <label
        htmlFor={id}
        className="font-heading text-[10px] font-semibold uppercase tracking-[0.1em] text-white/75"
      >
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
