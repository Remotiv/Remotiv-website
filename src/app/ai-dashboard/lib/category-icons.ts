import {
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  Bug,
  Calculator,
  Camera,
  Clapperboard,
  ChartColumn,
  ClipboardList,
  Cloud,
  CodeXml,
  Compass,
  Cpu,
  Database,
  Gamepad2,
  Handshake,
  HardHat,
  Headphones,
  Languages,
  Layers,
  Megaphone,
  Microscope,
  Network,
  Palette,
  PenLine,
  Scale,
  Server,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Stethoscope,
  Sun,
  TrendingUp,
  Truck,
  UserRound,
  Users,
  Wallet,
  Wrench,
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
  Engineering: { icon: CodeXml, ...TINT.purple },
  Data: { icon: Database, ...TINT.sky },
  Design: { icon: Palette, ...TINT.peach },
  "Content & Writing": { icon: PenLine, ...TINT.peach },
  Product: { icon: ChartColumn, ...TINT.mint },
  Operations: { icon: Sun, ...TINT.mint },
  Sales: { icon: TrendingUp, ...TINT.amber },
  Marketing: { icon: Megaphone, ...TINT.amber },
  "Customer Support": { icon: Briefcase, ...TINT.sky },
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

// ── Title matching ───────────────────────────────────────────

/**
 * The glyph for a job TITLE, which is what a reader actually scans.
 *
 * ── Why the category was not enough ──────────────────────────
 *
 * `jobs.category` is a bucket of twelve, and most companies hire several roles
 * out of one of them. Six technical openings all sat under "Engineering" and so
 * rendered six copies of the same row — the one element on the row carrying
 * role information carried none, which is the same failure the category mapping
 * above was written to fix, one level down.
 *
 * ── Order IS the specificity rule ────────────────────────────
 *
 * Rules are scanned top to bottom and the FIRST match wins. That is deliberate,
 * and it is why the list is not alphabetical: every rule that could also be
 * caught by a broader one sits above it.
 *
 *   "Machine Learning Engineer" → ML sits above generic engineering
 *   "DevOps / Cloud Engineer"   → devops sits above generic engineering
 *   "React Native Developer"    → mobile sits above front-end
 *   "Product Designer"          → design sits above product management
 *   "Sales Engineer"            → sales sits above generic engineering
 *
 * Longest-match was considered and rejected: it resolves the ML case correctly
 * but gets "DevOps / Cloud Engineer" wrong, because "engineer" (8) is longer
 * than "devops" (6). Curated order handles both.
 *
 * ── Whole-word matching, always ──────────────────────────────
 *
 * The title is normalised so every separator becomes a space, then searched for
 * SPACE-DELIMITED phrases. That is what stops "ai" matching "Retail", "ml"
 * matching "HTML", "bi" matching "Mobile" and "hr" matching "Chrome" — the
 * short tokens in this map are the dangerous ones and none of them can match
 * inside a longer word.
 *
 * Pure and deterministic: same title in, same icon out, no dates, no hashing,
 * no reliance on how the rows happen to be ordered.
 */
type TitleRule = { icon: LucideIcon; patterns: readonly string[] };

const TITLE_RULES: readonly TitleRule[] = [
  // ── Specialisms that also contain a broader word ──
  { icon: Brain, patterns: ["machine learning", "deep learning", "ml engineer", "ml", "ai", "artificial intelligence", "nlp", "llm", "data scientist", "data science", "computer vision"] },
  { icon: Smartphone, patterns: ["react native", "ios", "android", "mobile", "flutter", "swift", "kotlin"] },
  { icon: Cloud, patterns: ["devops", "sre", "site reliability", "infrastructure", "cloud", "platform engineer", "kubernetes", "aws", "azure"] },
  { icon: ShieldCheck, patterns: ["security", "infosec", "cybersecurity", "penetration tester", "appsec"] },
  { icon: Bug, patterns: ["qa", "quality assurance", "test engineer", "tester", "automation tester", "sdet"] },
  { icon: Network, patterns: ["network engineer", "network administrator", "systems administrator", "sysadmin"] },
  { icon: Cpu, patterns: ["embedded", "firmware", "hardware engineer", "electronics"] },
  { icon: Gamepad2, patterns: ["game developer", "game designer", "unity developer", "unreal"] },

  // ── Design before product, product-manager before anything else "product" ──
  { icon: Palette, patterns: ["designer", "ux", "ui ux", "user experience", "user interface", "graphic design", "brand design", "design"] },
  { icon: Clapperboard, patterns: ["video editor", "videographer", "motion designer", "motion graphics", "animator"] },
  { icon: Camera, patterns: ["photographer", "photography"] },

  // ── Engineering generalists ──
  { icon: Layers, patterns: ["full stack", "fullstack", "mern", "mean stack"] },
  { icon: Database, patterns: ["data engineer", "database", "dba", "etl", "data warehouse", "big data"] },
  { icon: Server, patterns: ["backend", "back end", "api engineer", "node", "python", "java", "golang", "ruby", "php", "laravel", "django", "rails", ".net", "c#"] },
  { icon: CodeXml, patterns: ["frontend", "front end", "react", "angular", "vue", "javascript", "typescript", "web developer", "ui engineer"] },

  // ── Delivery and product ──
  { icon: ClipboardList, patterns: ["project manager", "program manager", "delivery manager", "scrum master", "agile coach", "project coordinator"] },
  { icon: Compass, patterns: ["product manager", "product owner", "head of product", "product lead"] },

  // ── Data and analysis ──
  { icon: Microscope, patterns: ["research", "researcher", "scientist"] },
  { icon: ChartColumn, patterns: ["analyst", "analytics", "bi", "business intelligence", "reporting"] },

  // ── People, before anything that could catch "operations" ──
  { icon: Users, patterns: ["recruiter", "recruitment", "talent acquisition", "talent", "human resources", "hr", "people operations", "people partner", "hiring"] },

  // ── Commercial ──
  { icon: Handshake, patterns: ["account manager", "account executive", "partnerships", "client relations", "client success", "key accounts"] },
  { icon: TrendingUp, patterns: ["sales", "business development", "bd executive", "revenue", "growth"] },
  { icon: ShoppingCart, patterns: ["ecommerce", "e commerce", "merchandising", "category manager"] },
  { icon: Megaphone, patterns: ["marketing", "seo", "social media", "brand manager", "communications", "public relations", "pr"] },
  { icon: PenLine, patterns: ["copywriter", "content writer", "writer", "editor", "copy", "content", "technical writer", "journalist"] },

  // ── Support and back office ──
  { icon: Headphones, patterns: ["customer success", "customer support", "customer service", "support agent", "help desk", "service desk"] },
  { icon: Calculator, patterns: ["accountant", "accounting", "bookkeeper", "payroll", "auditor"] },
  { icon: Wallet, patterns: ["finance", "financial", "controller", "treasury", "cfo", "fp a"] },
  { icon: Scale, patterns: ["legal", "lawyer", "counsel", "paralegal", "compliance", "attorney"] },

  // ── Everything else with a distinct shape ──
  { icon: Bot, patterns: ["automation", "rpa", "workflow engineer"] },
  { icon: BookOpen, patterns: ["teacher", "trainer", "instructor", "tutor", "curriculum", "lecturer"] },
  { icon: Stethoscope, patterns: ["nurse", "doctor", "physician", "clinical", "medical", "healthcare"] },
  { icon: Truck, patterns: ["logistics", "supply chain", "warehouse", "driver", "fleet", "dispatch"] },
  { icon: HardHat, patterns: ["construction", "civil engineer", "site engineer", "surveyor"] },
  { icon: Wrench, patterns: ["technician", "maintenance", "mechanic", "field service", "repair"] },
  { icon: Languages, patterns: ["translator", "translation", "localization", "localisation", "interpreter"] },

  // ── LAST: the generic engineering catch-all ──
  // Everything specific has already had its turn, so a bare "Engineer" or
  // "Developer" landing on code brackets is the honest answer rather than a
  // collision. Nothing may be added below this line.
  { icon: CodeXml, patterns: ["engineer", "engineering", "developer", "programmer", "software", "architect"] },
];

/**
 * Lowercase, and turn every separator into a space.
 *
 * "Full-Stack Developer" → "full stack developer"
 * "DevOps / Cloud Engineer" → "devops cloud engineer"
 * "Full Stack Engineer (Next.js)" → "full stack engineer next js"
 *
 * Punctuation is not preserved because nothing in the map depends on it, and
 * collapsing it is what lets one pattern cover "front-end", "front end" and
 * "Front/End" without listing three spellings.
 */
function normaliseTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The title's glyph, or null when no rule matches. Exported for the tests. */
export function titleIcon(title: string | null | undefined): LucideIcon | null {
  const normalised = normaliseTitle(title ?? "");
  if (!normalised) return null;
  // Padded so `includes` is a whole-word test at both ends.
  const haystack = ` ${normalised} `;
  for (const rule of TITLE_RULES) {
    for (const pattern of rule.patterns) {
      if (haystack.includes(` ${pattern} `)) return rule.icon;
    }
  }
  return null;
}

/**
 * The icon and tint for one job.
 *
 * TITLE decides the glyph; CATEGORY still decides the tint, unchanged — every
 * Engineering role keeps its purple tile and only the glyph inside it varies,
 * so the column reads as a family rather than a paint chart. Falls back to the
 * category's own glyph when no title rule matches, and to the neutral briefcase
 * when neither does — the behaviour before this existed, so nothing can look
 * broken on a title nobody anticipated.
 */
export function jobVisual(
  title: string | null | undefined,
  category: string | null | undefined,
): CategoryVisual {
  const base = categoryVisual(category);
  return { ...base, icon: titleIcon(title) ?? base.icon };
}
