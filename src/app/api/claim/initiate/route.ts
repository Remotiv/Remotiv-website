import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";

export const runtime = "nodejs";

// Email collision check helper — talent emails must not collide with
// admin or client users (already enforced in Phases 1–3A).
async function emailHasAdminOrClientCollision(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<boolean> {
  const normalised = email.toLowerCase();
  try {
    const { data } = await service.auth.admin.listUsers({ perPage: 200 });
    const match = data?.users?.find(
      (u) => u.email?.toLowerCase() === normalised,
    );
    if (!match?.id) return false;

    const { data: adminRow } = await service
      .from("admin_users")
      .select("id")
      .eq("user_id", match.id)
      .maybeSingle();
    if (adminRow) return true;

    const { data: clientRow } = await service
      .from("clients")
      .select("id")
      .eq("user_id", match.id)
      .maybeSingle();
    if (clientRow) return true;

    return false;
  } catch (e) {
    console.error("[claim/initiate] collision check failed:", e);
    return false;
  }
}

const NEUTRAL_MESSAGE =
  "If we found a matching profile, you'll receive a 6-digit code shortly.";

export async function POST(request: Request) {
  const rl = rateLimit(request, {
    bucketKey: "claim-initiate",
    max: 5,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { email } = (body ?? {}) as { email?: unknown };
  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const normalisedEmail = email.trim().toLowerCase();
  const service = createServiceClient();

  if (await emailHasAdminOrClientCollision(service, normalisedEmail)) {
    return NextResponse.json({ ok: false, reason: "email_conflict" });
  }

  // Profile existence check — we only send a code if a profile exists.
  // Response stays neutral either way to prevent email enumeration.
  const { data: talentRow } = await service
    .from("talent_profiles")
    .select("id")
    .eq("email", normalisedEmail)
    .maybeSingle();

  let profileExists = Boolean(talentRow);
  if (!profileExists) {
    const { data: remoteRow } = await service
      .from("hire_remote_profiles")
      .select("id")
      .eq("email", normalisedEmail)
      .maybeSingle();
    profileExists = Boolean(remoteRow);
  }

  if (profileExists) {
    // signInWithOtp sends a 6-digit code via Supabase's configured SMTP
    // (Resend, in this project). Custom branding is set via the Supabase
    // Dashboard's "Magic Link" email template using the {{ .Token }} variable.
    // shouldCreateUser:true creates an auth.users row on first claim so
    // verifyOtp can succeed for first-time claimers.
    const supabase = await createClient();
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email: normalisedEmail,
      options: { shouldCreateUser: true },
    });
    if (otpErr) {
      console.error("[claim/initiate] signInWithOtp failed:", otpErr);
    }
  }

  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE });
}
