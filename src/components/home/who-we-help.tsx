import { ArrowUpRight } from "lucide-react";

const CARDS = [
  {
    title: "Startups",
    description:
      "Build your team from the ground up with carefully vetted talent. Move fast, stay lean, and hire the right people from day one.",
    bullets: [
      "Hire your first engineers or marketers",
      "Flexible hiring, no long-term commitments",
      "Fast turnaround — matched in 24 hours",
    ],
  },
  {
    title: "Agencies",
    description:
      "Scale your capacity with reliable, pre-vetted professionals. Take on more clients without hiring delays.",
    bullets: [
      "Quickly fill skill gaps on demand",
      "On-demand talent for any project",
      "Consistent quality & reliability",
    ],
  },
  {
    title: "Enterprises",
    description:
      "Expand your team with top-tier talent while reducing hiring time and operational overhead. Built for scale.",
    bullets: [
      "Dedicated teams or long-term hires",
      "Streamlined, low-friction hiring process",
      "Global-ready talent pool",
    ],
  },
] as const;

export function WhoWeHelp() {
  return (
    <section className="bg-white px-6 pt-12 pb-0 sm:px-14">
      <div className="mx-auto max-w-7xl">
        <h2 className="mb-16 text-center font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
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
