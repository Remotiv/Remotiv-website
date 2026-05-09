import Image from "next/image";

/**
 * "Trusted by leading companies worldwide" partner-logo marquee.
 *
 * Pixel-matched to the reference HTML's #partner-marquee block:
 *   - 26s linear-infinite scroll (paused on hover)
 *   - 75%-wide cream rounded card on a white outer section
 *   - Logos at 28 px tall, full colour (no grayscale / opacity dim)
 *   - Warm beige-grey 1×26 px dividers between each logo
 *   - 48 px fade gradients at both edges to soften the loop seam
 *
 * Logos live at /public/logos/*.webp (compressed from PNG @ 56 px tall
 * for retina sharpness, ~3-7 KB each).
 */

const LOGOS = [
  { src: "/logos/berlitz.webp", alt: "Berlitz" },
  { src: "/logos/cogent.webp", alt: "Cogent" },
  { src: "/logos/circle.webp", alt: "Circle" },
  { src: "/logos/unlayer.webp", alt: "Unlayer" },
  { src: "/logos/agency-partner.webp", alt: "Agency Partner" },
  { src: "/logos/digilatics.webp", alt: "Digilatics" },
  { src: "/logos/marketrove.webp", alt: "Marketrove" },
];

function LogoTrack() {
  return (
    <div className="flex shrink-0 items-center gap-10">
      {LOGOS.map((logo) => (
        <div key={logo.src} className="flex items-center gap-10">
          <Image
            src={logo.src}
            alt={logo.alt}
            width={120}
            height={28}
            className="h-[22px] w-auto md:h-7"
          />
          <span
            className="h-[26px] w-px bg-[#d9d3cd]"
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

export function PartnerMarquee() {
  return (
    <section className="flex w-full justify-center bg-white pt-8 pb-6 md:pt-[52px] md:pb-8">
      <div className="flex w-[92%] flex-col items-center overflow-hidden rounded-2xl bg-remotiv-bg py-[26px] md:w-[75%]">
        <h2 className="mb-5 text-center text-[13px] font-medium text-[#111] md:text-[15px]">
          Trusted by leading companies worldwide
        </h2>

        {/* Marquee wrapper */}
        <div className="group relative w-full overflow-hidden">
          {/* Fade edges — 48 px each, matches the reference */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-remotiv-bg to-transparent md:w-12" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-remotiv-bg to-transparent md:w-12" />

          {/* Scrolling track — 26s linear, pauses on hover */}
          <div className="flex w-max animate-[marquee_38s_linear_infinite] gap-10 group-hover:[animation-play-state:paused] md:animate-[marquee_26s_linear_infinite]">
            <LogoTrack />
            <LogoTrack />
          </div>
        </div>
      </div>
    </section>
  );
}
