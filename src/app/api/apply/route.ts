import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/normalizePhone";

// PDF text extraction needs the Node runtime — pdfjs-dist legacy build pulls in
// Node APIs that aren't available on Edge.
export const runtime = "nodejs";

function nullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "applicant";
}

/**
 * Extract plain text from a PDF buffer using the legacy (Node-friendly) build
 * of pdfjs-dist. Returns the concatenated text of every page joined by
 * newlines. Imported dynamically so the heavy module is only loaded when the
 * route actually runs.
 */
async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = (content.items as Array<{ str?: string }>)
      .map((item) => ("str" in item ? (item.str ?? "") : ""))
      .join(" ");
    pages.push(text);
  }
  return pages.join("\n");
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();

    const jobId     = nullable(form.get("job_id"));
    const jobTitle  = nullable(form.get("job_title_manual"));
    const firstName = nullable(form.get("first_name"));
    const lastName  = nullable(form.get("last_name"));
    const email     = nullable(form.get("email"));
    const phone     = nullable(form.get("phone"));
    const linkedin  = nullable(form.get("linkedin_url"));
    const notes     = nullable(form.get("notes"));
    let   cvText    = nullable(form.get("cv_text"));
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
          .limit(5000);

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

    // 1. Upload CV to storage — use email when present, otherwise a slug of the
    //    first name; the timestamp keeps every path unique.
    const timestamp = Date.now();
    const folder = jobId ?? "manual";
    const filename = email ? slug(email) : slug(firstName);
    const path = `${folder}/${filename}-${timestamp}.pdf`;
    const bytes = await cvFile.arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from("cvs")
      .upload(path, bytes, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    // 2. Get public URL
    const { data: urlData } = supabase.storage.from("cvs").getPublicUrl(path);
    const cvUrl = urlData.publicUrl;

    // 2b. If the client didn't already send extracted text (public job
    //     applications don't), extract it server-side so search still works.
    //     Failures here are silent — cv_text is optional and shouldn't block.
    if (!cvText) {
      try {
        cvText = await extractTextFromPdf(bytes);
      } catch {
        // ignore — leave cv_text as null
      }
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

    // 4. Insert application (service role bypasses RLS)
    const { error: insertError } = await supabase.from("job_applications").insert({
      job_id: resolvedJobId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      linkedin_url: linkedin,
      cv_url: cvUrl,
      cv_text: cvText,
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
