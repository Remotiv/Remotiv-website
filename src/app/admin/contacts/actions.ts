"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL, type UserRole } from "@/app/admin/lib/roles";

export type InquiryStatus = "new" | "in_progress" | "closed" | "archived";
export type InquiryType = "inquiry" | "booking";

export type Inquiry = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  service: string | null;
  message: string;
  status: InquiryStatus;
  admin_notes: string | null;
  created_at: string;
  // Booking-only fields (null for inquiries)
  preferred_date?: string | null;
  preferred_time?: string | null;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const STATUS_VALUES: ReadonlyArray<InquiryStatus> = [
  "new",
  "in_progress",
  "closed",
  "archived",
];

// ── Auth gates ───────────────────────────────────────────────

async function getAdminRole(): Promise<UserRole | null> {
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  if (user.email === SUPER_ADMIN_EMAIL) return "super_admin";

  const supabase = createServiceClient();
  const { data: roleRow } = await supabase
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();

  type AdminRow = { role: UserRole | null; status: string | null };
  const r = roleRow as AdminRow | null;
  if (!r || !r.role) return null;
  if (r.status && r.status !== "active") return null;
  return r.role;
}

async function requireAdmin(): Promise<UserRole> {
  const role = await getAdminRole();
  if (!role || (role !== "super_admin" && role !== "admin")) {
    throw new Error("Forbidden");
  }
  return role;
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchContactSubmissions(): Promise<Inquiry[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("contact_submissions")
    .select("id, name, email, company, service, message, status, admin_notes, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[contact_submissions] read failed:", error);
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: (r.name as string) ?? "",
    email: (r.email as string) ?? "",
    company: (r.company as string | null) ?? null,
    service: (r.service as string | null) ?? null,
    message: (r.message as string) ?? "",
    status: ((r.status as InquiryStatus) ?? "new"),
    admin_notes: (r.admin_notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  }));
}

export async function fetchBookings(): Promise<Inquiry[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("bookings")
    .select("id, full_name, email, company, service, message, preferred_date, preferred_time, status, admin_notes, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[bookings] read failed:", error);
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: (r.full_name as string) ?? "",
    email: (r.email as string) ?? "",
    company: (r.company as string | null) ?? null,
    service: (r.service as string | null) ?? null,
    message: ((r.message as string | null) ?? "") || "",
    preferred_date: (r.preferred_date as string | null) ?? null,
    preferred_time: (r.preferred_time as string | null) ?? null,
    status: ((r.status as InquiryStatus) ?? "new"),
    admin_notes: (r.admin_notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  }));
}

// ── Mutations ────────────────────────────────────────────────

function tableFor(type: InquiryType): "contact_submissions" | "bookings" {
  return type === "booking" ? "bookings" : "contact_submissions";
}

export async function updateInquiryStatus(
  id: string,
  type: InquiryType,
  newStatus: InquiryStatus,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  if (!STATUS_VALUES.includes(newStatus)) {
    return { success: false, error: "Invalid status" };
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from(tableFor(type))
    .update({ status: newStatus })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/contacts");
  return { success: true, data: undefined };
}

export async function updateInquiryNotes(
  id: string,
  type: InquiryType,
  notes: string,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from(tableFor(type))
    .update({ admin_notes: notes.trim() || null })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/contacts");
  return { success: true, data: undefined };
}

export async function deleteInquiry(
  id: string,
  type: InquiryType,
): Promise<MutationResult<undefined>> {
  const role = await requireAdmin();
  if (role !== "super_admin") {
    return { success: false, error: "Only super admin can delete." };
  }
  const supabase = createServiceClient();
  const { error } = await supabase.from(tableFor(type)).delete().eq("id", id);
  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/contacts");
  return { success: true, data: undefined };
}
