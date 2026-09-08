/**
 * The contract a model-proposed split has to satisfy before anyone sees it.
 *
 * ── Why the model returns NUMBERS, not text ──────────────────
 *
 * The obvious design is to ask for the grouped lines back and check they match
 * the input. This asks for line RANGES over a numbered list instead, and
 * rebuilds every group from the recruiter's own array.
 *
 * The difference matters more than it looks. Verifying returned text catches a
 * dropped or reworded line; returning ranges means the model never holds the
 * text at all, so there is nothing to drop and nothing to reword. A whole class
 * of failure stops being something we detect and starts being something that
 * cannot occur. The recruiter's words reach the box exactly as they typed them
 * because they never left it.
 *
 * What remains for the model to be wrong about is where the boundaries go and
 * what each group is called — and both of those are on screen, above the lines
 * they apply to, for the recruiter to confirm.
 *
 * ── A proposal that is nearly right is REJECTED ──────────────
 *
 * Every line, exactly once, in order, in exactly one group. A response that
 * skips line 7, or overlaps two groups, or stops at line 11 of 13, is not
 * "mostly correct" and is not repaired: it is thrown away whole and the screen
 * falls back to asking the recruiter directly.
 *
 * Same discipline as the CV scorer refusing to store a scorecard whose quotes
 * it cannot find in the CV. A partial answer from a model is not a partial
 * answer — it is an answer of unknown shape, and the cost of guessing which
 * part is sound is paid by whoever's job description gets mangled.
 *
 * A PLAIN MODULE — no imports — so the check that makes this safe is testable
 * on its own, without a model, a network, or a server.
 */

export type JdGroupKind = "description" | "responsibilities" | "requirements";

/** What the model returns: a kind, and an inclusive 1-based line range. */
export type JdRange = { kind: JdGroupKind; start: number; end: number };

/** What the screen consumes: a kind, and the recruiter's own lines. */
export type JdGroup = { kind: JdGroupKind; lines: string[] };

const KINDS: readonly string[] = ["description", "responsibilities", "requirements"];

/**
 * The lines a split is computed over: the box's non-blank lines, trimmed, in
 * order. Blank lines carry no content and numbering them would make the
 * model's job harder for nothing.
 */
export function splittableLines(box: string): string[] {
  return box
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Turn a model response into groups, or return null.
 *
 * NULL IS THE COMMON CASE TO GET RIGHT. Every caller treats it as "the model
 * did not answer", identically to a timeout or a network failure — there is no
 * path where a malformed proposal is partially used.
 */
export function toGroups(raw: unknown, lines: string[]): JdGroup[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const ranges: JdRange[] = [];
  for (const entry of raw) {
    const r = entry as { kind?: unknown; start?: unknown; end?: unknown };
    if (typeof r?.kind !== "string" || !KINDS.includes(r.kind)) return null;
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) return null;
    ranges.push({ kind: r.kind as JdGroupKind, start: r.start as number, end: r.end as number });
  }

  /*
   * The partition check, stated as the four things that must all hold. Written
   * out rather than folded together so a failure is readable in a log: each
   * clause is a distinct way for a response to be unusable.
   */
  let expected = 1;
  for (const r of ranges) {
    if (r.start !== expected) return null; // contiguous, and in order
    if (r.end < r.start) return null; // non-empty
    if (r.end > lines.length) return null; // inside the box
    expected = r.end + 1;
  }
  if (expected !== lines.length + 1) return null; // every line covered

  return ranges.map((r) => ({ kind: r.kind, lines: lines.slice(r.start - 1, r.end) }));
}

/**
 * A proposal worth showing.
 *
 * A single group covering everything is what a model returns when it could not
 * see the structure either. It is not wrong, but it proposes nothing — the
 * screen already knows how to ask "what is this?" about one undivided block,
 * and dressing that up as a suggestion would claim more than happened.
 */
export function isUseful(groups: JdGroup[] | null): boolean {
  return groups !== null && groups.length > 1;
}
