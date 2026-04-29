import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; phone?: string };
    const email = (body.email ?? "").trim();
    const phone = (body.phone ?? "").trim();

    if (!email && !phone) {
      return NextResponse.json({ exists: false, applicant: null });
    }

    const supabase = createServiceClient();

    // Build OR filter — match either field if provided
    const orParts: string[] = [];
    if (email) orParts.push(`email.eq.${email}`);
    if (phone) orParts.push(`phone.eq.${phone}`);

    const { data, error } = await supabase
      .from("job_applications")
      .select("*, jobs(title)")
      .or(orParts.join(","))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ exists: false, applicant: null });
    }

    const row = data as Record<string, unknown>;
    return NextResponse.json({
      exists: true,
      applicant: {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        phone: row.phone,
        status: row.status,
        created_at: row.created_at,
        job_title: (row.jobs as { title?: string } | null)?.title ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
