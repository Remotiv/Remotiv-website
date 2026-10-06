import "server-only";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { readCompanyUsage } from "@/lib/company-usage";
import {
  type ApplicantsUsage,
  type OverviewUsage,
  quotaWarnings,
  type SettingsUsage,
  usageSurfacesFor,
} from "@/lib/company-usage-types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The plan and usage each dashboard surface may show the signed-in viewer.
 *
 * ── Scoped to the session, and only the session ──────────────
 *
 * None of these takes an argument. The company is the one getCompanyContext
 * resolved from the viewer's own active membership, so there is no company id
 * a browser could supply, and no way to ask for another company's plan.
 *
 * Not a "use server" module on purpose: nothing here is a server action, so
 * nothing here can be called from the browser at all. The three pages call
 * these while rendering.
 *
 * ── Roles, decided here ──────────────────────────────────────
 *
 * usageSurfacesFor(role) is checked BEFORE any read. A viewer who may not see
 * a surface gets null, with no query made, rather than data a component then
 * hides. The quoted price is only selected for a billing role, so for everyone
 * else it is absent from the payload, not blanked in React.
 */

export async function loadSettingsUsage(): Promise<SettingsUsage> {
  const ctx = await getCompanyContext();
  const may = usageSurfacesFor(ctx.role);
  if (!may.settingsCard) return null;

  const read = await readCompanyUsage(createServiceClient(), ctx.companyId, {
    includePrice: may.price,
  });
  if (!read.ok) return { kind: "error" };
  if (read.internal) return null;

  const metrics = [read.cv, read.interviews];
  return {
    kind: "card",
    planName: read.plan?.planName ?? null,
    ...(may.price ? { price: read.plan?.price ?? null } : {}),
    metrics,
    resetDate: read.resetDate,
    warnings: quotaWarnings(metrics, read.resetDate),
  };
}

export async function loadOverviewUsage(): Promise<OverviewUsage> {
  const ctx = await getCompanyContext();
  const may = usageSurfacesFor(ctx.role);
  if (!may.overviewMeter) return null;

  const read = await readCompanyUsage(createServiceClient(), ctx.companyId, {
    includePrice: false,
  });
  if (!read.ok) return { kind: "error" };
  if (read.internal) return null;

  return { kind: "meter", metrics: [read.cv, read.interviews], linksToCard: may.settingsCard };
}

/**
 * Owner, admin and recruiter: the roles that spend credits on this page.
 *
 * Silent on a failed read: the banner is a warning, and someone working
 * through applicants is not helped by a notice that a warning could not be
 * checked. The Overview meter, which every such viewer also has, says so.
 */
export async function loadApplicantsUsage(): Promise<ApplicantsUsage> {
  const ctx = await getCompanyContext();
  const may = usageSurfacesFor(ctx.role);
  if (!may.applicantsBanner) return null;

  const read = await readCompanyUsage(createServiceClient(), ctx.companyId, {
    includePrice: false,
  });
  if (!read.ok || read.internal) return null;

  const warnings = quotaWarnings([read.cv, read.interviews], read.resetDate);
  return warnings.length > 0 ? { kind: "banner", warnings } : null;
}
