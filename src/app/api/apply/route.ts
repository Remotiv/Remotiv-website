import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();

    const jobId      = form.get("job_id") as string;
    const firstName  = form.get("first_name") as string;
    const lastName   = form.get("last_name") as string;
    const email      = form.get("email") as string;
    const phone      = form.get("phone") as string;
    const linkedin   = form.get("linkedin_url") as string;
    const cvFile     = form.get("cv") as File | null;

    if (!jobId || !firstName || !lastName || !email || !phone || !linkedin || !cvFile) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    const supabase = createServiceClient();

    // 1. Upload CV to storage
    const timestamp = Date.now();
    const path = `${jobId}/${email}-${timestamp}.pdf`;
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

    // 3. Insert application (service role bypasses RLS)
    const { error: insertError } = await supabase.from("job_applications").insert({
      job_id: jobId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      linkedin_url: linkedin,
      cv_url: cvUrl,
      status: "new",
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
