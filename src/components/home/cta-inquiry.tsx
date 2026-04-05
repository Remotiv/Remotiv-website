"use client";

import { Check, Send } from "lucide-react";
import Image from "next/image";
import { type FormEvent, useState } from "react";

const CHECKS = [
  "Pre-vetted senior engineers",
  "Matched in under 24 hours",
  "Zero-risk 2-week trial",
  "No long-term lock-in",
];

const SERVICES = [
  "Staff Augmentation",
  "Dedicated Teams",
  "Project-Based Hiring",
  "Executive Search",
  "Other",
];

const INPUT_CLASS =
  "rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none transition-colors focus:border-remotiv-purple-light focus:ring-2 focus:ring-remotiv-purple-light/20";

export function CtaInquiry() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <section className="bg-white px-6 pt-16 pb-0 sm:px-14 sm:pt-24">
      <div className="mx-auto max-w-7xl">
        <div className="-mb-[140px] grid gap-10 rounded-3xl bg-[#c9ff85] p-8 sm:p-12 lg:grid-cols-2 lg:gap-16">
          <div className="flex flex-col justify-center">
            <span className="mb-4 inline-flex w-fit items-center rounded-full bg-black/10 px-4 py-1.5 text-xs font-semibold text-remotiv-text-dark">
              Hire in 24 Hours
            </span>
            <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl">
              Ready to build your dream engineering team?
            </h2>
            <p className="mt-4 max-w-md text-base leading-relaxed text-remotiv-text-mid">
              Tell us what you need and we&apos;ll match you with pre-vetted engineers within 24
              hours.
            </p>

            <ul className="mt-8 space-y-3">
              {CHECKS.map((item) => (
                <li key={item} className="flex items-center gap-2.5 text-sm">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-black/10">
                    <Check className="size-3 text-remotiv-text-dark" />
                  </span>
                  <span className="text-remotiv-text-dark">{item}</span>
                </li>
              ))}
            </ul>

            <div className="mt-10 flex items-center gap-3">
              <div className="flex -space-x-2.5">
                {[1, 2, 3, 4].map((i) => (
                  <Image
                    key={i}
                    src="https://placehold.co/36x36"
                    alt=""
                    width={36}
                    height={36}
                    className="rounded-full border-2 border-[#c9ff85]"
                    unoptimized
                  />
                ))}
              </div>
              <span className="text-xs text-remotiv-text-mid">
                Trusted by 200+ engineering teams
              </span>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-7 shadow-sm">
            {submitted ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-12 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-remotiv-green/15">
                  <Check className="size-7 text-remotiv-green" />
                </span>
                <h3 className="font-heading text-xl font-bold text-remotiv-text-dark">
                  Request received!
                </h3>
                <p className="max-w-xs text-sm text-remotiv-text-mid">
                  We&apos;ll review your requirements and get back to you within 24 hours with
                  curated engineer profiles.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-remotiv-text-dark">Full name</span>
                    <input type="text" required placeholder="John Doe" className={INPUT_CLASS} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-remotiv-text-dark">Company</span>
                    <input type="text" required placeholder="Acme Inc." className={INPUT_CLASS} />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-remotiv-text-dark">Work email</span>
                  <input
                    type="email"
                    required
                    placeholder="john@acme.com"
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-remotiv-text-dark">Service</span>
                  <select
                    required
                    defaultValue=""
                    className={`${INPUT_CLASS} text-remotiv-text-mid`}
                  >
                    <option value="" disabled>
                      Select a service
                    </option>
                    {SERVICES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-remotiv-text-dark">Message</span>
                  <textarea
                    rows={3}
                    placeholder="Tell us about your hiring needs..."
                    className={`${INPUT_CLASS} resize-none`}
                  />
                </label>

                <button
                  type="submit"
                  className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#c9ff85] px-6 py-3 text-sm font-semibold text-remotiv-text-dark transition-all hover:-translate-y-0.5 hover:shadow-md"
                >
                  <Send className="size-4" />
                  Submit Inquiry
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
