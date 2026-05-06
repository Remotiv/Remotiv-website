"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { notifyAllAdmins } from "@/lib/notifications";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";

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
  const fullName = trimRequired(data.full_name);
  if (!fullName) return { success: false, error: "Name is required." };
  const email = (data.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  const company = trimToNull(data.company);
  const service = trimToNull(data.service);
  const message = trimToNull(data.message);
  const preferredTime = trimToNull(data.preferred_time);

  const supabase = createServiceClient();

  const { error } = await supabase.from("bookings").insert({
    full_name: fullName,
    email,
    company,
    service,
    message,
    preferred_time: preferredTime,
  });

  if (error) {
    console.error("[submitBooking] Supabase error:", error);
    return { success: false, error: error.message };
  }

  // Fire-and-forget — don't block the user response.
  notifyAllAdmins({
    event_type: "new_inquiry",
    title: `New booking request from ${fullName}`,
    message: `${service ?? "Discovery call"}${preferredTime ? ` · ${preferredTime}` : ""}${company ? ` · ${company}` : ""}`,
    link: "/admin/contacts?tab=bookings",
    metadata: {
      kind: "booking",
      email,
      service,
      preferred_time: preferredTime,
    },
  }).catch((err) => {
    console.error("[submitBooking] notifyAllAdmins failed:", err);
  });

  return { success: true };
}
