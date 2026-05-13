import { Clock, Star, Users } from "lucide-react";

const STATS = [
  { icon: Clock, stat: "24 hrs", description: "From brief to shortlist delivered" },
  { icon: Star, stat: "Top 1%", description: "Only engineers who pass our vetting" },
  { icon: Users, stat: "85%", description: "Client retention rate after first hire" },
] as const;

export function StatsCards() {
  return (
    <section className="bg-white px-8 py-12 md:py-[72px]">
      <div className="mx-auto max-w-7xl">
        <h2 className="mx-auto max-w-[700px] text-center font-heading text-[clamp(1.8rem,3.5vw,2.4rem)] font-bold leading-[1.2] tracking-tight text-[#111]">
          The talent you need,{" "}
          <span className="text-remotiv-purple">vetted and ready</span> within 24 hours
        </h2>

        <div className="mx-auto mt-14 grid max-w-[1100px] gap-6 md:grid-cols-3">
          {STATS.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.stat}
                className="flex flex-col items-center rounded-3xl border border-[#ececec] bg-white px-8 py-7 text-center transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_12px_40px_rgba(152,134,254,0.1)]"
              >
                <div className="mb-5 flex size-[68px] items-center justify-center rounded-[18px] bg-remotiv-purple-light">
                  <Icon className="size-[30px] text-white" strokeWidth={2} />
                </div>
                <p className="mb-1.5 font-heading text-[2.2rem] font-bold leading-tight text-[#111]">
                  {item.stat}
                </p>
                <p className="m-0 font-sans text-[0.95rem] leading-[1.5] text-[#666]">
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
