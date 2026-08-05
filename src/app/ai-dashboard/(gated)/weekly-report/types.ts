/**
 * Shapes for the weekly report.
 *
 * A separate module because actions.ts carries "use server" — every export
 * there is compiled into a server action, so a type cannot live in it.
 */

/**
 * How a rise in a metric should read.
 *
 * ALWAYS passed explicitly, never inferred from the metric's name or sign.
 * "Rejected" is `neutral` on purpose: more rejections is neither a win nor a
 * failure, and colouring it mint next to "Moved forward" would misread as
 * success. Any metric added later must state its own tone.
 */
export type DeltaTone = "good-up" | "good-down" | "neutral";

export type AttentionKind = "stalled" | "draft" | "quiet";

export type AttentionItem = {
  kind: AttentionKind;
  title: string;
  detail: string;
  cta: string;
  href: string;
};

export type TopMatch = {
  applicationId: string;
  name: string;
  role: string;
  score: number;
};

export type RoleCount = {
  jobId: string | null;
  title: string;
  count: number;
  /** The same role's count in the prior week, or null when there is none. */
  previous: number | null;
};

/**
 * One week of the report.
 *
 * `previous` is a sibling record, not a flag: the earliest week genuinely has
 * no predecessor, and every comparison in the UI resolves through this so a
 * missing one renders "no prior week" rather than a fabricated delta.
 */
export type WeekReport = {
  /** ISO date of the Monday, used as the navigation cursor. */
  weekStart: string;
  /** ISO date of the Sunday. */
  weekEnd: string;
  /** "28 July – 3 August". */
  range: string;
  /** "Last week at Remotiv" / "Week of 21 July" / "Your first week". */
  label: string;
  /** True when this is the most recent week the report will show. */
  isLatest: boolean;
  /** True when there is nothing before it — disables Previous. */
  isEarliest: boolean;

  applied: number;
  forward: number;
  rejected: number;
  stalled: number;

  /** At most 4. `rolesTotal` is how many the week actually had. */
  roles: RoleCount[];
  rolesTotal: number;
  /** Roles with zero applicants this week, counted before the cap. */
  quietRoles: number;
  /** At most 4. `topTotal` is every scored applicant from the week. */
  top: TopMatch[];
  topTotal: number;
  attention: AttentionItem[];

  /** Null on the earliest week. Drives every delta chip. */
  previous: {
    applied: number;
    forward: number;
    rejected: number;
    stalled: number;
  } | null;
};
