import { Check, ImageIcon } from "lucide-react";

const STEPS = [
  {
    step: "01",
    title: "Tell Us Your Stack",
    description:
      "Share your tech requirements, team culture, and timeline. Our AI matching engine starts filtering from 10,000+ vetted engineers instantly.",
    bullets: [
      "Define role, stack & seniority",
      "Set your budget and timeline",
      "Describe team culture & work style",
    ],
    cta: "Get Started",
    reversed: false,
  },
  {
    step: "02",
    title: "Review Your Top 5 Matches",
    description:
      "Within 48 hours you'll receive a shortlist of five engineers — each pre-screened with live coding assessments and reference checks.",
    bullets: [
      "AI-ranked candidate profiles",
      "Video intros & portfolio links",
      "Skill-match confidence scores",
    ],
    cta: "See Sample Profiles",
    reversed: true,
  },
  {
    step: "03",
    title: "Interview & Ship Code",
    description:
      "Run your own interviews, pick your favourite, and have them shipping production code within the first week.",
    bullets: ["Zero onboarding friction", "Dedicated success manager", "14-day risk-free trial"],
    cta: "Book A Call",
    reversed: false,
  },
] as const;

export function HowItWorks() {
  return (
    <section className="bg-white px-6 py-12 sm:px-14 sm:py-12">
      <div className="mx-auto max-w-7xl rounded-[28px] bg-remotiv-lime px-6 py-16 sm:px-12 md:px-16 md:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
            How Remotiv works
          </h2>
          <p className="mt-4 text-base leading-relaxed text-remotiv-text-mid sm:text-lg">
            From brief to first commit in under two weeks — here's the playbook.
          </p>
        </div>

        <div className="mt-14 space-y-16 md:space-y-20">
          {STEPS.map((step) => (
            <div
              key={step.step}
              className={`grid items-center gap-8 md:grid-cols-2 md:gap-12 ${
                step.reversed ? "md:[&>*:first-child]:order-2" : ""
              }`}
            >
              <div>
                <span className="inline-block rounded-full bg-black/10 px-3.5 py-1 text-xs font-semibold uppercase tracking-wider text-remotiv-text-dark">
                  Step {step.step}
                </span>
                <h3 className="mt-4 font-heading text-[28px] font-[900] leading-tight text-remotiv-text-dark sm:text-[30px]">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-remotiv-text-mid sm:text-base">
                  {step.description}
                </p>
                <ul className="mt-5 space-y-2.5">
                  {step.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-center gap-2.5 text-sm sm:text-base">
                      <Check
                        className="size-4 shrink-0 text-remotiv-purple-light"
                        strokeWidth={3}
                      />
                      <span className="text-remotiv-text-dark">{bullet}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="mt-6 inline-flex items-center rounded-full bg-remotiv-text-dark px-6 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  {step.cta}
                </button>
              </div>

              <div className="flex aspect-[4/3] items-center justify-center rounded-2xl border-2 border-dashed border-black/20 bg-white/50">
                <div className="flex flex-col items-center gap-2 text-black/30">
                  <ImageIcon className="size-10" strokeWidth={1.5} />
                  <span className="text-sm font-medium">Image / video placeholder</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
