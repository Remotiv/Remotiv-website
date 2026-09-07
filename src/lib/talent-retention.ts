import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Talent-pool retention: the shared constants, the token, and the copy.
 *
 * ══ NOT IN EFFECT — READ THIS FIRST ══════════════════════════
 *
 * Nothing here runs. Remotiv keeps talent-pool profiles and their CVs until the
 * person asks us to delete them; there is no automatic expiry and no warning
 * email going out. The two jobs that would enforce the rule below are written,
 * registered and deliberately absent from the recurring schedule — the note in
 * jobs-queue.ts's RECURRING list is the authoritative one, and that list is the
 * only thing that can enqueue them.
 *
 * This file is kept intact so that turning it on is a two-line change rather
 * than a rebuild. Everything below describes what WOULD happen, and what the
 * design has to preserve if it ever does. src/app/privacy/page.tsx is part of
 * that change: it currently tells people there is no automatic expiry.
 *
 * ── The rule, and where it comes from ────────────────────────
 *
 * A talent profile is kept for 24 months from the person's LAST ACTIVITY, not
 * from when it was created. The basis is consent, so the clock is theirs to
 * restart and ours only to observe.
 *
 * ACTIVITY IS DELIBERATELY NARROW:
 *
 *   · signing in to the talent dashboard
 *   · updating anything on the profile
 *   · clicking "keep my profile" in the warning email below
 *
 * Being matched to a role, appearing in a search, or being viewed by an
 * employer is NOT activity. If our own use of a profile extended the period we
 * may hold it, we would be self-authorising the retention — the consent would
 * renew itself without the person ever doing anything. That is the whole reason
 * this list is short, and it is the one part of this file not to "improve".
 *
 * ── Scope ────────────────────────────────────────────────────
 *
 * `talent_profiles` ONLY. A CLIENT COMPANY's applicant has a CV that does still
 * expire, 24 months from APPLY on a stored `cv_delete_after` (see
 * lib/cv-purge.ts, which runs) — a fixed clock rather than a rolling one,
 * because an applicant has no account and so has no observable activity to roll
 * the window forward. Different table, different basis, different owner:
 * that CV is held on the company's behalf, not kept as Remotiv's. Nothing here
 * may touch job_applications.
 *
 * The two rows can name the same storage object, and neither purge deletes a
 * file the other still points at — see lib/shared-storage-refs.ts.
 */

/** Months of inactivity before a profile is deleted. */
export const RETENTION_MONTHS = 24;

/** How long before expiry the warning goes out. */
export const WARN_BEFORE_DAYS = 30;

/**
 * A warned profile is not purgeable until the warning has had time to land and
 * be acted on. Slightly under WARN_BEFORE_DAYS so a warning sent a day late
 * still gets its full month, and comfortably over any plausible mail delay.
 */
export const MIN_DAYS_SINCE_WARNING = 25;

/**
 * Refuse rather than proceed above this many profiles in one purge run.
 *
 * ── Why this exists at all ───────────────────────────────────
 *
 * cv-purge.ts draws its safety from the expiry date being STORED: "nothing in
 * this file knows what 24 months is, so no edit to a constant can widen what
 * gets deleted." This job cannot have that property — the cutoff is rolling, so
 * it must be computed, and a wrong constant here would silently select a much
 * larger set.
 *
 * So the ceiling replaces it. A mis-set RETENTION_MONTHS shows up as a run that
 * REFUSES and shouts, not as a mass deletion discovered afterwards. The number
 * is far above any believable day's worth of expiries and far below a mistake.
 */
export const PURGE_CEILING = 200;

/** Milliseconds in a day, for the several places that need it. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant a profile last active at `lastActiveAt` expires. */
export function expiryFor(lastActiveAt: Date): Date {
  const d = new Date(lastActiveAt);
  d.setMonth(d.getMonth() + RETENTION_MONTHS);
  return d;
}

/** Profiles last active at or before this are due a warning. */
export function warnCutoff(now: Date = new Date()): Date {
  const d = new Date(now.getTime() + WARN_BEFORE_DAYS * DAY_MS);
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d;
}

/** Profiles last active at or before this have expired. */
export function purgeCutoff(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d;
}

/** A warning older than this has had its month; the profile may be purged. */
export function warnedBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - MIN_DAYS_SINCE_WARNING * DAY_MS);
}

/**
 * The one-click keep token.
 *
 * Same construction as lib/interviews/tokens.ts, deliberately — one pattern in
 * the codebase rather than two. 32 random bytes, only the SHA-256 hash
 * persisted (in `retention_keep_token_hash`), the raw value existing solely
 * inside the emailed URL. SHA-256 rather than bcrypt for the same reason: the
 * token already carries 256 bits of entropy, so there is no weak secret to slow
 * an attacker on.
 *
 * It does NOT follow talent_claim_tokens, which stores its token raw in a
 * column named token_hash — a leaked backup of that table hands out working
 * links, and this link mutates a retention date.
 */
export function mintKeepToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashKeepToken(rawToken) };
}

export function hashKeepToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** The URL in the email. Raw token, never the hash. */
export function keepProfileUrl(rawToken: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv.work";
  return `${base}/talent/keep/${rawToken}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The warning email.
 *
 * ── What this copy has to do ─────────────────────────────────
 *
 * Make KEEPING the profile the easy action. Deleting at 24 months without
 * warning would be worse than the indefinite retention it replaces, and a
 * warning that requires signing in to act on inverts the same thing — it makes
 * deletion the path of least resistance. So the button is one click, no login,
 * no form.
 *
 * Three deliberate choices:
 *   · The exact date appears TWICE. "Soon" is not a date a person can act on.
 *   · "Do nothing" is named as a real option rather than left implicit. Someone
 *     who wants out should not have to work out how.
 *   · It says the CV goes too. "Profile" alone understates what is deleted.
 */
export function buildRetentionWarningEmail(input: {
  firstName: string | null;
  joinedAt: Date;
  expiresAt: Date;
  keepUrl: string;
}): { subject: string; html: string } {
  const name = (input.firstName ?? "").trim();
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const expiry = escapeHtml(formatDate(input.expiresAt));
  const joined = escapeHtml(formatDate(input.joinedAt));
  const url = escapeHtml(input.keepUrl);

  return {
    subject: `Your Remotiv profile expires in ${WARN_BEFORE_DAYS} days`,
    html: `
<p>${greeting}</p>
<p>You joined Remotiv's talent pool on <strong>${joined}</strong>. We keep a profile
for ${RETENTION_MONTHS} months from your last activity, and yours reaches that point on
<strong>${expiry}</strong>.</p>
<p><a href="${url}" style="display:inline-block;background:#7E47FF;color:#fff;font-weight:700;padding:13px 22px;border-radius:13px;text-decoration:none">Keep my profile active</a></p>
<p>That is all it takes — one click, nothing to fill in, and we will keep it for another
${RETENTION_MONTHS} months. Signing in or updating anything on your profile does the same.</p>
<p>If you would rather we did not, do nothing. On ${expiry} we will delete your profile,
your CV and everything in it, and you will hear nothing further from us.</p>
<p>Questions, or want it gone sooner: <a href="mailto:talent@remotiv.work">talent@remotiv.work</a></p>
`.trim(),
  };
}

/** Local copy — lib/email/candidate/render.ts is for the company pipeline. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
