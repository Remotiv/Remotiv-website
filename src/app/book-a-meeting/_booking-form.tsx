"use client";

import { track } from "@vercel/analytics";
import { Check, Lock } from "lucide-react";
import { cloneElement, type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { isValidEmail } from "@/lib/validators";
import { submitBooking } from "./actions";

const BENEFITS = [
  "We reply within 24 hours",
  "No retainer — you only pay when you hire",
  "Curated shortlist within 24 hours of your brief",
  "90-day replacement guarantee on every placement",
  "Dedicated point of contact throughout",
] as const;

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

export default function BookingForm() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [form, setForm] = useState<BookingFormState>(EMPTY_BOOKING);
  // Single-error model: track which client-validated field tripped the guard
  // so we can wire aria-invalid + focus the right control. Mirrors contact's
  // per-field-error pattern, scaled down to the two fields validated client-side.
  const [invalidField, setInvalidField] = useState<"full_name" | "email" | null>(null);
  // Synchronous guard against rapid double-clicks: disabled={submitting} only
  // takes effect after React commits, leaving a microsecond window. Mirrors
  // contact's pattern.
  const submitLockRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the success heading when the success card mounts so keyboard
  // + SR users land on the new content instead of on the now-unmounted submit.
  useEffect(() => {
    if (submitted) {
      successHeadingRef.current?.focus();
    }
  }, [submitted]);

  function setField<K extends keyof BookingFormState>(
    key: K,
    value: BookingFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errorMsg) setErrorMsg(null);
    if (invalidField) setInvalidField(null);
  }

  function resetBookingForm() {
    setForm(EMPTY_BOOKING);
    setErrorMsg(null);
    setInvalidField(null);
    setSubmitted(false);
    submitLockRef.current = false;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setErrorMsg(null);
    setInvalidField(null);
    const trimmedEmail = form.email.trim();
    if (!form.full_name.trim() || !trimmedEmail) {
      setErrorMsg("Name and work email are required.");
      const which: "full_name" | "email" = !form.full_name.trim() ? "full_name" : "email";
      setInvalidField(which);
      if (which === "full_name") nameRef.current?.focus();
      else emailRef.current?.focus();
      submitLockRef.current = false;
      return;
    }
    // M3: client uses the same isValidEmail the server runs so we catch
    // typos before paying the round-trip cost.
    if (!isValidEmail(trimmedEmail)) {
      setErrorMsg("Please enter a valid email address.");
      setInvalidField("email");
      emailRef.current?.focus();
      submitLockRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitBooking(form);
      if (!result.success) {
        setErrorMsg(result.error);
        return;
      }
      track("booking_submitted", {
        source: "book_a_meeting_form",
      });
      setSubmitted(true);
    } catch {
      // M4: network/runtime failures used to leave submitting=true forever.
      setErrorMsg(
        "Something went wrong. Please try again or email us at talent@remotiv.work.",
      );
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  return submitted ? (
    <div className="rounded-3xl bg-remotiv-purple-light p-6 text-center text-white sm:p-8 md:p-10">
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-white/20">
        <Check className="size-7" />
      </div>
      <h2
        ref={successHeadingRef}
        tabIndex={-1}
        className="font-heading text-3xl font-bold focus:outline-none"
      >
        Request received
      </h2>
      <p className="mt-3 text-white/80">
        We&apos;ll reply within 24 hours to confirm your slot.
      </p>
      <button
        type="button"
        onClick={resetBookingForm}
        className="mt-6 inline-flex w-fit items-center gap-2 rounded-full bg-[#111] px-7 py-[14px] text-[15px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7E47FF] focus-visible:ring-offset-2"
      >
        Book another call
      </button>
    </div>
  ) : (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-3xl bg-remotiv-purple-light p-6 sm:p-8 md:p-10">
        <div className="mb-5 inline-flex w-fit items-center gap-[7px] rounded-full bg-white/20 px-4 py-1.5 font-heading text-[11px] font-semibold tracking-[0.08em] text-white">
          <span className="size-[7px] shrink-0 rounded-full bg-remotiv-lime-card" />
          BOOK A MEETING
        </div>
        <h2 className="mb-4 font-heading text-[32px] font-bold leading-[1.1] text-white sm:text-[44px] sm:leading-[1.08]">
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
          <p className="mb-2.5 font-heading text-[10px] font-semibold uppercase tracking-[0.12em] text-remotiv-lime-card">
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

      <form
        onSubmit={handleSubmit}
        className="rounded-3xl bg-remotiv-purple-light p-6 sm:p-8 md:p-10"
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
            <Field label="Full Name" required>
              <input
                ref={nameRef}
                type="text"
                required
                maxLength={100}
                autoComplete="name"
                placeholder="Your name"
                className={inputClass}
                value={form.full_name}
                aria-invalid={invalidField === "full_name" ? true : undefined}
                aria-describedby={errorMsg ? "bf-error" : undefined}
                onChange={(e) => setField("full_name", e.target.value)}
              />
            </Field>
            <Field label="Company">
              <input
                type="text"
                maxLength={100}
                autoComplete="organization"
                placeholder="Company name"
                className={inputClass}
                value={form.company}
                onChange={(e) => setField("company", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Work Email" required>
            <input
              ref={emailRef}
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              placeholder="you@company.com"
              className={inputClass}
              value={form.email}
              aria-invalid={invalidField === "email" ? true : undefined}
              aria-describedby={errorMsg ? "bf-error" : undefined}
              onChange={(e) => setField("email", e.target.value)}
            />
          </Field>
          <Field label="What Are You Looking For?" required>
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
              maxLength={5000}
              placeholder="Describe the role, tech stack, seniority level, and timeline..."
              className={`${inputClass} h-24 resize-none leading-relaxed`}
              value={form.message}
              onChange={(e) => setField("message", e.target.value)}
            />
          </Field>
          <Field label="Preferred Call Time" required>
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
            <p
              id="bf-error"
              role="alert"
              aria-live="assertive"
              className="rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-white"
            >
              {errorMsg}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="mt-1.5 w-full rounded-xl bg-[#111] px-4 py-[17px] font-heading text-[15px] font-bold tracking-wide text-white transition-colors hover:bg-[#222] motion-safe:active:scale-[0.985] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7E47FF] focus-visible:ring-offset-2"
          >
            {submitting ? "Booking…" : "Book My Call →"}
          </button>
          <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-xs text-white/70">
            <Lock className="size-3" />
            Your data is encrypted and kept 100% confidential.
          </p>
        </div>
      </form>
    </div>
  );
}

const inputClass =
  "w-full min-h-11 rounded-[10px] border-[1.5px] border-white/30 bg-white/20 px-[15px] py-3 text-base text-white outline-none placeholder:text-white/45 transition-colors focus:border-white/70 sm:min-h-0 sm:text-sm";

const selectClass = `${inputClass} cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%228%22 viewBox=%220 0 12 8%22><path fill=%22rgba(255,255,255,0.55)%22 d=%22M6 8L0 0h12z%22/></svg>')] bg-[length:10px] bg-[position:right_14px_center] bg-no-repeat pr-9 text-white/80 [&>option]:bg-white [&>option]:text-remotiv-text-dark`;

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
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
        {required && (
          <>
            {" "}
            <span className="text-red-500" aria-hidden="true">*</span>
          </>
        )}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
