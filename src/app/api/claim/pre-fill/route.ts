import { NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/server";

// Bridge endpoint for the apply → become-a-talent flow. Verifies a
// single-use token issued by /api/apply, marks it as opened, and returns
// the source job_application's contact fields so the client can pre-fill
// the talent form. cv_path/cv_text are NEVER returned to the client; the
// /api/talent route looks them up server-side at submit time using the
// same token (defense in depth — a tampered client can't lie about CV
// provenance).

export async function POST(request: Request) {
  // Parity with /api/claim/initiate (5/min) and /api/claim/verify (10/min).
  // 10/min matches verify since pre-fill runs once per form mount alongside
  // verify in normal flows; a higher cap would let a tampered client probe
  // tokens at scale.
  const rl = rateLimit(request, {
    bucketKey: "claim-prefill",
    max: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let token: string | undefined;
  try {
    const body = (await request.json()) as { token?: unknown };
    if (typeof body?.token === "string") token = body.token;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!token || typeof token !== "string" || token.length !== 64) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: tokenRow } = await service
    .from("talent_claim_tokens")
    .select("id, candidate_id, source_table, status, expires_at")
    .eq("token_hash", token)
    .eq("source_table", "job_applications")
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.json({ error: "token_not_found" }, { status: 404 });
  }

  const row = tokenRow as {
    id: string;
    candidate_id: string;
    source_table: string;
    status: string;
    expires_at: string;
  };

  if (new Date(row.expires_at) < new Date()) {
    return NextResponse.json({ error: "token_expired" }, { status: 410 });
  }

  if (row.status === "claimed") {
    return NextResponse.json({ error: "token_already_used" }, { status: 410 });
  }

  const { data: app } = await service
    .from("job_applications")
    .select("first_name, last_name, email, phone, linkedin_url, cv_path")
    .eq("id", row.candidate_id)
    .maybeSingle();

  if (!app) {
    return NextResponse.json(
      { error: "application_not_found" },
      { status: 404 },
    );
  }

  // Idempotently mark as opened (first-time only). Subsequent pre-fill
  // hits on an already-opened token still succeed — the candidate may
  // refresh the form mid-fill.
  if (row.status === "pending") {
    await service
      .from("talent_claim_tokens")
      .update({
        status: "opened",
        opened_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }

  const application = app as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    linkedin_url: string | null;
    cv_path: string | null;
  };

  return NextResponse.json({
    success: true,
    prefill: {
      firstName: application.first_name ?? "",
      lastName: application.last_name ?? "",
      email: application.email ?? "",
      phone: application.phone ?? "",
      linkedinUrl: application.linkedin_url ?? "",
      // hasCv is a UI marker — the client shows "CV from your application
      // will be used". The actual cv_path + cv_text are pulled from the
      // job_application row server-side at /api/talent submit time.
      hasCv: Boolean(application.cv_path),
    },
  });
}
