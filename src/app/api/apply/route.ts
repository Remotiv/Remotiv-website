import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";

// LinkedIn URL gate — applied to every submission regardless of `source`.
// Defense in depth: the bulk-upload UI already blocks invalid rows, but a
// direct API call (e.g. from a script) must not be able to slip through.
const LINKEDIN_URL_PATTERN = /linkedin\.com/i;

// Defensive bounds against weaponised inputs:
//   - 10 MB raw PDF
//   - 100 KB extracted text (more than any real CV)
const MAX_CV_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 100_000;

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
    const source    = ((form.get("source") as string) || "job_application") as
      | "job_application"
      | "manual_upload";
    const cvFile    = form.get("cv") as File | null;

    if (!firstName || !cvFile) {
      return NextResponse.json(
        { error: "First name and CV are required." },
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
        { error: "CV file is too large (max 10 MB)." },
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
          .from("job_applications")
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
          .from("job_applications")
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
      .from("cvs")
      .upload(path, cvBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    // 2. Get public URL
    const { data: urlData } = supabase.storage.from("cvs").getPublicUrl(path);
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
    const { error: insertError } = await supabase.from("job_applications").insert({
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
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
