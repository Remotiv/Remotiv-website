import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";

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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "applicant";
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

    // Truncate parsed CV text before it ends up in Postgres / search blobs.
    const boundedCvText =
      cvText && cvText.length > MAX_CV_TEXT_LENGTH
        ? cvText.slice(0, MAX_CV_TEXT_LENGTH)
        : cvText;

    if (!linkedin || !LINKEDIN_URL_PATTERN.test(linkedin)) {
      return NextResponse.json(
        { error: "Valid LinkedIn URL required" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 0. Hard duplicate check — only for public job applications. The admin
    //    "Manual Upload" flow already shows a soft warning panel and lets the
    //    admin opt in, so we don't want to block submissions there.
    if (source !== "manual_upload") {
      const normalizedPhone = normalizePhone(phone ?? "");

      // Email match — direct equality on a (presumably) unique column
      let emailMatch: { id: string } | null = null;
      if (email) {
        const { data } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id")
          .eq("email", email)
          .maybeSingle();
        emailMatch = (data as { id: string } | null) ?? null;
      }

      // Phone match — fetch a slice of recent rows and normalise in JS,
      // since we can't apply normalizePhone in SQL without a generated column.
      let phoneMatch: { id: string } | null = null;
      if (normalizedPhone.length >= 7) {
        const { data: phoneRecords } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id, phone")
          .not("phone", "is", null)
          .order("created_at", { ascending: false })
          .limit(100);

        const records = (phoneRecords ?? []) as Array<{ id: string; phone: string | null }>;
        const found = records.find(
          (r) => normalizePhone(r.phone ?? "") === normalizedPhone,
        );
        phoneMatch = found ? { id: found.id } : null;
      }

      if (emailMatch || phoneMatch) {
        return NextResponse.json(
          {
            error: "duplicate",
            message: "Your profile and CV already exist in our system. We will be in touch soon!",
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

    // 2. Get public URL
    const { data: urlData } = supabase.storage.from(CV_BUCKET).getPublicUrl(path);
    const cvUrl = urlData.publicUrl;

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

    // 4. Insert application (service role bypasses RLS)
    const { error: insertError } = await supabase.from(APPLICATIONS_TABLE).insert({
      job_id: resolvedJobId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      linkedin_url: linkedin,
      cv_url: cvUrl,
      cv_path: path,
      cv_text: boundedCvText,
      status: "new",
      source,
      notes,
    });

    if (insertError) {
      console.error("[/api/apply] DB insert failed:", insertError);
      // Rollback: the CV is already in storage but its DB row never landed.
      // Delete the orphaned object so storage doesn't accumulate junk PDFs.
      // Wrap the cleanup so its own failure can't mask the original 500.
      try {
        await supabase.storage.from(CV_BUCKET).remove([path]);
      } catch (cleanupErr) {
        console.error(
          "[/api/apply] rollback delete failed (CV orphaned at",
          path,
          "):",
          cleanupErr,
        );
      }
      return NextResponse.json(
        { error: GENERIC_ERROR_MESSAGE },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[/api/apply] unexpected error:", err);
    return NextResponse.json(
      { error: GENERIC_ERROR_MESSAGE },
      { status: 500 },
    );
  }
}
