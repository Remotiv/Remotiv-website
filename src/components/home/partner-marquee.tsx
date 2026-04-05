import Image from "next/image";

const PARTNERS = [
  "berlitz",
  "cogent",
  "acumen",
  "circle",
  "agency-partner",
  "digilatics",
  "marketrove",
];

function LogoTrack() {
  return (
    <div className="flex shrink-0 items-center gap-12">
      {PARTNERS.map((name) => (
        <div key={name} className="flex items-center gap-12">
          <Image
            src={`/logos/${name}.png`}
            alt={name}
            width={120}
            height={40}
            className="h-8 w-auto object-contain opacity-70 grayscale transition-all hover:opacity-100 hover:grayscale-0"
          />
          <span className="h-6 w-px bg-gray-300" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

export function PartnerMarquee() {
  return (
    <section className="w-full bg-white py-16">
      <div className="mx-auto flex w-[75%] max-w-5xl flex-col items-center rounded-2xl bg-remotiv-bg px-8 py-12">
        <h2 className="font-heading mb-10 text-center text-lg font-semibold text-remotiv-text-mid">
          Trusted by leading companies worldwide
        </h2>

        {/* Marquee wrapper */}
        <div className="group relative w-full overflow-hidden">
          {/* Fade edges */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-remotiv-bg to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-remotiv-bg to-transparent" />

          {/* Scrolling track */}
          <div className="flex w-max animate-[marquee_30s_linear_infinite] gap-12 group-hover:[animation-play-state:paused]">
            <LogoTrack />
            <LogoTrack />
          </div>
        </div>
      </div>
    </section>
  );
}
