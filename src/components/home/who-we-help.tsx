import { ArrowUpRight } from "lucide-react";

const CARDS = [
  {
    title: "Startups",
    description:
      "Move fast without compromising quality. We match you with senior engineers who've built and scaled products before.",
    bullets: [
      "Ship your MVP 2–3x faster",
      "Access senior talent from day one",
      "Flexible month-to-month contracts",
    ],
  },
  {
    title: "Agencies",
    description:
      "Extend your delivery capacity on demand. Plug in pre-vetted engineers who integrate with your workflows instantly.",
    bullets: [
      "White-label engineering teams",
      "Scale up or down per project",
      "Same-week onboarding",
    ],
  },
  {
    title: "Enterprises",
    description:
      "De-risk hiring and reduce time-to-productivity. Our engineers come battle-tested with enterprise-grade experience.",
    bullets: [
      "Dedicated team management",
      "Compliance & IP protection built in",
      "Long-term retention programs",
    ],
  },
] as const;

export function WhoWeHelp() {
  return (
    <section className="bg-white px-6 py-12 sm:px-14 sm:py-12">
      <div className="mx-auto max-w-7xl">
        <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
          Built for{" "}
          <span className="relative inline-block">
            <span
              aria-hidden
              className="absolute inset-x-[-6px] inset-y-[2px] -rotate-[1.2deg] rounded-md bg-remotiv-lime"
            />
            <span className="relative">startups</span>
          </span>
          , agencies &amp; scaling teams
        </h2>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {CARDS.map((card) => (
            <div
              key={card.title}
              className="group relative flex min-h-[420px] flex-col rounded-2xl border border-gray-200 bg-white p-7 transition-colors duration-350 hover:border-remotiv-purple hover:bg-remotiv-purple"
            >
              <div className="flex items-start justify-between">
                <h3 className="font-heading text-2xl font-bold text-remotiv-text-dark transition-colors duration-350 group-hover:text-white">
                  {card.title}
                </h3>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-gray-200 transition-colors duration-350 group-hover:border-white group-hover:bg-white">
                  <ArrowUpRight className="size-4 text-remotiv-text-dark transition-colors duration-350 group-hover:text-remotiv-purple" />
                </span>
              </div>

              <div className="flex-1" />

              <div className="border-t border-gray-200 pt-5 transition-colors duration-350 group-hover:border-white/30">
                <p className="text-sm leading-relaxed text-remotiv-text-mid transition-colors duration-350 group-hover:text-white/90">
                  {card.description}
                </p>
                <ul className="mt-4 space-y-2.5">
                  {card.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-center gap-2.5 text-sm">
                      <span className="size-2 shrink-0 rounded-full bg-remotiv-green transition-colors duration-350 group-hover:bg-white" />
                      <span className="text-remotiv-text-dark transition-colors duration-350 group-hover:text-white">
                        {bullet}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
