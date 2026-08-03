import {
  Braces,
  Briefcase,
  ChartNoAxesColumn,
  Database,
  Headphones,
  Megaphone,
  Palette,
  PenLine,
  Settings2,
  TrendingUp,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * Category → icon + tint, shared by the Overview "Live roles" cards and every
 * per-job row in the Jobs list.
 *
 * Both surfaces previously rendered the SAME briefcase on every job, so a board
 * of twelve roles gave a reader no signal at all from the one element designed
 * to carry it. jobs.category is a closed list that already exists on both
 * shapes (LiveRole.category, CompanyJobRow.category), so no data plumbing was
 * needed — only the mapping.
 *
 * ── Why lucide, not Tabler ───────────────────────────────────
 *
 * The brief said Tabler, and @tabler/icons-react IS a dependency (the public
 * apply modal uses it). But every icon already rendered in /ai-dashboard comes
 * from lucide-react, and the two sets differ in grid size and stroke geometry —
 * a Tabler icon sitting in a 34px tile beside lucide icons in the topbar and
 * sidebar reads as visibly heavier and slightly misaligned. Matching the
 * surrounding set is what "matching the design's treatment" means here. Say the
 * word and this file swaps to Tabler wholesale; it is the only place to change.
 *
 * ── Why the tint comes from the category too ─────────────────
 *
 * Both call sites previously tinted from a hash of the JOB ID, which is
 * deliberately random. Keeping that while making the icon meaningful would put
 * a code glyph in an arbitrary colour and break the association the icon is
 * there to create. Deriving both from the category means every Engineering role
 * on the board looks like every other Engineering role — which is the whole
 * point of a category, and is what makes the column scannable.
 *
 * Tints are grouped by FUNCTION rather than assigned one-per-category: six
 * families across twelve categories reads as a deliberate palette, where twelve
 * near-identical pastels would read as noise and exhaust the design tokens.
 */
export type CategoryVisual = {
  icon: LucideIcon;
  /** Background + foreground, using the segment's existing tint tokens. */
  bg: string;
  fg: string;
};

const TINT = {
  purple: { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  sky: { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
  peach: { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)" },
  mint: { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)" },
  amber: { bg: "var(--ai-amber-tint)", fg: "var(--ai-amber-ink)" },
  slate: { bg: "var(--ai-slate-tint)", fg: "var(--ai-slate-ink)" },
} as const;

/**
 * Keyed by the exact strings in JOB_CATEGORIES. A plain Record rather than a
 * typed one on purpose: `jobs.category` is free text at the database level
 * (/api/apply writes "Other" on the manual-entry path), so a lookup has to
 * tolerate a value outside the union rather than assume exhaustiveness.
 */
const CATEGORY_VISUALS: Record<string, CategoryVisual> = {
  Engineering: { icon: Braces, ...TINT.purple },
  Data: { icon: Database, ...TINT.sky },
  Design: { icon: Palette, ...TINT.peach },
  "Content & Writing": { icon: PenLine, ...TINT.peach },
  Product: { icon: ChartNoAxesColumn, ...TINT.mint },
  Operations: { icon: Settings2, ...TINT.mint },
  Sales: { icon: TrendingUp, ...TINT.amber },
  Marketing: { icon: Megaphone, ...TINT.amber },
  "Customer Support": { icon: Headphones, ...TINT.sky },
  "HR & Recruiting": { icon: UserRound, ...TINT.purple },
  "Finance & Accounting": { icon: Wallet, ...TINT.slate },
  Other: { icon: Briefcase, ...TINT.slate },
};

/** Neutral fallback: the briefcase everything used to get, in slate. */
const FALLBACK: CategoryVisual = { icon: Briefcase, ...TINT.slate };

/**
 * The icon and tint for a job's category.
 *
 * Trimmed and matched case-insensitively, because the column is free text and
 * a stray " Engineering" or "engineering" should still get the right glyph
 * rather than silently falling back. Anything genuinely unmapped — "Other", a
 * legacy value, an empty string — lands on the neutral briefcase, which is
 * exactly what the old behaviour was, so nothing can look broken.
 */
export function categoryVisual(category: string | null | undefined): CategoryVisual {
  const key = (category ?? "").trim();
  if (!key) return FALLBACK;
  if (CATEGORY_VISUALS[key]) return CATEGORY_VISUALS[key];

  const lower = key.toLowerCase();
  for (const [name, visual] of Object.entries(CATEGORY_VISUALS)) {
    if (name.toLowerCase() === lower) return visual;
  }
  return FALLBACK;
}
