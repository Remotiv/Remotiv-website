"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isValidEmail } from "@/lib/validators";
import {
  describeAuthEmailFailure,
  findAuthUserIdByEmail,
  syncJobsCompanyName,
} from "@/lib/company-identity";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import {
  COMPANY_DESCRIPTION_MAX,
  COMPANY_INDUSTRIES,
} from "@/app/ai-dashboard/lib/company-roles";
import { COMPANY_LOGO_BUCKET } from "./constants";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

/** Minimum for a new password. Mirrors the admin provisioning rule. */
const PASSWORD_MIN = 8;

/**
 * A website is optional, but a stored one must be a real absolute http(s) URL.
 *
 * Parsed with `URL` rather than regex-matched: the value is rendered as an
 * anchor on the public hero, and "javascript:alert(1)" passes a naive
 * "contains a dot" check while URL-parsing pins the protocol exactly.
 */
function normaliseWebsite(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
    if (!url.hostname.includes(".")) return { ok: false };
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false };
  }
}

/**
 * Save the company profile.
 *
 * Owner/admin only — the same predicate canEditCompanyProfile enforces in the
 * UI, re-checked here because a disabled input is not a permission.
 */
export async function updateCompanyProfile(input: {
  name: string;
  contact_name: string;
  website: string;
  industry: string;
  description: string;
}): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  const name = (input.name ?? "").trim();
  if (!name) return { success: false, error: "Company name can't be empty." };
  if (name.length > 200) {
    return { success: false, error: "Company name is too long (max 200 characters)." };
  }

  const site = normaliseWebsite(input.website ?? "");
  if (!site.ok) {
    return { success: false, error: "Enter a full URL, starting with https://" };
  }

  const description = (input.description ?? "").trim();
  if (description.length > COMPANY_DESCRIPTION_MAX) {
    return {
      success: false,
      error: `Description is over the ${COMPANY_DESCRIPTION_MAX.toLocaleString()} character limit.`,
    };
  }

  // Unrecognised industries fall back to null rather than being stored — the
  // list is closed precisely so this column stays groupable.
  const industry = (COMPANY_INDUSTRIES as readonly string[]).includes(input.industry)
    ? input.industry
    : null;

  const supabase = createServiceClient();
  const renamed = name !== ctx.company.name;

  const { error } = await supabase
    .from("companies")
    .update({
      name,
      contact_name: (input.contact_name ?? "").trim() || null,
      website: site.value,
      industry,
      description: description || null,
    })
    .eq("id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  // Identical to the admin rename, because it IS the admin rename — the same
  // exported helper, not a second implementation that could drift.
  if (renamed) {
    const synced = await syncJobsCompanyName(
      supabase,
      ctx.companyId,
      name,
      "ai-dashboard/settings",
    );
    if (synced) revalidatePath("/jobs");
  }

  revalidatePath("/ai-dashboard/settings");
  revalidatePath("/ai-dashboard");
  return { success: true, data: undefined };
}

/**
 * Update the ACTING user's own login email and/or password.
 *
 * Scoped to `ctx.user.id` throughout and never takes a user id from the
 * client — there is no shape of this request that can touch another member's
 * account, which is why it needs no role check beyond having a company at all.
 */
export async function updateOwnAccount(input: {
  email: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<MutationResult<undefined>> {
  const ctx = await getCompanyContext();

  const email = (input.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { success: false, error: "Enter a valid email address." };
  }

  const currentPassword = input.currentPassword ?? "";
  const newPassword = input.newPassword ?? "";
  const confirmPassword = input.confirmPassword ?? "";
  const wantsPasswordChange = Boolean(currentPassword || newPassword || confirmPassword);

  if (wantsPasswordChange) {
    if (!newPassword || newPassword.length < PASSWORD_MIN) {
      return { success: false, error: `Use at least ${PASSWORD_MIN} characters.` };
    }
    if (newPassword !== confirmPassword) {
      return { success: false, error: "Passwords don't match." };
    }
    if (!currentPassword) {
      return {
        success: false,
        error: "Enter your current password to set a new one.",
      };
    }

    // PROOF OF POSSESSION. An open session is not authorisation to change a
    // password: a borrowed laptop or a stolen cookie would otherwise be enough
    // to lock the real owner out of their own account.
    //
    // Verified by signing in with the supplied password on a fresh
    // cookie-scoped client. That is the only way to check a password through
    // Supabase — there is no verify endpoint — and it must NOT run on the
    // service client, which would bypass auth entirely and always succeed.
    const auth = await createClient();
    const { error: reauthErr } = await auth.auth.signInWithPassword({
      email: ctx.user.email,
      password: currentPassword,
    });
    if (reauthErr) {
      return { success: false, error: "That current password isn't right." };
    }
  }

  const emailChanged = email !== ctx.user.email.trim().toLowerCase();
  const service = createServiceClient();

  if (emailChanged) {
    // Same bounded collision pre-check the admin path uses, from the same
    // shared helper. An id match against THIS user is not a collision: it
    // means auth already holds the address and only a DB copy was stale.
    const existingId = await findAuthUserIdByEmail(email);
    if (existingId && existingId !== ctx.user.id) {
      return {
        success: false,
        error: "This email is already registered to another account.",
      };
    }
  }

  if (emailChanged || wantsPasswordChange) {
    const { error: authErr } = await service.auth.admin.updateUserById(ctx.user.id, {
      ...(emailChanged ? { email, email_confirm: true } : {}),
      ...(wantsPasswordChange ? { password: newPassword } : {}),
    });
    if (authErr) {
      return {
        success: false,
        error: describeAuthEmailFailure(
          "ai-dashboard/settings",
          { companyId: ctx.companyId, userId: ctx.user.id, email },
          authErr,
        ),
      };
    }
  }

  if (emailChanged) {
    // Keep the identity caches in step, exactly as the admin rename does.
    // company_members.email is this member's own copy; companies.contact_email
    // only belongs to the OWNER, so it is only touched on the owner's path.
    await service
      .from("company_members")
      .update({ email })
      .eq("company_id", ctx.companyId)
      .eq("user_id", ctx.user.id);

    if (ctx.role === "owner") {
      await service
        .from("companies")
        .update({ contact_email: email })
        .eq("id", ctx.companyId);
    }
  }

  revalidatePath("/ai-dashboard/settings");
  return { success: true, data: undefined };
}

/** Drop the logo and its stored object. Owner/admin, own company only. */
export async function removeCompanyLogo(): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");
  const service = createServiceClient();

  const existing = ctx.company.logo_path;
  const { error } = await service
    .from("companies")
    .update({ logo_path: null })
    .eq("id", ctx.companyId);
  if (error) return { success: false, error: error.message };

  // Object removal AFTER the column clears: an orphaned object is invisible
  // and cheap, whereas a cleared object with a live path renders a broken
  // image on the public profile.
  if (existing) {
    await service.storage.from(COMPANY_LOGO_BUCKET).remove([existing]);
  }

  revalidatePath("/ai-dashboard/settings");
  revalidatePath("/ai-dashboard");
  return { success: true, data: undefined };
}
