"use server";

import { resolveMembership } from "@/app/ai-dashboard/lib/company-guards";
import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action, so no type exports here.

const COMPANY_HOME = "/ai-dashboard";
const PUBLIC_HOME = "/browse-talent?password_updated=true";

/**
 * Where to send a user after they've set a new password on the shared reset
 * page.
 *
 * Resolves ONLY the already-authenticated caller — it takes no input, so it
 * can't be used to probe whether an arbitrary email belongs to a company. The
 * lookup needs the service client because company_members has RLS enabled with
 * no policies. Mirrors getCompanyContext's order (members row, then the
 * companies.user_id owner fallback) so an owner without a member row still
 * lands in the right product.
 *
 * Any failure falls back to the public destination — a wrong-but-valid page
 * beats a dead end, and the company portal re-gates on arrival anyway.
 */
export async function resolveResetDestination(): Promise<string> {
  try {
    const auth = await createAuthClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return PUBLIC_HOME;

    const service = createServiceClient();

    // Both paths in one: a member row OR the owner fallback means the company
    // portal. Previously a user in two companies matched NEITHER lookup and was
    // sent to the public site.
    const { companyId } = await resolveMembership(service, user.id);
    return companyId ? COMPANY_HOME : PUBLIC_HOME;
  } catch {
    return PUBLIC_HOME;
  }
}
