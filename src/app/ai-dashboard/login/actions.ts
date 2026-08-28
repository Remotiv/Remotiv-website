"use server";

import { resolveCompanyAccess } from "@/app/ai-dashboard/lib/company-guards";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Keep result types local to this file.
export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      reason: "credentials" | "rate_limited" | "not_company" | "inactive" | "unavailable" | "error";
      /** The company status, when `inactive` — picks the message to show. */
      status?: string;
    };

function isRateLimited(error: { message?: string; status?: number } | null): boolean {
  return error?.status === 429 || (error?.message?.toLowerCase().includes("rate") ?? false);
}

/**
 * Sign in to the AI product, and decide eligibility, in one server operation.
 *
 * ── Why the sign-in moved to the server ──────────────────────
 *
 * It used to run in the browser and then call a second action to check
 * membership. That left a window in which someone was authenticated but not yet
 * verified, which the client had to clean up by calling signOut() — and it made
 * the only way into the product depend on two network round-trips either of
 * which could fail independently. Here the two are one request: nobody holds a
 * session that has not been checked, because the check happens before the
 * response carrying the cookies is written.
 *
 * ── Credentials are passed as FormData deliberately ──────────
 *
 * Next logs server-action arguments to the dev terminal verbatim when
 * `logServerFunctions` is on (action-handler.js — it formats each argument with
 * JSON.stringify). Positional string arguments would print the password there.
 * A FormData serializes to `{}`, so it cannot.
 *
 * Never throws. Every failure is a value, so the caller's own catch is left for
 * genuine transport faults rather than being the thing that reports a bad
 * password.
 */
export async function signInToCompany(form: FormData): Promise<LoginResult> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  if (!email || !password) return { ok: false, reason: "credentials" };

  try {
    const auth = await createAuthClient();
    const { data, error } = await auth.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      // Enumeration-safe: every credential failure collapses to one message,
      // and only rate limiting is distinguished.
      return {
        ok: false,
        reason: isRateLimited(error as { message?: string; status?: number } | null)
          ? "rate_limited"
          : "credentials",
      };
    }

    const access = await resolveCompanyAccess(createServiceClient(), data.user.id);
    if (access.ok) return { ok: true };

    /*
     * A failed LOOKUP is not a failed login.
     *
     * Signing out is how this gate evicts someone who does not belong. When the
     * check could not RUN, the session is left intact and they are asked to
     * retry — signing a legitimate member out over a transient database error,
     * and telling them their account is the wrong kind, is the worse of the two
     * mistakes.
     */
    if (access.reason === "unavailable") return { ok: false, reason: "unavailable" };

    await auth.auth.signOut();

    if (access.reason === "inactive") {
      return { ok: false, reason: "inactive", status: access.status ?? undefined };
    }
    return { ok: false, reason: "not_company" };
  } catch (err) {
    // Reaching here means something neither path anticipated — the Supabase
    // call threw rather than returning an error, or a cookie write failed. The
    // user is told to retry, and the cause is on the server where it belongs.
    console.error("[login] sign-in threw:", err);
    return { ok: false, reason: "error" };
  }
}
