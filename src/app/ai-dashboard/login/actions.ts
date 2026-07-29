"use server";

import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { CompanyStatus } from "@/app/ai-dashboard/lib/company-roles";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Keep result types local to this file.
type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_company" | "inactive"; status?: string };

/**
 * Post-sign-in gate for /ai-dashboard/login.
 *
 * RLS is enabled on `companies` and `company_members` with no policies, so the
 * browser (anon) client can never see these rows — the verification has to run
 * server-side against the service client. Resolution order mirrors
 * getCompanyContext: company_members (active) → companies.user_id fallback.
 *
 * Returns a reason instead of throwing so the caller can sign the user out and
 * show the same message it always has.
 */
export async function verifyCompanyAccess(): Promise<VerifyResult> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { ok: false, reason: "not_company" };

  const service = createServiceClient();

  const { data: memberRow } = await service
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  let companyId = (memberRow as { company_id: string } | null)?.company_id ?? null;

  if (!companyId) {
    const { data: fallbackRow } = await service
      .from("companies")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    companyId = (fallbackRow as { id: string } | null)?.id ?? null;
  }

  if (!companyId) return { ok: false, reason: "not_company" };

  const { data: companyRow } = await service
    .from("companies")
    .select("status")
    .eq("id", companyId)
    .maybeSingle();

  const status = (companyRow as { status: CompanyStatus } | null)?.status ?? null;
  if (status !== "active") {
    return { ok: false, reason: "inactive", status: status ?? undefined };
  }

  return { ok: true };
}
