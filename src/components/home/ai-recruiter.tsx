import { Bot, BrainCircuit, Check, MessageSquare, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("");

  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  );
}

function SearchingAnimation() {
  const faces = [
    { color: "#49D7A7", initials: "AK" },
    { color: "#9886fe", initials: "BM" },
    { color: "#D9F972", initials: "SN" },
    { color: "#f59e0b", initials: "JR" },
    { color: "#ec4899", initials: "LP" },
  ];

  return (
    <div className="flex items-center gap-2 rounded-xl bg-white/10 px-4 py-3">
      <Search className="size-4 animate-pulse text-white/60" />
      <span className="text-xs font-medium text-white/70">Searching talent pool…</span>
      <div className="ml-auto flex -space-x-2">
        {faces.map((f) => (
          <div
            key={f.initials}
            className="flex size-7 items-center justify-center rounded-full border-2 border-[#9886fe] text-[10px] font-bold text-white"
            style={{ backgroundColor: f.color }}
          >
            {f.initials}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AIRecruiter() {
  const candidateRows = [
    { name: "Ahmed K.", color: "#49D7A7", elevated: false },
    { name: "Bilal M.", color: "#9886fe", elevated: true },
    { name: "Sara N.", color: "#D9F972", elevated: false },
  ];

  return (
    <section className="bg-white px-6 py-0 md:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="overflow-hidden rounded-3xl bg-[#9886fe] px-6 py-12 md:px-14 md:py-[72px]">
          <div className="grid items-start gap-10 lg:grid-cols-[1fr_auto_1fr]">
            <div className="flex flex-col">
              <span className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-remotiv-green/20 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-remotiv-green">
                <Sparkles className="size-3.5" />
                AI-Powered Matching
              </span>

              <h2 className="font-heading text-3xl font-bold leading-tight text-white sm:text-4xl">
                Meet Remotiv AI: <span className="text-remotiv-green">Your Always-On</span>{" "}
                Recruiter
              </h2>

              <p className="mt-4 max-w-md text-sm leading-relaxed text-white/70">
                Just tell us the role. Our AI scans 1M+ verified profiles and delivers a shortlist
                of pre-vetted candidates — within 24 hours.
              </p>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-white/40">
                At a fraction of what a traditional recruiter charges.
              </p>

              <Link
                href="/how-it-works"
                className="mt-8 inline-flex w-fit items-center rounded-full px-7 py-3 text-sm font-semibold shadow-lg transition-all hover:-translate-y-0.5 hover:shadow-xl"
                style={{ backgroundColor: "#49D7A7", color: "#453e40" }}
              >
                See How It Works →
              </Link>
            </div>

            <div className="hidden lg:flex lg:flex-col lg:items-center lg:gap-4 lg:self-stretch">
              <div className="flex-1 border-l-2 border-dashed border-white/20" />
              <div className="flex size-10 items-center justify-center rounded-xl bg-white/15 text-white">
                <BrainCircuit className="size-5" />
              </div>
              <div className="flex-1 border-l-2 border-dashed border-white/20" />
              <div className="flex size-10 items-center justify-center rounded-xl bg-white/15 text-white">
                <MessageSquare className="size-5" />
              </div>
              <div className="flex-1 border-l-2 border-dashed border-white/20" />
              <div className="flex size-10 items-center justify-center rounded-xl bg-white/15 text-white">
                <Bot className="size-5" />
              </div>
              <div className="flex-1 border-l-2 border-dashed border-white/20" />
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-2xl rounded-tl-sm bg-white/15 px-4 py-3">
                <p className="text-sm font-medium leading-relaxed text-white">
                  Send me candidates interested in{" "}
                  <span className="rounded-md bg-[#fbbf24]/90 px-1.5 py-0.5 font-medium text-[#453e40]">
                    React Dev
                  </span>{" "}
                  with experience in{" "}
                  <span className="rounded-md bg-indigo-500 px-1.5 py-0.5 font-medium text-white">
                    Next.js
                  </span>
                </p>
              </div>

              <div className="rounded-2xl rounded-tr-sm bg-remotiv-green/25 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-remotiv-green" />
                  <span className="text-xs font-semibold text-remotiv-green">Remotiv:ai</span>
                </div>
                <p className="mt-1 text-sm text-white/90">
                  Absolutely! Sending you a shortlist of top candidates now.
                </p>
              </div>

              <SearchingAnimation />

              <div className="rounded-2xl bg-[#f8f4f1] p-3">
                <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-[#453e40]/50">
                  Your qualified candidate review list
                </p>
                <div className="space-y-2">
                  {candidateRows.map((row) => {
                    const cardInner = (
                      <>
                        <Avatar name={row.name} color={row.color} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-[#453e40]">{row.name}</span>
                            <span className="rounded-full bg-[#49D7A7]/20 px-2 py-0.5 text-[10px] font-bold text-[#2a8f6f]">
                              Interested
                            </span>
                          </div>
                          <span className="mt-1 inline-block rounded-md bg-[#453e40]/10 px-2 py-0.5 text-[11px] text-[#453e40]/80">
                            Experience in Next.js
                          </span>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            className="flex size-9 items-center justify-center rounded-full border-2 border-[#49D7A7] bg-transparent text-[#49D7A7] transition-colors hover:bg-[#49D7A7]/10"
                            aria-label={`Accept ${row.name}`}
                          >
                            <Check className="size-4" strokeWidth={2.5} />
                          </button>
                          <button
                            type="button"
                            className="flex size-9 items-center justify-center rounded-full border-2 border-red-500 bg-transparent text-red-500 transition-colors hover:bg-red-500/10"
                            aria-label={`Reject ${row.name}`}
                          >
                            <X className="size-4" strokeWidth={2.5} />
                          </button>
                        </div>
                      </>
                    );

                    if (row.elevated) {
                      return (
                        <div
                          key={row.name}
                          className="relative rounded-xl bg-white px-3 py-2.5 shadow-lg ring-1 ring-black/5"
                        >
                          <span className="absolute -top-2 left-3 rounded bg-[#9886fe] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                            Recruiter
                          </span>
                          <div className="mt-2 flex items-center gap-3">{cardInner}</div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={row.name}
                        className="flex items-center gap-3 rounded-xl bg-[#f0ebe6] px-3 py-2.5"
                      >
                        {cardInner}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
