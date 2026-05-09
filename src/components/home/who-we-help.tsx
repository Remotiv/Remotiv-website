import { ArrowRight } from "lucide-react";

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
    <section className="bg-white px-6 pt-12 pb-24 sm:px-14 md:pb-12">
      <div className="mx-auto max-w-7xl">
        <h2 className="mb-10 text-center font-heading text-[clamp(2rem,3.8vw,2.6rem)] font-extrabold leading-tight tracking-tight text-[#111] md:mb-16">
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

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {CARDS.map((card, i) => (
            <div
              key={card.title}
              className="group sticky flex flex-col rounded-2xl border border-gray-200 bg-white pt-7 px-6 pb-8 shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-[colors,box-shadow] duration-350 [top:var(--card-top)] md:pt-9 md:px-8 md:pb-10 lg:relative lg:min-h-[420px] lg:[top:auto] lg:hover:border-remotiv-purple lg:hover:bg-remotiv-purple lg:hover:shadow-[0_16px_48px_rgba(126,71,255,0.28)]"
              style={{
                ["--card-top" as string]: `${(i + 1) * 12}px`,
                zIndex: i + 1,
              }}
            >
              <div className="flex items-start justify-between lg:min-h-[88px]">
                <h3 className="font-heading text-[1.6rem] font-extrabold tracking-[-0.025em] text-[#111] transition-colors duration-350 sm:text-[1.9rem] lg:group-hover:text-white">
                  {card.title}
                </h3>
                <span className="flex size-[38px] shrink-0 items-center justify-center rounded-full border border-gray-200 transition-colors duration-350 lg:group-hover:border-white lg:group-hover:bg-white">
                  <ArrowRight
                    className="size-4 text-remotiv-text-dark transition-colors duration-350 lg:group-hover:text-remotiv-purple"
                    strokeWidth={2}
                  />
                </span>
              </div>

              <div className="flex-1" />

              <div className="border-t border-gray-200 pt-5 transition-colors duration-350 lg:group-hover:border-white/20">
                <p className="font-sans text-[0.9rem] font-normal leading-[1.7] text-[#666] transition-colors duration-350 lg:min-h-[72px] lg:group-hover:text-white/75">
                  {card.description}
                </p>
                <ul className="mt-4 space-y-2">
                  {card.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-3">
                      <span className="mt-1.5 size-[5px] flex-shrink-0 rounded-full bg-remotiv-green transition-colors duration-350 lg:group-hover:bg-white/60" />
                      <span className="font-sans text-[0.82rem] font-normal leading-[1.5] text-[#555] transition-colors duration-350 lg:group-hover:text-white/80">
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
