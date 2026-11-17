"use server";

import { createHash } from "node:crypto";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { isAlreadyRegistered } from "@/lib/company-identity";
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
};

/** What the browser is told when a write fails. Never a library message. */
const JOIN_FAILED = "Couldn't finish joining the workspace. Please ask for a new invitation.";
const ACCOUNT_FAILED = "Couldn't create your account. Please try again.";
const ALREADY_USED = "This invitation has already been used.";

/** The error code only, never the message or the object (#100). */
function logCode(where: string, err: { code?: string | null; status?: number | null } | null) {
  console.error(`[accept-invite] ${where}: ${err?.code ?? err?.status ?? "error"}`);
}

/**
 * Redeem an invite token and join the company.
 *
 * ── Sequencing (#100) ────────────────────────────────────────
 *
 *   1. read the invite and refuse anything but a pending, unexpired one
 *   2. resolve the account for the INVITED address: create it, or prove the
 *      existing one with its password
 *   3. BURN the invite with one conditional UPDATE ... RETURNING: the mutual
 *      exclusion between two acceptances of one link
 *   4. write the membership: reactivate a surviving row, or insert
 *
 * The account is resolved BEFORE the burn so that a wrong password, or an
 * account that cannot be created, never spends the token: proving who you are
 * must not cost the invitation. Only the membership write needs the exclusion,
 * so the burn sits directly in front of it.
 *
 * With the burn first, a failure AFTER it (the membership write) leaves the
 * token spent and the person must be re-invited. That is acceptable only
 * because a removed member's surviving row is now reactivated rather than
 * colliding, so re-inviting works; the two changes depend on each other and
 * must not be separated.
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
    .select("id, company_id, email, name, role, status, expires_at")
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
    userId = signIn.user.id;
  } else {
    logCode("create account", createError);
    return { success: false, error: ACCOUNT_FAILED };
  }

  // 3. The burn, and the mutual exclusion. One conditional UPDATE with
  //    RETURNING: of two requests racing on the same token, exactly one gets a
  //    row back, and only that one may write a membership. No transaction and
  //    no RPC: PostgREST autocommits, and this single statement is the whole
  //    mechanism. The predicate repeats status = 'pending' AND expires_at >
  //    now, so a token revoked, superseded, accepted or expired since step 1
  //    is refused here as well; the read in step 1 is not relied on.
  const nowIso = new Date().toISOString();
  const { data: burnedRow, error: burnError } = await service
    .from("company_invites")
    .update({ status: "accepted", accepted_at: nowIso })
    .eq("id", invite.id)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    // created_at is the DATABASE's own timestamp of this invitation (default
    // now(), production read 10 Nov 2026); it is what step 4 compares with a
    // removed row's removed_at. Never a client value, never a separate read.
    .select("id, company_id, email, role, created_at")
    .maybeSingle();
  if (burnError) {
    logCode("burn invite", burnError);
    return { success: false, error: JOIN_FAILED };
  }
  if (!burnedRow) {
    // Lost the race, or withdrawn meanwhile. Nothing else is touched: an
    // account created above belongs to the invited address and is what the
    // winning request binds the membership to.
    return { success: false, error: ALREADY_USED };
  }
  const burned = burnedRow as { id: string; created_at: string };

  // 4. The membership. Removal is soft (team/actions.ts keeps the row with
  //    status 'removed'), and the row is unique on (company_id, user_id), so
  //    a returning person's row is REACTIVATED rather than inserted beside it.
  //    Looked up by the constraint's own key, whatever its status: an active
  //    member re-clicking a link writes nothing; any other status comes back
  //    as active with the role and name of THIS invitation, never the old row's.
  const { data: existingRow, error: existingError } = await service
    .from("company_members")
    .select("id, status")
    .eq("company_id", invite.company_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) {
    logCode("read membership", existingError);
    if (createdUserId) await service.auth.admin.deleteUser(createdUserId);
    return { success: false, error: JOIN_FAILED };
  }
  const existing = existingRow as { id: string; status: string } | null;

  const name = invite.name?.trim() || email.split("@")[0];
  let memberError: { code?: string | null } | null = null;
  if (existing?.status === "active") {
    // Already a member: the token is spent, nothing changes.
  } else if (existing?.status === "removed") {
    // A removed row comes back ONLY for an invitation created after its most
    // recent removal (migration 057, #100). The comparison lives in the
    // predicate of this one UPDATE, so there is no read-then-write window: a
    // removal that lands between the lookup above and this write makes the
    // write match nothing. removed_at is written by the database alone (the
    // 057 trigger) and is never sent from here; a removed row with a NULL
    // removed_at cannot satisfy lt and so fails closed. The strict less-than
    // refuses an invitation created at exactly the removal's instant, which
    // is the safe direction. Two separate filters, not a hand-built .or()
    // string: the client URL-encodes the timestamp's '+' and ':' itself.
    const { data: reactivated, error } = await service
      .from("company_members")
      .update({ status: "active", role: invite.role, name, email })
      .eq("id", existing.id)
      .eq("company_id", invite.company_id)
      .eq("status", "removed")
      .lt("removed_at", burned.created_at)
      .select("id")
      .maybeSingle();
    if (error) {
      memberError = error;
    } else if (!reactivated) {
      // Older than the removal, or removed again since the lookup. The token
      // is spent, which is right: a stale invitation is consumed harmlessly
      // and a fresh one is the way back. Same string as any failed join; the
      // browser is not told why.
      logCode("reactivate membership", { code: "stale_or_removed_again" });
      if (createdUserId) await service.auth.admin.deleteUser(createdUserId);
      return { success: false, error: JOIN_FAILED };
    }
  } else if (existing) {
    // Any other non-active status (legacy 'invited'): never removed, so its
    // removed_at is NULL by the 057 invariant, and the predicate says so.
    const { data: activated, error } = await service
      .from("company_members")
      .update({ status: "active", role: invite.role, name, email })
      .eq("id", existing.id)
      .eq("company_id", invite.company_id)
      .neq("status", "active")
      .is("removed_at", null)
      .select("id")
      .maybeSingle();
    if (error) {
      memberError = error;
    } else if (!activated) {
      logCode("activate membership", { code: "status_changed" });
      if (createdUserId) await service.auth.admin.deleteUser(createdUserId);
      return { success: false, error: JOIN_FAILED };
    }
  } else {
    const { error } = await service.from("company_members").insert({
      company_id: invite.company_id,
      user_id: userId,
      name,
      email,
      role: invite.role,
      status: "active",
    });
    memberError = error;
  }

  if (memberError) {
    // The token is already spent (see the sequencing note): a new invitation
    // is the way back in, and it works because of the reactivation above.
    // Roll back only an account WE created — never an account that predated
    // this invite — so the person can set a password again next time.
    logCode("write membership", memberError);
    if (createdUserId) {
      await service.auth.admin.deleteUser(createdUserId);
    }
    return { success: false, error: JOIN_FAILED };
  }

  if (existing?.status !== "active") {
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
