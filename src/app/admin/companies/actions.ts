"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { isValidEmail } from "@/app/admin/lib/validators";
import type { CompanyStatus } from "@/app/ai-dashboard/lib/company-roles";

// ── Types ────────────────────────────────────────────────────
// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. CompanyStatus is therefore NOT re-exported
// here; consumers import it from @/app/ai-dashboard/lib/company-roles.

export type Company = {
  id: string;
  user_id: string | null;
  name: string;
  slug: string | null;
  contact_name: string | null;
  contact_email: string;
  website: string | null;
  status: CompanyStatus;
  created_at: string;
  member_count: number;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// ── Helpers ──────────────────────────────────────────────────

function isValidPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8;
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchCompanies(): Promise<Company[]> {
  await requireSuperAdmin();

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("companies")
    .select(`
      id, user_id, name, slug, contact_name, contact_email, website, status, created_at,
      members:company_members(id, status)
    `)
    .order("created_at", { ascending: false });

  type MemberRow = { id: string; status: string | null };
  type CompanyQueryRow = {
    id: string;
    user_id: string | null;
    name: string | null;
    slug: string | null;
    contact_name: string | null;
    contact_email: string | null;
    website: string | null;
    status: string | null;
    created_at: string | null;
    members: MemberRow[] | null;
  };

  return ((data ?? []) as CompanyQueryRow[]).map((r) => {
    const members = Array.isArray(r.members) ? r.members : [];
    return {
      id: r.id,
      user_id: r.user_id,
      name: r.name ?? "",
      slug: r.slug,
      contact_name: r.contact_name,
      contact_email: r.contact_email ?? "",
      website: r.website,
      status: ((r.status as CompanyStatus) ?? "active"),
      created_at: r.created_at ?? "",
      member_count: members.filter((m) => m.status === "active").length,
    };
  });
}

// ── Mutations ────────────────────────────────────────────────

export async function createCompany(input: {
  name: string;
  contact_name: string;
  contact_email: string;
  password: string;
}): Promise<MutationResult<{ id: string }>> {
  await requireSuperAdmin();

  const name = input.name?.trim() ?? "";
  const contact_name = input.contact_name?.trim() ?? "";
  const contact_email = input.contact_email?.trim().toLowerCase() ?? "";
  const password = input.password ?? "";

  if (!name) return { success: false, error: "Company name is required." };
  if (!isValidEmail(contact_email)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  if (!isValidPassword(password)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();

  // 1. Create the auth user. Failure here typically means the email is taken.
  const { data: created, error: authError } = await supabase.auth.admin.createUser({
    email: contact_email,
    password,
    email_confirm: true,
  });

  if (authError || !created?.user) {
    const msg = authError?.message ?? "Failed to create auth user.";
    if (/already|exists|registered/i.test(msg)) {
      return { success: false, error: "This email is already registered." };
    }
    return { success: false, error: msg };
  }

  const userId = created.user.id;

  // 2. Insert the companies row. If this fails, clean up the orphaned auth
  //    user so the email can be reused without manual intervention.
  //    must_change_password=true forces the owner through
  //    /ai-dashboard/change-password on first login.
  const { data: row, error: insertError } = await supabase
    .from("companies")
    .insert({
      user_id: userId,
      name,
      contact_name: contact_name || null,
      contact_email,
      status: "active",
      must_change_password: true,
    })
    .select("id")
    .single();

  if (insertError || !row) {
    await supabase.auth.admin.deleteUser(userId);
    if (insertError?.code === "23505") {
      return { success: false, error: "This email is already registered." };
    }
    return { success: false, error: insertError?.message ?? "Failed to insert company." };
  }

  const companyId = (row as { id: string }).id;

  // 3. Insert the owner membership row. company_members is the source of
  //    truth for tenant resolution, so a company without it would resolve
  //    only through the companies.user_id fallback — roll the whole
  //    provisioning back rather than leave a half-provisioned tenant.
  const { error: memberError } = await supabase.from("company_members").insert({
    company_id: companyId,
    user_id: userId,
    role: "owner",
    status: "active",
  });

  if (memberError) {
    await supabase.from("companies").delete().eq("id", companyId);
    await supabase.auth.admin.deleteUser(userId);
    if (memberError.code === "23505") {
      return { success: false, error: "This user is already a member of a company." };
    }
    return { success: false, error: memberError.message };
  }

  revalidatePath("/admin/companies");
  return { success: true, data: { id: companyId } };
}

export async function updateCompany(
  id: string,
  updates: {
    name?: string;
    contact_name?: string;
    contact_email?: string;
    status?: CompanyStatus;
  },
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  const patch: Record<string, unknown> = {};
  if (typeof updates.name === "string") patch.name = updates.name.trim();
  if (typeof updates.contact_name === "string") {
    patch.contact_name = updates.contact_name.trim();
  }
  if (updates.status) patch.status = updates.status;

  const supabase = createServiceClient();

  // Email edits must also swap the Supabase auth login email —
  // companies.contact_email and auth.users.email are seeded together at
  // create-time but nothing keeps them in sync afterwards, so a DB-only patch
  // would silently desync login. Order: validate → auth first (the likely
  // failure) → DB → best-effort auth rollback if the DB write fails after
  // auth already changed.
  let authEmailChanged = false;
  let rollbackUserId: string | null = null;
  let rollbackEmail: string | null = null;

  if (typeof updates.contact_email === "string" && updates.contact_email.trim().length > 0) {
    const newEmail = updates.contact_email.trim().toLowerCase();
    if (!isValidEmail(newEmail)) {
      return { success: false, error: "Please enter a valid email address." };
    }

    const { data: currentRow, error: fetchErr } = await supabase
      .from("companies")
      .select("user_id, contact_email")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return { success: false, error: fetchErr.message };
    const current = currentRow as { user_id: string | null; contact_email: string | null } | null;
    if (!current || !current.user_id) {
      return { success: false, error: "Company not found." };
    }

    const oldEmail = current.contact_email ?? "";
    if (oldEmail.toLowerCase() !== newEmail) {
      const { error: authErr } = await supabase.auth.admin.updateUserById(current.user_id, {
        email: newEmail,
        email_confirm: true,
      });
      if (authErr) {
        const msg = authErr.message ?? "Failed to update auth email.";
        if (/already|exists|registered/i.test(msg)) {
          return { success: false, error: "This email is already registered." };
        }
        return { success: false, error: msg };
      }
      authEmailChanged = true;
      rollbackUserId = current.user_id;
      rollbackEmail = oldEmail;
      patch.contact_email = newEmail;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { success: true, data: undefined };
  }

  const { error } = await supabase.from("companies").update(patch).eq("id", id);
  if (error) {
    if (authEmailChanged && rollbackUserId && rollbackEmail) {
      // Best-effort: put the auth email back so login and record don't
      // silently diverge. If the rollback itself fails there's nothing
      // sensible we can do from here — surface the original DB error.
      await supabase.auth.admin.updateUserById(rollbackUserId, {
        email: rollbackEmail,
        email_confirm: true,
      });
    }
    return { success: false, error: error.message };
  }

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}

export async function resetCompanyPassword(
  id: string,
  newPassword: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  if (!isValidPassword(newPassword)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();
  const { data: row, error: fetchErr } = await supabase
    .from("companies")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!row || !(row as { user_id: string | null }).user_id) {
    return { success: false, error: "Company has no linked auth user." };
  }

  const userId = (row as { user_id: string }).user_id;
  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) return { success: false, error: updateErr.message };

  // Re-arm the must-change gate so the owner is asked to pick their own
  // password the next time they sign in.
  await supabase
    .from("companies")
    .update({ must_change_password: true })
    .eq("id", id);

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}

export async function deleteCompany(id: string): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  const supabase = createServiceClient();

  // Resolve the auth user_id BEFORE deleting the companies row — once the row
  // is gone we lose the link.
  const { data: row } = await supabase
    .from("companies")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  const userId = (row as { user_id: string | null } | null)?.user_id ?? null;

  // Delete the companies row first; cascade in the schema removes
  // company_members. If this fails, abort before touching the auth user.
  const { error: delErr } = await supabase.from("companies").delete().eq("id", id);
  if (delErr) return { success: false, error: delErr.message };

  if (userId) {
    // Best-effort auth-user cleanup. We don't fail the action if this throws —
    // the companies row is already gone so the contract is fulfilled.
    await supabase.auth.admin.deleteUser(userId);
  }

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}
