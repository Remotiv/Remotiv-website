"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { notifyAllAdmins } from "@/lib/notifications";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";

type ContactInput = {
  name: string;
  email: string;
  company: string;
  service: string;
  message: string;
};

type Result = { success: true } | { success: false; error: string };

export async function submitContact(data: ContactInput): Promise<Result> {
  const name = trimRequired(data.name);
  if (!name) return { success: false, error: "Name is required." };
  const email = (data.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  const message = trimRequired(data.message);
  if (!message) return { success: false, error: "Message is required." };
  const company = trimToNull(data.company);
  const service = trimToNull(data.service);

  // Service-role client bypasses RLS. Public form mutations have no
  // business being scoped to the visitor's session — every other server
  // action in this codebase follows the same pattern.
  const supabase = createServiceClient();

  const { error } = await supabase
    .from("contact_submissions")
    .insert({
      name,
      email,
      company,
      service,
      message,
    })
    .select()
    .single();

  if (error) {
    console.error("[submitContact] Supabase error:", error);
    return { success: false, error: error.message };
  }

  // Fire-and-forget notification to all admins. Don't block the user
  // response on the listUsers + insert round-trip.
  notifyAllAdmins({
    event_type: "new_inquiry",
    title: `New inquiry from ${name}`,
    message: `${service ?? "General inquiry"}${company ? ` · ${company}` : ""} — "${message.slice(0, 120)}${message.length > 120 ? "…" : ""}"`,
    link: "/admin/contacts",
    metadata: { kind: "inquiry", email, service },
  }).catch((err) => {
    console.error("[submitContact] notifyAllAdmins failed:", err);
  });

  return { success: true };
}
