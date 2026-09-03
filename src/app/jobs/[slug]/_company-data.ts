import "server-only";
import { type BrandPreset, toPreset } from "@/components/white-label/brand";
import { initialsOf } from "@/components/white-label/company";
import { publiclyVisible } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";

/** Public-read bucket, so a plain public URL is correct and no signing runs. */
const COMPANY_LOGO_BUCKET = "company-logos";

/**
 * The owning company, as the white-label job page needs it.
 *
 * `otherRoles` counts the company's OTHER publicly visible jobs — this one
 * excluded — because every consumer of it phrases things that way: "See all N
 * roles" versus "Visit careers page", and "See all N open roles at X" versus
 * "This is the only role open right now".
 */
export type JobCompany = {
  name: string;
  /** The company's colour, already narrowed — null and unknown both mean Plum. */
  preset: BrandPreset;
  /** Null when the company has no slug, which is what gates the careers links. */
  slug: string | null;
  website: string | null;
  description: string | null;
  teamSize: string | null;
  location: string | null;
  logoUrl: string | null;
  initials: string;
  otherRoles: number;
};

type CompanyRow = {
  name: string;
  slug: string | null;
  website: string | null;
  description: string | null;
  team_size: string | null;
  location: string | null;
  logo_path: string | null;
  brand_preset: string | null;
  status: string;
};

/**
 * Resolve the company behind a company-owned job, or null.
 *
 * Null means "render the Remotiv page instead", and it covers a company that is
 * paused or archived as well as one that has gone missing: a customer whose
 * account is not active should not get white-label chrome on a job that is
 * still, for whatever reason, publicly visible.
 *
 * Never throws. This runs on a public page whose primary content is the job,
 * and a companies-table blip must not take the job posting down with it — the
 * caller falls back to the Remotiv rendering, which needs nothing from here.
 */
export async function getJobCompany(companyId: string, jobId: string): Promise<JobCompany | null> {
  try {
    const service = createServiceClient();

    const { data: row, error } = await service
      .from("companies")
      .select(
        "name, slug, website, description, team_size, location, logo_path, brand_preset, status",
      )
      .eq("id", companyId)
      .maybeSingle();

    if (error) {
      console.error("[job] company lookup failed:", error.message);
      return null;
    }

    const company = row as CompanyRow | null;
    if (company?.status !== "active") return null;

    // HEAD count — no rows cross the wire for a number the page renders twice.
    const { count } = await publiclyVisible(
      service
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .neq("id", jobId),
    );

    const logoPath = (company.logo_path ?? "").trim();
    const name = company.name.trim();

    return {
      name,
      slug: (company.slug ?? "").trim() || null,
      website: (company.website ?? "").trim() || null,
      description: (company.description ?? "").trim() || null,
      // Trimmed to null so a row holding "" is indistinguishable from one never
      // filled — both must drop the fact, not render a blank one.
      teamSize: (company.team_size ?? "").trim() || null,
      location: (company.location ?? "").trim() || null,
      logoUrl: logoPath
        ? (service.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(logoPath).data.publicUrl ?? null)
        : null,
      initials: initialsOf(name),
      preset: toPreset(company.brand_preset),
      otherRoles: count ?? 0,
    };
  } catch (err) {
    console.error("[job] company lookup threw:", err);
    return null;
  }
}
