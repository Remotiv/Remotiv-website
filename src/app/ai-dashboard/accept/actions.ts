"use server";

import { createHash } from "node:crypto";
import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { isAlreadyRegistered } from "@/lib/company-identity";
import { notifyCompany } from "@/lib/notifications/company";

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

/**
 * Redeem an invite token and join the company.
 *
 * Sequencing is deliberate: create-or-resolve the auth user, insert the
 * membership, and only THEN burn the invite. Marking the invite accepted
 * first would strand the invitee if the membership insert failed.
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

  // Idempotency: a double-submit shouldn't create a second membership.
  const { data: existingMember } = await service
    .from("company_members")
    .select("id")
    .eq("company_id", invite.company_id)
    .eq("email", email)
    .eq("status", "active")
    .maybeSingle();

  if (existingMember) {
    await service
      .from("company_invites")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invite.id);
    return { success: true };
  }

  // Create the auth account, or fall back to signing in an existing one.
  // `createdUserId` stays null for the existing-account path so the rollback
  // below never deletes an account we didn't create.
  let userId: string | null = null;
  let createdUserId: string | null = null;

  const { data: created, error: createError } =
    await service.auth.admin.createUser({
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
    const { data: signIn, error: signInError } =
      await auth.auth.signInWithPassword({ email, password });

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
    return {
      success: false,
      error: createError?.message ?? "Couldn't create your account.",
    };
  }

  const { error: memberError } = await service.from("company_members").insert({
    company_id: invite.company_id,
    user_id: userId,
    name: invite.name?.trim() || email.split("@")[0],
    email,
    role: invite.role,
    status: "active",
  });

  if (memberError) {
    // Roll back only an account WE created — never an account that predated
    // this invite.
    if (createdUserId) {
      await service.auth.admin.deleteUser(createdUserId);
    }
    return { success: false, error: memberError.message };
  }

  /*
   * Membership has committed, so there is now a team to tell.
   *
   * Placed AFTER the insert and its rollback branch — notifying about a join
   * that was then rolled back would be a bell entry for something that never
   * happened. Placed BEFORE the invite is burned only because that is the next
   * statement; the two are independent, and notifyCompany never throws, so it
   * cannot leave the invite un-burned and re-usable.
   *
   * Owner/admin only — resolveRecipients routes team-administration types
   * there. No actorMemberId: the person joining has no company_members row
   * until the insert above, and they are looking at the workspace they just
   * walked into rather than needing a notification about it.
   */
  await notifyCompany({
    companyId: invite.company_id,
    type: "invite_accepted",
    title: `${(invite.name ?? "").trim() || email} joined the team`,
    body: "They accepted their invite and can sign in now.",
    href: "/ai-dashboard/team",
  });

  // Membership committed — now the invite can be burned (single-use).
  await service
    .from("company_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  // Sign the new account in so they land straight in the workspace. The
  // existing-account path already established a session above.
  if (createdUserId) {
    const auth = await createAuthClient();
    await auth.auth.signInWithPassword({ email, password });
  }

  return { success: true };
}
