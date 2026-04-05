import { Bot, BrainCircuit, Check, MessageSquare, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";

const CANDIDATES = [
  {
    name: "Ahmed K.",
    role: "Senior Full-Stack Engineer",
    match: 97,
    skills: ["React", "Node.js", "AWS"],
  },
  {
    name: "Bilal M.",
    role: "Staff Backend Engineer",
    match: 94,
    skills: ["Go", "Kubernetes", "PostgreSQL"],
  },
  {
    name: "Sara N.",
    role: "Senior Frontend Engineer",
    match: 91,
    skills: ["TypeScript", "Next.js", "Figma"],
  },
] as const;

const SKILL_TAGS = ["React", "TypeScript", "Node.js", "AWS", "5+ years", "Remote-ready"];

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

function matchColor(match: number): string {
  if (match > 95) return "#49D7A7";
  if (match > 92) return "#9886fe";
  return "#f59e0b";
}

function CandidateCard({ candidate }: { candidate: (typeof CANDIDATES)[number] }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/10 px-3 py-2.5">
      <Avatar name={candidate.name} color={matchColor(candidate.match)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{candidate.name}</span>
          <span className="rounded-full bg-remotiv-green/20 px-2 py-0.5 text-[10px] font-bold text-remotiv-green">
            {candidate.match}% match
          </span>
        </div>
        <p className="text-xs text-white/60">{candidate.role}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {candidate.skills.map((s) => (
            <span key={s} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-lg bg-remotiv-green/20 text-remotiv-green transition-colors hover:bg-remotiv-green/30"
          aria-label={`Accept ${candidate.name}`}
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-lg bg-white/10 text-white/50 transition-colors hover:bg-white/20"
          aria-label={`Reject ${candidate.name}`}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function AIRecruiter() {
  return (
    <section className="bg-white px-6 py-20 md:px-16 lg:py-20">
      <div className="mx-auto max-w-6xl">
        <div className="overflow-hidden rounded-3xl bg-[#9886fe] px-6 py-12 md:px-12 lg:px-16 lg:py-16">
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
                Our AI recruiter works 24/7, scanning and ranking candidates against your exact
                requirements. It learns from every hire to deliver increasingly precise matches — so
                you spend less time screening and more time building.
              </p>

              <Link
                href="/ai-matching"
                className="mt-8 inline-flex w-fit items-center rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#9886fe] shadow-lg transition-all hover:-translate-y-0.5 hover:shadow-xl"
              >
                Try AI Matching →
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
                <p className="text-sm font-medium text-white">
                  I need a senior full-stack engineer with React & Node.js experience, fluent
                  English, and available to start within 2 weeks.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SKILL_TAGS.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-medium text-white/80"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl rounded-tr-sm bg-remotiv-green/25 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-remotiv-green" />
                  <span className="text-xs font-semibold text-remotiv-green">Remotiv AI</span>
                </div>
                <p className="mt-1 text-sm text-white/90">
                  Found <span className="font-semibold text-white">3 top matches</span> from 12,847
                  profiles. All pre-vetted, English-fluent, and available immediately.
                </p>
              </div>

              <SearchingAnimation />

              <div className="rounded-2xl bg-white/10 p-3">
                <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-white/50">
                  Your qualified candidate review list
                </p>
                <div className="space-y-2">
                  {CANDIDATES.map((c) => (
                    <CandidateCard key={c.name} candidate={c} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
