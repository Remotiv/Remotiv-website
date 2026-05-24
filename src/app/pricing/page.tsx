import Link from "next/link";
import type { ReactNode } from "react";
import { Navbar } from "@/components/navbar";
import { PLAN_PRICING } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { TierCTA } from "./_tier-cta";

type FeatureValue = boolean | string;

interface Tier {
  name: string;
  price: string;
  priceSuffix?: string;
  description: string;
  features: readonly { label: string; included?: boolean }[];
  cta: string;
  href: string;
  featured?: boolean;
}

const TIERS: readonly Tier[] = [
  {
    name: PLAN_PRICING.starter.name,
    price: PLAN_PRICING.starter.price,
    priceSuffix: PLAN_PRICING.starter.priceSuffix,
    description: "For companies exploring the talent pool",
    features: [
      { label: "Browse the full Remotiv talent pool" },
      { label: "View candidate profiles with resumes" },
      { label: "Unlock up to 30 contact details per month" },
      { label: "Advanced filters", included: false },
      { label: "Dedicated account manager", included: false },
    ],
    cta: "Get Started",
    href: "/signup",
  },
  {
    name: PLAN_PRICING.pro.name,
    price: PLAN_PRICING.pro.price,
    priceSuffix: PLAN_PRICING.pro.priceSuffix,
    description: "For teams actively hiring at scale",
    features: [
      { label: "Everything in Starter" },
      { label: "300 Profiles/mo" },
      { label: "Advanced filters — role, stack, seniority, availability, salary" },
      { label: "Save and shortlist candidates" },
      { label: "Priority support" },
    ],
    cta: "Get Started",
    href: "/signup",
    featured: true,
  },
  {
    name: PLAN_PRICING.enterprise.name,
    price: PLAN_PRICING.enterprise.price,
    priceSuffix: PLAN_PRICING.enterprise.priceSuffix,
    description: "For companies who want Remotiv to do the heavy lifting",
    features: [
      { label: "Everything in Pro" },
      { label: "Our recruiters source and vet candidates for you" },
      { label: "AI-powered matching to your exact role requirements" },
      { label: "Unlimited talent access" },
      { label: "90-day free replacement guarantee" },
      { label: "Dedicated success manager" },
    ],
    cta: "Get a Quote",
    href: "/contact",
  },
];

const FULL_SERVICE_FEATURES = [
  "Shortlist delivered within 24 hours of your brief",
  "Every candidate screened, referenced & salary-benchmarked",
  "90-day free replacement — no questions asked",
  "One dedicated recruiter assigned to your role",
] as const;

const COMPARISON: readonly {
  feature: string;
  starter: FeatureValue;
  pro: FeatureValue;
  enterprise: FeatureValue;
}[] = [
  {
    feature: "Talent Profile Access",
    starter: "30 Profiles/mo",
    pro: "300 Profiles/mo",
    enterprise: "Unlimited",
  },
  {
    feature: "CV / Resume Downloads",
    starter: "30/mo",
    pro: "300/mo",
    enterprise: "Unlimited",
  },
  {
    feature: "Direct Candidate Contact",
    starter: true,
    pro: true,
    enterprise: true,
  },
  {
    feature: "Shortlist & Save Profiles",
    starter: true,
    pro: true,
    enterprise: true,
  },
  {
    feature: "Dedicated Account Manager",
    starter: false,
    pro: false,
    enterprise: true,
  },
  {
    feature: "Custom Hiring Workflows",
    starter: false,
    pro: false,
    enterprise: true,
  },
  {
    feature: "90-Day Replacement Guarantee",
    starter: false,
    pro: false,
    enterprise: true,
  },
  {
    feature: "Support",
    starter: "Email",
    pro: "Priority",
    enterprise: "24/7 Dedicated",
  },
];

const STATS = [
  {
    value: "90%",
    label: "Placement Success Rate",
    desc: "Our clients consistently fill roles faster and with higher quality candidates than traditional recruiting methods.",
  },
  {
    value: "5/5",
    label: "Client Satisfaction Score",
    desc: "Businesses that work with Remotiv rate us top marks for communication, speed, and candidate quality.",
  },
] as const;

const FAQS = [
  {
    q: "Can I change plans later?",
    a: "Yes, you can upgrade or downgrade at any time. Changes take effect at the start of your next billing cycle.",
  },
  {
    q: "Is there a free trial?",
    a: "We offer a personalized demo instead of a free trial so we can tailor the platform to your hiring needs. Book a meeting to explore.",
  },
  {
    q: "What does 'success-based' mean for Enterprise?",
    a: "For our full-service Enterprise plan, you only pay a placement fee when you hire a candidate we deliver — no upfront cost.",
  },
  {
    q: "How does the 90-day replacement guarantee work?",
    a: "If a placed candidate doesn't work out within 90 days, we'll find a replacement at no additional cost.",
  },
] as const;

function CheckCircle({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-remotiv-green",
        className,
      )}
    >
      <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className="size-[11px]">
        <path
          d="M2 6l3 3 5-5"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function CrossCircle({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className="size-[11px]">
        <path d="M3 3l6 6M9 3l-6 6" stroke="#999" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "inline-block text-[0.72rem] font-bold uppercase tracking-[0.14em] text-remotiv-green",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ComparisonCell({ value, featured }: { value: FeatureValue; featured?: boolean }) {
  if (value === true)
    return (
      <>
        <CheckCircle className="size-7" />
        <span className="sr-only">Included</span>
      </>
    );
  if (value === false)
    return (
      <>
        <span className="inline-block h-[2px] w-5 rounded bg-[#ccc]" aria-hidden="true" />
        <span className="sr-only">Not included</span>
      </>
    );
  return (
    <span className={cn("text-[0.9rem]", featured ? "font-medium text-[#111]" : "text-[#444]")}>
      {value}
    </span>
  );
}

export default function PricingPage() {
  return (
    <>
      <Navbar />
      <main id="main" className="flex-1">
        <section className="bg-remotiv-bg px-6 py-20 sm:px-8 md:px-14 md:py-24">
          <div className="mx-auto mb-14 max-w-3xl text-center">
            <span className="mb-5 inline-block rounded-full bg-remotiv-green/[0.12] px-4 py-1.5 text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-remotiv-green">
              Pricing
            </span>
            <h1 className="mb-4 font-heading text-[clamp(2rem,3.5vw,3rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
              Find Your Perfect Plan
            </h1>
            <p className="mx-auto max-w-[560px] text-[1.05rem] leading-relaxed text-remotiv-text-light">
              Everything you need to find, unlock, and hire top talent — built for companies that
              move fast.
            </p>
          </div>

          <div className="mx-auto grid max-w-[1080px] items-stretch gap-6 lg:grid-cols-3">
            {TIERS.map((tier) => {
              const ctaClassName = cn(
                "mt-auto block rounded-[14px] px-6 py-[15px] text-center text-[0.97rem] font-bold transition-all hover:-translate-y-0.5",
                tier.featured
                  ? "bg-white text-remotiv-purple hover:bg-white/90"
                  : "bg-remotiv-green text-remotiv-text-dark hover:bg-remotiv-green-light",
              );
              // Enterprise tier routes to a real contact page; Starter/Pro
              // open the shared PricingModal (Stripe not wired yet, so the
              // modal's CTA surfaces a coming-soon toast).
              const isContactCTA = tier.href === "/contact";
              return (
              <article
                key={tier.name}
                className={cn(
                  "relative flex flex-col rounded-3xl border p-7 shadow-[0_4px_24px_rgba(0,0,0,0.05)] sm:p-8 md:p-9",
                  tier.featured
                    ? "border-remotiv-purple bg-remotiv-purple shadow-[0_12px_48px_rgba(126,71,255,0.28)] lg:scale-[1.03]"
                    : "border-black/[0.07] bg-white",
                )}
              >
                <div className="mb-7 rounded-2xl bg-white p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="font-heading text-[1.1rem] font-bold text-remotiv-text-dark">
                      {tier.name}
                    </h3>
                    {tier.featured && (
                      <span className="rounded-full bg-remotiv-purple px-3 py-[5px] text-[0.72rem] font-semibold tracking-wide text-white">
                        Most Popular
                      </span>
                    )}
                  </div>
                  <div
                    className={cn(
                      "mb-1.5 font-heading font-extrabold leading-none text-remotiv-text-dark",
                      tier.priceSuffix ? "text-[clamp(1.9rem,6vw,2.4rem)]" : "text-[clamp(1.6rem,5vw,2rem)]",
                    )}
                  >
                    {tier.price}
                    {tier.priceSuffix && (
                      <span className="text-base font-medium text-remotiv-text-light">
                        {" "}
                        {tier.priceSuffix}
                      </span>
                    )}
                  </div>
                  {tier.priceSuffix && (
                    <p className="mt-1 text-sm text-[#6b6b6b]">Billed monthly</p>
                  )}
                  <p className="mt-2 text-[0.88rem] leading-snug text-remotiv-text-light">
                    {tier.description}
                  </p>
                </div>

                <ul className="mb-8 flex flex-1 flex-col gap-[13px]">
                  {tier.features.map((f) => {
                    const included = f.included !== false;
                    let featureTextClass: string;
                    if (included) {
                      featureTextClass = tier.featured ? "text-white" : "text-[#333]";
                    } else {
                      featureTextClass = tier.featured
                        ? "text-white/40 line-through"
                        : "text-[#6b6b6b] line-through";
                    }
                    return (
                      <li
                        key={f.label}
                        className="flex items-start gap-2.5 text-[0.9rem] leading-[1.4]"
                      >
                        {included ? (
                          <CheckCircle />
                        ) : (
                          <CrossCircle
                            className={tier.featured ? "bg-white/20" : "bg-black/[0.08]"}
                          />
                        )}
                        <span className={featureTextClass}>{f.label}</span>
                      </li>
                    );
                  })}
                </ul>

                {isContactCTA ? (
                  <Link href={tier.href} className={ctaClassName}>
                    {tier.cta}
                  </Link>
                ) : (
                  <TierCTA label={tier.cta} className={ctaClassName} />
                )}
              </article>
              );
            })}
          </div>
        </section>

        <section className="bg-remotiv-bg px-6 pb-24 sm:px-8 md:px-14">
          <div className="mx-auto max-w-[1080px]">
            <div className="mb-12">
              <Eyebrow className="mb-3.5">Full-Service Hiring</Eyebrow>
              <h2 className="mb-4 font-heading text-[clamp(2rem,3.5vw,2.8rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
                We Find. You Hire.
              </h2>
              <p className="max-w-[680px] text-base leading-relaxed text-remotiv-text-light">
                We handle the entire search — sourcing, vetting, references, and negotiation. You
                review candidates and make the call. That&apos;s it.
              </p>
            </div>

            <div className="overflow-hidden rounded-3xl border-2 border-remotiv-green bg-white shadow-[0_8px_48px_rgba(73,215,167,0.15),0_2px_12px_rgba(0,0,0,0.06)]">
              <div className="flex items-center gap-2 bg-remotiv-lime-card px-8 py-2.5">
                <span className="text-[0.9rem]">★</span>
                <span className="font-heading text-[0.8rem] font-bold tracking-wide text-remotiv-text-dark">
                  Most Popular
                </span>
              </div>

              <div className="grid md:grid-cols-2">
                <div className="border-b border-black/[0.07] p-8 md:border-b-0 md:border-r md:p-11">
                  <h3 className="mb-3 font-heading text-[1.45rem] font-extrabold tracking-[-0.02em] text-remotiv-text-dark">
                    We Handle Everything
                  </h3>
                  <p className="mb-9 max-w-[380px] text-[0.95rem] leading-relaxed text-[#555]">
                    You share the role. We take it from there — and only bring you candidates worth
                    your time.
                  </p>
                  <div className="mb-8 h-px bg-black/[0.07]" />
                  <div className="mb-2 font-heading text-[0.82rem] font-bold uppercase tracking-wide text-remotiv-text-dark">
                    You Only Pay When You Hire
                  </div>
                  <div className="font-heading text-[1.25rem] font-extrabold leading-snug tracking-[-0.02em] text-remotiv-text-dark">
                    Success-Based Only. You Pay When We Deliver.
                  </div>
                </div>

                <div className="flex flex-col justify-between p-8 md:p-11">
                  <ul className="mb-10 flex flex-col gap-3.5">
                    {FULL_SERVICE_FEATURES.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-3 text-[0.95rem] leading-[1.4] text-[#333]"
                      >
                        <CheckCircle className="mt-0.5 size-[22px]" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/book-a-meeting"
                    className="block rounded-[14px] bg-remotiv-green px-6 py-[17px] text-center font-heading text-base font-bold tracking-[-0.01em] text-remotiv-text-dark transition-all hover:-translate-y-0.5 hover:bg-remotiv-green-light"
                  >
                    Book a Free Meeting
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white px-6 py-20 sm:px-8 md:px-14">
          <div className="mx-auto max-w-[1080px]">
            <div className="mb-14 text-center">
              <Eyebrow className="mb-3.5">Compare Plans</Eyebrow>
              <h2 className="mb-3.5 font-heading text-[clamp(1.8rem,3vw,2.4rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
                Everything You Need to Hire Smarter
              </h2>
              <p className="text-base leading-relaxed text-remotiv-text-light">
                Compare our plans and find the right fit for your hiring needs.
              </p>
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[20%]" />
                  <col className="w-[22%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="pb-7 text-left font-heading text-[1.05rem] font-bold text-remotiv-text-dark">
                      Plan features
                    </th>
                    <th scope="col" className="pb-7 text-center font-heading text-base font-bold text-remotiv-text-dark">
                      Starter Plan
                    </th>
                    <th scope="col" className="px-0 pb-7 text-center">
                      <span className="mx-2 block rounded-t-3xl bg-[#f0f8f5] px-3 py-4 font-heading text-base font-bold text-remotiv-text-dark">
                        Pro Plan
                      </span>
                    </th>
                    <th scope="col" className="pb-7 text-center font-heading text-base font-bold text-remotiv-text-dark">
                      Enterprise Plan
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((row, idx) => {
                    const isLast = idx === COMPARISON.length - 1;
                    return (
                      <tr
                        key={row.feature}
                        className={cn(
                          "border-t border-black/[0.07]",
                          isLast && "border-b border-black/[0.07]",
                        )}
                      >
                        <th scope="row" className="py-[18px] pl-0 text-left text-[0.93rem] font-medium text-[#333]">
                          {row.feature}
                        </th>
                        <td className="py-[18px] text-center">
                          <ComparisonCell value={row.starter} />
                        </td>
                        <td
                          className={cn(
                            "bg-[#f0f8f5] py-[18px] text-center",
                            isLast && "rounded-b-3xl",
                          )}
                        >
                          <span className="mx-2 block">
                            <ComparisonCell value={row.pro} featured />
                          </span>
                        </td>
                        <td className="py-[18px] text-center">
                          <ComparisonCell value={row.enterprise} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile comparison — stacked per plan */}
            <div className="space-y-8 md:hidden">
              {(["Starter", "Pro", "Enterprise"] as const).map((plan) => {
                const key = plan.toLowerCase() as "starter" | "pro" | "enterprise";
                const isPro = plan === "Pro";
                return (
                  <div
                    key={plan}
                    className={cn(
                      "overflow-hidden rounded-2xl border",
                      isPro ? "border-remotiv-green" : "border-black/[0.08]",
                    )}
                  >
                    <div
                      className={cn(
                        "py-5 text-center",
                        isPro ? "bg-[#f0f8f5]" : "bg-white",
                      )}
                    >
                      <h3 className="font-heading text-[1.1rem] font-bold text-remotiv-text-dark">
                        {plan} Plan
                      </h3>
                      {isPro && (
                        <span className="mt-1 inline-block rounded-full bg-remotiv-green px-2.5 py-[3px] text-[0.68rem] font-bold uppercase tracking-wide text-white">
                          Most Popular
                        </span>
                      )}
                    </div>
                    <div>
                      {COMPARISON.map((row) => (
                        <div
                          key={row.feature}
                          className={cn(
                            "flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 last:border-0",
                            isPro ? "bg-[#f7fdfb]" : "bg-white",
                          )}
                        >
                          <span className="flex-1 text-[0.88rem] font-medium text-[#333]">
                            {row.feature}
                          </span>
                          <span className="shrink-0 text-right text-[0.88rem] text-[#444]">
                            <ComparisonCell value={row[key]} featured={isPro} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-white px-6 pb-24 pt-12 sm:px-8 md:px-14">
          <div className="mx-auto max-w-[1080px]">
            <div className="mb-14 text-center">
              <h2 className="mb-4 font-heading text-[clamp(1.9rem,3vw,2.6rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
                Trusted by Companies Worldwide
              </h2>
              <p className="mx-auto max-w-[620px] text-base leading-relaxed text-remotiv-text-light">
                From fast-growing startups to established enterprises — businesses trust Remotiv to
                find, vet, and place top remote talent that delivers from day one.
              </p>
            </div>

            <div className="grid items-stretch gap-6 md:grid-cols-[1fr_1.4fr]">
              <div className="rounded-3xl bg-[#111] p-8 md:p-11">
                {STATS.map((s, i) => (
                  <div
                    key={s.label}
                    className={cn(
                      "py-8 first:pt-0 last:pb-0",
                      i < STATS.length - 1 && "border-b border-white/[0.15]",
                    )}
                  >
                    <div className="mb-2 font-heading text-5xl font-extrabold leading-none tracking-[-0.03em] text-white">
                      {s.value}
                    </div>
                    <div className="mb-2.5 font-heading text-base font-bold text-white">
                      {s.label}
                    </div>
                    <div className="text-[0.88rem] leading-relaxed text-white/70">{s.desc}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col justify-between rounded-3xl bg-remotiv-bg p-8 md:p-11">
                <div>
                  <div className="mb-8 flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-full bg-remotiv-green">
                      <svg
                        viewBox="0 0 20 20"
                        fill="none"
                        aria-hidden="true"
                        className="size-5"
                      >
                        <circle cx="10" cy="10" r="8" stroke="#fff" strokeWidth="2" />
                        <path
                          d="M6 10c0-2.2 1.8-4 4-4s4 1.8 4 4"
                          stroke="#fff"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                    <div className="font-heading text-base font-bold text-remotiv-text-dark">
                      Ride the Wave
                    </div>
                  </div>
                  <blockquote className="mb-7 font-heading text-[1.25rem] font-bold leading-[1.45] tracking-[-0.02em] text-remotiv-text-dark">
                    &ldquo;Remotiv provided candidates faster and in higher quality than most
                    overseas recruiters we have used. Communication was really strong, which led to
                    a long working relationship. Very happy with our time working with
                    Remotiv.&rdquo;
                  </blockquote>
                </div>
                <div className="mt-8 flex items-center gap-3.5">
                  <div className="flex size-12 items-center justify-center rounded-full bg-remotiv-green/[0.15] font-heading text-base font-bold text-remotiv-green">
                    DM
                  </div>
                  <div>
                    <div className="font-heading text-[0.95rem] font-bold text-remotiv-text-dark">
                      Daniel Magazu
                    </div>
                    <div className="text-[0.85rem] text-remotiv-text-light">CEO</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-remotiv-bg px-6 py-24 sm:px-8 md:px-14">
          <div className="mx-auto max-w-3xl">
            <div className="mb-12 text-center">
              <Eyebrow className="mb-3.5">FAQ</Eyebrow>
              <h2 className="mb-4 font-heading text-[clamp(1.8rem,3vw,2.4rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-remotiv-text-dark">
                Frequently Asked Questions
              </h2>
              <p className="text-base leading-relaxed text-remotiv-text-light">
                Everything you need to know about plans, billing, and guarantees.
              </p>
            </div>
            <div className="space-y-4">
              {FAQS.map((f) => (
                <details
                  key={f.q}
                  className="group rounded-2xl border border-black/[0.07] bg-white p-6 transition-shadow hover:shadow-[0_4px_24px_rgba(0,0,0,0.05)]"
                >
                  <summary className="flex cursor-pointer items-center justify-between font-heading text-[1.05rem] font-bold text-remotiv-text-dark marker:hidden [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span className="ml-4 text-xl text-remotiv-text-light transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-4 text-[0.95rem] leading-relaxed text-remotiv-text-mid">
                    {f.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white px-6 py-20 sm:px-8 md:px-14">
          <div className="mx-auto max-w-4xl rounded-3xl bg-gradient-to-br from-remotiv-purple-light to-remotiv-purple p-10 text-center text-white md:p-14">
            <h2 className="mb-4 font-heading text-3xl font-extrabold tracking-[-0.02em] md:text-4xl">
              Ready to Hire Smarter?
            </h2>
            <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-white/80">
              Book a free 30-minute consultation and we&apos;ll show you how Remotiv can fill your
              next role in days — not months.
            </p>
            <Link
              href="/book-a-meeting"
              className="inline-block rounded-full bg-white px-8 py-4 font-heading font-bold text-remotiv-purple transition-transform hover:-translate-y-0.5"
            >
              Book a Meeting
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
