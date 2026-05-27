import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";

export const runtime = "nodejs";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://remotiv-website-m3jo.vercel.app";

// Looks up the (possibly-existing) auth.users row for an email and, if found,
// returns true iff that user_id has a row in admin_users OR clients. We can't
// query admin_users / clients directly by email because neither table has an
// email column — emails live in auth.users. The notifications module uses the
// same listUsers approach for the super-admin lookup.
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
    // If listUsers fails for any reason, fail open (assume no collision) and
    // log — refusing every login on a transient Supabase admin-API hiccup
    // would be worse than the rare false-negative collision.
    console.error("[claim/verify] collision check failed:", e);
    return false;
  }
}

export async function POST(request: Request) {
  const rl = rateLimit(request, {
    bucketKey: "claim-verify",
    max: 10,
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

  const { token } = (body ?? {}) as { token?: unknown };
  if (typeof token !== "string" || token.length === 0 || token.length > 200) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: tokenRow } = await service
    .from("talent_claim_tokens")
    .select("id, candidate_id, source_table, status, expires_at")
    .eq("token_hash", token)
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  const row = tokenRow as {
    id: string;
    candidate_id: string;
    source_table: SourceTable;
    status: string;
    expires_at: string | null;
  };

  if (row.status === "claimed") {
    return NextResponse.json({ ok: false, reason: "already_claimed" });
  }

  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (row.status === "expired" || expiresAtMs < Date.now()) {
    return NextResponse.json({ ok: false, reason: "expired" });
  }

  const { data: profile } = await service
    .from(row.source_table)
    .select("email, first_name")
    .eq("id", row.candidate_id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  const profileRow = profile as {
    email: string | null;
    first_name: string | null;
  };
  const candidateEmail = profileRow.email?.trim();
  if (!candidateEmail) {
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  if (await emailHasAdminOrClientCollision(service, candidateEmail)) {
    return NextResponse.json({ ok: false, reason: "email_conflict" });
  }

  // Mark the token as opened (status='opened', opened_at=now) — only if still
  // pending. If already opened from a prior click, leave it alone.
  await service
    .from("talent_claim_tokens")
    .update({ status: "opened", opened_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending");

  const { data: linkData, error: linkErr } =
    await service.auth.admin.generateLink({
      type: "magiclink",
      email: candidateEmail,
      options: {
        redirectTo: `${BASE_URL}/auth/callback?next=/talent/dashboard`,
      },
    });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error("[claim/verify] generateLink failed:", linkErr);
    return NextResponse.json({ ok: false, reason: "auth_error" });
  }

  return NextResponse.json({
    ok: true,
    email: candidateEmail,
    firstName: profileRow.first_name ?? null,
    actionLink: linkData.properties.action_link,
  });
}
