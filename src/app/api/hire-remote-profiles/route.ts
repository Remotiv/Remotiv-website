import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";

export const runtime = "nodejs";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

const ALLOWED_CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

function nullable(v: FormDataEntryValue | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function numberOrNull(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

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
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "applicant"
  );
}

function fileExt(name: string, fallback = "bin"): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : fallback;
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();

    // Personal
    const firstName       = nullable(form.get("first_name"));
    const lastName        = nullable(form.get("last_name"));
    const email           = nullable(form.get("email"));
    const rawPhone        = nullable(form.get("phone"));
    const normalisedPhone = rawPhone ? normalizePhone(rawPhone) : "";
    const phone           = normalisedPhone || null;
    const city            = nullable(form.get("city"));
    const country         = nullable(form.get("country"));
    const timeZone        = nullable(form.get("time_zone"));
    const linkedinUrl     = nullable(form.get("linkedin_url"));

    // Professional
    const jobTitles = nullable(form.get("job_titles"));
    const bio       = nullable(form.get("bio"));
    const cvText    = nullable(form.get("cv_text"));

    const skills = (() => {
      const parsed = safeJson<unknown>(form.get("skills"), []);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    })();

    type EmploymentItem = { title: string; company: string; dates: string; description: string };
    const employmentHistory: EmploymentItem[] = (() => {
      const parsed = safeJson<unknown>(form.get("employment_history"), []);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({
          title:       typeof e.title       === "string" ? e.title       : "",
          company:     typeof e.company     === "string" ? e.company     : "",
          dates:       typeof e.dates       === "string" ? e.dates       : "",
          description: typeof e.description === "string" ? e.description : "",
        }))
        .filter((e) => e.title || e.company);
    })();

    type EducationObj = { institution: string; degree: string; dates: string };
    const education: EducationObj = (() => {
      const parsed = safeJson<Record<string, unknown>>(form.get("education"), {} as Record<string, unknown>);
      return {
        institution: typeof parsed.institution === "string" ? parsed.institution : "",
        degree:      typeof parsed.degree      === "string" ? parsed.degree      : "",
        dates:       typeof parsed.dates       === "string" ? parsed.dates       : "",
      };
    })();

    type PortfolioItem = { title: string; role: string; url: string; description: string };
    const portfolio: PortfolioItem[] = (() => {
      const parsed = safeJson<unknown>(form.get("portfolio"), []);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p) => ({
          title:       typeof p.title       === "string" ? p.title       : "",
          role:        typeof p.role        === "string" ? p.role        : "",
          url:         typeof p.url         === "string" ? p.url         : "",
          description: typeof p.description === "string" ? p.description : "",
        }))
        .filter((p) => p.title || p.role || p.url);
    })();

    // Work preferences
    const hourlyRate        = numberOrNull(form.get("hourly_rate"));
    const hoursPerWeek      = nullable(form.get("hours_per_week"));
    const workType          = nullable(form.get("work_type"));
    const availability      = nullable(form.get("availability"));
    const availableFromDate = nullable(form.get("available_from_date"));

    type LanguageItem = { name: string; level: string };
    const languages: LanguageItem[] = (() => {
      const parsed = safeJson<unknown>(form.get("languages"), []);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
        .map((l) => ({
          name:  typeof l.name  === "string" ? l.name  : "",
          level: typeof l.level === "string" ? l.level : "",
        }))
        .filter((l) => l.name);
    })();

    // Files
    const cvFile    = form.get("cv")    as File | null;
    const photoFile = form.get("photo") as File | null;

    // Required-field validation
    if (!firstName || !lastName || !email || !phone || !city || !country || !timeZone || !linkedinUrl) {
      return NextResponse.json(
        { error: "Missing required personal information." },
        { status: 400 },
      );
    }
    if (!jobTitles || !bio) {
      return NextResponse.json(
        { error: "Job titles and bio are required." },
        { status: 400 },
      );
    }
    if (skills.length < 3) {
      return NextResponse.json(
        { error: "At least 3 skills are required." },
        { status: 400 },
      );
    }
    if (employmentHistory.length === 0) {
      return NextResponse.json(
        { error: "At least one employment entry is required." },
        { status: 400 },
      );
    }
    if (!education.institution || !education.degree) {
      return NextResponse.json(
        { error: "Education institution and degree are required." },
        { status: 400 },
      );
    }
    if (hourlyRate === null || hourlyRate < 0) {
      return NextResponse.json(
        { error: "A valid hourly rate is required." },
        { status: 400 },
      );
    }
    if (!hoursPerWeek || !workType || !availability) {
      return NextResponse.json(
        { error: "Hours per week, work type, and availability are required." },
        { status: 400 },
      );
    }
    if (languages.length === 0) {
      return NextResponse.json(
        { error: "At least one language is required." },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1. Duplicate-by-email — exact match on canonical lowercased email.
    const normalisedEmail = normalizeEmail(email);
    const { data: emailRow } = await supabase
      .from("hire_remote_profiles")
      .select("id")
      .eq("email", normalisedEmail)
      .maybeSingle();
    const emailMatch = (emailRow as { id: string } | null) ?? null;

    // 2. Duplicate-by-phone — fetch the latest 5,000 phone-bearing rows and
    //    normalise both sides in JS. Same pattern as /api/apply and
    //    /api/talent (no SQL-side normalisation without a generated column).
    let phoneMatch: { id: string } | null = null;
    if (normalisedPhone.length >= 7) {
      const { data: phoneRecords } = await supabase
        .from("hire_remote_profiles")
        .select("id, phone")
        .not("phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000);

      const records = (phoneRecords ?? []) as Array<{ id: string; phone: string | null }>;
      const found = records.find(
        (r) => normalizePhone(r.phone ?? "") === normalisedPhone,
      );
      phoneMatch = found ? { id: found.id } : null;
    }

    if (emailMatch || phoneMatch) {
      return NextResponse.json(
        {
          error: "duplicate",
          message: "You've already applied with this email",
        },
        { status: 409 },
      );
    }

    const timestamp = Date.now();
    const filenameSlug = slug(normalisedEmail);

    // 2. Upload CV (optional)
    let cvUrl: string | null = null;
    if (cvFile && cvFile.size > 0) {
      if (cvFile.type && !ALLOWED_CV_TYPES.includes(cvFile.type)) {
        return NextResponse.json(
          { error: `Unsupported CV type: ${cvFile.type}. Use PDF, DOC, or DOCX.` },
          { status: 400 },
        );
      }
      const ext = fileExt(cvFile.name, "pdf");
      const path = `hire-remote/cvs/${filenameSlug}-${timestamp}.${ext}`;
      const buf = await cvFile.arrayBuffer();
      const { error: cvErr } = await supabase.storage
        .from("cvs")
        .upload(path, buf, {
          contentType: cvFile.type || "application/pdf",
          upsert: false,
        });
      if (cvErr) {
        return NextResponse.json({ error: cvErr.message }, { status: 500 });
      }
      const { data: cUrl } = supabase.storage.from("cvs").getPublicUrl(path);
      cvUrl = cUrl.publicUrl;
    }

    // 3. Upload photo (optional)
    let photoUrl: string | null = null;
    if (photoFile && photoFile.size > 0) {
      if (photoFile.type && !ALLOWED_IMAGE_TYPES.includes(photoFile.type)) {
        return NextResponse.json(
          { error: `Unsupported photo type: ${photoFile.type}. Use JPG, PNG, WEBP, or GIF.` },
          { status: 400 },
        );
      }
      const ext = fileExt(photoFile.name, "jpg");
      const path = `hire-remote/photos/${filenameSlug}-${timestamp}.${ext}`;
      const buf = await photoFile.arrayBuffer();
      const contentType =
        photoFile.type && ALLOWED_IMAGE_TYPES.includes(photoFile.type)
          ? photoFile.type
          : "image/jpeg";
      const { error: photoErr } = await supabase.storage
        .from("cvs")
        .upload(path, buf, { contentType, upsert: false });
      if (photoErr) {
        return NextResponse.json({ error: photoErr.message }, { status: 500 });
      }
      const { data: pUrl } = supabase.storage.from("cvs").getPublicUrl(path);
      photoUrl = pUrl.publicUrl;
    }

    // 4. Insert
    const { error: insertError } = await supabase
      .from("hire_remote_profiles")
      .insert({
        first_name: firstName,
        last_name: lastName,
        email: normalisedEmail,
        phone,
        city,
        country,
        time_zone: timeZone,
        linkedin_url: linkedinUrl,

        job_titles: jobTitles,
        bio,
        skills,
        employment_history: employmentHistory,
        education,
        portfolio,

        hourly_rate: hourlyRate,
        hours_per_week: hoursPerWeek,
        work_type: workType,
        availability,
        available_from_date: availableFromDate,
        languages,

        cv_url: cvUrl,
        cv_text: cvText,
        photo_url: photoUrl,

        status: "pending",
        email_verified: true,
        id_verified: false,
        phone_verified: false,
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
