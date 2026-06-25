import { headers } from "next/headers";
import Link from "next/link";
import { Navbar } from "@/components/navbar";
import { MARKETING_STATS } from "@/lib/marketing-stats";
import { HireMarketplace, type RemoteProfileRow } from "./_marketplace";

export const dynamic = "force-dynamic";

const HERO_STATS = [
  `${MARKETING_STATS.talentPool} Talent Pool`,
  "$25–50/hr",
  `${MARKETING_STATS.placementTime} avg time to hire`,
  `${MARKETING_STATS.clientRetention} Client Retention`,
] as const;

// SSR page-1 fetch against our own API. Uses the request host so dev / preview
// / prod all work without an env var. The API returns the same explicit
// column allow-list (no email/phone/cv_*/photo_*) that this page used to read
// directly, so nothing sensitive is added to the SSR payload.
async function fetchInitialPage(): Promise<{
  candidates: RemoteProfileRow[];
  total: number;
}> {
  try {
    const h = await headers();
    const host = h.get("host") ?? "localhost:3000";
    const proto =
      h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    const baseUrl = `${proto}://${host}`;

    const res = await fetch(`${baseUrl}/api/hire-remote/candidates?page=1`, {
      cache: "no-store",
    });
    if (!res.ok) return { candidates: [], total: 0 };

    const json: unknown = await res.json();
    if (!json || typeof json !== "object") return { candidates: [], total: 0 };
    const j = json as { candidates?: unknown; total?: unknown };

    return {
      candidates: Array.isArray(j.candidates) ? (j.candidates as RemoteProfileRow[]) : [],
      total: typeof j.total === "number" ? j.total : 0,
    };
  } catch {
    return { candidates: [], total: 0 };
  }
}

export default async function HireRemotePage() {
  const { candidates, total } = await fetchInitialPage();

  return (
    <>
      <Navbar />
      <main id="main" className="bg-remotiv-bg">
        <HeroSection />
        <HireMarketplace initialCandidates={candidates} initialTotal={total} />
        <HowItWorks />
        <QuoteCta />
      </main>
    </>
  );
}

function HeroSection() {
  return (
    <section className="relative isolate overflow-hidden bg-remotiv-bg px-6 pb-20 pt-20 text-center md:px-14 md:pb-[72px] md:pt-[84px]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(rgba(0,0,0,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.05)_1px,transparent_1px)] bg-[size:52px_52px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[10%] left-1/2 -z-10 h-[520px] w-[860px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.6)_0%,transparent_70%)]"
      />
      <div className="relative mx-auto max-w-[820px]">
        <span className="mb-5 inline-block rounded-full bg-remotiv-green/10 px-4 py-1.5 font-heading text-[0.72rem] font-bold uppercase tracking-[0.16em] text-remotiv-green">
          Find Freelancers
        </span>
        <h1 className="mb-3 font-heading text-[clamp(2.2rem,4.2vw,3.5rem)] font-extrabold leading-[1.09] tracking-[-0.032em] text-remotiv-text-dark">
          Hire Pakistan&apos;s top 1% talent.
        </h1>
        <p className="mx-auto mb-5 max-w-[640px] font-heading text-[clamp(1.05rem,1.6vw,1.35rem)] font-semibold text-remotiv-text-dark">
          Engineers, AI experts &amp; domain specialists.
        </p>
        <p className="mx-auto mb-10 max-w-[600px] text-[1.02rem] leading-[1.68] text-remotiv-text-mid">
          Professionals ready to join your team or train your AI models — at
          50–70% less cost than US rates.
        </p>
        <div className="inline-flex flex-wrap items-center justify-center rounded-full border border-black/10 bg-white/70 px-1 py-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.05)] backdrop-blur-md">
          {HERO_STATS.map((stat, idx) => (
            <div
              key={stat}
              className={`flex items-center gap-2 px-5 py-0.5 text-[0.84rem] font-medium text-[#555] ${
                idx < HERO_STATS.length - 1 ? "border-r-[1.5px] border-black/10" : ""
              }`}
            >
              <span className="text-[0.78rem] text-remotiv-green">✦</span>
              {stat}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const STEPS = [
    {
      num: "1",
      color: "text-[#7E47FF] border-[#7E47FF]/30 bg-[#7E47FF]/5",
      title: "Browse",
      body: "Filter by role, skills, rate, and availability. Every profile is vetted by Remotiv before going live.",
    },
    {
      num: "2",
      color: "text-[#49D7A7] border-[#49D7A7]/30 bg-[#49D7A7]/5",
      title: "Unlock",
      body: "Pay to unlock full contact details or subscribe for unlimited access.",
    },
    {
      num: "3",
      color: "text-[#111] border-black/15 bg-white",
      title: "Hire",
      body: "Contact the candidate directly. Need full support? Our team manages the entire process.",
    },
  ];
  return (
    <section className="bg-white px-6 py-20 text-center md:px-14 md:py-24">
      <span className="mb-5 inline-block rounded-full bg-[#49D7A7]/10 px-4 py-1.5 font-heading text-[0.7rem] font-bold uppercase tracking-[0.16em] text-[#49D7A7]">
        How It Works
      </span>
      <h2 className="mb-14 font-heading text-[clamp(1.6rem,3vw,2.2rem)] font-extrabold tracking-[-0.02em] text-[#111]">
        Three Steps to Your Next Hire
      </h2>
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-3">
        {STEPS.map((s) => (
          <div
            key={s.num}
            className="rounded-2xl border border-black/[0.06] bg-white p-8 text-left shadow-[0_2px_12px_rgba(0,0,0,0.04)]"
          >
            <div
              className={`mb-5 flex size-12 items-center justify-center rounded-full border-[1.5px] font-heading text-base font-extrabold ${s.color}`}
            >
              {s.num}
            </div>
            <h3 className="mb-2 font-heading text-lg font-bold text-[#111]">{s.title}</h3>
            <p className="text-sm leading-[1.7] text-[#666]">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuoteCta() {
  return (
    <section className="bg-white px-6 pb-20 pt-2 md:px-14">
      <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-6 overflow-hidden rounded-3xl bg-[#c9ff85] px-8 py-12 md:flex-row md:items-center md:justify-between md:gap-10 md:px-14 md:py-14">
        <div className="text-left md:max-w-[640px]">
          <h2 className="mb-3 font-heading text-[clamp(1.5rem,2.4vw,1.85rem)] font-extrabold tracking-[-0.018em] text-[#111]">
            Need help finding the right person?
          </h2>
          <p className="text-[0.95rem] leading-[1.65] text-[#222]">
            Looking for a Developer, SDR, or Customer Support professional — for
            a permanent role or part-time? We find you the right person within days.
          </p>
        </div>
        <Link
          href="/contact"
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-[#111] px-7 py-3.5 font-heading text-[0.9rem] font-bold text-white transition-opacity hover:opacity-90"
        >
          Get a Quote
        </Link>
      </div>
    </section>
  );
}
