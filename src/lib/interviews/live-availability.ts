import "server-only";

/**
 * Which companies may send AI Video Interviews at all.
 *
 * ── Why this exists while the send path does ─────────────────
 *
 * The live invite path is built, but the candidate route has no live screen:
 * a live link resolves to "This interview isn't open yet". Sending one to a
 * real candidate would email them a dead end. Exposing the send is a launch
 * decision, and until it is taken this list is empty in production.
 *
 * ── Company ids, not a boolean and not a super-admin check ───
 *
 * .env.local points at the PRODUCTION database. A boolean flipped on locally
 * would let any company's recruiter send real invites to real candidates. A
 * super-admin check guards the wrong thing: the harm is an email reaching a
 * candidate, which depends on whose applicants they are, not on who clicks.
 * An allowlist confines sending to a company Remotiv owns and tests with.
 *
 * ── Read at call time, and not NEXT_PUBLIC_ ──────────────────
 *
 * Same reasoning as SUPER_ADMIN_EMAIL in app/admin/lib/roles.ts: no public
 * prefix, so the value can never be inlined into a browser bundle, and no
 * module-level read, so it is not frozen at import. The client never decides
 * this; it is told by the server whether to render the section.
 *
 * Called FIRST inside gateLiveInterviewInvite, so no send can pass the gate
 * without passing this — one lock, not two to keep in step.
 */
export function liveInterviewsAvailableFor(companyId: string): boolean {
  if (!companyId) return false;
  const allowed = (process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.includes(companyId);
}
