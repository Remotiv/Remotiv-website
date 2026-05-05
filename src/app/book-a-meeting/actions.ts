"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { notifyAllAdmins } from "@/lib/notifications";

export type BookingInput = {
  full_name: string;
  email: string;
  company: string;
  service: string;
  message: string;
  preferred_time: string;
};

type Result = { success: true } | { success: false; error: string };

export async function submitBooking(data: BookingInput): Promise<Result> {
  if (!data.full_name?.trim() || !data.email?.trim()) {
    return { success: false, error: "Name and email are required." };
  }

  const supabase = createServiceClient();

  const { error } = await supabase.from("bookings").insert({
    full_name: data.full_name.trim(),
    email: data.email.trim(),
    company: data.company?.trim() || null,
    service: data.service || null,
    message: data.message?.trim() || null,
    preferred_time: data.preferred_time || null,
  });

  if (error) {
    console.error("[submitBooking] Supabase error:", error);
    return { success: false, error: error.message };
  }

  await notifyAllAdmins({
    event_type: "new_inquiry",
    title: `New booking request from ${data.full_name.trim()}`,
    message: `${data.service || "Discovery call"}${data.preferred_time ? ` · ${data.preferred_time}` : ""}${data.company ? ` · ${data.company}` : ""}`,
    link: "/admin/contacts?tab=bookings",
    metadata: {
      kind: "booking",
      email: data.email.trim(),
      service: data.service,
      preferred_time: data.preferred_time,
    },
  });

  return { success: true };
}
