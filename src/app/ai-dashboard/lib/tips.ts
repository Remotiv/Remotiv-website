/**
 * Contextual tips, and the guides the Help launcher lists.
 *
 * Existing workspaces learned this dashboard before several features shipped,
 * so each tip appears once where the feature lives and stays reachable from
 * Help afterwards. One catalogue holds both: the tip on the page and the guide
 * in the panel read the SAME words, because a Help entry that paraphrases the
 * tip it reopens is a second copy to keep true.
 *
 * Pure data — no server imports — so the client panel and the server pages can
 * both hold it. Persistence lives in `tip-state.ts` (read) and
 * `(gated)/tip-actions.ts` (write).
 */

/** One key per tip. Stored verbatim in company_member_tips.tip_key. */
export type TipKey = "team_role_access";

export type Guide = {
  key: TipKey;
  /** Heading on the tip card and the title in the Help panel. */
  title: string;
  /** Where the tip itself appears, so the panel can say where it came from. */
  where: string;
  /** Paragraphs, in order. */
  body: readonly string[];
};

/**
 * The guides, in the order the panel lists them.
 *
 * Only tips that have shipped appear. An entry for a tip that does not exist
 * yet would be a promise in the product's own Help panel, and the panel says
 * plainly that more arrive as features ship rather than listing them early.
 */
export const GUIDES: ReadonlyArray<Guide> = [
  {
    key: "team_role_access",
    title: "Who sees which jobs",
    where: "Team",
    /*
     * Deliberately not "each person only sees their own role's work" — that is
     * true of two of the four roles and false of the other two, and the wrong
     * half is the half that governs candidate data. Owner and admin are
     * company-wide (getJobScope returns `scoped: false` for them); recruiter
     * and hiring manager are narrowed to job_hiring_team membership, and an
     * unassigned one resolves to an EMPTY job list rather than an absent
     * filter. The second paragraph says that out loud because "sees nothing"
     * is the surprising half and the one people get backwards.
     */
    body: [
      "Owners and admins see every job and applicant in the workspace. Recruiters and hiring managers see only the jobs they have been added to.",
      "Each job's hiring team is what grants that access — a recruiter on no jobs sees nothing rather than everything.",
    ],
  },
];

export function getGuide(key: TipKey): Guide | undefined {
  return GUIDES.find((g) => g.key === key);
}

/** Narrows a string off the wire before it reaches a query. */
export function isTipKey(value: string): value is TipKey {
  return GUIDES.some((g) => g.key === value);
}
