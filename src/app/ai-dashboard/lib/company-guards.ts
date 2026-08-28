import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { CompanyContext, CompanyRole, CompanyRow } from "./company-roles";

const COMPANY_COLUMNS =
  "id, name, slug, contact_name, contact_email, website, logo_path, industry, description, status, user_id, must_change_password, created_at";

/**
 * A lookup that could not be ASKED, as distinct from one answered "no".
 *
 * Every caller that evicts on refusal — signs the user out, or bounces them to
 * login as the wrong kind of account — has to be able to tell the two apart.
 * resolveMembership throws rather than returning null for exactly this reason;
 * without a distinguishable type, each caller's `catch` collapses the
 * distinction again on the way back out.
 */
export class CompanyLookupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompanyLookupError";
  }
}

/** What resolving a user to a tenant produced, and which path produced it. */
export type ResolvedMembership = {
  companyId: string | null;
  role: CompanyRole;
  memberName: string | null;
  memberId: string | null;
  /** "member" | "owner_fallback" | "none" — for callers that need to explain. */
  source: "member" | "owner_fallback" | "none";
};

/**
 * Resolve a user to ONE company. The single copy of this rule.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * Four places resolved a user to a company — getCompanyContext, the login gate,
 * the password-reset redirect and the must_change_password write — each with
 * its own transcription of the same order, and all four carried the same bug:
 *
 *     .eq("user_id", user.id).eq("status", "active").maybeSingle()
 *
 * with the error discarded. `maybeSingle()` over two rows does not pick one; it
 * returns `data: null` with PGRST116 and HTTP 406 (verified against the live
 * database). Since only `data` was read, a member of TWO companies was
 * indistinguishable from a member of NONE — and that is reachable today, by
 * design: the invite guard blocks only an existing member of THIS company
 * ("cross-product emails are fine"), and company_members is unique on
 * (company_id, user_id), so a second row for a second company is legal.
 *
 * The consequence was silent: the user fell through to the companies.user_id
 * fallback and either landed in whichever company they happened to own, as
 * "owner", or was told they were not a company account at all.
 *
 * ── Which company wins ───────────────────────────────────────
 *
 * The OLDEST active membership, by created_at, with the row id as a tie-break
 * so the answer is total rather than merely usually-unique.
 *
 * Oldest is chosen because it is defensible, not merely stable: it is the
 * workspace they have been using, and it means accepting a new invite can never
 * silently relocate someone who is mid-conversation with a candidate. Ordering
 * by anything the database finds convenient would be just as deterministic and
 * would answer no question at all.
 *
 * This is a stopgap with a known shape, not a resolution: the second company
 * remains unreachable until there is a way to switch. That is deliberate and
 * out of scope here.
 */
export async function resolveMembership(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<ResolvedMembership> {
  const { data: memberRows, error: memberError } = await service
    .from("company_members")
    .select("id, company_id, role, name")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  // Surfaced, never swallowed. A failed lookup is not the same fact as "no
  // membership", and treating it as one is what hid the original bug.
  if (memberError) {
    throw new CompanyLookupError(
      `Could not resolve company membership: ${memberError.message}`,
      { cause: memberError },
    );
  }

  const member = (memberRows ?? [])[0] as
    | { id: string; company_id: string; role: CompanyRole; name: string | null }
    | undefined;

  if (member) {
    return {
      companyId: member.company_id,
      role: member.role,
      memberName: member.name,
      memberId: member.id,
      source: "member",
    };
  }

  // Fallback: a company whose member row was lost or predates provisioning.
  // Ordered for the same reason — companies.user_id has no unique index, so one
  // auth user owning two companies is legal here too.
  const { data: ownedRows, error: ownedError } = await service
    .from("companies")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  if (ownedError) {
    throw new CompanyLookupError(
      `Could not resolve company ownership: ${ownedError.message}`,
      { cause: ownedError },
    );
  }

  const owned = (ownedRows ?? [])[0] as { id: string } | undefined;
  if (owned) {
    return {
      companyId: owned.id,
      role: "owner",
      memberName: null,
      memberId: null,
      source: "owner_fallback",
    };
  }

  return { companyId: null, role: "owner", memberName: null, memberId: null, source: "none" };
}

/**
 * Resolve the logged-in user to their company + role for /ai-dashboard.
 *
 * Resolution order lives in resolveMembership, which all four resolvers share:
 * oldest active membership, then the companies.user_id fallback, then nothing.
 *
 * Throws on: no session, no company, or a non-active company. Deliberately
 * separate from the /client portal's getClientContext — the two products never
 * share tenant resolution.
 */
export async function getCompanyContext(): Promise<CompanyContext> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const service = createServiceClient();

  const { companyId, role, memberName, memberId } = await resolveMembership(service, user.id);

  // Neither path resolved a company. resolveMembership throws on a failed
  // lookup, so reaching here genuinely means there is no membership rather than
  // meaning the question could not be asked.
  if (!companyId) throw new Error("Not a company account");

  // Surfaced for the same reason as the membership lookup. This select asks for
  // thirteen columns where the login gate asks only for `status`, so it can fail
  // where the gate succeeds — a renamed column here used to arrive as "Not a
  // company account", bouncing the user to a login page that would send them
  // straight back.
  const { data: companyRow, error: companyError } = await service
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) {
    throw new CompanyLookupError(`Could not load company: ${companyError.message}`, {
      cause: companyError,
    });
  }
  const row = companyRow as CompanyRow | null;
  if (!row) throw new Error("Not a company account");
  if (row.status !== "active") throw new Error(`Company status: ${row.status}`);

  const company: CompanyRow = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    website: row.website,
    logo_path: row.logo_path,
    industry: row.industry,
    description: row.description,
    status: row.status,
    user_id: row.user_id,
    must_change_password: row.must_change_password === true,
    created_at: row.created_at,
  };

  const email = user.email ?? "";

  return {
    user: { id: user.id, email },
    companyId,
    company,
    role,
    // Identity resolves from whoever OWNS the edit, matching fetchTeamMembers:
    //
    //   owner          -> companies.contact_name FIRST. An admin edits it in
    //                     /admin/companies; nothing in the company product
    //                     edits an owner's name. company_members.name is a
    //                     copy written once at provisioning and updated by
    //                     nothing, so letting it win showed a stale name in
    //                     the topbar and sidebar long after the admin edit.
    //   invited member -> company_members.name FIRST. They set it themselves
    //                     at accept time and have no companies row; the
    //                     company's contact_name is somebody else's name.
    //
    // Both then fall back to the other source, then the email local-part. The
    // owner-by-companies.user_id fallback path has no member row and `role`
    // stays "owner", so it lands on contact_name — correct on that path too.
    memberName:
      (role === "owner"
        ? company.contact_name?.trim() || memberName?.trim()
        : memberName?.trim() || company.contact_name?.trim()) ||
      email.split("@")[0] ||
      "",
    memberId,
    mustChangePassword: row.must_change_password === true,
  };
}

/** Guard: resolve the company context and require one of `allowed` roles. */
export async function requireCompanyRole(
  ...allowed: CompanyRole[]
): Promise<CompanyContext> {
  const ctx = await getCompanyContext();
  if (!allowed.includes(ctx.role)) {
    throw new Error("Forbidden: insufficient company role");
  }
  return ctx;
}
