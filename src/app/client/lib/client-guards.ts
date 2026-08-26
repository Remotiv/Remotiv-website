import type { ClientRow } from "@/app/client/actions";
import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { ClientContext, ClientRole } from "./client-roles";

/** What resolving a user to a client produced, and which path produced it. */
export type ResolvedClientMembership = {
  companyId: string | null;
  role: ClientRole;
  /** "member" | "owner_fallback" | "none" — for callers that need to explain. */
  source: "member" | "owner_fallback" | "none";
};

/**
 * Resolve a user to ONE client. The single copy of this rule.
 *
 * Mirrors resolveMembership in ai-dashboard/lib/company-guards.ts deliberately:
 * same defect, same fix, so the two portals cannot drift into two different
 * answers to one question. The two files share no code on purpose — they are
 * separate tenancy boundaries — but they should not be separate RULES.
 *
 * ── The defect this replaces ─────────────────────────────────
 *
 *     .eq("user_id", user.id).eq("status", "active").maybeSingle()
 *
 * with the error discarded. `maybeSingle()` over two rows does not pick one; it
 * returns `data: null` with PGRST116 and HTTP 406. Since only `data` was read, a
 * member of TWO clients was indistinguishable from a member of NONE — and
 * client_members is unique on (client_id, user_id), so a second row for a second
 * client is legal. The consequence was silent: the user fell through to the
 * clients.user_id fallback and either landed in whichever client they happened
 * to own, as "owner", or was told they were not a client account at all.
 *
 * `clients.user_id` carries no unique index either — only `clients_email_key` —
 * so the fallback could collapse the same way, which is why it is ordered too.
 *
 * ── Which client wins ────────────────────────────────────────
 *
 * The OLDEST active membership, by created_at, with the row id as a tie-break so
 * the answer is total rather than merely usually-unique. Oldest is defensible
 * rather than merely stable: it is the workspace they have been using, and it
 * means a second membership can never silently relocate someone. Ordering by
 * whatever the database finds convenient would be just as deterministic and
 * would answer no question at all.
 *
 * Unlike the company side, multi-client is LATENT rather than live: nothing in
 * the codebase inserts into client_members, so a second membership can only
 * arrive by hand today. This closes the hole before a client team feature opens
 * it, and it does not make the second client reachable — that needs switching,
 * which is out of scope here exactly as it is there.
 */
export async function resolveClientMembership(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<ResolvedClientMembership> {
  const { data: memberRows, error: memberError } = await service
    .from("client_members")
    .select("client_id, role")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  // Surfaced, never swallowed. A failed lookup is not the same fact as "no
  // membership", and treating it as one is the entire defect.
  if (memberError) {
    throw new Error(`Could not resolve client membership: ${memberError.message}`);
  }

  const member = (memberRows ?? [])[0] as { client_id: string; role: ClientRole } | undefined;

  if (member) {
    // Their REAL role, read from the membership — not the "owner" the fallback
    // synthesises for a legacy single-login client.
    return { companyId: member.client_id, role: member.role, source: "member" };
  }

  const { data: ownedRows, error: ownedError } = await service
    .from("clients")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  if (ownedError) {
    throw new Error(`Could not resolve client ownership: ${ownedError.message}`);
  }

  const owned = (ownedRows ?? [])[0] as { id: string } | undefined;
  if (owned) return { companyId: owned.id, role: "owner", source: "owner_fallback" };

  return { companyId: null, role: "owner", source: "none" };
}

/**
 * Resolve the logged-in user to their company + role for the /client portal.
 *
 * Resolution order lives in resolveClientMembership: oldest active membership,
 * then the legacy clients.user_id fallback, then nothing.
 *
 * Throws on: no session, no company, or a non-active company — matching the
 * existing getCurrentClient contract so callers behave identically.
 */
export async function getClientContext(): Promise<ClientContext> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const service = createServiceClient();

  const { companyId, role } = await resolveClientMembership(service, user.id);

  // resolveClientMembership throws on a failed lookup, so reaching here
  // genuinely means there is no membership rather than meaning the question
  // could not be asked.
  if (!companyId) throw new Error("Not a client account");

  // Load the company row (+ password gate) by companyId.
  const { data: companyRow } = await service
    .from("clients")
    .select(
      "id, user_id, company_name, contact_name, email, status, created_at, must_change_password",
    )
    .eq("id", companyId)
    .maybeSingle();
  const row = companyRow as
    | (ClientRow & { must_change_password: boolean | null })
    | null;
  if (!row) throw new Error("Not a client account");
  if (row.status !== "active") throw new Error(`Client status: ${row.status}`);

  const company: ClientRow = {
    id: row.id,
    user_id: row.user_id,
    company_name: row.company_name,
    contact_name: row.contact_name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };

  return {
    user: { id: user.id, email: user.email ?? "" },
    companyId,
    company,
    role,
    mustChangePassword: row.must_change_password === true,
  };
}

/**
 * Guard: resolve the client context and require one of `allowed` roles.
 * Defined now (1a); applied to scoped actions in 1b — do NOT gate existing
 * actions with it yet.
 */
export async function requireClientRole(
  ...allowed: ClientRole[]
): Promise<ClientContext> {
  const ctx = await getClientContext();
  if (!allowed.includes(ctx.role)) {
    throw new Error("Forbidden: insufficient client role");
  }
  return ctx;
}
