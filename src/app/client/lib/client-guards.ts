import type { ClientRow } from "@/app/client/actions";
import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { ClientContext, ClientRole } from "./client-roles";

/**
 * Resolve the logged-in user to their company + role for the /client portal.
 *
 * Resolution order (backward-compatible cutover):
 *   1. client_members (active) — the multi-user source of truth.
 *   2. FALLBACK: clients.user_id — the legacy 1-login-1-company path; role is
 *      synthesized as "owner" so pre-backfill / edge clients keep working.
 *   3. Neither → throw the same "Not a client account" error the old
 *      getCurrentClient threw.
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

  let companyId: string | null = null;
  let role: ClientRole = "owner";

  // 1. client_members (multi-user teams).
  const { data: memberRow } = await service
    .from("client_members")
    .select("client_id, role")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  const member = memberRow as { client_id: string; role: ClientRole } | null;
  if (member) {
    companyId = member.client_id;
    role = member.role;
  } else {
    // 2. Fallback: legacy single-user client resolved by clients.user_id.
    const { data: legacyRow } = await service
      .from("clients")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    const legacy = legacyRow as { id: string } | null;
    if (legacy) {
      companyId = legacy.id;
      role = "owner";
    }
  }

  // 3. Neither path resolved a company.
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
