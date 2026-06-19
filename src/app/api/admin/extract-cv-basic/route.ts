import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import {
  extractBasicFieldsFromCv,
  type ExtractedBasicFields,
} from "@/lib/cv-extract";

export const runtime = "nodejs";

// Discriminated-union response. Mirrors /api/admin/extract-cv's shape so the
// bulk-upload client can branch on `ok` and a string `reason` for soft
// failures (no_text / extraction_failed). True failures (auth, rate limit,
// malformed body, unexpected throw) come through as `ok: false`.
export type ExtractCvBasicResponse =
  | {
      ok: true;
      prefill: ExtractedBasicFields | null;
      reason?: "no_text" | "extraction_failed";
    }
  | {
      ok: false;
      error:
        | "rate_limited"
        | "not_authenticated"
        | "invalid_request"
        | "internal_error";
    };

export async function POST(request: Request) {
  // 1. Rate limit. Cap chosen to absorb a full 50-CV bulk-upload batch with
  //    10-row headroom; a sustained ~1/sec from the admin's sequential loop
  //    flows through, while abuse hits the cap immediately. Distinct bucket
  //    from "admin-extract-cv" (the rich Move-to-Talent endpoint, 20/min) so
  //    the two paths don't starve each other.
  const rl = rateLimit(request, {
    bucketKey: "extract-cv-basic",
    max: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" } satisfies ExtractCvBasicResponse,
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfter) },
      },
    );
  }

  // 2. Admin gate — try/catch → 401 JSON shape so the client always sees a
  //    discriminated-union response (not a thrown rejection).
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "not_authenticated",
      } satisfies ExtractCvBasicResponse,
      { status: 401 },
    );
  }

  // 3. Parse + validate body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request",
      } satisfies ExtractCvBasicResponse,
      { status: 400 },
    );
  }

  const { cvText } = (body ?? {}) as { cvText?: unknown };
  if (typeof cvText !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request",
      } satisfies ExtractCvBasicResponse,
      { status: 400 },
    );
  }

  // 4. Empty / whitespace-only CV text — short-circuit before paying for an
  //    AI call. The client falls back to regex (which will also produce
  //    mostly empty values, but at least the loop stays cheap).
  if (cvText.trim().length === 0) {
    return NextResponse.json({
      ok: true,
      prefill: null,
      reason: "no_text",
    } satisfies ExtractCvBasicResponse);
  }

  try {
    // 5. AI call. NEVER throws — null on any failure. The util applies its
    //    own CV_TEXT_INPUT_CAP so very long inputs are silently truncated.
    const prefill = await extractBasicFieldsFromCv(cvText);

    if (prefill === null) {
      return NextResponse.json({
        ok: true,
        prefill: null,
        reason: "extraction_failed",
      } satisfies ExtractCvBasicResponse);
    }

    return NextResponse.json({
      ok: true,
      prefill,
    } satisfies ExtractCvBasicResponse);
  } catch (err) {
    // Belt-and-braces — the util's never-throws contract makes this branch
    // unreachable in practice, but a safe 500 is preferable to an unhandled
    // rejection if that contract ever drifts.
    console.error("[admin/extract-cv-basic] internal error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "internal_error",
      } satisfies ExtractCvBasicResponse,
      { status: 500 },
    );
  }
}
