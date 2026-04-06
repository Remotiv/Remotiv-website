"use client";

import { Check, Lock } from "lucide-react";
import { type FormEvent, useState } from "react";

const CHECKS = [
  "We respond within 24 hours",
  "No retainer fees — pay only when you hire",
  "100% confidential — your data stays private",
];

const SERVICES = ["Recruitment", "Staff Augmentation", "Dedicated Team", "Payroll Services"];

const INPUT_CLASS =
  "rounded-lg border-none bg-[#f5f5f5] px-3 py-2.5 text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef]";

export function CtaInquiry() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <section className="relative z-[3] bg-white px-10 pt-16 pb-[60px]">
      <div className="mx-auto max-w-[900px]">
        <div className="relative z-[4] -mb-[140px] grid gap-14 rounded-3xl bg-[#c9ff85] px-[60px] py-[52px] lg:grid-cols-2">
          <div className="flex flex-col justify-center">
            <span className="mb-4 inline-flex w-fit items-center rounded-full bg-white/45 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-remotiv-text-dark">
              Hire in 24 Hours
            </span>
            <h2 className="font-heading text-[clamp(1.5rem,2.2vw,2rem)] font-black leading-[1.05] tracking-tight text-remotiv-text-dark">
              Ready to Build Your
              <br />
              Engineering Team?
            </h2>
            <p className="mt-3 max-w-md text-[13px] leading-[1.75] text-remotiv-text-dark/75">
              Tell us what you&apos;re looking for. We&apos;ll match you with pre-vetted senior
              engineers — no retainers, no risk, shortlist in 24 hours.
            </p>

            <ul className="mt-6 space-y-2.5">
              {CHECKS.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-[13px] font-medium text-remotiv-text-dark"
                >
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-white/50">
                    <Check className="size-[9px] text-remotiv-text-dark" strokeWidth={2.5} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            <div className="mt-7 flex items-center gap-2">
              <div className="flex">
                <div className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-[#c9ff85] bg-[#111] text-[9px] font-bold text-[#c9ff85]">
                  JC
                </div>
                <div className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-[#c9ff85] bg-[#7E47FF] text-[9px] font-bold text-white">
                  SM
                </div>
                <div className="flex size-7 items-center justify-center rounded-full border-2 border-[#c9ff85] bg-[#333] text-[9px] font-bold text-white">
                  OF
                </div>
              </div>
              <span className="ml-2 text-xs text-remotiv-text-dark/65">
                Trusted by 100+ companies worldwide
              </span>
            </div>
          </div>

          <div className="rounded-2xl bg-white px-6 py-7">
            {submitted ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 py-6 text-center">
                <div className="text-4xl">✅</div>
                <h3 className="font-heading text-base font-bold text-remotiv-text-dark">
                  Inquiry Sent!
                </h3>
                <p className="text-[13px] text-[#666]">
                  We&apos;ll get back to you within 24 hours.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
                <h3 className="mb-1 font-heading text-sm font-bold text-remotiv-text-dark">
                  Send an Inquiry
                </h3>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[#888]">
                      Full Name
                    </span>
                    <input type="text" required placeholder="Your name" className={INPUT_CLASS} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[#888]">
                      Company
                    </span>
                    <input
                      type="text"
                      required
                      placeholder="Company name"
                      className={INPUT_CLASS}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[#888]">
                    Work Email
                  </span>
                  <input
                    type="email"
                    required
                    placeholder="you@company.com"
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[#888]">
                    I&apos;m looking for
                  </span>
                  <select
                    required
                    defaultValue="Recruitment"
                    className={`${INPUT_CLASS} text-remotiv-text-mid`}
                  >
                    {SERVICES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[#888]">
                    Message
                  </span>
                  <textarea
                    rows={3}
                    placeholder="Tell us about the role..."
                    className={`${INPUT_CLASS} resize-none`}
                  />
                </label>

                <button
                  type="submit"
                  className="w-full rounded-[10px] bg-[#c9ff85] py-3 font-heading text-xs font-bold uppercase tracking-wide text-remotiv-text-dark transition-all hover:-translate-y-0.5 hover:bg-[#b8f060]"
                >
                  Send Inquiry →
                </button>
                <p className="flex items-center justify-center gap-1 text-center text-[10px] text-[#bbb]">
                  <Lock className="size-[9px] shrink-0 text-[#bbb]" strokeWidth={2} aria-hidden />
                  Your data is encrypted and 100% confidential
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
