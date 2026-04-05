import { Clock, RefreshCcw, Trophy } from "lucide-react";

const STATS = [
  {
    icon: Clock,
    stat: "24 hrs",
    description:
      "Average time to match you with a pre-vetted senior engineer — not weeks, not days.",
  },
  {
    icon: Trophy,
    stat: "Top 1%",
    description:
      "Only the top 1% of applicants pass our multi-stage vetting process — technical, cultural, and project-based.",
  },
  {
    icon: RefreshCcw,
    stat: "85%",
    description:
      "Of clients extend or scale their teams within the first 3 months. That's retention built on results.",
  },
] as const;

export function StatsCards() {
  return (
    <section className="bg-white px-6 py-16 sm:px-14 sm:py-24">
      <div className="mx-auto max-w-7xl">
        <h2 className="font-heading mx-auto max-w-2xl text-center text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
          The talent you need, vetted and ready within{" "}
          <span className="text-remotiv-purple-light">24 hours</span>
        </h2>

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {STATS.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.stat}
                className="rounded-3xl border border-gray-200 bg-white p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg"
              >
                <div className="mb-6 flex size-14 items-center justify-center rounded-full bg-remotiv-purple-light/10">
                  <Icon className="size-6 text-remotiv-purple-light" />
                </div>
                <p className="font-heading text-4xl font-extrabold text-remotiv-text-dark">
                  {item.stat}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-remotiv-text-mid">
                  {item.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
