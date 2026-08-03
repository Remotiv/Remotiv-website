"use server";

import { headers } from "next/headers";
import { isValidEmail, trimRequired, trimToNull } from "@/lib/validators";
import { notifyAllAdmins } from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/server";

export type BookingInput = {
  full_name: string;
  email: string;
  company: string;
  service: string;
  message: string;
  preferred_time: string;
  // Honeypot — bots fill this; legitimate browsers leave it blank.
  companyUrl?: string;
};

type Result = { success: true } | { success: false; error: string };

const GENERIC_ERROR =
  "We couldn't book your call. Please try again or email us at talent@remotiv.work.";

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

const FIELD_LIMITS = {
  full_name: 100,
  email: 254,
  company: 100,
  service: 50,
  message: 5000,
  preferred_time: 50,
} as const;

const globalForRateLimit = globalThis as typeof globalThis & {
  __submitBookingBuckets?: Map<string, { count: number; resetAt: number }>;
};

if (!globalForRateLimit.__submitBookingBuckets) {
  globalForRateLimit.__submitBookingBuckets = new Map();
}

const rateBuckets = globalForRateLimit.__submitBookingBuckets;

async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return h.get("x-real-ip") ?? "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

export async function submitBooking(data: BookingInput): Promise<Result> {
  // Honeypot — silently succeed for bots that fill the hidden field
  if (data.companyUrl && data.companyUrl.trim().length > 0) {
    return { success: true };
  }

  // Per-IP rate limit
  const ip = await getClientIp();
  if (!checkRateLimit(ip)) {
    return {
      success: false,
      error: "Too many submissions. Please wait a moment and try again.",
    };
  }

  // Reject oversize payloads before any further work. Returns a generic
  // error so a probing client can't enumerate per-field caps.
  if ((data.full_name ?? "").length > FIELD_LIMITS.full_name) {
    return { success: false, error: GENERIC_ERROR };
  }
  if ((data.email ?? "").length > FIELD_LIMITS.email) {
    return { success: false, error: GENERIC_ERROR };
  }
  if ((data.company ?? "").length > FIELD_LIMITS.company) {
    return { success: false, error: GENERIC_ERROR };
  }
  if ((data.service ?? "").length > FIELD_LIMITS.service) {
    return { success: false, error: GENERIC_ERROR };
  }
  if ((data.message ?? "").length > FIELD_LIMITS.message) {
    return { success: false, error: GENERIC_ERROR };
  }
  if ((data.preferred_time ?? "").length > FIELD_LIMITS.preferred_time) {
    return { success: false, error: GENERIC_ERROR };
  }

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
    // Log full details server-side; return a generic message to the client.
    console.error("[submitBooking] Supabase error:", error);
    return { success: false, error: GENERIC_ERROR };
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
