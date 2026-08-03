import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Company identity operations shared by Remotiv admin and the company product's
 * own Settings page.
 *
 * Both surfaces rename a company and both change an owner's login email, and
 * both must behave identically — a rename from /admin and a rename from
 * /ai-dashboard/settings cannot leave the public job list in different states.
 * These lived inline in src/app/admin/companies/actions.ts; they are extracted
 * here rather than copied so there is one implementation to fix when the next
 * edge case turns up.
 *
 * Deliberately NOT in the admin tree: the company product must not import from
 * src/app/admin (product separation), and the dependency direction has to point
 * at the shared layer rather than into one of the consumers.
 */

/**
 * Look up an auth user by exact email, without paginating the whole project.
 *
 * `auth.admin.listUsers` walks every user and truncates, which made it useless
 * as a collision check on a growing project. GoTrue's admin REST endpoint
 * filters server-side, so this is bounded regardless of user count.
 *
 * The exact-equality re-check is deliberate belt and braces: `filter` is a
 * partial match, so without it "wal@x.com" could match "waleed@x.com" and
 * report a collision that does not exist. Returns null on any failure — the
 * caller treats "unknown" as "no collision found" and lets GoTrue itself be the
 * final authority when the update runs.
 */
export async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  const target = email.trim().toLowerCase();
  try {
    const res = await fetch(
      `${base}/auth/v1/admin/users?filter=${encodeURIComponent(target)}&page=1&per_page=10`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      users?: Array<{ id?: string; email?: string }>;
    };
    const hit = (body.users ?? []).find(
      (u) => (u.email ?? "").toLowerCase() === target,
    );
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Translate a GoTrue email-update failure into something a user can act on,
 * and leave a forensic trail that does not store the address itself.
 *
 * Only the DOMAIN is logged: logs are retained and broadly readable, and the
 * full address is PII. The domain is enough to tell a typo'd domain from a
 * genuine collision.
 */
export function describeAuthEmailFailure(
  scope: string,
  ctx: { companyId?: string; userId: string; email: string },
  authErr: { status?: number; code?: string; message?: string },
): string {
  console.error(`[${scope}] auth email update failed`, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    emailDomain: ctx.email.split("@")[1] ?? "(none)",
    status: authErr.status,
    code: authErr.code,
    message: authErr.message,
  });

  const msg = authErr.message ?? "Failed to update the login email.";
  if (/already|exists|registered/i.test(msg)) {
    return "This email is already registered to another account.";
  }
  // A 5xx from GoTrue is not the caller's fault and its raw text is not useful
  // to them.
  if (typeof authErr.status === "number" && authErr.status >= 500) {
    return "The authentication service is unavailable. Please try again.";
  }
  return msg;
}

/**
 * Keep jobs.company in step with a company rename.
 *
 * jobs.company is free text stamped at creation, so without this a rename
 * leaves every existing job advertising the OLD name on remotiv.work/jobs.
 *
 * Resolved by keeping the denormalised value in step rather than joining at
 * read time, because jobs.company is read on the public jobs list — the
 * hottest page on the site — whose LIST_SELECT deliberately avoids joins for
 * payload size. A job's name at posting time IS history, but this column is
 * not a historical record: it is the label on a LIVE listing, and a candidate
 * reading a defunct name is simply being told something false.
 *
 * Best-effort by contract. The rename itself has already committed by the time
 * this runs, so a failure here must be logged, never surfaced as a failed save.
 * Returns whether the sync landed so the caller can decide about revalidation.
 */
export async function syncJobsCompanyName(
  supabase: ReturnType<typeof createServiceClient>,
  companyId: string,
  name: string,
  scope: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("jobs")
    .update({ company: name })
    .eq("company_id", companyId);

  if (error) {
    console.error(`[${scope}] job company-name sync failed (non-fatal)`, {
      companyId,
      error: error.message,
    });
    return false;
  }
  return true;
}
