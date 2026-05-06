import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";

// 200-char ceiling on each input keeps payload-padding abuse in check.
const MAX_INPUT_LENGTH = 200;

type ApplicantRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  jobs: { title?: string } | null;
};

function shape(row: ApplicantRow) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    created_at: row.created_at,
    job_title: row.jobs?.title ?? null,
  };
}

export async function POST(request: NextRequest) {
  // Bumped cap because legitimate use fires this on every email/phone keystroke.
  // 100 / min comfortably covers the worst typist; abuse scripts spike past it fast.
  const rl = rateLimit(request, {
    bucketKey: "check-duplicate",
    max: 100,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    const body = (await request.json()) as { email?: string; phone?: string };
    const rawEmail = (body.email ?? "").slice(0, MAX_INPUT_LENGTH);
    const rawPhone = (body.phone ?? "").slice(0, MAX_INPUT_LENGTH);
    const email = normalizeEmail(rawEmail);
    const phone = rawPhone.trim();
    const normalizedPhone = normalizePhone(phone);

    if (!email && !normalizedPhone) {
      return NextResponse.json({ exists: false, applicant: null });
    }

    const supabase = createServiceClient();

    // 1. Email match (cheap, indexed equality). Skip the DB hit when the
    //    email is half-typed garbage so partial keystrokes don't query.
    if (email && isValidEmail(email)) {
      const { data, error } = await supabase
        .from("job_applications")
        .select("id, first_name, last_name, email, phone, status, created_at, jobs(title)")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (data) {
        return NextResponse.json({
          exists: true,
          applicant: shape(data as unknown as ApplicantRow),
        });
      }
    }

    // 2. Phone match — normalise in JS since we can't do it in SQL.
    //    Fetch recent rows that have a phone and look for a normalised match.
    if (normalizedPhone.length >= 7) {
      const { data: rows, error } = await supabase
        .from("job_applications")
        .select("id, first_name, last_name, email, phone, status, created_at, jobs(title)")
        .not("phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const candidates = (rows ?? []) as unknown as ApplicantRow[];
      const found = candidates.find(
        (r) => normalizePhone(r.phone ?? "") === normalizedPhone,
      );
      if (found) {
        return NextResponse.json({ exists: true, applicant: shape(found) });
      }
    }

    return NextResponse.json({ exists: false, applicant: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
