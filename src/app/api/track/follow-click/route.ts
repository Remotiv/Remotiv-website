import { NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Public counter endpoint for the "Follow Remotiv on LinkedIn" CTA on the
// apply-success modal. No auth, no PII — only source + platform + timestamp.
// The click handler on the client uses fetch(..., { keepalive: true }) so the
// request survives the navigation to LinkedIn; this route MUST never throw
// user-visible errors or delay the response path.
const ALLOWED_SOURCES = new Set(["apply_success_modal"]);
const ALLOWED_PLATFORMS = new Set(["linkedin"]);
const MAX_FIELD_LEN = 64;

function sanitize(
  value: unknown,
  allowed: Set<string>,
  fallback: string,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LEN) {
    return fallback;
  }
  return allowed.has(value) ? value : fallback;
}

export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(request, {
    bucketKey: "track-follow-click",
    max: 30,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    source?: unknown;
    platform?: unknown;
  };
  const source = sanitize(body.source, ALLOWED_SOURCES, "apply_success_modal");
  const platform = sanitize(body.platform, ALLOWED_PLATFORMS, "linkedin");

  try {
    const service = createServiceClient();
    const { error } = await service
      .from("social_follow_clicks")
      .insert({ source, platform });
    if (error) console.error("[social_follow_clicks insert]", error);
  } catch (err) {
    console.error("[social_follow_clicks insert]", err);
  }

  return new NextResponse(null, { status: 204 });
}
