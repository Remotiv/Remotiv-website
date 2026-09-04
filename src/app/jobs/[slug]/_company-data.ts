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
  is_internal: boolean | null;
  status: string;
};

/**
 * Resolve the company behind a company-owned job, or null.
 *
 * Null means "render the Remotiv page instead". It covers four cases, and they
 * are deliberately one answer because the caller does the same thing for all of
 * them: a company that has gone missing, one that is paused or archived, a
 * lookup that failed — and an INTERNAL company.
 *
 * ── Why internal belongs in that list ────────────────────────
 *
 * White-label is for CLIENTS. Remotiv is a `companies` row like any other, so
 * a role it posts through the AI dashboard used to satisfy "has a company" and
 * render as though Remotiv were its own customer — while the same role posted
 * through admin (no company_id) rendered editorial. Two of Remotiv's own jobs,
 * side by side, looking like different employers. Which internal tool posted a
 * job is not a fact about who is hiring, and it should not decide the design.
 *
 * `is_internal` is the flag that already answers this question elsewhere —
 * lib/admin-scope.ts uses it so Remotiv's own applications are visible to the
 * team that owns them. Same predicate, same meaning, second reader.
 *
 * NOTE the failure direction. Every path here returns null, so a companies-table
 * blip renders a CLIENT's job with Remotiv chrome rather than the reverse. That
 * is the safe way round — a missing brand for one request, never a client's
 * page dressed as somebody else's.
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
        "name, slug, website, description, team_size, location, logo_path, brand_preset, is_internal, status",
      )
      .eq("id", companyId)
      .maybeSingle();

    if (error) {
      console.error("[job] company lookup failed:", error.message);
      return null;
    }

    const company = row as CompanyRow | null;
    if (company?.status !== "active") return null;
    // Remotiv's own account. Editorial, not white-label — see the note above.
    if (company.is_internal === true) return null;

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

/**
 * Is this company Remotiv's own account?
 *
 * A second, tiny read rather than a wider return type from getJobCompany.
 * That function answers one question — "which client owns this job, if any" —
 * and every one of its null paths means the same thing to its caller. Making it
 * report WHY it said null would push a four-case union through a call site that
 * branches on two, to serve a star rating.
 *
 * Only reached when getJobCompany already returned null for a job that HAS a
 * company_id, which is: paused, archived, missing, unreadable, or internal.
 * Rare by construction, and Remotiv's own roles are the common case among them.
 *
 * Fails CLOSED. An unreadable row returns false, so the rating is withheld
 * rather than invented — the same direction as every other guard in this file,
 * and the one that cannot show a client a number about Remotiv.
 */
export async function isInternalCompany(companyId: string): Promise<boolean> {
  try {
    const { data, error } = await createServiceClient()
      .from("companies")
      .select("is_internal")
      .eq("id", companyId)
      .maybeSingle();

    if (error) {
      console.error("[job] internal-company check failed:", error.message);
      return false;
    }
    return (data as { is_internal: boolean | null } | null)?.is_internal === true;
  } catch (err) {
    console.error("[job] internal-company check threw:", err);
    return false;
  }
}
