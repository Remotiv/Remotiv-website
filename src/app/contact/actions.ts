"use server";

import { headers } from "next/headers";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";
import { notifyAllAdmins } from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/server";

type ContactInput = {
  name: string;
  email: string;
  company: string;
  service: string;
  message: string;
  // Honeypot — bots fill this; legitimate browsers leave it blank.
  companyUrl?: string;
};

type Result = { success: true } | { success: false; error: string };

const GENERIC_ERROR =
  "We couldn't send your inquiry. Please try again or email us at talent@remotiv.work.";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

const FIELD_LIMITS = {
  name: 100,
  email: 254,
  company: 100,
  service: 50,
  message: 5000,
} as const;

// In-memory per-IP buckets. Best-effort only — resets on cold start.
// Stored on globalThis so HMR in dev doesn't double-register the map.
type Bucket = { count: number; resetAt: number };
type SCGlobal = typeof globalThis & {
  __submitContactBuckets?: Map<string, Bucket>;
};
const sc = globalThis as SCGlobal;
if (!sc.__submitContactBuckets) {
  sc.__submitContactBuckets = new Map();
}
const submitBuckets = sc.__submitContactBuckets;

async function getClientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = submitBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    submitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

export async function submitContact(data: ContactInput): Promise<Result> {
  // Honeypot: bots that auto-fill every input will populate this hidden
  // field; humans leave it empty. Silently pretend success so the bot
  // doesn't learn its submission was rejected.
  if (data.companyUrl && data.companyUrl.trim().length > 0) {
    return { success: true };
  }

  // Per-IP rate limit. The action is publicly callable; without this a
  // script can spam Supabase inserts.
  const ip = await getClientIp();
  if (!checkRateLimit(ip)) {
    return {
      success: false,
      error: "Too many submissions. Please wait a moment and try again.",
    };
  }

  // Reject oversize payloads before any further work. Returns a generic
  // error so a probing client can't enumerate per-field caps.
  if ((data.name ?? "").length > FIELD_LIMITS.name) {
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
    // Log full details server-side for diagnostics; return a generic
    // message to the client to avoid leaking DB internals.
    console.error("[submitContact] Supabase error:", error);
    return { success: false, error: GENERIC_ERROR };
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
