"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { isValidEmail, trimRequired } from "@/app/admin/lib/validators";

// ── Types ────────────────────────────────────────────────────

export type ClientStatus = "active" | "paused" | "archived";

export type Client = {
  id: string;
  user_id: string | null;
  company_name: string;
  contact_name: string | null;
  email: string;
  status: ClientStatus;
  created_at: string;
  batch_count: number;
  candidate_count: number;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// ── Helpers ──────────────────────────────────────────────────

function isValidPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8;
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchClients(): Promise<Client[]> {
  await requireSuperAdmin();

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("clients")
    .select(`
      id, user_id, company_name, contact_name, email, status, created_at,
      batches:client_batches(id, candidates:client_batch_candidates(id))
    `)
    .order("created_at", { ascending: false });

  type BatchRow = {
    id: string;
    candidates: Array<{ id: string }> | null;
  };
  type ClientRow = {
    id: string;
    user_id: string | null;
    company_name: string | null;
    contact_name: string | null;
    email: string | null;
    status: string | null;
    created_at: string | null;
    batches: BatchRow[] | null;
  };

  return ((data ?? []) as ClientRow[]).map((r) => {
    const batches = Array.isArray(r.batches) ? r.batches : [];
    const candidate_count = batches.reduce(
      (sum, b) => sum + (Array.isArray(b.candidates) ? b.candidates.length : 0),
      0,
    );
    return {
      id: r.id,
      user_id: r.user_id,
      company_name: r.company_name ?? "",
      contact_name: r.contact_name,
      email: r.email ?? "",
      status: ((r.status as ClientStatus) ?? "active"),
      created_at: r.created_at ?? "",
      batch_count: batches.length,
      candidate_count,
    };
  });
}

// ── Mutations ────────────────────────────────────────────────

export async function createClient(input: {
  company_name: string;
  contact_name: string;
  email: string;
  password: string;
}): Promise<MutationResult<{ id: string }>> {
  await requireSuperAdmin();

  const company_name = input.company_name?.trim() ?? "";
  const contact_name = input.contact_name?.trim() ?? "";
  const email = input.email?.trim().toLowerCase() ?? "";
  const password = input.password ?? "";

  if (!company_name) return { success: false, error: "Company name is required." };
  if (!contact_name) return { success: false, error: "Contact name is required." };
  if (!isValidEmail(email)) return { success: false, error: "Please enter a valid email address." };
  if (!isValidPassword(password)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();

  // 1. Create the auth user. Failure here typically means the email is taken.
  const { data: created, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError || !created?.user) {
    const msg = authError?.message ?? "Failed to create auth user.";
    if (/already|exists|registered/i.test(msg)) {
      return { success: false, error: "This email is already registered as a client." };
    }
    return { success: false, error: msg };
  }

  const userId = created.user.id;

  // 2. Insert the clients row. If this fails, clean up the orphaned auth user
  //    so the email can be reused without manual intervention.
  //    must_change_password=true marks the client as needing to set their
  //    own password on first login. (No /client/change-password page yet —
  //    flag is dormant on the client side; admins re-set it on resets.)
  const { data: row, error: insertError } = await supabase
    .from("clients")
    .insert({
      user_id: userId,
      company_name,
      contact_name,
      email,
      status: "active",
      must_change_password: true,
    })
    .select("id")
    .single();

  if (insertError || !row) {
    await supabase.auth.admin.deleteUser(userId);
    if (insertError?.code === "23505") {
      return { success: false, error: "This email is already registered as a client." };
    }
    return { success: false, error: insertError?.message ?? "Failed to insert client." };
  }

  revalidatePath("/admin/clients");
  return { success: true, data: { id: (row as { id: string }).id } };
}

export async function updateClient(
  id: string,
  updates: {
    company_name?: string;
    contact_name?: string;
    email?: string;
    status?: ClientStatus;
  },
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  const patch: Record<string, unknown> = {};
  if (typeof updates.company_name === "string") patch.company_name = updates.company_name.trim();
  if (typeof updates.contact_name === "string") patch.contact_name = updates.contact_name.trim();
  if (updates.status) patch.status = updates.status;

  const supabase = createServiceClient();

  // Email edits must also swap the Supabase auth login email — clients.email
  // and auth.users.email are seeded together at create-time but nothing
  // keeps them in sync afterwards, so a DB-only patch would silently
  // desync login. Order: validate → auth first (the likely failure) →
  // DB → best-effort auth rollback if the DB write fails after auth
  // already changed.
  let authEmailChanged = false;
  let rollbackUserId: string | null = null;
  let rollbackEmail: string | null = null;

  if (typeof updates.email === "string" && updates.email.trim().length > 0) {
    const newEmail = updates.email.trim().toLowerCase();
    if (!isValidEmail(newEmail)) {
      return { success: false, error: "Please enter a valid email address." };
    }

    const { data: currentRow, error: fetchErr } = await supabase
      .from("clients")
      .select("user_id, email")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return { success: false, error: fetchErr.message };
    const current = currentRow as { user_id: string | null; email: string | null } | null;
    if (!current || !current.user_id) {
      return { success: false, error: "Client not found." };
    }

    const oldEmail = current.email ?? "";
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
      patch.email = newEmail;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { success: true, data: undefined };
  }

  const { error } = await supabase.from("clients").update(patch).eq("id", id);
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

  revalidatePath("/admin/clients");
  return { success: true, data: undefined };
}

export async function resetClientPassword(
  id: string,
  newPassword: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  if (!isValidPassword(newPassword)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();
  const { data: row, error: fetchErr } = await supabase
    .from("clients")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!row || !(row as { user_id: string | null }).user_id) {
    return { success: false, error: "Client has no linked auth user." };
  }

  const userId = (row as { user_id: string }).user_id;
  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) return { success: false, error: updateErr.message };

  // Re-arm the must-change gate so the client is asked to pick their own
  // password the next time they sign in.
  await supabase
    .from("clients")
    .update({ must_change_password: true })
    .eq("id", id);

  revalidatePath("/admin/clients");
  return { success: true, data: undefined };
}

export async function deleteClient(id: string): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  const supabase = createServiceClient();

  // Resolve the auth user_id BEFORE deleting the clients row — once the row
  // is gone we lose the link.
  const { data: row } = await supabase
    .from("clients")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  const userId = (row as { user_id: string | null } | null)?.user_id ?? null;

  // Delete the clients row first; cascade in the schema removes batches and
  // candidates. If this fails, abort before touching the auth user.
  const { error: delErr } = await supabase.from("clients").delete().eq("id", id);
  if (delErr) return { success: false, error: delErr.message };

  if (userId) {
    // Best-effort auth-user cleanup. We don't fail the action if this throws —
    // the clients row is already gone so the contract is fulfilled.
    await supabase.auth.admin.deleteUser(userId);
  }

  revalidatePath("/admin/clients");
  return { success: true, data: undefined };
}
