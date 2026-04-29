import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();

    const jobId       = (form.get("job_id") as string | null) || null;
    const jobTitle    = (form.get("job_title_manual") as string | null) || null;
    const firstName   = form.get("first_name")  as string;
    const lastName    = form.get("last_name")   as string;
    const email       = form.get("email")       as string;
    const phone       = form.get("phone")       as string;
    const linkedinRaw = form.get("linkedin_url") as string | null;
    const linkedin    = linkedinRaw && linkedinRaw.trim() ? linkedinRaw.trim() : null;
    const source      = ((form.get("source") as string) || "job_application") as
      | "job_application"
      | "manual_upload";
    const notesRaw    = form.get("notes") as string | null;
    const notes       = notesRaw && notesRaw.trim() ? notesRaw.trim() : null;
    const cvFile      = form.get("cv") as File | null;

    if (!firstName || !lastName || !email || !phone || !cvFile) {
      return NextResponse.json(
        { error: "First name, last name, email, phone, and CV are required." },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1. Upload CV to storage
    const timestamp = Date.now();
    const folder = jobId ?? "manual";
    const path = `${folder}/${email}-${timestamp}.pdf`;
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
