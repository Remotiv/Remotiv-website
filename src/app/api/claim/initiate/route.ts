import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";
import { sendEmail } from "@/lib/email/send";
import {
  claimVerificationSubject,
  renderClaimVerificationEmail,
} from "@/lib/email/templates/claim-verification";

export const runtime = "nodejs";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://remotiv-website-m3jo.vercel.app";

const NEUTRAL_MESSAGE =
  "If we found a matching profile, you'll receive an email shortly.";

// Same collision check used by /api/claim/verify. Inlined (not extracted to a
// shared helper) because Phase 3A's scoping limits new files to the explicit
// list. Keep in sync with verify/route.ts if changing the rule.
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

  // Profile existence check. We only mint a magic link if a row exists in
  // either talent pool — but the response stays neutral either way so an
  // attacker can't enumerate registered emails from the API surface.
  const { data: talentRow } = await service
    .from("talent_profiles")
    .select("id, first_name")
    .eq("email", normalisedEmail)
    .maybeSingle();

  let firstName: string | null =
    (talentRow as { first_name: string | null } | null)?.first_name ?? null;
  let profileExists = Boolean(talentRow);
  if (!profileExists) {
    const { data: remoteRow } = await service
      .from("hire_remote_profiles")
      .select("id, first_name")
      .eq("email", normalisedEmail)
      .maybeSingle();
    profileExists = Boolean(remoteRow);
    if (remoteRow) {
      firstName =
        (remoteRow as { first_name: string | null }).first_name ?? null;
    }
  }

  if (profileExists) {
    // Mint a magic link via the admin API (no PKCE, deterministic) and send
    // the resulting actionLink through our branded Resend template. Errors
    // are logged but we still return the neutral success message so the
    // attacker model can't time-distinguish "email sent" from "no profile".
    const { data: linkData, error: linkErr } =
      await service.auth.admin.generateLink({
        type: "magiclink",
        email: normalisedEmail,
        options: {
          redirectTo: `${BASE_URL}/talent/verify`,
        },
      });

    if (linkErr || !linkData?.properties?.action_link) {
      console.error("[claim/initiate] generateLink failed:", linkErr);
    } else {
      const candidateName =
        firstName?.trim() || normalisedEmail.split("@")[0] || "there";
      sendEmail({
        to: normalisedEmail,
        subject: claimVerificationSubject,
        html: renderClaimVerificationEmail({
          candidateName,
          loginUrl: linkData.properties.action_link,
        }),
      }).catch((err) =>
        console.error("[claim/initiate] email send failed:", err),
      );
    }
  }

  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE });
}
