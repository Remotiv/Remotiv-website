"use server";

import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { CompanyStatus } from "@/app/ai-dashboard/lib/company-roles";
import { resolveMembership } from "@/app/ai-dashboard/lib/company-guards";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Keep result types local to this file.
type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_company" | "inactive" | "unavailable"; status?: string };

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

  /*
   * `unavailable` is not `not_company`.
   *
   * The caller signs the user out on a refusal, so answering "you are not a
   * company account" when the lookup merely FAILED would evict a legitimate
   * member over a transient database error. resolveMembership throws rather
   * than returning null on failure precisely so the two can be told apart.
   */
  let companyId: string | null;
  try {
    companyId = (await resolveMembership(service, user.id)).companyId;
  } catch (err) {
    console.error("[login] company resolution failed:", err);
    return { ok: false, reason: "unavailable" };
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
