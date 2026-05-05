import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAvatarUrl } from "@/lib/avatars";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";

export const runtime = "nodejs";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

function nullable(v: FormDataEntryValue | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function intOrNull(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "applicant";
}

function fileExt(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "bin";
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();

    const firstName       = nullable(form.get("first_name"));
    const lastName        = nullable(form.get("last_name"));
    const rawEmail        = nullable(form.get("email"));
    const email           = rawEmail ? normalizeEmail(rawEmail) : null;
    const rawPhone        = nullable(form.get("phone"));
    const normalisedPhone = rawPhone ? normalizePhone(rawPhone) : "";
    const phone           = normalisedPhone || null;
    const city            = nullable(form.get("city"));
    const country         = nullable(form.get("country"));
    const linkedin        = nullable(form.get("linkedin_url"));
    const githubUrl       = nullable(form.get("github_url"));
    const jobTitle        = nullable(form.get("job_title"));
    const roleCategory    = nullable(form.get("role_category"));
    const yearsExperience = intOrNull(form.get("years_experience"));
    const industry        = nullable(form.get("industry"));
    const degree          = nullable(form.get("degree"));
    const institution     = nullable(form.get("institution"));
    const summary         = nullable(form.get("summary"));
    const availability    = nullable(form.get("availability"));
    const workType        = nullable(form.get("work_type"));
    const noticePeriod    = nullable(form.get("notice_period"));
    const workLocation    = nullable(form.get("work_location"));
    const salaryMin       = intOrNull(form.get("salary_min"));
    const salaryMax       = intOrNull(form.get("salary_max"));
    const cvText          = nullable(form.get("cv_text"));

    const skillsRaw = form.get("skills");
    let skills: string[] = [];
    if (typeof skillsRaw === "string" && skillsRaw.trim()) {
      try {
        const parsed = JSON.parse(skillsRaw);
        if (Array.isArray(parsed)) {
          skills = parsed.filter((s) => typeof s === "string");
        }
      } catch {
        // fall back to comma-split
        skills = skillsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }

    // Work history — JSON-encoded array of { title, company, start, end, dates, skills[] }.
    // Stored as jsonb on talent_profiles.experience.
    type ExperienceItem = {
      title: string;
      company: string;
      start: string;
      end: string;
      dates: string;
      skills: string[];
    };
    const experienceRaw = form.get("experience");
    let experience: ExperienceItem[] = [];
    if (typeof experienceRaw === "string" && experienceRaw.trim()) {
      try {
        const parsed = JSON.parse(experienceRaw);
        if (Array.isArray(parsed)) {
          experience = parsed
            .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
            .map((e) => ({
              title:   typeof e.title   === "string" ? e.title   : "",
              company: typeof e.company === "string" ? e.company : "",
              start:   typeof e.start   === "string" ? e.start   : "",
              end:     typeof e.end     === "string" ? e.end     : "",
              dates:   typeof e.dates   === "string" ? e.dates   : "",
              skills:  Array.isArray(e.skills)
                ? (e.skills as unknown[]).filter((s): s is string => typeof s === "string")
                : [],
            }))
            .filter((e) => e.title || e.company);
        }
      } catch {
        // ignore — leave experience empty
      }
    }

    const cvFile    = form.get("cv")    as File | null;
    const photoFile = form.get("photo") as File | null;

    if (!firstName || !email) {
      return NextResponse.json(
        { error: "First name and email are required." },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1. Duplicate-by-email — exact match on lowercased email.
    let emailMatch: { id: string } | null = null;
    if (email) {
      const { data } = await supabase
        .from("talent_profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      emailMatch = (data as { id: string } | null) ?? null;
    }

    // 2. Duplicate-by-phone — fetch the latest 5,000 phone-bearing rows and
    //    normalise both sides in JS (we can't apply normalizePhone in SQL
    //    without a generated column). Same pattern as /api/apply.
    let phoneMatch: { id: string } | null = null;
    if (normalisedPhone.length >= 7) {
      const { data: phoneRecords } = await supabase
        .from("talent_profiles")
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
          message: "You're already in our talent network! We'll reach out when the right opportunity comes along.",
        },
        { status: 409 },
      );
    }

    const timestamp = Date.now();
    const filenameSlug = slug(email);

    // 2. Upload photo if provided, otherwise pick a random avatar from /avatars
    let avatarUrl: string;
    if (photoFile && photoFile.size > 0) {
      // Reject anything that isn't a common image type. We accept jpeg/jpg/png/webp/gif.
      if (photoFile.type && !ALLOWED_IMAGE_TYPES.includes(photoFile.type)) {
        return NextResponse.json(
          { error: `Unsupported photo type: ${photoFile.type}. Use JPG, PNG, WEBP, or GIF.` },
          { status: 400 },
        );
      }
      const ext = fileExt(photoFile.name);
      const path = `talent/photos/${filenameSlug}-${timestamp}.${ext}`;
      const buf = await photoFile.arrayBuffer();
      // Always send the explicit MIME from the upload (falling back to image/jpeg
      // when the browser didn't set one) so Supabase doesn't infer it as octet-stream.
      const contentType = photoFile.type && ALLOWED_IMAGE_TYPES.includes(photoFile.type)
        ? photoFile.type
        : "image/jpeg";
      const { error: photoErr } = await supabase.storage
        .from("cvs")
        .upload(path, buf, { contentType, upsert: false });
      if (photoErr) {
        return NextResponse.json({ error: photoErr.message }, { status: 500 });
      }
      const { data: pUrl } = supabase.storage.from("cvs").getPublicUrl(path);
      avatarUrl = pUrl.publicUrl;
    } else {
      // Deterministic gender-aware fallback. Same name → same avatar.
      avatarUrl = getAvatarUrl(firstName, lastName);
    }

    // 3. Upload CV (optional — talent profile can exist without a CV early on)
    let cvUrl: string | null = null;
    if (cvFile && cvFile.size > 0) {
      const path = `talent/cvs/${filenameSlug}-${timestamp}.pdf`;
      const buf = await cvFile.arrayBuffer();
      const { error: cvErr } = await supabase.storage
        .from("cvs")
        .upload(path, buf, { contentType: cvFile.type || "application/pdf", upsert: false });
      if (cvErr) {
        return NextResponse.json({ error: cvErr.message }, { status: 500 });
      }
      const { data: cUrl } = supabase.storage.from("cvs").getPublicUrl(path);
      cvUrl = cUrl.publicUrl;
    }

    // 4. Insert
    const { error: insertError } = await supabase.from("talent_profiles").insert({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      city,
      country,
      linkedin_url: linkedin,
      github_url: githubUrl,
      job_title: jobTitle,
      role_category: roleCategory,
      years_experience: yearsExperience,
      industry,
      degree,
      institution,
      skills,
      experience,
      summary,
      availability,
      work_type: workType,
      notice_period: noticePeriod,
      work_location: workLocation,
      salary_min: salaryMin,
      salary_max: salaryMax,
      avatar_url: avatarUrl,
      cv_url: cvUrl,
      cv_text: cvText,
      status: "pending",
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
