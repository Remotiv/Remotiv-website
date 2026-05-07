/**
 * Homepage hero — pixel-matched to the reference HTML's `.hero` block.
 *
 * Style is owned entirely by hero.module.css (this component is layout
 * only). Typewriter animation removed — visual correctness > motion.
 *
 * Preserved from the reference:
 *   - 4 floating avatars with the gentle floatY up/down animation
 *   - Local WebP portraits at /hero-avatars/avatar-{1..4}.webp
 *   - Blinking green "." after "Fast" (`.blinkDot` keyframe)
 *   - CTA arrow icon that slides right on hover
 */

import styles from "./hero.module.css";

function ArrowRight() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      <polygon points="0,0 18,9 0,18" fill="#49D7A7" />
    </svg>
  );
}

function ArrowLeft() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      style={{ transform: "rotate(180deg)", display: "block", flexShrink: 0 }}
      aria-hidden="true"
    >
      <polygon points="0,0 18,9 0,18" fill="#49D7A7" />
    </svg>
  );
}

export function Hero() {
  return (
    <section className={styles.hero}>
      {/* Floating avatars (4 corners; 2 hide on mobile via media query) */}
      <div className={`${styles.avatar} ${styles.av1}`}>
        <div className={styles.avatarCircle}>
          {/* biome-ignore lint/performance/noImgElement: bypass next/image; .avatarCircle CSS handles object-fit */}
          <img
            src="/hero-avatars/avatar-1.webp"
            alt=""
            loading="eager"
            width={74}
            height={74}
          />
        </div>
        <div className={styles.arrow}>
          <ArrowRight />
        </div>
      </div>
      <div className={`${styles.avatar} ${styles.av2}`}>
        <div className={styles.arrowLeft}>
          <ArrowLeft />
        </div>
        <div className={styles.avatarCircle}>
          {/* biome-ignore lint/performance/noImgElement: bypass next/image; .avatarCircle CSS handles object-fit */}
          <img
            src="/hero-avatars/avatar-4.webp"
            alt=""
            loading="eager"
            width={74}
            height={74}
          />
        </div>
      </div>
      <div className={`${styles.avatar} ${styles.av3}`}>
        <div className={styles.avatarCircle}>
          {/* biome-ignore lint/performance/noImgElement: bypass next/image; .avatarCircle CSS handles object-fit */}
          <img
            src="/hero-avatars/avatar-3.webp"
            alt=""
            loading="eager"
            width={74}
            height={74}
          />
        </div>
        <div className={styles.arrow}>
          <ArrowRight />
        </div>
      </div>
      <div className={`${styles.avatar} ${styles.av4}`}>
        <div className={styles.arrowLeft}>
          <ArrowLeft />
        </div>
        <div className={styles.avatarCircle}>
          {/* biome-ignore lint/performance/noImgElement: bypass next/image; .avatarCircle CSS handles object-fit */}
          <img
            src="/hero-avatars/avatar-2.webp"
            alt=""
            loading="eager"
            width={74}
            height={74}
          />
        </div>
      </div>

      {/* Above-headline pill */}
      <div className={styles.pill}>⚡ 24-Hour Expert Engineering Matching</div>

      {/* Headline — keep the "Fast" green span + blinking dot */}
      <h1 className={styles.headline}>
        Build High-Quality Engineering
        <br />
        Teams,{" "}
        <span className={styles.headlineAccent}>
          Fast<span className={styles.blinkDot}>.</span>
        </span>
      </h1>

      {/* Sub-headline */}
      <p className={styles.sub}>
        Hire pre-vetted engineers, scale with staff augmentation, or build
        dedicated teams — without the usual delays.
      </p>

      {/* Primary CTA */}
      <a href="/browse-talent" className={styles.btnCta}>
        Find Your Next Hire
        <span className={styles.arrowIcon}>→</span>
      </a>
    </section>
  );
}
