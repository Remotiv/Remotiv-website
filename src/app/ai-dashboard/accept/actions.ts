"use server";

import { createHash } from "node:crypto";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { isAlreadyRegistered } from "@/lib/company-identity";
import { sendEmail } from "@/lib/email/send";
import { inviteCodeSubject, renderInviteCodeEmail } from "@/lib/email/templates/invite-code";
import {
  clearInviteCodeVerify,
  clearInvitePasswordAttempts,
  type ReserveResult,
  reserveInviteCodeSend,
  reserveInviteCodeVerify,
  reserveInvitePasswordAttempt,
} from "@/lib/invite-password-limit";
import { notifyCompany } from "@/lib/notifications/company";
import {
  createClient as createAuthClient,
  createServiceClient,
  createStatelessClient,
} from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Types stay local / in lib/company-roles.ts.
type AcceptResult =
  | { success: true }
  | { success: false; error: string; needsExistingPassword?: boolean };

type SendCodeResult =
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
const WRONG_PASSWORD =
  "That password doesn't match your existing Remotiv account. Enter your current password to join.";
const CODE_WRONG = "That code is not right or has expired.";
const CODE_SEND_FAILED = "We couldn't send a code just now. Please try again in a moment.";
const CODE_SEND_LOCKED = "Too many codes were sent to this email. Please try again in 15 minutes.";
const CODE_CHECK_LOCKED =
  "Too many incorrect codes for this email. Please try again in 15 minutes.";
const CODE_CHECK_UNAVAILABLE =
  "We couldn't check your code just now. Please try again in a moment.";

/**
 * Set in APP_METADATA on an account the code step CREATES (#51), in the same
 * createUser call that creates it, so no account exists unmarked for a moment
 * and none that existed before can gain it. Only the service role writes
 * app_metadata; a signed-in user's updateUser writes user_metadata, which is
 * never read for this. Cleared when the password is set. It decides which
 * proof the final step asks for: an account that carries it is new and gets
 * the password typed here; any other must prove its existing password as well
 * as the code.
 */
const NEW_ACCOUNT_MARKER = "remotiv_invite_signup";

/** Supabase's code is 6 digits by default and configurable up to 10: digits only, nothing else reaches it. */
const CODE_FORMAT = /^\d{6,10}$/;

/** The error code only, never the message or the object (#100). */
function logCode(where: string, err: { code?: string | null; status?: number | null } | null) {
  console.error(`[accept-invite] ${where}: ${err?.code ?? err?.status ?? "error"}`);
}

type Checked =
  | { ok: true; invite: InviteRow; tokenHash: string; email: string }
  | { ok: false; error: string };

/**
 * Steps shared by both actions, read-only: the token, the per-token throttle,
 * and refusal of anything but a pending, unexpired invitation whose inviter is
 * still an active owner or admin. A dead invitation sends no code and creates
 * no account.
 */
async function checkInvite(
  service: ReturnType<typeof createServiceClient>,
  rawToken: string,
): Promise<Checked> {
  if (!rawToken) return { ok: false, error: "Missing invitation token." };

  // The incoming value is the RAW token; only its hash is stored.
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // No Request object in a server action, so key the limiter on the token
  // hash — this throttles brute-forcing a single invite.
  const rl = rateLimitByKey(`company-accept:${tokenHash}`, {
    max: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return { ok: false, error: `Too many attempts. Try again in ${rl.retryAfter}s.` };
  }

  // An old, revoked, superseded or already-accepted invitation is refused
  // HERE and again by accept_company_invite: only a fresh, pending, unexpired,
  // owner-issued invitation reaches a write.
  const { data: inviteRow } = await service
    .from("company_invites")
    .select("id, company_id, email, name, role, status, expires_at, invited_by")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const invite = inviteRow as InviteRow | null;
  if (!invite) return { ok: false, error: "This invitation link isn't valid." };
  if (invite.status !== "pending") {
    return { ok: false, error: "This invitation is no longer active." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { ok: false, error: "This invitation has expired." };
  }

  // The inviter must still be an active owner or admin of this company (#49).
  // Checked here, read-only; checked AGAIN, atomically with the grant, by
  // accept_company_invite (migration 062), which is the check that counts.
  if (!invite.invited_by) return { ok: false, error: INVITE_NO_LONGER_VALID };
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
    return { ok: false, error: JOIN_FAILED };
  }
  if (!inviterRow) return { ok: false, error: INVITE_NO_LONGER_VALID };

  return { ok: true, invite, tokenHash, email: invite.email.toLowerCase() };
}

/**
 * The #48 proof for an account that already exists: a slot taken against the
 * ACCOUNT before the password is checked, then the check itself on a client
 * with no cookies, so a correct password signs nobody in. Returns the
 * account's id, or the refusal to show.
 */
async function provePassword(
  email: string,
  password: string,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const slot = await reserveInvitePasswordAttempt(email);
  if (!slot.ok) {
    return {
      ok: false,
      error: slot.reason === "locked" ? PASSWORD_LOCKED : PASSWORD_CHECK_UNAVAILABLE,
    };
  }
  const probe = createStatelessClient();
  const { data, error } = await probe.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { ok: false, error: WRONG_PASSWORD };
  await probe.auth.signOut({ scope: "local" });
  await clearInvitePasswordAttempts(email);
  return { ok: true, userId: data.user.id };
}

function refusal(slot: Exclude<ReserveResult, { ok: true }>, locked: string, down: string) {
  return slot.reason === "locked" ? locked : down;
}

/**
 * Step 1 of accepting (#51): email a code to the INVITED address.
 *
 *   existing account  the #48 password check first; nothing is created
 *   new address       the service role creates the account, unconfirmed,
 *                     with no password, no membership and the marker in
 *                     app_metadata; an address that already has an account,
 *                     from an earlier send or from anywhere else, is left as
 *                     it is
 *
 * Then the code: auth.admin.generateLink (type magiclink) returns it and
 * sends NOTHING, and we email it ourselves, through Resend, to the invited
 * address only. Supabase's own templates are shared with client signup and
 * talent login, so no Supabase auth email is ever sent for an invitation.
 * The code is never logged. If our email fails, an account this call created
 * is deleted again: the person sees one fixed message and can try again.
 *
 * `existingAccount` only picks which of the two to try; it proves nothing.
 * The final step decides again from the account itself (NEW_ACCOUNT_MARKER).
 * Every send costs a slot of the address's send budget, taken before the
 * email goes: an admin re-inviting cannot flood the address.
 */
export async function sendInviteCode(input: {
  token: string;
  password: string;
  existingAccount: boolean;
}): Promise<SendCodeResult> {
  const password = input.password ?? "";
  if (password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }
  const service = createServiceClient();
  const checked = await checkInvite(service, input.token ?? "");
  if (!checked.ok) return { success: false, error: checked.error };
  const { email } = checked;

  if (input.existingAccount) {
    const proof = await provePassword(email, password);
    if (!proof.ok) return { success: false, error: proof.error, needsExistingPassword: true };
  }

  const slot = await reserveInviteCodeSend(email);
  if (!slot.ok) {
    return { success: false, error: refusal(slot, CODE_SEND_LOCKED, CODE_SEND_FAILED) };
  }

  // Set only when THIS call created the account, so only that one is undone.
  let createdId: string | null = null;
  const undoCreate = async () => {
    if (createdId) await service.auth.admin.deleteUser(createdId);
  };
  if (!input.existingAccount) {
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      email_confirm: false,
      app_metadata: { [NEW_ACCOUNT_MARKER]: true },
    });
    if (createError && !isAlreadyRegistered(createError.message ?? "")) {
      logCode("create account", createError);
      return { success: false, error: ACCOUNT_FAILED };
    }
    createdId = created?.user?.id ?? null;
  }

  // The code, minted without any email (staging, #51: type magiclink, checked
  // by verifyOtp type "email", for a new unconfirmed account and an existing
  // one alike). A newer one replaces the last.
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const code = link?.properties?.email_otp ?? "";
  if (linkError || !code) {
    logCode("make code", linkError ?? { code: "no_code" });
    await undoCreate();
    return { success: false, error: CODE_SEND_FAILED };
  }

  const { data: companyRow } = await service
    .from("companies")
    .select("name")
    .eq("id", checked.invite.company_id)
    .maybeSingle();
  const companyName = (companyRow as { name?: string } | null)?.name?.trim() || "your team";
  const sent = await sendEmail({
    to: email,
    subject: inviteCodeSubject(companyName),
    html: renderInviteCodeEmail({ companyName, code }),
  });
  if (!sent.ok) {
    logCode("send code", { code: "email_failed" });
    await undoCreate();
    return { success: false, error: CODE_SEND_FAILED };
  }
  return { success: true };
}

/**
 * Step 2 of accepting: the code, then the grant.
 *
 * ── Sequencing (#100, #49, #51) ──────────────────────────────
 *
 *   1. the invitation, read-only (checkInvite): a dead invitation writes
 *      nothing
 *   2. the code, checked on a client with no cookies, against the INVITED
 *      address, after a slot of that address's check budget. A wrong or
 *      expired code ends here: nothing is written
 *   3. the account the code proved must BE the invited address. If the code
 *      step created it (NEW_ACCOUNT_MARKER), the password typed here becomes
 *      its password; otherwise it existed already and must ALSO prove its
 *      existing password (#48), and be the same account
 *   4. burn the invite and grant the membership in ONE transaction,
 *      accept_company_invite (migration 062), which re-checks the inviter
 *      under a row lock: the check that counts
 *
 * The account is resolved BEFORE the burn so that a wrong code or password,
 * or an account that cannot be finished, never spends the token.
 *
 * A spent token whose grant is refused by 057's removal rule stays spent and
 * the person must be re-invited, as before: re-inviting works because a
 * removed member's surviving row is reactivated rather than colliding.
 */
export async function acceptInvite(input: {
  token: string;
  password: string;
  code: string;
}): Promise<AcceptResult> {
  const password = input.password ?? "";
  const code = (input.code ?? "").trim();
  if (password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const service = createServiceClient();
  const checked = await checkInvite(service, input.token ?? "");
  if (!checked.ok) return { success: false, error: checked.error };
  const { invite, tokenHash, email } = checked;

  if (!CODE_FORMAT.test(code)) return { success: false, error: CODE_WRONG };
  const slot = await reserveInviteCodeVerify(email);
  if (!slot.ok) {
    return { success: false, error: refusal(slot, CODE_CHECK_LOCKED, CODE_CHECK_UNAVAILABLE) };
  }

  // 2. The code. The session it yields lives in `codeClient` only and is
  //    signed out below: the browser is signed in at the end, by password.
  const codeClient = createStatelessClient();
  const { data: verified, error: codeError } = await codeClient.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  const user = verified?.user ?? null;
  if (codeError || !user) return { success: false, error: CODE_WRONG };
  await clearInviteCodeVerify(email);
  const endCodeSession = () => codeClient.auth.signOut({ scope: "local" }).catch(() => {});

  // 3. The account.
  if ((user.email ?? "").trim().toLowerCase() !== email) {
    await endCodeSession();
    logCode("check code", { code: "email_mismatch" });
    return { success: false, error: CODE_WRONG };
  }
  // app_metadata only: user_metadata is the user's own to write.
  const isNew = user.app_metadata?.[NEW_ACCOUNT_MARKER] === true;
  if (isNew) {
    const { error: setError } = await service.auth.admin.updateUserById(user.id, {
      password,
      app_metadata: { [NEW_ACCOUNT_MARKER]: null },
    });
    if (setError) {
      await endCodeSession();
      logCode("set password", setError);
      return { success: false, error: ACCOUNT_FAILED };
    }
  } else {
    const proof = await provePassword(email, password);
    if (!proof.ok || proof.userId !== user.id) {
      await endCodeSession();
      return {
        success: false,
        error: proof.ok ? JOIN_FAILED : proof.error,
        needsExistingPassword: true,
      };
    }
  }
  await endCodeSession();
  const userId = user.id;
  const createdUserId = isNew ? user.id : null;

  // 4. Burn and grant, atomically (migration 062, #49). One transaction locks
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
    // account finished above belongs to the invited address and is what the
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

  // Sign the browser in so they land straight in the workspace. Both paths:
  // every check above ran on clients with no cookies.
  const auth = await createAuthClient();
  await auth.auth.signInWithPassword({ email, password });

  return { success: true };
}
