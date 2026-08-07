import type { ReactNode } from "react";

/**
 * The dark hero, in its two sanctioned forms.
 *
 * ── The purple glow is gone, permanently ─────────────────────
 *
 * No dark surface in this product carries a purple radial glow any more —
 * not heroes, not modal headers, not the wizard rail. It was rejected. This
 * component has no glow layer to reintroduce one through, which is the point:
 * a page cannot opt back in without editing this file.
 *
 * ── Two variants, and the asymmetry is deliberate ────────────
 *
 * METRIC (Jobs, Applicants, Messages, Team, and Interviews when it lands):
 * a headline NUMBER on a solid mint panel, with the breakdown on ink beside
 * it. 340px + 1fr, no divider column.
 *
 * STATEMENT (Overview, Weekly Report, Settings): flat ink, no mint block.
 * These open with a sentence rather than a number, so there is nothing to put
 * in the block. Do not "unify" the two — the difference is the design.
 *
 * ── Both known gotchas are designed out, not patched ─────────
 *
 * 1. THE NUMERAL'S MARGIN. `<p>` carries a UA `margin: 1em 0`, which at 46px
 *    is a 46px bottom margin. It used to collapse against the subline; margins
 *    do NOT collapse inside a flex container, so making the panel flex left a
 *    55px dead band under every number. Here the numeral element is rendered
 *    BY this component with `m-0` — callers pass the value, never the element,
 *    so there is no `<p>` for the margin to come back through.
 *
 * 2. ORDER AGAINST MEDIA QUERIES. The original bug was an override appended
 *    after the stylesheet's media queries, silently beating the 1180px
 *    fallback at equal specificity and clipping the nowrap labels. There is
 *    now exactly ONE declaration of the hero's responsive behaviour — the
 *    `min-[1180px]:` variants below — so there is no second rule to lose to.
 *    A page that wants a different collapse has to change it here, for
 *    everyone, on purpose.
 */

type HeroProps = {
  /** Small uppercase label above the number. */
  eyebrow: string;
  /**
   * The headline number. A node rather than a string so a page can append a
   * unit ("3 / 10") — but never a block element, because the margin reset
   * belongs to the wrapper this component owns.
   */
  value: ReactNode;
  /** Optional "+N this week" chip. Inverts to ink-on-mint inside the block. */
  delta?: ReactNode;
  /** One line under the number. */
  subline: ReactNode;
  /**
   * Anything between the number and the subline — currently only Team's seat
   * bar. Inside the mint panel, so it must be legible on #49D7A7.
   */
  belowValue?: ReactNode;
  /** The breakdown, rendered on ink to the right of the block. */
  children: ReactNode;
  /**
   * A third column on ink, right-aligned — Team's facepile. Collapses under
   * the breakdown below 1180px like everything else.
   */
  trailing?: ReactNode;
};

export function DashboardHero({
  eyebrow,
  value,
  delta,
  subline,
  belowValue,
  children,
  trailing,
}: HeroProps) {
  return (
    <div
      className={`relative mb-[26px] grid grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] shadow-[0_18px_46px_rgba(20,16,32,0.24)] min-[1180px]:grid-cols-[340px_minmax(0,1fr)]${
        trailing ? " min-[1180px]:grid-cols-[340px_minmax(0,1fr)_auto]" : ""
      }`}
    >
      {/* The mint block. Solid #49D7A7 — no gradient, no glow, no divider. */}
      <div className="flex flex-col justify-center bg-remotiv-green px-[26px] py-[22px] min-[1180px]:px-7 min-[1180px]:py-[26px]">
        <p className="m-0 mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.14em] text-[rgba(4,52,44,0.55)]">
          {eyebrow}
        </p>
        {/* m-0 is the whole of gotcha 1. Do not remove it, and do not let a
            caller supply this element. */}
        <p className="m-0 flex flex-wrap items-baseline gap-x-[11px] gap-y-2 font-heading text-[46px] font-extrabold leading-none tracking-[-0.04em] text-[var(--ai-mint-ink)]">
          {value}
          {delta}
        </p>
        {belowValue}
        <p className="m-0 mt-[9px] text-[12.5px] font-semibold text-[rgba(4,52,44,0.72)]">
          {subline}
        </p>
      </div>

      <div className="min-w-0 px-[26px] py-[22px] min-[1180px]:px-[30px] min-[1180px]:py-[26px]">
        {children}
      </div>

      {trailing && (
        <div className="px-[26px] pb-[22px] pt-0 min-[1180px]:py-[26px] min-[1180px]:pl-2.5 min-[1180px]:pr-[30px]">
          {trailing}
        </div>
      )}
    </div>
  );
}

/**
 * The "+N this week" chip.
 *
 * Ink-on-mint, inverting the page's usual mint-on-ink — on a mint panel the
 * original treatment would have vanished into its own background.
 */
export function HeroDelta({ children }: { children: ReactNode }) {
  return (
    <em className="rounded-full bg-[var(--ai-sidebar)] px-[9px] py-1 font-sans text-[12.5px] font-bold not-italic tracking-normal text-remotiv-green">
      {children}
    </em>
  );
}

/**
 * The statement hero — flat ink, no mint block.
 *
 * Deliberately thin: these three pages have almost nothing in common beyond
 * the surface they sit on, so the component owns the surface and nothing else.
 * Giving it slots for a headline and a stat row would only push each page to
 * bend them, which is how eleven copies of a hero happened last time.
 */
export function DashboardHeroStatement({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative mb-[26px] overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] px-6 py-7 shadow-[0_18px_46px_rgba(20,16,32,0.24)] min-[840px]:px-[30px] ${className}`}
    >
      {children}
    </div>
  );
}
