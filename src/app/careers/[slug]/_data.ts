import "server-only";
import { type BrandPreset, toPreset } from "@/components/white-label/brand";
import { LIST_SELECT, publiclyVisible } from "@/lib/jobs";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Everything the careers page renders, resolved server-side.
 *
 * Nothing here is hardcoded: every field traces to the company's own row or to
 * its published jobs. The sample company and the six sample roles in the
 * reference HTML are demo fixtures and are gone.
 */

/** Public-read bucket, so a plain public URL is correct and no signing runs. */
const COMPANY_LOGO_BUCKET = "company-logos";

/**
 * How recently a role must have been published to wear the "New" badge.
 *
 * The design shows the badge and the reference marks it by hand on two sample
 * roles, so the rule had to be chosen rather than copied. Seven days matches
 * the "N live positions" framing — a badge that lingers for a month stops
 * meaning anything, and one that lasts a day is missed by most visitors.
 * Named here so it is one decision in one place rather than an inline literal.
 */
const NEW_ROLE_DAYS = 7;

export type CareersCompany = {
  id: string;
  /** The company's colour, already narrowed — null and unknown both mean Plum. */
  preset: BrandPreset;
  slug: string;
  name: string;
  /** First word, for the closer and the header link. */
  short: string;
  website: string | null;
  description: string | null;
  logoUrl: string | null;
  /** First letters of up to two words — the lettermark when there is no logo. */
  initials: string;
  /**
   * The two rail facts that came from Settings.
   *
   * Free text on purpose: "40–60 people" and "Dubai · Remote" are the shapes the
   * design shows, and neither is a number or an enum. Null when unset, and the
   * page omits the cell rather than printing an em-dash — a rail that says
   * "Team size —" tells a candidate less than one that doesn't raise the
   * subject.
   */
  teamSize: string | null;
  location: string | null;
};

/**
 * The public projection of a role.
 *
 * Deliberately narrow, and deliberately not `Job`: this crosses into a client
 * component for the category filter, and anything passed as a client prop is
 * serialized into the RSC payload and readable in devtools. Screening
 * questions, ownership columns and the numeric mode must never travel.
 */
export type CareersRole = {
  id: string;
  href: string;
  title: string;
  category: string;
  /** Work type · contract type · experience level, in the design's order. */
  meta: string[];
  /** Formatted pay, e.g. "USD 60k–90k" or "Competitive". */
  pay: string;
  /** The small line under the pay. Monthly, matching the rest of the product. */
  payUnit: string;
  /**
   * Computed on the SERVER from created_at.
   *
   * Never in the browser: a relative-date comparison rendered on both sides of
   * hydration is a mismatch by construction, and a mismatch on this page would
   * discard the tree and orphan the server DOM. A boolean crosses the boundary
   * instead of a timestamp.
   */
  isNew: boolean;
};

export type CareersData = {
  company: CareersCompany;
  roles: CareersRole[];
  /**
   * The roles could not be READ. Distinct from "this company has no openings",
   * which is what an empty `roles` array otherwise means.
   */
  rolesUnavailable: boolean;
  /** Distinct categories, in first-appearance order — drives the filter tabs. */
  categories: string[];
};

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  return (letters || name[0] || "?").toUpperCase();
}

/**
 * Pay, formatted for the index row.
 *
 * The unit says "per month", not the reference's "per year": salaries in this
 * product are monthly everywhere else it shows one, and copying the sample's
 * label would misstate the number beside it.
 */
function formatPay(
  min: number | null,
  max: number | null,
  currency: string | null,
): { pay: string; payUnit: string } {
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const k = (n: number) => {
    if (n >= 1000) {
      const v = n / 1000;
      return `${Number.isInteger(v) ? v : v.toFixed(1)}k`;
    }
    return n.toLocaleString("en-US");
  };
  if (min != null && max != null) {
    return {
      pay: min === max ? `${cur} ${k(min)}` : `${cur} ${k(min)}–${k(max)}`,
      payUnit: "per month",
    };
  }
  if (min != null) return { pay: `${cur} from ${k(min)}`, payUnit: "per month" };
  if (max != null) return { pay: `${cur} up to ${k(max)}`, payUnit: "per month" };
  // No figure to qualify, so no unit line — "COMPETITIVE / per month" reads as
  // a number that failed to load.
  return { pay: "Competitive", payUnit: "" };
}

type CompanyRow = {
  id: string;
  slug: string | null;
  name: string;
  website: string | null;
  description: string | null;
  logo_path: string | null;
  team_size: string | null;
  location: string | null;
  brand_preset: string | null;
  status: string;
};

type JobRow = {
  id: string;
  title: string;
  slug: string | null;
  category: string | null;
  work_type: string | null;
  contract_type: string | null;
  experience_level: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  created_at: string;
};

/**
 * Resolve a careers page from its company slug, or null.
 *
 * Null covers three cases the caller treats identically as a 404: no such slug,
 * a company that is not active, and a slug that resolves to a row with no
 * usable identity. A paused or archived company must not keep a public hiring
 * page live.
 */
/**
 * The careers page's content, or the fact that we could not look.
 *
 * `Read<CareersData | null>`: the company lookup below used to answer a failed
 * query and a deleted company identically, and the page turned both into a 404.
 * A live careers page told visitors it did not exist.
 */
export async function getCareersData(slug: string): Promise<Read<CareersData | null>> {
  const service = createServiceClient();

  const { data: companyRow, error: companyError } = await service
    .from("companies")
    .select(
      "id, slug, name, website, description, logo_path, team_size, location, brand_preset, status",
    )
    .eq("slug", slug)
    .maybeSingle();

  // A failed lookup is not the same fact as "no such company", and the page now
  // has a way to say each. This is the one that could not be ASKED.
  if (companyError) {
    console.error("[careers] company lookup failed:", companyError.message);
    return unavailable();
  }

  // Asked and answered: no such company, or one that is no longer active.
  const company = companyRow as CompanyRow | null;
  if (!company?.slug || company.status !== "active") return answered(null);

  const { data: jobRows, error: jobsError } = await publiclyVisible(
    service.from("jobs").select(LIST_SELECT).eq("company_id", company.id),
  )
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);

  /*
   * A company with a masthead and no index is still a truthful page — this is
   * NOT a 500. But the empty state it used to render said "{company} isn't
   * hiring at the moment", which is a claim about the company made to a
   * candidate on evidence we do not have. The flag lets the page say the true
   * thing instead.
   */
  if (jobsError) console.error("[careers] jobs lookup failed:", jobsError.message);
  const rolesUnavailable = Boolean(jobsError);

  const logoPath = (company.logo_path ?? "").trim();
  const logoUrl = logoPath
    ? (service.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(logoPath).data.publicUrl ?? null)
    : null;

  const newerThan = Date.now() - NEW_ROLE_DAYS * 24 * 60 * 60 * 1000;

  const roles: CareersRole[] = ((jobRows ?? []) as unknown as JobRow[])
    // A role with no slug has no detail page to link to, and a row that
    // navigates nowhere is worse than one that is absent.
    .filter((j) => Boolean(j.slug))
    .map((j) => {
      const { pay, payUnit } = formatPay(j.salary_min, j.salary_max, j.salary_currency);
      const created = new Date(j.created_at).getTime();
      return {
        id: j.id,
        href: `/jobs/${j.slug}`,
        title: j.title,
        category: (j.category ?? "").trim() || "Other",
        meta: [j.work_type, j.contract_type, j.experience_level]
          .map((m) => (m ?? "").trim())
          .filter(Boolean),
        pay,
        payUnit,
        isNew: !Number.isNaN(created) && created >= newerThan,
      };
    });

  const categories: string[] = [];
  for (const r of roles) if (!categories.includes(r.category)) categories.push(r.category);

  const trimmedName = company.name.trim();
  const website = (company.website ?? "").trim() || null;
  const description = (company.description ?? "").trim() || null;
  // Trimmed to null so a row holding "" or "   " is indistinguishable from one
  // that was never filled — both must omit the cell, not render a blank one.
  const teamSize = (company.team_size ?? "").trim() || null;
  const location = (company.location ?? "").trim() || null;

  return answered({
    company: {
      id: company.id,
      slug: company.slug,
      name: trimmedName,
      short: trimmedName.split(/\s+/)[0] || trimmedName,
      website,
      description,
      logoUrl,
      initials: initialsOf(trimmedName),
      teamSize,
      location,
      preset: toPreset(company.brand_preset),
    },
    roles,
    categories,
    rolesUnavailable,
  });
}

/** The bare host, for display — the design shows "acme.com", not the scheme. */
export function displayHost(website: string): string {
  return website.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** An href that works whether or not Settings stored the scheme. */
export function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}
