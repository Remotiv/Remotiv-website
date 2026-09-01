import type { PipelineStage } from "@/app/ai-dashboard/lib/applicant-types";
import type { Read } from "@/lib/supabase/read";

/**
 * Overview page types.
 *
 * A plain module, not the action file: `overview-actions.ts` carries the
 * "use server" directive, and such a module may only export async functions —
 * a type re-export there compiles into a server action and breaks the
 * Turbopack build (tsc and biome both pass, so only `next build` catches it).
 */

/** One step of the hero funnel. */
export type FunnelStep = {
  stage: PipelineStage;
  count: number;
  /** Share of all applications, 0–100. Rendered as the bar width. */
  pct: number;
};

/** A published role with its applicant volume, for the Live roles strip. */
export type LiveRole = {
  id: string;
  title: string;
  category: string;
  applicants: number;
  /** Applications received in the last 7 days. */
  newThisWeek: number;
};

/** A recent applicant, for the "Latest applicants" card. */
export type RecentApplicant = {
  id: string;
  name: string;
  jobTitle: string;
  stage: PipelineStage;
  createdAt: string;
};

/** One entry of the merged activity feed. */
export type ActivityItem = {
  id: string;
  kind: "stage" | "applied" | "published";
  /** Pre-composed lead, rendered bold. */
  subject: string;
  /** Rest of the sentence, rendered muted. */
  predicate: string;
  /** "Bilal · 3 hours ago" — actor is null for system-generated entries. */
  actor: string | null;
  createdAt: string;
};

/** Everything the Overview renders, from one server round of queries. */
export type OverviewData = {
  /** Applications belonging to this company, all stages. */
  totalApplicants: number;
  /** Applications created in the last 7 days. */
  newThisWeek: number;
  /**
   * Applications that arrived with at least one screening answer. Drives the
   * hero claim, which must not overstate what actually ran.
   */
  screenedCount: number;
  funnel: FunnelStep[];

  publishedJobs: number;
  draftJobs: number;
  /** The single draft's id, when exactly one exists — lets the card deep-link. */
  soleDraftId: string | null;
  soleDraftTitle: string | null;

  /** Applications still sitting in the 'applied' stage. */
  awaitingReview: number;
  /** Invites sent but not yet accepted. */
  /**
   * Pending team invites, or the fact that we could not count them.
   *
   * A Read rather than a number because the card it feeds is gated on `> 0`:
   * a failed count of 0 and a real 0 both hid the card, so nobody learned an
   * invite was sitting unaccepted until it expired.
   */
  pendingInvites: Read<number>;

  liveRoles: LiveRole[];
  recentApplicants: RecentApplicant[];
  /**
   * The merged feed, or the fact that we could not read its history.
   *
   * "Nothing has happened yet" is a claim about their workspace; an empty array
   * on a failed read made the feed say it on no evidence.
   */
  activity: Read<ActivityItem[]>;
};
