import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";

export const runtime = "nodejs";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

// Token verification path (admin invite flow):
// The admin "Send Claim Email" button still creates a talent_claim_tokens row
// and emails the candidate a tokenized URL: /talent/login?token=xxx
// On that URL load, the login client posts here to (a) validate the token
// and (b) trigger signInWithOtp on the linked profile's email so the
// candidate receives an OTP code via Supabase.
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
  if (typeof token !== "string" || !token) {
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
    expires_at: string;
  };

  if (row.status === "claimed") {
    return NextResponse.json({ ok: false, reason: "already_claimed" });
  }
  if (new Date(row.expires_at) < new Date() || row.status === "expired") {
    return NextResponse.json({ ok: false, reason: "expired" });
  }

  // Look up the candidate's email from the linked profile
  const { data: profile } = await service
    .from(row.source_table)
    .select("email, first_name")
    .eq("id", row.candidate_id)
    .maybeSingle();

  const candidateEmail = (profile as { email: string | null } | null)?.email;
  if (!candidateEmail) {
    return NextResponse.json({ ok: false, reason: "no_email" });
  }

  const candidateFirstName =
    (profile as { first_name: string | null } | null)?.first_name ?? null;

  // Mark token as opened
  await service
    .from("talent_claim_tokens")
    .update({ status: "opened", opened_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending");

  // Return the email so the login client can call /api/claim/initiate
  // with it (which sends the OTP code). The candidate types the 6-digit
  // code into the same /talent/login UI.
  return NextResponse.json({
    ok: true,
    email: candidateEmail,
    firstName: candidateFirstName,
  });
}
