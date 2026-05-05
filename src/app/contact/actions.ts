"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { notifyAllAdmins } from "@/lib/notifications";

type ContactInput = {
  name: string;
  email: string;
  company: string;
  service: string;
  message: string;
};

type Result = { success: true } | { success: false; error: string };

export async function submitContact(data: ContactInput): Promise<Result> {
  // Service-role client bypasses RLS. Public form mutations have no
  // business being scoped to the visitor's session — every other server
  // action in this codebase follows the same pattern.
  const supabase = createServiceClient();

  const { error } = await supabase
    .from("contact_submissions")
    .insert({
      name: data.name,
      email: data.email,
      company: data.company || null,
      service: data.service || null,
      message: data.message,
    })
    .select()
    .single();

  if (error) {
    console.error("[submitContact] Supabase error:", error);
    return { success: false, error: error.message };
  }

  // Fire-and-forget notification to all admins.
  await notifyAllAdmins({
    event_type: "new_inquiry",
    title: `New inquiry from ${data.name}`,
    message: `${data.service || "General inquiry"}${data.company ? ` · ${data.company}` : ""} — "${data.message.slice(0, 120)}${data.message.length > 120 ? "…" : ""}"`,
    link: "/admin/contacts",
    metadata: { kind: "inquiry", email: data.email, service: data.service },
  });

  return { success: true };
}
