import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/server";
import {
  extractTalentFieldsFromCv,
  type ExtractedTalentFields,
} from "@/lib/cv-extract";
import { adminApplicationScope } from "@/lib/admin-scope";

export const runtime = "nodejs";

// Vercel: allow up to 60s for the Haiku CV extraction (default Hobby limit
// ~10s kills the ~15s call). Admin-only action; a longer ceiling is
// acceptable here.
export const maxDuration = 60;

const UUID_REGEX = /^[0-9a-fA-F-]{36}$/;

// Discriminated-union response. Phase B client code reads `ok` to decide
// whether to seed the modal from `prefill` or open it blank.
export type ExtractCvResponse =
  | {
      ok: true;
      prefill: ExtractedTalentFields | null;
      reason?: "no_cv" | "extraction_failed";
      cached?: boolean;
    }
  | {
      ok: false;
      error:
        | "rate_limited"
        | "not_authenticated"
        | "invalid_request"
        | "not_found"
        | "internal_error";
    };

const VALID_AVAILABILITY = ["Available Now", "Not Available"] as const;
const VALID_WORK_TYPE = ["Full-time", "Part-time", "Contract", "Any"] as const;
const VALID_NOTICE_PERIOD = [
  "Immediate",
  "2 Weeks",
  "1 Month",
  "Negotiable",
] as const;
const VALID_WORK_LOCATION = ["Remote", "Hybrid", "Onsite"] as const;

function isPopulatedString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isPopulatedArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function coerceEnum<T extends string>(
  v: unknown,
  valid: ReadonlyArray<T>,
): T | null {
  if (typeof v !== "string") return null;
  return (valid as ReadonlyArray<string>).includes(v) ? (v as T) : null;
}

// Build an ExtractedTalentFields object from a `job_applications` row whose
// 14 columns are already populated (i.e. cache-hit). Per-field shape mirrors
// what extractTalentFieldsFromCv would return so the client wires the same
// way for fresh vs cached results.
function rowToPrefill(row: Record<string, unknown>): ExtractedTalentFields {
  return {
    applicant_job_title: isPopulatedString(row.applicant_job_title)
      ? (row.applicant_job_title as string)
      : null,
    role_category: isPopulatedString(row.role_category)
      ? (row.role_category as string)
      : null,
    years_experience:
      typeof row.years_experience === "number" ? row.years_experience : null,
    degree: isPopulatedString(row.degree) ? (row.degree as string) : null,
    institution: isPopulatedString(row.institution)
      ? (row.institution as string)
      : null,
    city: isPopulatedString(row.city) ? (row.city as string) : null,
    country: isPopulatedString(row.country) ? (row.country as string) : null,
    summary: isPopulatedString(row.summary) ? (row.summary as string) : null,
    availability: coerceEnum(row.availability, VALID_AVAILABILITY),
    work_type: coerceEnum(row.work_type, VALID_WORK_TYPE),
    notice_period: coerceEnum(row.notice_period, VALID_NOTICE_PERIOD),
    work_location: coerceEnum(row.work_location, VALID_WORK_LOCATION),
    skills: Array.isArray(row.skills)
      ? (row.skills as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    employment_history: Array.isArray(row.employment_history)
      ? (row.employment_history as unknown[])
          .filter(
            (e): e is Record<string, unknown> => !!e && typeof e === "object",
          )
          .map((e) => ({
            title: typeof e.title === "string" ? e.title : "",
            company: typeof e.company === "string" ? e.company : "",
            start: typeof e.start === "string" ? e.start : "",
            end: typeof e.end === "string" ? e.end : "",
            description:
              typeof e.description === "string" ? e.description : "",
            skills: Array.isArray(e.skills)
              ? (e.skills as unknown[]).filter(
                  (s): s is string => typeof s === "string",
                )
              : [],
          }))
      : [],
  };
}

export async function POST(request: Request) {
  // 1. Rate limit — same shape as /api/admin/send-invite.
  const rl = rateLimit(request, {
    bucketKey: "admin-extract-cv",
    max: 20,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" } satisfies ExtractCvResponse,
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
      { ok: false, error: "not_authenticated" } satisfies ExtractCvResponse,
      { status: 401 },
    );
  }

  // 3. Parse + validate body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_request" } satisfies ExtractCvResponse,
      { status: 400 },
    );
  }

  const { applicationId } = (body ?? {}) as { applicationId?: unknown };
  if (typeof applicationId !== "string" || !UUID_REGEX.test(applicationId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_request" } satisfies ExtractCvResponse,
      { status: 400 },
    );
  }

  try {
    const service = createServiceClient();

    // 4. Load the row — the 14 wizard columns + cv_text.
    const { data: row } = await service
      .from("job_applications")
      .select(
        "id, cv_text, applicant_job_title, role_category, years_experience, degree, institution, city, country, summary, availability, work_type, notice_period, work_location, skills, employment_history",
      )
      .eq("id", applicationId)
      // Remotiv must not run CV extraction over a company's applicant data.
      .or(await adminApplicationScope())
      .maybeSingle();

    if (!row) {
      return NextResponse.json(
        { ok: false, error: "not_found" } satisfies ExtractCvResponse,
        { status: 404 },
      );
    }

    const r = row as Record<string, unknown>;

    // 5. Cache check — a row is "already extracted" only when the AI-derived
    //    fields are present. We key on summary + skills because the AI always
    //    writes both on success. This prevents a half-filled row (e.g. a bulk
    //    import that set only applicant_job_title) from being mistaken for a
    //    completed extraction — such rows must fall through to the AI so
    //    every field gets populated.
    const cached =
      isPopulatedString(r.summary) && isPopulatedArray(r.skills);

    if (cached) {
      return NextResponse.json({
        ok: true,
        prefill: rowToPrefill(r),
        cached: true,
      } satisfies ExtractCvResponse);
    }

    // 6. No cv_text → no AI possible. Modal opens blank.
    if (!isPopulatedString(r.cv_text)) {
      return NextResponse.json({
        ok: true,
        prefill: null,
        reason: "no_cv",
      } satisfies ExtractCvResponse);
    }

    // 7. Call the AI util. It NEVER throws — null on any failure.
    const prefill = await extractTalentFieldsFromCv(r.cv_text as string);
    if (prefill === null) {
      return NextResponse.json({
        ok: true,
        prefill: null,
        reason: "extraction_failed",
      } satisfies ExtractCvResponse);
    }

    // 8. Cache write — best-effort, fire-and-forget. If this errors, the
    //    move flow still works (the modal already has the prefill in hand).
    //    Logged but never surfaced to the client.
    service
      .from("job_applications")
      .update({
        applicant_job_title: prefill.applicant_job_title,
        role_category: prefill.role_category,
        years_experience: prefill.years_experience,
        degree: prefill.degree,
        institution: prefill.institution,
        city: prefill.city,
        country: prefill.country,
        summary: prefill.summary,
        availability: prefill.availability,
        work_type: prefill.work_type,
        notice_period: prefill.notice_period,
        work_location: prefill.work_location,
        skills: prefill.skills,
        employment_history: prefill.employment_history,
      })
      .eq("id", applicationId)
      .then(({ error }) => {
        if (error) {
          console.error("[admin/extract-cv] cache write failed", error);
        }
      });

    // 9. Return the fresh extraction.
    return NextResponse.json({
      ok: true,
      prefill,
    } satisfies ExtractCvResponse);
  } catch (err) {
    // Belt-and-braces — any unexpected throw becomes a safe 500 so the
    // client opens a blank modal rather than seeing an unhandled rejection.
    console.error("[admin/extract-cv] internal error", err);
    return NextResponse.json(
      { ok: false, error: "internal_error" } satisfies ExtractCvResponse,
      { status: 500 },
    );
  }
}
