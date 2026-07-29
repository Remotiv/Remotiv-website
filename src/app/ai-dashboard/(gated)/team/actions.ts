"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidEmail } from "@/app/admin/lib/validators";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { sendEmail } from "@/lib/email/send";
import {
  companyInviteSubject,
  renderCompanyInviteEmail,
} from "@/lib/email/templates/company-invite";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import {
  COMPANY_ROLE_LABELS,
  type CompanyMemberStatus,
  type CompanyRole,
  type TeamMemberRow,
} from "@/app/ai-dashboard/lib/company-roles";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Result/row types live in lib/company-roles.ts.
type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const ASSIGNABLE_ROLES: readonly CompanyRole[] = [
  "admin",
  "recruiter",
  "hiring_manager",
];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type MemberQueryRow = {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  role: CompanyRole;
  status: CompanyMemberStatus;
};

type InviteQueryRow = {
  id: string;
  email: string;
  name: string | null;
  role: CompanyRole;
  invited_by_name: string | null;
  created_at: string;
};

/**
 * Mint a single-use invite token.
 *
 * Only the SHA-256 hash is persisted; the raw value exists solely in the
 * emailed URL. Note the existing talent_claim_tokens table stores its token
 * RAW despite the column being named token_hash — that pattern is deliberately
 * NOT copied here. SHA-256 rather than bcrypt because the token already
 * carries 256 bits of entropy, so there is nothing to brute-force.
 */
function mintInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashInviteToken(rawToken) };
}

function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function inviteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv.work";
}

// ── Reads ────────────────────────────────────────────────────

/**
 * Every member of the viewer's company. Readable by any active member; only
 * mutations are role-gated.
 *
 * Email + last_sign_in_at come from auth.users, which PostgREST can't see —
 * they need the Admin API. We fan out getUserById per member inside
 * Promise.all rather than calling listUsers: listUsers paginates the ENTIRE
 * project's auth table (every talent, client, and admin account) and silently
 * truncates at the page size, so it would drop members as the project grows.
 * Team sizes are small, so N parallel lookups cost one wall-clock round-trip.
 */
export async function fetchTeamMembers(): Promise<TeamMemberRow[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const nowIso = new Date().toISOString();

  const [membersResult, invitesResult] = await Promise.all([
    service
      .from("company_members")
      .select("id, user_id, name, email, role, status")
      .eq("company_id", ctx.companyId)
      .neq("status", "removed")
      .order("created_at", { ascending: true }),
    // Pending invites live in their own table (they carry a hashed token and
    // no auth user yet) but render as rows in the same list.
    service
      .from("company_invites")
      .select("id, email, name, role, invited_by_name, created_at")
      .eq("company_id", ctx.companyId)
      .eq("status", "pending")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: true }),
  ]);

  if (membersResult.error) {
    console.error("[team] fetchTeamMembers query failed:", membersResult.error);
    return [];
  }
  if (invitesResult.error) {
    // A broken invites read shouldn't blank the member list.
    console.error("[team] pending invites query failed:", invitesResult.error);
  }

  const members = (membersResult.data ?? []) as MemberQueryRow[];
  const invites = (invitesResult.data ?? []) as InviteQueryRow[];

  const authResults = await Promise.all(
    members.map(async (m) => {
      if (!m.user_id) return { email: null, lastSignInAt: null };
      try {
        const { data: authData } = await service.auth.admin.getUserById(m.user_id);
        return {
          email: authData?.user?.email ?? null,
          lastSignInAt: authData?.user?.last_sign_in_at ?? null,
        };
      } catch {
        // One failed lookup degrades that row, never the whole page.
        return { email: null, lastSignInAt: null };
      }
    }),
  );

  const memberRows: TeamMemberRow[] = members.map((m, i) => {
    const email = m.email?.trim() || authResults[i].email || "";
    const name = m.name?.trim() || email.split("@")[0] || "Unknown";
    return {
      id: m.id,
      user_id: m.user_id,
      name,
      email,
      role: m.role,
      status: m.status,
      last_sign_in_at: authResults[i].lastSignInAt,
      is_self: m.user_id !== null && m.user_id === ctx.user.id,
      is_owner: m.role === "owner",
      invited_by_name: null,
      invited_at: null,
    };
  });

  // `id` is the INVITE id on these rows — resend/revoke key off it, which is
  // why the client branches on status before calling a mutation.
  const inviteRows: TeamMemberRow[] = invites.map((inv) => ({
    id: inv.id,
    user_id: null,
    name: inv.name?.trim() || inv.email.split("@")[0] || "Invited",
    email: inv.email,
    role: inv.role,
    status: "invited",
    last_sign_in_at: null,
    is_self: false,
    is_owner: false,
    invited_by_name: inv.invited_by_name,
    invited_at: inv.created_at,
  }));

  return [...memberRows, ...inviteRows];
}

// ── Mutations ────────────────────────────────────────────────

export async function updateMemberRole(
  memberId: string,
  role: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  // Validate against the union — never trust a client-supplied role string.
  if (!ASSIGNABLE_ROLES.includes(role as CompanyRole)) {
    return { success: false, error: "Invalid role." };
  }

  const service = createServiceClient();

  // Re-fetch the target row: the client-supplied id proves nothing about
  // which company it belongs to.
  const { data: targetRow } = await service
    .from("company_members")
    .select("id, company_id, user_id, role")
    .eq("id", memberId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    user_id: string | null;
    role: CompanyRole;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Member not found in your workspace." };
  }
  if (target.role === "owner") {
    return { success: false, error: "The owner's role can't be changed." };
  }
  if (target.user_id && target.user_id === ctx.user.id) {
    return { success: false, error: "You can't change your own role." };
  }

  const { error } = await service
    .from("company_members")
    .update({ role })
    .eq("id", memberId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: undefined };
}

export async function removeMember(
  memberId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  const service = createServiceClient();

  const { data: targetRow } = await service
    .from("company_members")
    .select("id, company_id, user_id, role")
    .eq("id", memberId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    user_id: string | null;
    role: CompanyRole;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Member not found in your workspace." };
  }
  if (target.role === "owner") {
    return { success: false, error: "The owner can't be removed." };
  }
  if (target.user_id && target.user_id === ctx.user.id) {
    return { success: false, error: "You can't remove yourself." };
  }

  // Soft removal: the status enum already carries "removed", so we keep the
  // row for audit. The auth user is deliberately NOT deleted — that account
  // may be in use elsewhere; we only sever this membership.
  const { error } = await service
    .from("company_members")
    .update({ status: "removed" })
    .eq("id", memberId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: undefined };
}

// ── Invites ──────────────────────────────────────────────────

export async function inviteMember(input: {
  email: string;
  name: string;
  role: string;
}): Promise<MutationResult<{ acceptUrl: string }>> {
  const ctx = await requireCompanyRole("owner", "admin");

  // Server actions carry no Request, so rate-limit by company rather than IP.
  const rl = rateLimitByKey(`company-invite:${ctx.companyId}`, {
    max: 20,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      success: false,
      error: `Too many invites. Try again in ${rl.retryAfter}s.`,
    };
  }

  const email = (input.email ?? "").trim().toLowerCase();
  const name = (input.name ?? "").trim();
  const role = input.role;

  if (!isValidEmail(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  // "owner" is absent from the allowlist, which is what makes "never invite an
  // owner" structural rather than a separate check.
  if (!ASSIGNABLE_ROLES.includes(role as CompanyRole)) {
    return { success: false, error: "Invalid role." };
  }

  const service = createServiceClient();

  // Collision policy: cross-product emails are fine (a talent may also be a
  // company member). Block only an existing ACTIVE member of THIS company.
  const { data: existingMember } = await service
    .from("company_members")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("email", email)
    .eq("status", "active")
    .maybeSingle();

  if (existingMember) {
    return { success: false, error: "That person is already on your team." };
  }

  // Supersede any live invite for the same email so only the newest token is
  // honoured (mirrors the talent claim flow's expire-then-issue).
  await service
    .from("company_invites")
    .update({ status: "expired" })
    .eq("company_id", ctx.companyId)
    .eq("email", email)
    .eq("status", "pending");

  const { rawToken, tokenHash } = mintInviteToken();

  const { data: inviteRow, error: insertError } = await service
    .from("company_invites")
    .insert({
      company_id: ctx.companyId,
      email,
      name: name || null,
      role,
      token_hash: tokenHash,
      status: "pending",
      invited_by: ctx.user.id,
      invited_by_name: ctx.memberName,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !inviteRow) {
    return {
      success: false,
      error: insertError?.message ?? "Failed to create the invite.",
    };
  }

  const inviteId = (inviteRow as { id: string }).id;
  const acceptUrl = `${inviteBaseUrl()}/ai-dashboard/accept/${rawToken}`;

  // AWAITED, and the result checked. sendEmail never throws — it returns
  // { ok:false } — so an unchecked call would report success for a mail that
  // never left. If it fails we expire the invite we just wrote rather than
  // leave a pending row nobody can act on.
  const sendResult = await sendEmail({
    to: email,
    subject: companyInviteSubject,
    html: renderCompanyInviteEmail({
      inviteeName: name || email.split("@")[0] || "there",
      companyName: ctx.company.name,
      inviterName: ctx.memberName || ctx.user.email,
      role: COMPANY_ROLE_LABELS[role as CompanyRole],
      acceptUrl,
    }),
    replyTo: ctx.user.email,
  });

  if (!sendResult.ok) {
    await service
      .from("company_invites")
      .update({ status: "expired" })
      .eq("id", inviteId);
    return {
      success: false,
      error: `Couldn't send the invitation email: ${sendResult.error ?? "unknown error"}`,
    };
  }

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: { acceptUrl } };
}

export async function resendInvite(
  inviteId: string,
): Promise<MutationResult<{ acceptUrl: string }>> {
  const ctx = await requireCompanyRole("owner", "admin");

  const rl = rateLimitByKey(`company-invite-resend:${ctx.companyId}`, {
    max: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      success: false,
      error: `Too many resends. Try again in ${rl.retryAfter}s.`,
    };
  }

  const service = createServiceClient();

  const { data: targetRow } = await service
    .from("company_invites")
    .select("id, company_id, email, name, role, status")
    .eq("id", inviteId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    email: string;
    name: string | null;
    role: CompanyRole;
    status: string;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Invite not found in your workspace." };
  }
  if (target.status !== "pending") {
    return { success: false, error: "That invitation is no longer active." };
  }

  // Never reuse a token: retire the old row and issue a fresh one.
  await service
    .from("company_invites")
    .update({ status: "expired" })
    .eq("id", inviteId);

  const { rawToken, tokenHash } = mintInviteToken();

  const { data: freshRow, error: insertError } = await service
    .from("company_invites")
    .insert({
      company_id: ctx.companyId,
      email: target.email,
      name: target.name,
      role: target.role,
      token_hash: tokenHash,
      status: "pending",
      invited_by: ctx.user.id,
      invited_by_name: ctx.memberName,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !freshRow) {
    return {
      success: false,
      error: insertError?.message ?? "Failed to reissue the invite.",
    };
  }

  const freshId = (freshRow as { id: string }).id;
  const acceptUrl = `${inviteBaseUrl()}/ai-dashboard/accept/${rawToken}`;

  const sendResult = await sendEmail({
    to: target.email,
    subject: companyInviteSubject,
    html: renderCompanyInviteEmail({
      inviteeName: target.name?.trim() || target.email.split("@")[0] || "there",
      companyName: ctx.company.name,
      inviterName: ctx.memberName || ctx.user.email,
      role: COMPANY_ROLE_LABELS[target.role],
      acceptUrl,
    }),
    replyTo: ctx.user.email,
  });

  if (!sendResult.ok) {
    await service
      .from("company_invites")
      .update({ status: "expired" })
      .eq("id", freshId);
    return {
      success: false,
      error: `Couldn't resend the invitation: ${sendResult.error ?? "unknown error"}`,
    };
  }

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: { acceptUrl } };
}

export async function revokeInvite(
  inviteId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  const service = createServiceClient();

  const { data: targetRow } = await service
    .from("company_invites")
    .select("id, company_id, status")
    .eq("id", inviteId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    status: string;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Invite not found in your workspace." };
  }
  if (target.status !== "pending") {
    return { success: false, error: "That invitation is no longer active." };
  }

  const { error } = await service
    .from("company_invites")
    .update({ status: "revoked" })
    .eq("id", inviteId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: undefined };
}
