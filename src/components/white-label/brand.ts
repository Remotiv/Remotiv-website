/**
 * The five brand presets, and the three tokens derived from each.
 *
 * ── Where these values come from ─────────────────────────────
 *
 * HANDOFF.md §3.1 and the `PRESETS` array carried identically by both design
 * files. The ids are the design's own, and they are what `companies.brand_preset`
 * stores:
 *
 *   navy "Slate Navy" #1F3A5F · forest #1D6A4A · plum #5B3FBF (default)
 *   rust #B4451F · ink #24242B
 *
 * `mix` and `rgba` below are ports of the design's functions, not a
 * reinterpretation of them — same clamping, same rounding, same asymmetry
 * between the negative and positive branch. The handoff says these three are
 * "derived in JS ... never hand-picked", and a second implementation that
 * rounded differently would be exactly the hand-picking it warns against.
 *
 * ── Why this is not done in the browser ──────────────────────
 *
 * The design derives them in a client script because its preset is a demo
 * switcher. Ours is a database column, known before the first byte is sent, so
 * the derivation belongs on the server: `WhiteLabelShell` writes the four
 * values as an inline style on the canvas element and the correct brand is in
 * the HTML itself. Doing it in an effect would paint Plum and repaint — the
 * flash — and would leave a no-JS visitor on the wrong brand permanently.
 *
 * A PLAIN MODULE. No "use server" — every export in such a file becomes a
 * server action, and these are pure functions a client component may want.
 */

/** A preset id, as stored in `companies.brand_preset`. */
export type BrandPreset = "navy" | "forest" | "plum" | "rust" | "ink";

/** The default, and what every existing company renders as today. */
export const DEFAULT_PRESET: BrandPreset = "plum";

/**
 * The five, in the design's own order — which is the order the Settings
 * swatches show, so the picker and the handoff can be read side by side.
 */
export const BRAND_PRESETS: ReadonlyArray<{
  id: BrandPreset;
  /** The design's display name. "Slate Navy" is one preset, not two. */
  name: string;
  hex: string;
}> = [
  { id: "navy", name: "Slate Navy", hex: "#1F3A5F" },
  { id: "forest", name: "Forest", hex: "#1D6A4A" },
  { id: "plum", name: "Plum", hex: "#5B3FBF" },
  { id: "rust", name: "Rust", hex: "#B4451F" },
  { id: "ink", name: "Ink", hex: "#24242B" },
];

const PRESET_IDS = new Set<string>(BRAND_PRESETS.map((p) => p.id));

/**
 * A stored value, narrowed to a preset we can actually render.
 *
 * Null is the ordinary case — no company has ever set this — and it means Plum.
 * An UNRECOGNISED value falls back the same way rather than throwing: the
 * column has a CHECK constraint, so a surprise here means the constraint and
 * this list have drifted, and a public careers page is not the place to
 * discover that. It is logged instead.
 */
export function toPreset(value: string | null | undefined): BrandPreset {
  if (!value) return DEFAULT_PRESET;
  if (PRESET_IDS.has(value)) return value as BrandPreset;
  console.warn(`[white-label] unknown brand_preset "${value}" — rendering ${DEFAULT_PRESET}`);
  return DEFAULT_PRESET;
}

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Toward black on a negative amount, toward white on a positive one.
 *
 * The two branches are NOT symmetric — `v * (1 + a)` scales, `v + (255 - v) * a`
 * interpolates — and swapping either for the other changes every derived value.
 * Ported verbatim from the design's `mix()`.
 */
function mix(hex: string, amount: number): string {
  const out = channels(hex).map((v) =>
    Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount))),
  );
  return `rgb(${out.join(",")})`;
}

function withAlpha(hex: string, alpha: number): string {
  return `rgba(${channels(hex).join(",")},${alpha})`;
}

/** The four values `[data-wl-canvas]` needs, as CSS custom properties. */
export type BrandTokens = {
  "--brand": string;
  "--brand-ink": string;
  "--brand-tint": string;
  "--brand-line": string;
};

/**
 * One preset's tokens, at the design's three constants.
 *
 * ── These do not exactly match the CSS fallback, on purpose ──
 *
 * white-label.css carries Plum's values as literals so the frame is right
 * before this runs. HANDOFF.md's §3.1 CSS block and its own prose disagree
 * about them: the block says `--brand-ink:#432E8E`, `--brand-tint:#EFECFA` and
 * `.28`, while the prose and both design files' JS produce `#432F8D`,
 * `#F0EEF9` and `.30`.
 *
 * The COMPUTED values win here. Two reasons: the alpha is a real 0.02
 * difference rather than a rounding artefact, and — the deciding one — Plum
 * must be derived by the same function as the other four, or it is the one
 * preset whose tokens came from a different process and nobody could say which
 * was authoritative later. The two hexes differ by under 1% and are invisible;
 * this is about there being a single derivation, not about the pixels.
 */
export function brandTokens(preset: BrandPreset): BrandTokens {
  const { hex } = BRAND_PRESETS.find((p) => p.id === preset) ?? BRAND_PRESETS[2];
  return {
    "--brand": hex,
    "--brand-ink": mix(hex, -0.26),
    "--brand-tint": mix(hex, 0.91),
    "--brand-line": withAlpha(hex, 0.3),
  };
}
