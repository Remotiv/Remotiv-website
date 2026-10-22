import "server-only";

/**
 * Remotiv staff access to customers' AI Video Interviews (F4: /admin/interviews)
 * is OFF unless deliberately turned on (decision, 22 Oct 2026): customer
 * interview data is not visible to Remotiv staff by default.
 *
 * On only when ADMIN_LIVE_REVIEW_ENABLED is exactly "1". Missing, empty,
 * "true", "0", " 1" and anything else are off. Read on the server, at call
 * time, never baked into the client bundle: the nav gets a plain boolean from
 * the admin layout, and the pages and actions check this before anything else.
 */
export function adminLiveReviewEnabled(): boolean {
  return process.env.ADMIN_LIVE_REVIEW_ENABLED === "1";
}
