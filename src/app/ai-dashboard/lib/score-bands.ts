/**
 * Score bands — ONE definition, shared by CV scores and interview scores.
 *
 * The thresholds were previously written out at each call site. They are the
 * same three numbers in both products by design: a 78 on a CV and a 78 on an
 * interview mean the same thing to the recruiter reading them, and a page that
 * drifted to 75 would quietly say otherwise.
 *
 * Plain module, importable from server and client — no "use server", no
 * server-only. It is arithmetic and class names, nothing more.
 */

export type ScoreBand = "hi" | "mid" | "lo";

/** >=80 mint · 60-79 amber · <60 red. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 80) return "hi";
  if (score >= 60) return "mid";
  return "lo";
}

/** Text colour, for a numeral on a light surface. */
export const BAND_TEXT: Record<ScoreBand, string> = {
  hi: "text-[var(--ai-mint-ink)]",
  mid: "text-[#7A4E05]",
  lo: "text-[#B02A24]",
};

/** Tinted pill, for a score beside other content. */
export const BAND_PILL: Record<ScoreBand, string> = {
  hi: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  mid: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  lo: "bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]",
};

/**
 * Solid panel, for the verdict strip's score block.
 *
 * The only place a band tints a whole panel rather than text. Its inks are
 * darker than BAND_TEXT's because they sit on a saturated fill rather than on
 * white — #04342C on mint, not mint-ink on a tint.
 */
export const BAND_PANEL: Record<ScoreBand, { panel: string; numeral: string; label: string }> = {
  hi: {
    panel: "bg-remotiv-green",
    numeral: "text-[var(--ai-mint-ink)]",
    label: "text-[rgba(4,52,44,0.55)]",
  },
  mid: {
    panel: "bg-[#F5A524]",
    numeral: "text-[#5C3A03]",
    label: "text-[rgba(92,58,3,0.6)]",
  },
  lo: {
    panel: "bg-[#E0524B]",
    numeral: "text-[#5E1712]",
    label: "text-[rgba(94,23,18,0.62)]",
  },
};
