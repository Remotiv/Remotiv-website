"use server";

import { createHash } from "node:crypto";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { isAlreadyRegistered } from "@/lib/company-identity";
import {
  clearInvitePasswordAttempts,
  reserveInvitePasswordAttempt,
} from "@/lib/invite-password-limit";
import { notifyCompany } from "@/lib/notifications/company";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Types stay local / in lib/company-roles.ts.
type AcceptResult =
  | { success: true }
  | { success: false; error: string; needsExistingPassword?: boolean };

type InviteRow = {
  id: string;
  company_id: string;
  email: string;
  name: string | null;
  role: CompanyRole;
  status: string;
  expires_at: string;
  invited_by: string | null;
};

/** What the browser is told when a write fails. Never a library message. */
const JOIN_FAILED = "Couldn't finish joining the workspace. Please ask for a new invitation.";
const ACCOUNT_FAILED = "Couldn't create your account. Please try again.";
const ALREADY_USED = "This invitation has already been used.";
const INVITE_NO_LONGER_VALID =
  "This invitation is no longer valid. Ask your team to send a new one.";
const PASSWORD_LOCKED =
  "Too many incorrect passwords for this account. Please try again in 15 minutes.";
const PASSWORD_CHECK_UNAVAILABLE =
  "We couldn't check your password just now. Please try again in a moment.";

/** The error code only, never the message or the object (#100). */
function logCode(where: string, err: { code?: string | null; status?: number | null } | null) {
  console.error(`[accept-invite] ${where}: ${err?.code ?? err?.status ?? "error"}`);
}

/**
 * Redeem an invite token and join the company.
 *
 * ── Sequencing (#100, #49) ───────────────────────────────────
 *
 *   1. read the invite and refuse anything but a pending, unexpired one whose
 *      inviter is still an active owner or admin (read-only, early: a dead
 *      invitation creates no account)
 *   2. resolve the account for the INVITED address: create it, or prove the
 *      existing one with its password
 *   3. burn the invite and grant the membership in ONE transaction,
 *      accept_company_invite (migration 062), which re-checks the inviter
 *      under a row lock: the check that counts
 *
 * The account is resolved BEFORE the burn so that a wrong password, or an
 * account that cannot be created, never spends the token: proving who you are
 * must not cost the invitation.
 *
 * A spent token whose grant is refused by 057's removal rule stays spent and
 * the person must be re-invited, as before: re-inviting works because a
 * removed member's surviving row is reactivated rather than colliding.
 */
export async function acceptInvite(input: {
  token: string;
  password: string;
}): Promise<AcceptResult> {
  const rawToken = input.token ?? "";
  const password = input.password ?? "";

  if (!rawToken) return { success: false, error: "Missing invitation token." };
  if (password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  // The incoming value is the RAW token; only its hash is stored.
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // No Request object in a server action, so key the limiter on the token
  // hash — this throttles brute-forcing a single invite.
  const rl = rateLimitByKey(`company-accept:${tokenHash}`, {
    max: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      success: false,
      error: `Too many attempts. Try again in ${rl.retryAfter}s.`,
    };
  }

  const service = createServiceClient();

  // 1. The invite. An old, revoked, superseded or already-accepted invitation
  //    is refused HERE and again by the burn's own predicate in step 3: only a
  //    fresh, pending, unexpired, owner-issued invitation reaches a write.
  const { data: inviteRow } = await service
    .from("company_invites")
    .select("id, company_id, email, name, role, status, expires_at, invited_by")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const invite = inviteRow as InviteRow | null;
  if (!invite) {
    return { success: false, error: "This invitation link isn't valid." };
  }
  if (invite.status !== "pending") {
    return { success: false, error: "This invitation is no longer active." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { success: false, error: "This invitation has expired." };
  }

  // 1b. The inviter must still be an active owner or admin of this company
  //     (#49). Checked here, read-only, so a dead invitation creates no
  //     account; checked AGAIN, atomically with the grant, by
  //     accept_company_invite (migration 062), which is the check that counts.
  if (!invite.invited_by) {
    return { success: false, error: INVITE_NO_LONGER_VALID };
  }
  const { data: inviterRow, error: inviterError } = await service
    .from("company_members")
    .select("id")
    .eq("company_id", invite.company_id)
    .eq("user_id", invite.invited_by)
    .eq("status", "active")
    .in("role", ["owner", "admin"])
    .maybeSingle();
  if (inviterError) {
    logCode("read inviter", inviterError);
    return { success: false, error: JOIN_FAILED };
  }
  if (!inviterRow) {
    return { success: false, error: INVITE_NO_LONGER_VALID };
  }

  const email = invite.email.toLowerCase();

  // 2. The account for the invited address. `createdUserId` stays null for
  //    the existing-account path so the rollback below never deletes an
  //    account we didn't create.
  let userId: string | null = null;
  let createdUserId: string | null = null;

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created?.user) {
    userId = created.user.id;
    createdUserId = created.user.id;
  } else if (createError && isAlreadyRegistered(createError.message)) {
    // The invitee already has a Remotiv login. They keep it — proving
    // ownership with their existing password both authenticates them and
    // yields the user id, without ever enumerating auth.users.
    //
    // A slot is taken BEFORE the password is checked, against the ACCOUNT
    // (the invited address), not the token: a Resend or another company's
    // invitation must not reset the count (#48, lib/invite-password-limit.ts).
    const slot = await reserveInvitePasswordAttempt(email);
    if (!slot.ok) {
      return {
        success: false,
        error: slot.reason === "locked" ? PASSWORD_LOCKED : PASSWORD_CHECK_UNAVAILABLE,
        needsExistingPassword: true,
      };
    }
    const auth = await createAuthClient();
    const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !signIn.user) {
      return {
        success: false,
        error:
          "That password doesn't match your existing Remotiv account. Enter your current password to join.",
        needsExistingPassword: true,
      };
    }
    await clearInvitePasswordAttempts(email);
    userId = signIn.user.id;
  } else {
    logCode("create account", createError);
    return { success: false, error: ACCOUNT_FAILED };
  }

  // 3. Burn and grant, atomically (migration 062, #49). One transaction locks
  //    the invite, proves the email and the Auth user are the invited ones,
  //    locks the inviter's membership FOR SHARE and requires it to be an
  //    active owner/admin, then burns the invite and writes the membership
  //    under 057's rules. A removal or demotion of the inviter either commits
  //    first (this returns inviter_invalid, nothing written) or waits for this
  //    to commit (granted while the inviter was still authorised). Two
  //    requests on one token: the invite lock serialises them; the second
  //    sees not_pending.
  const name = invite.name?.trim() || email.split("@")[0];
  const { data: outcome, error: rpcError } = await service.rpc("accept_company_invite", {
    p_token_hash: tokenHash,
    p_user_id: userId,
    p_name: name,
    p_email: email,
  });
  if (rpcError) {
    logCode("accept invite", rpcError);
    if (createdUserId) await service.auth.admin.deleteUser(createdUserId);
    return { success: false, error: JOIN_FAILED };
  }
  if (outcome === "not_pending" || outcome === "expired") {
    // Lost the race, or withdrawn meanwhile. Nothing else is touched: an
    // account created above belongs to the invited address and is what the
    // winning request binds the membership to.
    return { success: false, error: ALREADY_USED };
  }
  if (outcome !== "joined" && outcome !== "already_member") {
    // inviter_invalid, invalid, email_mismatch, user_mismatch, stale_removal,
    // status_changed, or anything unknown: fail closed, and roll back only an
    // account WE created, never one that predated this invite.
    logCode("accept invite", { code: typeof outcome === "string" ? outcome : "unknown" });
    if (createdUserId) await service.auth.admin.deleteUser(createdUserId);
    return {
      success: false,
      error: outcome === "inviter_invalid" ? INVITE_NO_LONGER_VALID : JOIN_FAILED,
    };
  }

  if (outcome === "joined") {
    /*
     * Membership has committed, so there is now a team to tell.
     *
     * Owner/admin only — resolveRecipients routes team-administration types
     * there. No actorMemberId: the person joining has no company_members row
     * of their own to act as until the write above, and they are looking at
     * the workspace they just walked into rather than needing a notification
     * about it. notifyCompany never throws.
     */
    await notifyCompany({
      companyId: invite.company_id,
      type: "invite_accepted",
      title: `${(invite.name ?? "").trim() || email} joined the team`,
      body: "They accepted their invite and can sign in now.",
      href: "/ai-dashboard/team",
    });
  }

  // Sign the new account in so they land straight in the workspace. The
  // existing-account path already established a session above.
  if (createdUserId) {
    const auth = await createAuthClient();
    await auth.auth.signInWithPassword({ email, password });
  }

  return { success: true };
}
