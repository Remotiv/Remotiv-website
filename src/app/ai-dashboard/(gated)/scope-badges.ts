import type { JobScope } from "@/app/ai-dashboard/lib/job-scope";
import type { Read } from "@/lib/supabase/read";

/** One sidebar badge's count read, as supabase-js reports a HEAD count. */
export type BadgeRead = { count: number | null; error: unknown };

/**
 * The four sidebar badges (Jobs, Applicants, Messages, Interviews), decided by
 * the viewer's job scope where it can, and counted by `count` where it cannot.
 *
 * A failed scope read is NOT an empty scope (#24). Answering it with four
 * zeros put a confident 0 beside every page for a member whose assignments
 * simply could not be read, which is the exact "failed count shown as zero"
 * the layout's badgeCount exists to prevent. So a failed read reports four
 * failures, and badgeCount renders no badge. A genuine empty scope still
 * answers four real zeros.
 *
 * The scope reaches the layout only as the argument to `count`, and `count`
 * runs only on a successful, non-empty read. A failed read therefore leaves
 * no scope value in the layout for later code to pick up by mistake.
 *
 * A plain module rather than a function in layout.tsx: a Next layout may
 * export only its own reserved names, and this decision needs a test.
 */
export async function scopeBadges(
  scopeRead: Read<JobScope>,
  count: (scope: JobScope) => Promise<BadgeRead[]>,
): Promise<BadgeRead[]> {
  if (!scopeRead.ok) {
    const unread: BadgeRead = { count: null, error: "job scope unavailable" };
    return [unread, unread, unread, unread];
  }
  const scope = scopeRead.value;
  if (scope.scoped && scope.jobIds.length === 0) {
    const none: BadgeRead = { count: 0, error: null };
    return [none, none, none, none];
  }
  return count(scope);
}

/**
 * A badge number the sidebar can stand behind, or nothing at all.
 *
 * `count ?? 0` turned a query that FAILED into a confident zero. A recruiter
 * reads "0" beside Applicants, believes it, and stops looking — while the page
 * itself would have listed eighty-seven. A wrong answer presented as a right
 * one is worse than no answer, and the sidebar already knows how to show no
 * answer: an undefined count renders no badge.
 *
 * A real zero survives. The noJobs short-circuit passes `error: null`, and a
 * genuinely empty workspace still counts nothing and still shows 0 — which is
 * the entire point, since those two cases used to be indistinguishable.
 */
export function badgeCount(result: BadgeRead): number | undefined {
  return result.error ? undefined : (result.count ?? 0);
}
