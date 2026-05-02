import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

const MALE_AVATARS = [
  "/avatars/male 1.png", "/avatars/male 2.png", "/avatars/male 3.png", "/avatars/male 4.png",
  "/avatars/male 5.png", "/avatars/male 6.png", "/avatars/male 7.png", "/avatars/male 8.png",
  "/avatars/male 9.png", "/avatars/male 10.png", "/avatars/male 11.png", "/avatars/male 12.png",
  "/avatars/male 16.png", "/avatars/male 17.png", "/avatars/male 18.png", "/avatars/male 19.png",
];

const FEMALE_AVATARS = [
  "/avatars/female 2.png", "/avatars/female 3.png", "/avatars/female 4.png", "/avatars/female 5.png",
  "/avatars/female 6.png", "/avatars/female 7.png", "/avatars/female 8.png", "/avatars/female 9.png",
  "/avatars/female 10.png", "/avatars/female 11.png", "/avatars/female 12.png", "/avatars/female 13.png",
  "/avatars/female 15.png", "/avatars/female 16.png", "/avatars/female 17.png", "/avatars/female 18.png",
  "/avatars/female 19.png",
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

function pickAvatar(): string {
  const pool = MALE_AVATARS;
  return pool[Math.floor(Math.random() * pool.length)] ?? MALE_AVATARS[0];
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
    const email           = nullable(form.get("email"));
    const phone           = nullable(form.get("phone"));
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

    // 1. Duplicate-by-email
    const { data: existing } = await supabase
      .from("talent_profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
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
      avatarUrl = pickAvatar();
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
