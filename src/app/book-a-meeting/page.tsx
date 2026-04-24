"use client";

import { Check, Lock } from "lucide-react";
import { cloneElement, type ReactElement, useId, useState } from "react";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

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

export default function BookAMeetingPage() {
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

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
                      />
                    </Field>
                    <Field label="Company">
                      <input
                        type="text"
                        placeholder="Company name"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <Field label="Work Email">
                    <input
                      type="email"
                      required
                      placeholder="you@company.com"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="What Are You Looking For?">
                    <select required defaultValue="" className={selectClass}>
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
                    />
                  </Field>
                  <Field label="Preferred Call Time">
                    <select required defaultValue="" className={selectClass}>
                      <option value="" disabled>
                        Select a time
                      </option>
                      <option>This week</option>
                      <option>Next week</option>
                    </select>
                  </Field>
                  <button
                    type="submit"
                    className="mt-1.5 w-full rounded-xl bg-[#111] px-4 py-[17px] font-heading text-[15px] font-bold tracking-wide text-white transition-colors hover:bg-[#222] active:scale-[0.985]"
                  >
                    Book My Call →
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
