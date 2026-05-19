import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";
import { requireAdmin } from "@/app/admin/lib/role-guards";

/**
 * POST /api/batch-candidate-cv
 *
 * Uploads ONE CV file to Supabase storage and inserts ONE row into
 * client_batch_candidates. Called per-row by the batch-detail bulk upload
 * modal — keeps the logic parallel to /api/apply (which is the same shape
 * for job_applications), but writes to the batch's candidate table instead.
 *
 * Auth: requireAdmin (a public visitor has no business adding candidates
 * to a client's batch).
 *
 * Body (multipart):
 *   - batch_id   (string, required)
 *   - first_name (string, required)
 *   - last_name  (string, optional)
 *   - email      (string, required and validated)
 *   - phone      (string, optional)
 *   - linkedin_url (string, required) — same gate as /api/apply
 *   - position   (string, optional) — stored in position_applied
 *   - cv         (File, required) — magic-byte checked
 *   - cv_text    (string, optional) — pre-extracted text for full-text search
 */

const MAX_CV_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 100_000;
const LINKEDIN_URL_PATTERN = /linkedin\.com/i;

function nullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "candidate"
  );
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "batch-candidate-cv" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const form = await request.formData();

    const batchId   = nullable(form.get("batch_id"));
    const firstName = nullable(form.get("first_name"));
    const lastName  = nullable(form.get("last_name"));
    const rawEmail  = nullable(form.get("email"));
    const email     = rawEmail ? rawEmail.toLowerCase() : null;
    const phone     = nullable(form.get("phone"));
    const linkedin  = nullable(form.get("linkedin_url"));
    const position  = nullable(form.get("position"));
    const cvText    = nullable(form.get("cv_text"));
    const cvFile    = form.get("cv") as File | null;

    if (!batchId) {
      return NextResponse.json({ error: "batch_id is required." }, { status: 400 });
    }
    if (!firstName || !cvFile) {
      return NextResponse.json(
        { error: "First name and CV are required." },
        { status: 400 },
      );
    }
    if (!email || !isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 },
      );
    }
    if (!linkedin || !LINKEDIN_URL_PATTERN.test(linkedin)) {
      return NextResponse.json(
        { error: "Valid LinkedIn URL required" },
        { status: 400 },
      );
    }
    if (cvFile.size > MAX_CV_FILE_BYTES) {
      return NextResponse.json(
        { error: "CV file is too large (max 10 MB)." },
        { status: 413 },
      );
    }

    // Magic-byte check: PDF starts with "%PDF" (0x25 0x50 0x44 0x46).
    const cvBuffer = Buffer.from(await cvFile.arrayBuffer());
    const isPdf =
      cvBuffer.length >= 4 &&
      cvBuffer[0] === 0x25 &&
      cvBuffer[1] === 0x50 &&
      cvBuffer[2] === 0x44 &&
      cvBuffer[3] === 0x46;
    if (!isPdf) {
      return NextResponse.json(
        { error: "Please upload a valid PDF file." },
        { status: 400 },
      );
    }

    const boundedCvText =
      cvText && cvText.length > MAX_CV_TEXT_LENGTH
        ? cvText.slice(0, MAX_CV_TEXT_LENGTH)
        : cvText;

    const supabase = createServiceClient();

    // 1. Cross-table duplicate check — same email OR phone in any of:
    //    client_batch_candidates (any batch), job_applications, talent_profiles.
    //    The check runs BEFORE the storage upload so we don't leave orphan
    //    CV files in the bucket when a duplicate is rejected.
    //
    //    Order matters: batch candidates first (most specific to this flow),
    //    then applications, then talent. We surface the first match and stop;
    //    the modal renders a friendly badge based on `source`.
    const orParts: string[] = [];
    if (email) orParts.push(`email.eq.${email}`);
    if (phone) orParts.push(`phone.eq.${phone}`);
    if (orParts.length > 0) {
      const orFilter = orParts.join(",");

      const { data: batchHit } = await supabase
        .from("client_batch_candidates")
        .select("id, first_name, last_name")
        .or(orFilter)
        .limit(1)
        .maybeSingle();
      if (batchHit) {
        const hit = batchHit as { id: string; first_name: string; last_name: string };
        return NextResponse.json(
          {
            error: "Duplicate",
            details: `Already exists in another batch: ${hit.first_name} ${hit.last_name}`.trim(),
            source: "batch",
            existingId: hit.id,
          },
          { status: 409 },
        );
      }

      const { data: appHit } = await supabase
        .from("job_applications")
        .select("id, first_name, last_name")
        .or(orFilter)
        .limit(1)
        .maybeSingle();
      if (appHit) {
        const hit = appHit as { id: string; first_name: string; last_name: string };
        return NextResponse.json(
          {
            error: "Duplicate",
            details: `Already exists in Applications: ${hit.first_name} ${hit.last_name}`.trim(),
            source: "application",
            existingId: hit.id,
          },
          { status: 409 },
        );
      }

      const { data: talentHit } = await supabase
        .from("talent_profiles")
        .select("id, first_name, last_name")
        .or(orFilter)
        .limit(1)
        .maybeSingle();
      if (talentHit) {
        const hit = talentHit as { id: string; first_name: string; last_name: string };
        return NextResponse.json(
          {
            error: "Duplicate",
            details: `Already exists in Talent: ${hit.first_name} ${hit.last_name}`.trim(),
            source: "talent",
            existingId: hit.id,
          },
          { status: 409 },
        );
      }
    }

    // 2. Upload CV to storage. K1: filename is a UUID — no PII in the path.
    //    Folder still groups by batchId so admin tooling can locate files.
    const path = `batch/${batchId}/${crypto.randomUUID()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("cvs")
      .upload(path, cvBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("cvs").getPublicUrl(path);
    const cvUrl = urlData.publicUrl;

    // 3. Insert into client_batch_candidates. The source_type column is
    //    NOT NULL with a CHECK ('application' | 'talent'); a fresh CV
    //    upload doesn't fit either bucket cleanly, so we pick "application"
    //    (raw CVs are closest in spirit to job-applications submissions).
    //    source_id stays null because there's no upstream row to link to.
    //    Stage "-" matches addCandidateToBatch's default.
    const { data: row, error: insertError } = await supabase
      .from("client_batch_candidates")
      .insert({
        batch_id: batchId,
        source_type: "application",
        source_id: null,
        first_name: firstName,
        last_name: lastName ?? "",
        email,
        phone,
        linkedin_url: linkedin,
        cv_url: cvUrl,
        cv_path: path,
        position_applied: position,
        stage: "-",
      })
      .select("id")
      .single();

    if (insertError || !row) {
      return NextResponse.json(
        { error: insertError?.message ?? "Failed to insert candidate." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      candidate_id: (row as { id: string }).id,
      cv_text_truncated: !!cvText && cvText.length > MAX_CV_TEXT_LENGTH,
      // cv_text wasn't stored — client_batch_candidates doesn't have a
      // cv_text column. Returned in the bounded form for any caller that
      // wants to surface it (e.g. for an admin search), but no DB write.
      cv_text: boundedCvText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
