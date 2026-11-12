import type { CompanyApplicantRow } from "@/app/ai-dashboard/lib/applicant-types";

/**
 * Small display pieces shared by the Applicants list rows: the live table row,
 * the mobile card and the Split list item. Moved here unchanged from
 * _applicants-client.tsx (Applicants Split, commit 4) so the Split item can use
 * them without importing the client module that renders it.
 */

export const AVATAR_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)" },
  { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)" },
  { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
  { bg: "var(--ai-amber-tint)", fg: "var(--ai-amber-ink)" },
  { bg: "var(--ai-slate-tint)", fg: "var(--ai-slate-ink)" },
];

/** Tint derived from a stable hash of the record id, never array position. */
export function getTint(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

export function initials(first: string, last: string, email: string): string {
  const a = first.trim()[0] ?? "";
  const b = last.trim()[0] ?? "";
  const joined = `${a}${b}`.toUpperCase();
  return joined || email.slice(0, 2).toUpperCase() || "?";
}

export function fullName(r: CompanyApplicantRow): string {
  return `${r.first_name} ${r.last_name}`.trim() || r.email.split("@")[0] || "Unknown";
}

/**
 * "Worth a look" - the COMPANY's rule, deliberately unlike "Top match".
 *
 * Top match is the model's own opinion (score >= 90) and wears a FILLED lime
 * sticker. This is a threshold somebody chose, so it wears a purple OUTLINE
 * chip on a faint purple wash. Filled vs outline, lime vs purple: the two must
 * never be mistakable, because one is "the AI rates this person highly" and the
 * other is "this cleared a bar you set" - different claims, different recourse.
 *
 * The × is the first of three dismiss entry points and appears on row hover so
 * it is not a permanent invitation to clear the thing you just asked for.
 */
/**
 * The flag, as a MARK. It takes no props and it never will.
 *
 * ── Why the dismiss button is gone rather than optional ──────
 *
 * It used to accept `onDismiss`, and passing it rendered a <button> inside the
 * chip. Both places the chip is used are rows that are themselves <button>s, so
 * that one optional prop decided whether the markup was valid - and invalid is
 * not a cosmetic state here. The parser generates implied end tags on a nested
 * <button> and pops the outer one, so everything after the chip became a
 * SIBLING of the row: the server tree and the client tree disagreed, hydration
 * failed, and React left the mangled server DOM orphaned below the page.
 *
 * A component whose validity depends on where it is rendered is a trap, and no
 * signature can express "only if my ancestor is not a button" - the type system
 * cannot see the DOM. So the capability is removed instead of guarded: with no
 * prop to pass, the mistake is unspeakable rather than merely discouraged, and
 * a reader does not have to know the rule to stay on the right side of it.
 *
 * Dismissal lives in the drawer's Worth-a-look banner, which is a real region
 * rather than a chip and can hold a button safely. Both call sites open that
 * drawer on click, so it is one click from either.
 */
export function WorthALookChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-remotiv-purple/45 bg-remotiv-purple/[0.06] py-0.5 pl-[7px] pr-[7px] text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-remotiv-purple">
      Worth a look
    </span>
  );
}

/**
 * "Added by team" - this person was filed by hand and did not apply.
 *
 * SLATE, deliberately, and not purple. Purple is this dashboard's primary
 * action colour: it marks the things worth clicking - Open CV, Add candidate,
 * Worth a look. This is a fact about where the row came from, with nothing
 * behind it to click, so borrowing that colour would promise an action it does
 * not have. Slate is the same neutral the Applied stage pill already uses.
 *
 * Says "team", not "manual" or "you": the row records no author, so naming one
 * would be an invention. And "manual", sitting a column from CV score, reads
 * as manually scored.
 *
 * Beside the job title rather than on the name line, which already carries Top
 * match and Worth a look and truncates the name behind them.
 */
export function AddedByTeamChip() {
  return (
    <span
      title="Added by someone on your team. They didn't apply through the job board, and weren't emailed."
      className="inline-flex shrink-0 items-center rounded-lg bg-[var(--ai-slate-tint)] px-2 py-[5px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--ai-slate-ink)]"
    >
      Added by team
    </span>
  );
}

/**
 * The reason, which replaces the email sub-line on a flagged row.
 *
 * A flag without its reason is just a badge - the recruiter cannot tell whether
 * it fired on a CV at 82 or an interview at 95, and those warrant different
 * next moves. The stored sentence names the score and the mark it cleared.
 */
export function FlagReasonLine({ reason }: { reason: string | null }) {
  return (
    <p className="m-0 mt-0.5 truncate text-[12.5px] font-medium text-remotiv-purple">
      {reason?.trim() || "Met your auto-shortlist mark."}
    </p>
  );
}
