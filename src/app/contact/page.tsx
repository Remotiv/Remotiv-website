"use client";

import { ArrowRight, Check, Clock, Lock, Mail, MapPin } from "lucide-react";
import { type FormEvent, useState } from "react";
import { submitContact } from "./actions";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";

const INQUIRY_CARDS = [
  {
    title: "Recruitment Inquiry",
    description:
      "Looking to hire top remote talent from Pakistan? Our recruitment team will match you with vetted professionals in days.",
    cta: "Contact recruitment",
    targetService: "Recruitment",
    illustration: (
      <svg
        viewBox="0 0 120 120"
        width="120"
        height="120"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="46" cy="36" r="16" fill="#e8e2f8" stroke="#7E47FF" strokeWidth="2" />
        <rect x="28" y="56" width="36" height="38" rx="10" fill="#fff" stroke="#7E47FF" strokeWidth="2" />
        <circle cx="46" cy="36" r="8" fill="#c8b8f0" />
        <line x1="64" y1="70" x2="76" y2="62" stroke="#7E47FF" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="74" y="46" width="34" height="44" rx="6" fill="#f9c74f" stroke="#e6ac30" strokeWidth="1.5" />
        <rect x="82" y="40" width="18" height="10" rx="3" fill="#e6ac30" />
        <line x1="80" y1="62" x2="102" y2="62" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <line x1="80" y1="70" x2="102" y2="70" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <line x1="80" y1="78" x2="94" y2="78" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <polyline points="80,62 83,65 88,59" stroke="#49D7A7" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="80,70 83,73 88,67" stroke="#49D7A7" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: "Sales Inquiry",
    description:
      "We're here to help! Whether you have a question about Remotiv's services, pricing, or partnerships — reach out anytime.",
    cta: "Contact sales",
    targetService: "General Inquiry",
    illustration: (
      <svg
        viewBox="0 0 120 120"
        width="120"
        height="120"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="68" cy="36" r="16" fill="#e8f8f0" stroke="#49D7A7" strokeWidth="2" />
        <rect x="50" y="56" width="36" height="38" rx="10" fill="#fff" stroke="#49D7A7" strokeWidth="2" />
        <circle cx="68" cy="36" r="8" fill="#a8e8cc" />
        <rect x="18" y="66" width="42" height="28" rx="6" fill="#c8b8f0" stroke="#7E47FF" strokeWidth="1.5" />
        <rect x="22" y="70" width="34" height="18" rx="3" fill="#e8e2f8" />
        <ellipse cx="39" cy="96" rx="10" ry="3" fill="#b0a0e0" />
        <line x1="50" y1="64" x2="42" y2="58" stroke="#49D7A7" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="24" y="34" width="32" height="22" rx="4" fill="#f9c74f" stroke="#e6ac30" strokeWidth="1.5" />
        <polyline points="24,36 40,48 56,36" stroke="#e6ac30" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="58" cy="34" r="8" fill="#49D7A7" />
        <text x="54.5" y="38" fontFamily="DM Sans" fontSize="8" fontWeight="700" fill="#111">+1</text>
        <text x="22" y="34" fontFamily="DM Sans" fontSize="14" fill="#7E47FF">+</text>
      </svg>
    ),
  },
];

const CONTACT_DETAILS = [
  {
    title: "Our Location",
    value: (
      <>
        Lahore, Pakistan
        <br />
        Serving clients globally
      </>
    ),
    icon: MapPin,
  },
  {
    title: "Email Us",
    value: (
      <>
        <a href="mailto:waleed@remotiv.work" className="text-remotiv-text-light hover:text-remotiv-text-dark">
          waleed@remotiv.work
        </a>
        <br />
        We reply within 24 hours
      </>
    ),
    icon: Mail,
  },
  {
    title: "Response Time",
    value: (
      <>
        Mon – Fri, 9am – 6pm PKT
        <br />
        Urgent? We prioritise same-day replies
      </>
    ),
    icon: Clock,
  },
];

const TRUST_CHECKS = [
  "We respond within 24 hours",
  "No commitment required to reach out",
  "100% confidential — your data stays private",
];

const TRUST_AVATARS = [
  { initials: "JC", bg: "#111", color: "#c9ff85" },
  { initials: "SM", bg: "#7E47FF", color: "#fff" },
  { initials: "OF", bg: "#333", color: "#fff" },
];

const SERVICE_OPTIONS = [
  "Recruitment",
  "Staff Augmentation",
  "Dedicated Team",
  "Payroll Services",
  "Hire per-hour",
  "Subscription",
  "General Inquiry",
];

type FormState = {
  name: string;
  company: string;
  email: string;
  service: string;
  message: string;
};

const INITIAL_FORM: FormState = {
  name: "",
  company: "",
  email: "",
  service: SERVICE_OPTIONS[0],
  message: "",
};

const INPUT_CLASS =
  "w-full rounded-lg bg-[#f5f5f5] px-3 py-[9px] text-xs text-[#333] font-sans outline-none transition-colors focus:bg-[#efefef] data-[invalid=true]:outline data-[invalid=true]:outline-2 data-[invalid=true]:outline-[#ff6b6b]";

const LABEL_CLASS = "mb-[5px] block text-[10px] font-semibold uppercase tracking-[0.06em] text-[#888]";

export default function ContactPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<{ name?: boolean; email?: boolean }>({});
  const [status, setStatus] = useState<"idle" | "sending" | "success">("idle");

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === "name" || key === "email") {
      setErrors((prev) => ({ ...prev, [key]: false }));
    }
  }

  function jumpToForm(targetService: string) {
    if (SERVICE_OPTIONS.includes(targetService)) {
      setForm((prev) => ({ ...prev, service: targetService }));
    }
    if (typeof document !== "undefined") {
      document
        .getElementById("contact-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = { name: !form.name.trim(), email: !form.email.trim() };
    if (nextErrors.name || nextErrors.email) {
      setErrors(nextErrors);
      return;
    }

    setStatus("sending");
    try {
      const result = await submitContact(form);
      if (result.success) {
        setStatus("success");
      } else {
        setStatus("idle");
        alert(
          `Submission failed: ${result.error}\n\nIf this keeps happening, email waleed@remotiv.work directly.`,
        );
      }
    } catch (err) {
      setStatus("idle");
      alert(
        `Submission failed: ${err instanceof Error ? err.message : "Unknown error"}\n\nIf this keeps happening, email waleed@remotiv.work directly.`,
      );
    }
  }

  function resetForm() {
    setForm(INITIAL_FORM);
    setErrors({});
    setStatus("idle");
  }

  return (
    <>
      <Navbar />
      <main className="bg-remotiv-bg font-sans">
        <section className="px-6 pb-14 pt-[72px] text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-remotiv-purple/20 bg-remotiv-purple/10 px-5 py-[7px] text-xs font-semibold uppercase tracking-[0.06em] text-remotiv-purple">
            <span className="size-1.5 rounded-full bg-remotiv-purple" />
            Get In Touch
          </div>
          <h1 className="mx-auto mb-5 max-w-[700px] font-heading text-[clamp(2rem,4vw,3.2rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
            We&apos;d Love to Hear From You
          </h1>
          <p className="mx-auto max-w-[520px] text-[1.05rem] leading-[1.65] text-remotiv-text-light">
            Whether you&apos;re looking to hire remote talent or join our network — our team is here to help.
          </p>
        </section>

        <section className="mx-auto mb-16 grid max-w-[900px] gap-5 px-6 md:grid-cols-2">
          {INQUIRY_CARDS.map((card) => (
            <div
              key={card.title}
              className="flex flex-col items-center rounded-3xl border border-black/[0.07] bg-white px-9 pb-10 pt-12 text-center shadow-[0_2px_16px_rgba(0,0,0,0.05)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_8px_40px_rgba(0,0,0,0.1)]"
            >
              <div className="mb-7 flex size-[120px] items-center justify-center">{card.illustration}</div>
              <h3 className="mb-3 font-heading text-xl font-bold text-remotiv-text-dark">{card.title}</h3>
              <p className="mb-7 max-w-[280px] text-[0.92rem] leading-[1.65] text-remotiv-text-light">
                {card.description}
              </p>
              <button
                type="button"
                onClick={() => jumpToForm(card.targetService)}
                className="inline-flex items-center gap-2 rounded-full bg-[#111] px-7 py-[13px] text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-[#333]"
              >
                {card.cta}
                <ArrowRight className="size-3.5" />
              </button>
            </div>
          ))}
        </section>

        <section id="contact-form" className="mx-auto mb-20 grid max-w-[1200px] items-center gap-10 px-6 md:px-14 lg:grid-cols-2 lg:gap-16 scroll-mt-24">
          <div>
            <div className="mb-5 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-remotiv-green">
              <span className="h-0.5 w-5 rounded-sm bg-remotiv-green" />
              Contact Us
            </div>
            <h2 className="mb-6 font-heading text-[clamp(1.8rem,3vw,2.8rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
              Have questions?
              <br />
              Send Us a Message
            </h2>
            <p className="mb-10 text-base leading-[1.75] text-[#555]">
              Fill out the form and we&apos;ll get back to you as soon as possible. We&apos;re committed to providing
              excellent customer service and addressing any inquiries you may have.
            </p>
            <div className="flex flex-col gap-6">
              {CONTACT_DETAILS.map(({ title, value, icon: Icon }) => (
                <div key={title} className="flex items-start gap-4">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-[#111]">
                    <Icon className="size-[18px] text-remotiv-green" strokeWidth={1.8} />
                  </div>
                  <div>
                    <div className="mb-1 font-heading text-[0.9rem] font-bold text-remotiv-text-dark">
                      {title}
                    </div>
                    <div className="text-[0.88rem] leading-[1.55] text-remotiv-text-light">{value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl bg-remotiv-lime-card px-10 py-12 md:px-[60px] md:py-[52px]">
            <div className="mb-[18px] inline-flex items-center rounded-full bg-white/45 px-3.5 py-[5px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[#111]">
              Get In Touch
            </div>
            <h2 className="mb-3 font-heading text-[clamp(1.5rem,2.2vw,2rem)] font-black leading-[1.05] tracking-[-0.03em] text-[#111]">
              Ready to Connect
              <br />
              With Remotiv?
            </h2>
            <p className="mb-6 text-[13px] leading-[1.75] text-[#111]/75">
              Tell us what you need. Whether it&apos;s hiring remote talent or a partnership question — we&apos;ll get
              back to you within 24 hours.
            </p>
            <ul className="mb-7 flex flex-col gap-2.5">
              {TRUST_CHECKS.map((check) => (
                <li key={check} className="flex items-center gap-2 text-[13px] font-medium text-[#111]">
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-white/50">
                    <Check className="size-[9px] text-[#111]" strokeWidth={3} />
                  </span>
                  {check}
                </li>
              ))}
            </ul>
            <div className="mb-7 flex items-center">
              <div className="flex">
                {TRUST_AVATARS.map((avatar) => (
                  <div
                    key={avatar.initials}
                    className="-mr-[7px] flex size-7 items-center justify-center rounded-full border-2 border-white text-[9px] font-bold"
                    style={{ background: avatar.bg, color: avatar.color }}
                  >
                    {avatar.initials}
                  </div>
                ))}
              </div>
              <span className="ml-3 text-xs text-[#111]/65">Trusted by 100+ companies worldwide</span>
            </div>

            <div className="rounded-2xl bg-white px-6 py-7">
              {status === "success" ? (
                <div className="py-6 text-center">
                  <div className="mb-3 text-4xl">✅</div>
                  <h3 className="mb-2 font-heading text-base font-bold text-remotiv-text-dark">
                    Inquiry Sent!
                  </h3>
                  <p className="text-[13px] text-remotiv-text-mid">We&apos;ll get back to you within 24 hours.</p>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="mt-4 rounded-[10px] bg-[#111] px-5 py-2.5 text-xs font-semibold tracking-[0.03em] text-white"
                  >
                    Submit Another Inquiry
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate>
                  <p className="mb-4 font-heading text-sm font-bold text-remotiv-text-dark">Send an Inquiry</p>
                  <div className="mb-2.5 grid gap-2.5 sm:grid-cols-2">
                    <div>
                      <label className={LABEL_CLASS} htmlFor="ct-name">
                        Full Name
                      </label>
                      <input
                        id="ct-name"
                        type="text"
                        className={INPUT_CLASS}
                        placeholder="Your name"
                        value={form.name}
                        data-invalid={errors.name || undefined}
                        onChange={(e) => update("name", e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={LABEL_CLASS} htmlFor="ct-company">
                        Company
                      </label>
                      <input
                        id="ct-company"
                        type="text"
                        className={INPUT_CLASS}
                        placeholder="Company name"
                        value={form.company}
                        onChange={(e) => update("company", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="mb-2.5">
                    <label className={LABEL_CLASS} htmlFor="ct-email">
                      Work Email
                    </label>
                    <input
                      id="ct-email"
                      type="email"
                      className={INPUT_CLASS}
                      placeholder="you@company.com"
                      value={form.email}
                      data-invalid={errors.email || undefined}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </div>
                  <div className="mb-2.5">
                    <label className={LABEL_CLASS} htmlFor="ct-service">
                      I&apos;m looking for
                    </label>
                    <select
                      id="ct-service"
                      className={INPUT_CLASS}
                      value={form.service}
                      onChange={(e) => update("service", e.target.value)}
                    >
                      {SERVICE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-2.5">
                    <label className={LABEL_CLASS} htmlFor="ct-message">
                      Message
                    </label>
                    <textarea
                      id="ct-message"
                      className={`${INPUT_CLASS} min-h-[68px] resize-none`}
                      placeholder="Tell us how we can help..."
                      value={form.message}
                      onChange={(e) => update("message", e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={status === "sending"}
                    className="mb-2.5 w-full rounded-[10px] bg-remotiv-lime-card px-3 py-3 font-heading text-xs font-bold uppercase tracking-[0.06em] text-[#111] transition-all hover:-translate-y-0.5 hover:bg-[#b8f060] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {status === "sending" ? "Sending…" : "Send Inquiry →"}
                  </button>
                  <p className="flex items-center justify-center gap-1 text-center text-[10px] text-[#bbb]">
                    <Lock className="size-[9px]" />
                    Your data is encrypted and 100% confidential
                  </p>
                </form>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
