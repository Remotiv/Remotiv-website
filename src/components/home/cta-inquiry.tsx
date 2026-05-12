"use client";

import { Check, Lock } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { submitContact } from "@/app/contact/actions";

const CHECKS = [
  "We respond within 24 hours",
  "No retainer fees — pay only when you hire",
  "100% confidential — your data stays private",
] as const;

const SERVICES = [
  "Recruitment",
  "Staff Augmentation",
  "Dedicated Team",
  "Payroll Services",
  "Hire per-hour",
  "Subscription",
  "General Inquiry",
] as const;

const TRUST_AVATARS = [
  { initials: "JC", bg: "#111", color: "#c9ff85" },
  { initials: "SM", bg: "#7E47FF", color: "#ffffff" },
  { initials: "OF", bg: "#333", color: "#ffffff" },
] as const;

const INPUT_CLASS =
  "w-full rounded-lg border-none bg-[#f5f5f5] px-3 py-2.5 font-sans text-xs text-[#333] outline-none transition-colors focus:bg-[#efefef]";

const LABEL_CLASS =
  "mb-1 block font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-[#666]";

type FormState = {
  name: string;
  company: string;
  email: string;
  service: string;
  message: string;
  // Honeypot — kept blank by humans; bots fill it. See actions.ts.
  companyUrl: string;
};

const INITIAL_FORM: FormState = {
  name: "",
  company: "",
  email: "",
  service: SERVICES[0],
  message: "",
  companyUrl: "",
};

export function CtaInquiry() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // M1: Double-click guard — synchronous lock before any async state flip
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    setStatus("sending");
    setErrorMessage(null);
    try {
      // M2: 15s client-side timeout — race the server action against a timer
      const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              success: false,
              error:
                "This is taking longer than expected. Please try again or email us at hello@remotiv.com.",
            }),
          15000,
        ),
      );

      const result = await Promise.race([submitContact(form), timeoutPromise]);

      if (result.success) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMessage(result.error);
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error
          ? "Something unexpected happened. Please try again or email us at hello@remotiv.com."
          : "Something unexpected happened. Please try again or email us at hello@remotiv.com.",
      );
    } finally {
      submitLockRef.current = false;
    }
  }

  const isPending = status === "sending";

  return (
    <section className="relative z-[3] bg-white px-6 pt-16 pb-[60px] md:px-10">
      <div className="mx-auto max-w-[900px]">
        <div className="relative z-[4] -mb-10 grid items-center gap-14 rounded-3xl bg-remotiv-lime-card px-7 py-10 md:-mb-[140px] md:grid-cols-2 md:px-[60px] md:py-[52px]">
          <div className="flex flex-col">
            <span className="mb-[18px] inline-flex w-fit items-center rounded-full bg-white/45 px-3.5 py-[5px] font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-[#111]">
              Hire in 24 Hours
            </span>
            <h2 className="mb-3 font-heading text-[clamp(1.5rem,2.2vw,2rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#111]">
              Ready to build your
              <br />
              engineering team?
            </h2>
            <p className="mb-6 max-w-md font-sans text-[13px] leading-[1.75] text-[#111]/75">
              Tell us what you&apos;re looking for. We&apos;ll match you with pre-vetted senior
              engineers — no retainers, no risk, shortlist in 24 hours.
            </p>

            <ul className="mb-7 flex flex-col gap-2.5">
              {CHECKS.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 font-sans text-[13px] font-medium text-[#111]"
                >
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-white/50">
                    <Check className="size-[9px] text-[#111]" strokeWidth={1.8} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            <div className="flex items-center">
              <div className="flex">
                {TRUST_AVATARS.map((avatar, i) => (
                  <div
                    key={avatar.initials}
                    className={`flex size-7 items-center justify-center rounded-full border-2 border-remotiv-lime-card text-[9px] font-bold ${i < TRUST_AVATARS.length - 1 ? "-mr-[7px]" : ""}`}
                    style={{ background: avatar.bg, color: avatar.color }}
                  >
                    {avatar.initials}
                  </div>
                ))}
              </div>
              <span className="ml-3 font-sans text-xs text-[#111]/65">
                Trusted by 100+ companies worldwide
              </span>
            </div>
          </div>

          {status === "success" ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-2xl bg-white px-6 py-10 text-center"
            >
              <div className="text-4xl">✅</div>
              <h3 className="mt-4 mb-2 font-heading text-base font-bold text-[#111]">
                Inquiry Sent!
              </h3>
              <p className="font-sans text-[13px] text-[#666]">
                We&apos;ll get back to you within 24 hours.
              </p>
              <button
                type="button"
                onClick={() => {
                  setForm(INITIAL_FORM);
                  setStatus("idle");
                  setErrorMessage(null);
                }}
                className="mt-4 text-sm font-medium text-remotiv-purple underline-offset-4 hover:underline"
              >
                Send another inquiry
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-white px-6 py-7">
              <h3 className="mb-4 font-heading text-sm font-bold text-[#111]">Send an Inquiry</h3>

              {/* Honeypot — hidden from humans, filled by bots */}
              <input
                type="text"
                name="company_url"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
                value={form.companyUrl}
                onChange={(e) => update("companyUrl", e.target.value)}
              />

              <div className="mb-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="cta-name">
                    Full Name
                  </label>
                  <input
                    id="cta-name"
                    type="text"
                    required
                    maxLength={100}
                    placeholder="Your name"
                    className={INPUT_CLASS}
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    aria-describedby={status === "error" ? "cta-form-error" : undefined}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="cta-company">
                    Company
                  </label>
                  <input
                    id="cta-company"
                    type="text"
                    required
                    maxLength={100}
                    placeholder="Company name"
                    className={INPUT_CLASS}
                    value={form.company}
                    onChange={(e) => update("company", e.target.value)}
                    aria-describedby={status === "error" ? "cta-form-error" : undefined}
                  />
                </div>
              </div>

              <div className="mb-2.5">
                <label className={LABEL_CLASS} htmlFor="cta-email">
                  Work Email
                </label>
                <input
                  id="cta-email"
                  type="email"
                  required
                  maxLength={254}
                  placeholder="you@company.com"
                  className={INPUT_CLASS}
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  aria-describedby={status === "error" ? "cta-form-error" : undefined}
                />
              </div>

              <div className="mb-2.5">
                <label className={LABEL_CLASS} htmlFor="cta-service">
                  I&apos;m looking for
                </label>
                <select
                  id="cta-service"
                  className={INPUT_CLASS}
                  value={form.service}
                  onChange={(e) => update("service", e.target.value)}
                  aria-describedby={status === "error" ? "cta-form-error" : undefined}
                >
                  {SERVICES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-2.5">
                <label className={LABEL_CLASS} htmlFor="cta-message">
                  Message
                </label>
                <textarea
                  id="cta-message"
                  rows={3}
                  maxLength={5000}
                  placeholder="Tell us about the role..."
                  className={`${INPUT_CLASS} min-h-[68px] resize-none`}
                  value={form.message}
                  onChange={(e) => update("message", e.target.value)}
                  aria-describedby={status === "error" ? "cta-form-error" : undefined}
                />
              </div>

              {status === "error" && (
                <p
                  id="cta-form-error"
                  role="alert"
                  aria-live="assertive"
                  className="mb-3 text-center text-[11px] text-red-600"
                >
                  {errorMessage ??
                    "Something went wrong. Please try again or email hello@remotiv.com."}
                </p>
              )}

              <button
                type="submit"
                disabled={isPending}
                className="w-full rounded-[10px] bg-remotiv-lime-card py-3 font-heading text-xs font-bold uppercase tracking-[0.06em] text-[#111] transition-all hover:-translate-y-0.5 hover:bg-[#b8f060] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              >
                {isPending ? "Sending…" : "Send Inquiry →"}
              </button>

              <p className="mt-3 flex items-center justify-center gap-1 font-sans text-[10px] text-[#666]">
                <Lock className="size-[9px] shrink-0" strokeWidth={2} aria-hidden />
                Your data is encrypted and 100% confidential
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
