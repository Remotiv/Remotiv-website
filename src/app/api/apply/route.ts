import { NextRequest, NextResponse } from "next/server";
import type { ScreeningQuestion } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";
import { extractPdfTextServer } from "@/lib/pdf-text";

// LinkedIn URL gate — applied to every submission regardless of `source`.
// Defense in depth: the bulk-upload UI already blocks invalid rows, but a
// direct API call (e.g. from a script) must not be able to slip through.
const LINKEDIN_URL_PATTERN = /linkedin\.com/i;

// jobId, when present, MUST be a real UUID. Otherwise it'd be interpolated
// directly into the storage path (folder = jobId ?? "manual"), allowing
// `../` or other injection patterns to escape the bucket layout.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defensive bounds against weaponised inputs:
//   - 5 MB raw PDF (matches the Supabase bucket upload limit)
//   - 100 KB extracted text (more than any real CV)
//   - per-text-field length caps below
const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 100;
const MAX_JOB_TITLE_LENGTH = 200;
const MAX_PHONE_LENGTH = 50;
const MAX_NOTES_LENGTH = 2000;

// Phase 2b — wizard fields. Caps mirror /api/talent/route.ts FIELD_MAX (29-46)
// so an applicant's payload is interchangeable with a /become-a-talent submit.
// Named APPLY_FIELD_MAX to avoid confusion with the existing MAX_* set above.
const APPLY_FIELD_MAX = {
  jobTitle: 200,
  roleCategory: 60,
  degree: 200,
  institution: 200,
  city: 100,
  country: 100,
  summary: 2000,
  skill: 50,
  expField: 200,
  experienceDescription: 1000,
};
const MAX_SKILLS = 30;
const MAX_EXPERIENCES = 30;

// Enum coercion sets — values match /api/talent/route.ts:55-62 verbatim so
// the same wizard pill choice validates the same way on both routes. Strategy
// (Option 2 from the audit): empty stays NULL; an unrecognised NON-empty value
// snaps to the default. The wizard's pills prevent invalid non-empty values in
// the happy path; this guards stale-cached clients + direct API calls.
const VALID_AVAILABILITY = ["Available Now", "Not Available"];
const DEFAULT_AVAILABILITY = "Available Now";
const VALID_WORK_TYPE = ["Full-time", "Part-time", "Contract", "Any"];
const DEFAULT_WORK_TYPE = "Full-time";
const VALID_NOTICE_PERIOD = ["Immediate", "2 Weeks", "1 Month", "Negotiable"];
const DEFAULT_NOTICE_PERIOD = "Immediate";
const VALID_WORK_LOCATION = ["Remote", "Hybrid", "Onsite"];
const DEFAULT_WORK_LOCATION = "Remote";

// Shared error message — never leaks Supabase/Postgres details to the client.
// Real failures are logged server-side via console.error.
const GENERIC_ERROR_MESSAGE = "Submission failed. Please try again.";
const GENERIC_INVALID_MESSAGE = "Invalid submission.";

// Storage bucket + DB table names — single source of truth.
const CV_BUCKET = "cvs";
const APPLICATIONS_TABLE = "job_applications";

function nullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Mirror of /api/talent/route.ts:70-74. Returns null on missing, non-string,
// or non-numeric input — so callers can clamp/null in one shape.
function intOrNull(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Mirror of /api/hire-remote-profiles/route.ts:40-49. Generic JSON parse with
// silent fallback — used for skills + employment_history. Garbage in / parse
// failure → fallback, never throws.
function safeJson<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "applicant";
}

// Rich, frozen-at-apply-time snapshot of the candidate's screening answers.
// Scored entirely against the SERVER's questions (source of truth) — only the
// answer string comes from the client. Pure + never-throws: bad/missing input
// yields answer:"" / matched:false. Mirrors the modal's matching exactly
// (yesno equal · numeric >= · multiple index-equal).
type ScreeningAnswerSnapshot = {
  question_id: string;
  question: string;
  type: "yesno" | "numeric" | "multiple";
  essential: boolean;
  ideal: string;
  answer: string;
  answer_label?: string;
  ideal_label?: string;
  matched: boolean;
};

function buildScreeningSnapshot(
  questions: ScreeningQuestion[],
  answerMap: Map<string, string>,
): ScreeningAnswerSnapshot[] {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  return questions.slice(0, 10).map((q) => {
    const answer = (answerMap.get(q.id) ?? "").trim();
    let matched = false;
    let answer_label: string | undefined;
    let ideal_label: string | undefined;

    if (q.type === "yesno") {
      matched = answer !== "" && answer === q.ideal;
    } else if (q.type === "numeric") {
      const a = Number(answer);
      const ideal = Number(q.ideal);
      matched = answer !== "" && Number.isFinite(a) && Number.isFinite(ideal) && a >= ideal;
    } else if (q.type === "multiple") {
      matched = answer !== "" && String(answer) === String(q.ideal);
      const ai = Number(answer);
      const ii = Number(q.ideal);
      const opts = Array.isArray(q.options) ? q.options : [];
      if (Number.isInteger(ai) && ai >= 0 && ai < opts.length) answer_label = opts[ai];
      if (Number.isInteger(ii) && ii >= 0 && ii < opts.length) ideal_label = opts[ii];
    }

    return {
      question_id: String(q.id),
      question: String(q.question ?? ""),
      type: q.type,
      essential: Boolean(q.essential),
      ideal: String(q.ideal ?? ""),
      answer,
      ...(answer_label !== undefined ? { answer_label } : {}),
      ...(ideal_label !== undefined ? { ideal_label } : {}),
      matched,
    };
  });
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "apply" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    const form = await request.formData();

    const jobId     = nullable(form.get("job_id"));
    const jobTitle  = nullable(form.get("job_title_manual"));
    const firstName = nullable(form.get("first_name"));
    const lastName  = nullable(form.get("last_name"));
    const rawEmail  = nullable(form.get("email"));
    const email     = rawEmail ? normalizeEmail(rawEmail) : null;
    const phone     = nullable(form.get("phone"));
    const linkedin  = nullable(form.get("linkedin_url"));
    const notes     = nullable(form.get("notes"));
    const cvText    = nullable(form.get("cv_text"));
    // Guard the `source` field: only accept the two known string values.
    const sourceRaw = form.get("source");
    const source: "job_application" | "manual_upload" =
      sourceRaw === "manual_upload" ? "manual_upload" : "job_application";
    // Guard the `cv` field: must be a File, not a string. A renamed field
    // (e.g. text) would otherwise type-assert through and crash on .size.
    const cvFieldValue = form.get("cv");
    const cvFile = cvFieldValue instanceof File ? cvFieldValue : null;

    if (!firstName || !cvFile) {
      return NextResponse.json(
        { error: "First name and CV are required." },
        { status: 400 },
      );
    }

    // Length caps on every user-supplied text field. Reject early — before
    // any DB read or storage write — so an attacker can't pad rows or stall
    // queries with multi-MB strings. Generic message so we don't tell them
    // which field tripped.
    if (
      firstName.length > MAX_NAME_LENGTH ||
      (lastName !== null && lastName.length > MAX_NAME_LENGTH) ||
      (jobTitle !== null && jobTitle.length > MAX_JOB_TITLE_LENGTH) ||
      (phone !== null && phone.length > MAX_PHONE_LENGTH) ||
      (notes !== null && notes.length > MAX_NOTES_LENGTH)
    ) {
      return NextResponse.json(
        { error: GENERIC_INVALID_MESSAGE },
        { status: 400 },
      );
    }

    // jobId, when present, MUST be a real UUID — see UUID_REGEX comment.
    if (jobId !== null && !UUID_REGEX.test(jobId)) {
      return NextResponse.json(
        { error: GENERIC_INVALID_MESSAGE },
        { status: 400 },
      );
    }

    // Email is optional on /apply (job application can be anonymised), but if
    // provided it must be a real-looking address — we use it for duplicate
    // detection and downstream contact.
    if (email !== null && !isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 },
      );
    }

    if (cvFile.size > MAX_CV_FILE_BYTES) {
      return NextResponse.json(
        { error: "CV file is too large (max 5 MB)." },
        { status: 413 },
      );
    }

    // Magic-byte check: PDF files start with "%PDF" (0x25 0x50 0x44 0x46).
    // Don't trust the client-supplied content type — a renamed .html or .exe
    // would otherwise sail through the upload step.
    const cvBuffer = Buffer.from(await cvFile.arrayBuffer());
    const isPdf =
      cvBuffer.length >= 4 &&
      cvBuffer[0] === 0x25 &&
      cvBuffer[1] === 0x50 &&
      cvBuffer[2] === 0x44 &&
      cvBuffer[3] === 0x46;
    if (!isPdf) {
      return NextResponse.json(
        { error: "Please upload a valid PDF file. Other file types are not accepted." },
        { status: 400 },
      );
    }

    // Server-side CV text extraction (unpdf). Prefer client-sent cv_text
    // (admin bulk upload still extracts in the browser); otherwise extract
    // from the PDF bytes we already have in cvBuffer. Double-wrapped so a
    // failure — including an unexpected module-load/runtime error — can
    // NEVER 500 or block the application. On any failure the row still
    // inserts with cv_text=null and a cv_text_status of 'failed'/'skipped'.
    let resolvedCvText: string | null = cvText;
    let cvTextStatus: "pending" | "completed" | "failed" | "skipped" = "pending";
    let cvTextError: string | null = null;

    if (resolvedCvText && resolvedCvText.trim()) {
      // Client (admin bulk) already supplied text — trust it, skip server extraction.
      cvTextStatus = "completed";
    } else {
      try {
        const result = await extractPdfTextServer(cvBuffer);
        resolvedCvText = result.text;
        cvTextStatus = result.status;
        cvTextError = result.error;
      } catch (err) {
        // Belt-and-braces: the helper is never-throws, but if the module
        // itself fails to load at runtime (the pdf-parse failure mode),
        // degrade gracefully here.
        console.error("[apply] cv extraction call failed:", err);
        resolvedCvText = null;
        cvTextStatus = "failed";
        cvTextError = "extract_call_failed";
      }
    }

    // Truncate parsed CV text before it ends up in Postgres / search blobs.
    const boundedCvText =
      resolvedCvText && resolvedCvText.length > MAX_CV_TEXT_LENGTH
        ? resolvedCvText.slice(0, MAX_CV_TEXT_LENGTH)
        : resolvedCvText;

    if (!linkedin || !LINKEDIN_URL_PATTERN.test(linkedin)) {
      return NextResponse.json(
        { error: "Valid LinkedIn URL required" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 0. Same-job duplicate check — only for public job applications. The admin
    //    "Manual Upload" flow already shows a soft warning panel and lets the
    //    admin opt in, so we don't want to block submissions there.
    //
    //    Bridge-flow change: dedup is now scoped to (email|phone, job_id).
    //    A candidate applying to the same job twice with the same email or
    //    phone is blocked; applying to a DIFFERENT job with the same details
    //    is allowed. This is required for the apply → become-a-talent bridge
    //    (we want repeat applicants across jobs to keep getting the bridge
    //    CTA on each application). Skip the check entirely when there's no
    //    job_id (manual-title submissions with placeholder job).
    if (source !== "manual_upload" && jobId !== null) {
      const normalizedPhone = normalizePhone(phone ?? "");

      // Email match — case-insensitive lookup scoped to this job.
      let emailMatch: { id: string; created_at: string | null } | null = null;
      if (email) {
        const { data } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id, created_at")
          .ilike("email", email.trim())
          .eq("job_id", jobId)
          .maybeSingle();
        emailMatch =
          (data as { id: string; created_at: string | null } | null) ?? null;
      }

      // Phone match — fetch a slice of recent rows for this job and
      // normalise in JS, since we can't apply normalizePhone in SQL without
      // a generated column.
      let phoneMatch: { id: string; created_at: string | null } | null = null;
      if (normalizedPhone.length >= 7) {
        const { data: phoneRecords } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id, phone, created_at")
          .eq("job_id", jobId)
          .not("phone", "is", null)
          .order("created_at", { ascending: false })
          .limit(100);

        const records = (phoneRecords ?? []) as Array<{
          id: string;
          phone: string | null;
          created_at: string | null;
        }>;
        const found = records.find(
          (r) => normalizePhone(r.phone ?? "") === normalizedPhone,
        );
        phoneMatch = found
          ? { id: found.id, created_at: found.created_at }
          : null;
      }

      const dupMatch = emailMatch ?? phoneMatch;
      if (dupMatch) {
        return NextResponse.json(
          {
            error: "duplicate_application",
            message: "You have already applied to this job.",
            appliedAt: dupMatch.created_at,
          },
          { status: 409 },
        );
      }
    }

    // 1. Upload CV to storage. K1: filename is a UUID — no PII in the path,
    //    no guessable timestamp/email pattern. Folder still groups by job for
    //    operational find-ability.
    const folder = jobId ?? "manual";
    const path = `${folder}/${crypto.randomUUID()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(CV_BUCKET)
      .upload(path, cvBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      console.error("[/api/apply] storage upload failed:", uploadError);
      return NextResponse.json(
        { error: GENERIC_ERROR_MESSAGE },
        { status: 500 },
      );
    }

    // 3. If a manual job title was typed, create a placeholder job and link it.
    //    Job title from a dropdown is referenced via job_id directly.
    let resolvedJobId: string | null = jobId;
    if (!resolvedJobId && jobTitle) {
      const { data: jobRow } = await supabase
        .from("jobs")
        .insert({
          title: jobTitle,
          company: "Manual Entry",
          company_rating: 0,
          location: "—",
          contract_type: "Full time",
          work_type: "Remote",
          category: "Other",
          experience_level: "Intermediate",
          language: "English",
          status: "closed",
        })
        .select("id")
        .single();
      resolvedJobId = (jobRow as { id?: string } | null)?.id ?? null;
    }

    // Screening questions — fetched from the SERVER job row (source of truth)
    // so scoring can't be spoofed by the client. job missing / no questions →
    // [] → snapshot []. Never throws.
    let serverScreeningQuestions: ScreeningQuestion[] = [];
    if (resolvedJobId) {
      const { data: jobQ } = await supabase
        .from("jobs")
        .select("screening_questions")
        .eq("id", resolvedJobId)
        .maybeSingle();
      const raw = (jobQ as { screening_questions?: unknown } | null)?.screening_questions;
      serverScreeningQuestions = Array.isArray(raw) ? (raw as ScreeningQuestion[]) : [];
    }

    // Phase 2b — parse the wizard's new fields just before the INSERT. Placed
    // AFTER the dedup + CV upload + placeholder-job blocks so a malformed
    // payload on these new fields can't waste a storage upload or trip the
    // dedup-by-email gate. None of these branches reject: empties stay NULL,
    // garbage enum values coerce to the safe default, JSON parse failures
    // fall back to []. This is intentional — the wizard's UI is the gate.
    const cap = (s: string | null, n: number): string | null =>
      s === null ? null : s.slice(0, n);

    const applicantJobTitle = cap(nullable(form.get("applicant_job_title")), APPLY_FIELD_MAX.jobTitle);
    const roleCategory      = cap(nullable(form.get("role_category")),       APPLY_FIELD_MAX.roleCategory);
    const degree            = cap(nullable(form.get("degree")),              APPLY_FIELD_MAX.degree);
    const institution       = cap(nullable(form.get("institution")),         APPLY_FIELD_MAX.institution);
    const city              = cap(nullable(form.get("city")),                APPLY_FIELD_MAX.city);
    const country           = cap(nullable(form.get("country")),             APPLY_FIELD_MAX.country);
    const summary           = cap(nullable(form.get("summary")),             APPLY_FIELD_MAX.summary);

    const yearsParsed = intOrNull(form.get("years_experience"));
    const yearsExperience = yearsParsed == null
      ? null
      : Math.max(0, Math.min(70, yearsParsed));

    const rawAvailability = nullable(form.get("availability"));
    const availability = rawAvailability
      ? (VALID_AVAILABILITY.includes(rawAvailability) ? rawAvailability : DEFAULT_AVAILABILITY)
      : null;

    const rawWorkType = nullable(form.get("work_type"));
    const workType = rawWorkType
      ? (VALID_WORK_TYPE.includes(rawWorkType) ? rawWorkType : DEFAULT_WORK_TYPE)
      : null;

    const rawNoticePeriod = nullable(form.get("notice_period"));
    const noticePeriod = rawNoticePeriod
      ? (VALID_NOTICE_PERIOD.includes(rawNoticePeriod) ? rawNoticePeriod : DEFAULT_NOTICE_PERIOD)
      : null;

    const rawWorkLocation = nullable(form.get("work_location"));
    const workLocation = rawWorkLocation
      ? (VALID_WORK_LOCATION.includes(rawWorkLocation) ? rawWorkLocation : DEFAULT_WORK_LOCATION)
      : null;

    const skillsRaw = safeJson<unknown>(form.get("skills"), []);
    const skills: string[] = Array.isArray(skillsRaw)
      ? (skillsRaw as unknown[])
          .filter((s): s is string => typeof s === "string")
          .slice(0, MAX_SKILLS)
          .map((s) => s.slice(0, APPLY_FIELD_MAX.skill))
      : [];

    type EmploymentEntry = {
      title: string;
      company: string;
      start: string;
      end: string;
      description: string;
      skills: string[];
    };
    const empRaw = safeJson<unknown>(form.get("employment_history"), []);
    const employmentHistory: EmploymentEntry[] = Array.isArray(empRaw)
      ? (empRaw as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
          .map((e) => ({
            title:       typeof e.title       === "string" ? (e.title as string).slice(0,       APPLY_FIELD_MAX.expField)              : "",
            company:     typeof e.company     === "string" ? (e.company as string).slice(0,     APPLY_FIELD_MAX.expField)              : "",
            start:       typeof e.start       === "string" ? (e.start as string).slice(0,       APPLY_FIELD_MAX.expField)              : "",
            end:         typeof e.end         === "string" ? (e.end as string).slice(0,         APPLY_FIELD_MAX.expField)              : "",
            description: typeof e.description === "string" ? (e.description as string).slice(0, APPLY_FIELD_MAX.experienceDescription) : "",
            skills: Array.isArray(e.skills)
              ? (e.skills as unknown[])
                  .filter((s): s is string => typeof s === "string")
                  .slice(0, MAX_SKILLS)
                  .map((s) => (s as string).slice(0, APPLY_FIELD_MAX.skill))
              : [],
          }))
          .filter((row) => row.title || row.company)
          .slice(0, MAX_EXPERIENCES)
      : [];

    // Screening answers — read the client's submitted answers (answer strings
    // only), key them by question id, then score against the server questions.
    // safeJson never throws; non-string ids/answers are coerced or skipped.
    const rawScreeningAnswers = safeJson<unknown>(form.get("screening_answers"), []);
    const screeningAnswerMap = new Map<string, string>();
    if (Array.isArray(rawScreeningAnswers)) {
      for (const item of rawScreeningAnswers) {
        if (item && typeof item === "object") {
          const id = (item as { id?: unknown }).id;
          const ans = (item as { answer?: unknown }).answer;
          if (typeof id === "string") {
            screeningAnswerMap.set(id, typeof ans === "string" ? ans : String(ans ?? ""));
          }
        }
      }
    }
    const screeningSnapshot = buildScreeningSnapshot(
      serverScreeningQuestions,
      screeningAnswerMap,
    );

    // 4. Insert application (service role bypasses RLS). We capture the
    //    inserted row id so the bridge-token issuance below can reference it
    //    via talent_claim_tokens.candidate_id.
    const { data: insertedRow, error: insertError } = await supabase
      .from(APPLICATIONS_TABLE)
      .insert({
        job_id: resolvedJobId,
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        linkedin_url: linkedin,
        cv_url: null,
        cv_path: path,
        cv_text: boundedCvText,
        cv_text_status: cvTextStatus,
        cv_text_error: cvTextError,
        status: "new",
        source,
        notes,
        applicant_job_title: applicantJobTitle,
        role_category:       roleCategory,
        years_experience:    yearsExperience,
        degree,
        institution,
        city,
        country,
        availability,
        work_type:           workType,
        notice_period:       noticePeriod,
        work_location:       workLocation,
        summary,
        skills,
        employment_history:  employmentHistory,
        screening_answers:   screeningSnapshot,
      })
      .select("id")
      .single();

    if (insertError || !insertedRow) {
      console.error("[/api/apply] DB insert failed:", insertError);
      // Rollback: the CV is already in storage but its DB row never landed.
      // Delete the orphaned object so storage doesn't accumulate junk PDFs.
      // Wrap the cleanup so its own failure can't mask the original 500.
      try {
        await supabase.storage.from(CV_BUCKET).remove([path]);
      } catch (cleanupErr) {
        // [CV_ORPHAN] is the production grep tag — search logs for this
        // marker to surface every storage object whose rollback failed.
        console.error(
          "[CV_ORPHAN][/api/apply] rollback delete failed",
          { path, bucket: CV_BUCKET, error: cleanupErr },
        );
      }
      return NextResponse.json(
        { error: GENERIC_ERROR_MESSAGE },
        { status: 500 },
      );
    }

    const applicationId = (insertedRow as { id: string }).id;

    // 5. Issue a bridge token so the success modal can offer
    //    "Complete your profile" → /become-a-talent?token=… . Reuses the
    //    talent_claim_tokens infrastructure with source_table='job_applications'
    //    (the source_table CHECK was widened to accept this value — see
    //    src/lib/supabase/schema.sql talent_claim_tokens migration).
    //
    //    Failure here MUST NOT fail the application. The candidate already
    //    successfully applied; we just can't offer the bridge. We log and
    //    fall through with bridgeToken=null. The success modal degrades
    //    gracefully to the original 3-second auto-close.
    let bridgeToken: string | null = null;
    try {
      const token =
        (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { error: tokenErr } = await supabase
        .from("talent_claim_tokens")
        .insert({
          token_hash: token,
          candidate_id: applicationId,
          source_table: "job_applications",
          status: "pending",
          expires_at: expiresAt,
        });
      if (tokenErr) {
        console.error(
          "[/api/apply] bridge token insert failed (non-fatal):",
          tokenErr,
        );
      } else {
        bridgeToken = token;
      }
    } catch (tokenThrow) {
      console.error(
        "[/api/apply] bridge token threw (non-fatal):",
        tokenThrow,
      );
    }

    return NextResponse.json({
      success: true,
      applicationId,
      bridgeToken,
    });
  } catch (err) {
    console.error("[/api/apply] unexpected error:", err);
    return NextResponse.json(
      { error: GENERIC_ERROR_MESSAGE },
      { status: 500 },
    );
  }
}
