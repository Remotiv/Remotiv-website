/**
 * The eligibility rule for /ai-dashboard, and nothing else.
 *
 * Kept apart from company-guards.ts on purpose: this module has no runtime
 * dependency on next/headers or on the Supabase factories — every caller hands
 * it a client — so the rule that decides who gets into the product can be
 * exercised directly by a test, with the database stubbed. `import type` is
 * erased at runtime, which is what keeps that true.
 */
import type { createServiceClient } from "@/lib/supabase/server";
import type { CompanyRole, CompanyStatus } from "./company-roles";

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

/**
 * What resolving a user to a tenant produced.
 *
 * A union rather than four independently-nullable fields, so that "there is a
 * company" and "there is a member row" are the SAME fact rather than two facts
 * a caller has to check separately. They are the same fact now: company_members
 * is the only thing that resolves a user to a company.
 */
export type ResolvedMembership =
  | { companyId: string; role: CompanyRole; memberName: string | null; memberId: string }
  | { companyId: null; role: null; memberName: null; memberId: null };

/**
 * Resolve a user to ONE company, through company_members and nothing else.
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
 * ── There used to be a second way in ─────────────────────────
 *
 * A user who owned a `companies` row could resolve through `companies.user_id`
 * even with no membership. It was carried here when the rule was extracted, and
 * it should not have been: a canonical resolver with two independent paths into
 * it is not canonical, and it is the same shape this function was written to
 * remove.
 *
 * It was also unreachable. Provisioning has inserted the owner's member row
 * since the feature's first commit and rolls the whole company back if that
 * insert fails (admin/companies/actions.ts), the product refuses to change an
 * owner's role or remove them (team/actions.ts), and production carried no
 * company that resolved through it. So this is not a migration — there was
 * never an earlier era to migrate from.
 *
 * `companies.user_id` stays as a COLUMN. It is how an admin updates the owner's
 * auth email and password, how deletion finds the auth user, and what the admin
 * drawer displays. It just no longer confers access.
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
    throw new CompanyLookupError(`Could not resolve company membership: ${memberError.message}`, {
      cause: memberError,
    });
  }

  const member = (memberRows ?? [])[0] as
    | { id: string; company_id: string; role: CompanyRole; name: string | null }
    | undefined;

  if (!member) return { companyId: null, role: null, memberName: null, memberId: null };

  return {
    companyId: member.company_id,
    role: member.role,
    memberName: member.name,
    memberId: member.id,
  };
}

/** May this user enter /ai-dashboard at all, and as whom. */
export type CompanyAccess =
  | {
      ok: true;
      companyId: string;
      role: CompanyRole;
      memberName: string | null;
      /**
       * Never null. Access requires an active membership, so granting it and
       * having a member row are now the same fact — which is what lets
       * job_hiring_team.member_id be resolved without a null branch.
       */
      memberId: string;
    }
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "not_company" }
  | { ok: false; reason: "inactive"; status: CompanyStatus | null }
  | { ok: false; reason: "unavailable" };

export type CompanyAccessDeniedReason = Extract<CompanyAccess, { ok: false }>;

/**
 * The single eligibility rule for the AI product. Nothing else decides this.
 *
 * ── Why it is its own function ───────────────────────────────
 *
 * Two gates guard the same door — the login page, which decides whether to send
 * a signed-in user onward, and the gated layout, which decides whether to let
 * them in. They used to ask different questions: the login gate selected ONE
 * company column (`status`), the layout selected THIRTEEN. A column the layout
 * needed and the gate did not could therefore fail on one side only, and the
 * two answers contradicted each other in the one direction that never settles:
 * login says "yes, go to the dashboard", the dashboard says "cannot tell, go to
 * login", forever, until the browser gives up on the redirect chain.
 *
 * Making both gates select all thirteen would have made them agree by making
 * them equally fragile — a renamed column nobody's access depends on would then
 * lock everyone out of both. What they need is the same RULE, not the same
 * query. So eligibility asks for exactly what eligibility turns on:
 *
 *     authenticated user
 *       → active company_members membership
 *       → company row exists and is active
 *       → company_id + role
 *
 * Everything else about a company is PROFILE data, fetched after this has
 * answered, and a failure to load it is no longer an access decision — see
 * CompanyProfileError.
 *
 * `unavailable` is not a refusal. Callers evict on a refusal, so a lookup that
 * could not be ASKED must stay distinguishable from one answered "no".
 */
export async function resolveCompanyAccess(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  // `unauthenticated` is excluded because a user id is already in hand here —
  // only getCompanyContext, which resolves the session itself, can produce it.
): Promise<Exclude<CompanyAccess, { reason: "unauthenticated" }>> {
  let membership: ResolvedMembership;
  try {
    membership = await resolveMembership(service, userId);
  } catch (err) {
    console.error("[company-access] membership resolution failed:", err);
    return { ok: false, reason: "unavailable" };
  }

  if (!membership.companyId) return { ok: false, reason: "not_company" };

  const { data: companyRow, error } = await service
    .from("companies")
    .select("status")
    .eq("id", membership.companyId)
    .maybeSingle();

  if (error) {
    console.error("[company-access] company status lookup failed:", error);
    return { ok: false, reason: "unavailable" };
  }

  const row = companyRow as { status: CompanyStatus } | null;
  // A membership pointing at a company that isn't there is not a transient
  // failure — the question was asked and answered.
  if (!row) return { ok: false, reason: "not_company" };
  if (row.status !== "active") return { ok: false, reason: "inactive", status: row.status };

  return {
    ok: true,
    companyId: membership.companyId,
    role: membership.role,
    memberName: membership.memberName,
    memberId: membership.memberId,
  };
}

/**
 * Access was decided and the answer was no.
 *
 * Carries the reason so callers redirect to a login page that will AGREE with
 * them. Every reason below maps to a login page that renders the form rather
 * than bouncing back, which is what makes the pairing loop-free.
 */
export class CompanyAccessDenied extends Error {
  // An explicit field, not a `readonly` constructor parameter: parameter
  // properties are TypeScript that has to be COMPILED, and Node's strip-only
  // type removal — which is how this module's tests run — rejects them.
  readonly access: CompanyAccessDeniedReason;

  constructor(access: CompanyAccessDeniedReason) {
    super(`Company access denied: ${access.reason}`);
    this.name = "CompanyAccessDenied";
    this.access = access;
  }
}

/**
 * Company PROFILE data could not be loaded, after access was already granted.
 *
 * Deliberately NOT a redirect to login. The eligibility rule has already said
 * yes, so login would say yes too and send them straight back. This is a 500 —
 * an honest error page — and that is the whole point of separating it.
 */
export class CompanyProfileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompanyProfileError";
  }
}

/** Where to send someone the gate refused, such that login agrees. */
export function loginRedirectFor(access: CompanyAccessDeniedReason): string {
  const base = "/ai-dashboard/login";
  switch (access.reason) {
    // Simply signed out. No banner — "this login is for company accounts only"
    // would be a puzzling thing to tell someone whose session merely ended.
    case "unauthenticated":
      return base;
    case "not_company":
      return `${base}?reason=unauthorized`;
    case "unavailable":
      return `${base}?reason=unavailable`;
    case "inactive":
      // paused and archived have their own copy; anything else we may add later
      // falls back to a message that is true of every non-active status.
      return `${base}?reason=${access.status === "paused" || access.status === "archived" ? access.status : "inactive"}`;
  }
}
