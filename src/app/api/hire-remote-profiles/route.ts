import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/lib/validators";

export const runtime = "nodejs";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

// M10: PDF only. DOC/DOCX were previously accepted on MIME-type alone with
// no magic-byte verification, letting a renamed .exe / .html slip through
// with a forged content type. Matches /join-as-talent's intake stance.
const ALLOWED_CV_TYPES = ["application/pdf"];

const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHONE_DEDUP_LIMIT = 5000;
const CV_STORAGE_PREFIX = "hire-remote/cvs/";
const PHOTO_STORAGE_PREFIX = "hire-remote/photos/";

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

// H4: storage rollback helper. When a multi-step request uploads files and
// then fails (either upload error after a sibling already succeeded, or a
// DB insert failure once both files are in storage), we delete every
// successfully-uploaded object so production storage doesn't accumulate
// orphans. Logs [CV_ORPHAN] on cleanup failure so production grep surfaces
// the leak. Inlined here (NOT a shared lib) per the H4 commit policy.
async function rollbackUploadedFiles(
  supabase: ReturnType<typeof createServiceClient>,
  paths: { bucket: string; path: string }[],
  routeTag: string,
): Promise<void> {
  for (const { bucket, path } of paths) {
    try {
      const { error } = await supabase.storage.from(bucket).remove([path]);
      if (error) {
        console.error(
          `[CV_ORPHAN]${routeTag} rollback delete returned error`,
          { path, bucket, error },
        );
      }
    } catch (cleanupErr) {
      console.error(
        `[CV_ORPHAN]${routeTag} rollback delete threw`,
        { path, bucket, error: cleanupErr },
      );
    }
  }
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "hire-remote" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    const form = await request.formData();

    // Honeypot — bots fill the hidden `website_url` input; humans leave it
    // blank. Silently fake success so the bot doesn't learn its submission
    // was rejected. Mirror contact/book-a-meeting's server-side check.
    const honeypot = form.get("website_url");
    if (typeof honeypot === "string" && honeypot.trim().length > 0) {
      return NextResponse.json({ success: true });
    }

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
    const bioRaw    = nullable(form.get("bio"));
    const bio       = bioRaw === null ? null : bioRaw.slice(0, 2000);
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
          description: typeof e.description === "string" ? e.description.slice(0, 1000) : "",
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
    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
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
    // M1 server-mirror: if a future availability date was supplied, it must be
    // strictly in the future. Client also enforces this, but never trust the
    // client.
    if (availableFromDate) {
      const chosenDate = new Date(availableFromDate);
      if (Number.isNaN(chosenDate.getTime()) || chosenDate <= new Date()) {
        return NextResponse.json(
          { error: "future_date_invalid" },
          { status: 400 },
        );
      }
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

    // 2. Duplicate-by-phone — fetch the latest PHONE_DEDUP_LIMIT phone-bearing
    //    rows and normalise both sides in JS. Same pattern as /api/apply and
    //    /api/talent (no SQL-side normalisation without a generated column).
    let phoneMatch: { id: string } | null = null;
    if (normalisedPhone.length >= 7) {
      const { data: phoneRecords } = await supabase
        .from("hire_remote_profiles")
        .select("id, phone")
        .not("phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(PHONE_DEDUP_LIMIT);

      const records = (phoneRecords ?? []) as Array<{ id: string; phone: string | null }>;
      const found = records.find(
        (r) => normalizePhone(r.phone ?? "") === normalisedPhone,
      );
      phoneMatch = found ? { id: found.id } : null;
    }

    // M2: distinguish email-dup from phone-dup so the client can render the
    // correct channel-specific message. Email is checked first so a row that
    // matches both surfaces as a duplicate_email.
    if (emailMatch) {
      return NextResponse.json(
        {
          error: "duplicate_email",
          message: "You've already applied with this email address.",
        },
        { status: 409 },
      );
    }
    if (phoneMatch) {
      return NextResponse.json(
        {
          error: "duplicate_phone",
          message: "You've already applied with this phone number.",
        },
        { status: 409 },
      );
    }

    const timestamp = Date.now();
    const filenameSlug = slug(normalisedEmail);

    // H4: every successfully-uploaded storage object goes here so any later
    // failure (sibling upload error, DB insert error) can roll them back.
    // Uploads are sequential (CV first, then photo, then DB insert) — push
    // immediately after each successful upload so the next failure point
    // can clean up everything that landed before it.
    const uploadedPaths: { bucket: string; path: string }[] = [];

    // 2. Upload CV (optional). PDF only — we cross-check magic bytes (%PDF)
    //    so a renamed .html / .exe can't slip through with a forged content
    //    type. M10 removed DOC/DOCX from the allowlist; the magic-byte gate
    //    is the only signature defense and OLE/ZIP container checks weren't
    //    in place for those formats.
    let cvUrl: string | null = null;
    let cvPath: string | null = null;
    if (cvFile && cvFile.size > 0) {
      if (cvFile.size > MAX_CV_BYTES) {
        return NextResponse.json(
          { error: "CV must be under 5 MB." },
          { status: 400 },
        );
      }
      if (cvFile.type && !ALLOWED_CV_TYPES.includes(cvFile.type)) {
        return NextResponse.json(
          { error: `Unsupported CV type: ${cvFile.type}. Use PDF only.` },
          { status: 400 },
        );
      }
      const cvBuffer = Buffer.from(await cvFile.arrayBuffer());
      if (cvFile.type === "application/pdf") {
        const isPdf =
          cvBuffer.length >= 4 &&
          cvBuffer[0] === 0x25 &&
          cvBuffer[1] === 0x50 &&
          cvBuffer[2] === 0x44 &&
          cvBuffer[3] === 0x46;
        if (!isPdf) {
          return NextResponse.json(
            { error: "Uploaded file does not look like a real PDF. Please re-export and try again." },
            { status: 400 },
          );
        }
      }
      const ext = fileExt(cvFile.name, "pdf");
      const path = `${CV_STORAGE_PREFIX}${crypto.randomUUID()}.${ext}`;
      const { error: cvErr } = await supabase.storage
        .from("cvs")
        .upload(path, cvBuffer, {
          contentType: cvFile.type || "application/pdf",
          upsert: false,
        });
      if (cvErr) {
        // H4: CV upload failed BEFORE anything else uploaded — nothing to
        // roll back, just return. (Photo upload happens after this block.)
        return NextResponse.json({ error: cvErr.message }, { status: 500 });
      }
      // H4: CV uploaded successfully — track so a later failure can clean it up.
      uploadedPaths.push({ bucket: "cvs", path });
      const { data: cUrl } = supabase.storage.from("cvs").getPublicUrl(path);
      cvUrl = cUrl.publicUrl;
      cvPath = path;
    }

    // 3. Upload photo (optional). The cvs bucket is private; we store only
    //    photo_path so the admin list query can re-sign a fresh URL at read
    //    time (mirror of cv_path). photo_url is left null going forward.
    let photoUrl: string | null = null;
    let photoPath: string | null = null;
    if (photoFile && photoFile.size > 0) {
      if (photoFile.size > MAX_PHOTO_BYTES) {
        return NextResponse.json(
          { error: "Photo must be under 5 MB." },
          { status: 400 },
        );
      }
      if (photoFile.type && !ALLOWED_IMAGE_TYPES.includes(photoFile.type)) {
        return NextResponse.json(
          { error: `Unsupported photo type: ${photoFile.type}. Use JPG, PNG, WEBP, or GIF.` },
          { status: 400 },
        );
      }
      const ext = fileExt(photoFile.name, "jpg");
      const path = `${PHOTO_STORAGE_PREFIX}${filenameSlug}-${timestamp}.${ext}`;
      const buf = await photoFile.arrayBuffer();
      const contentType =
        photoFile.type && ALLOWED_IMAGE_TYPES.includes(photoFile.type)
          ? photoFile.type
          : "image/jpeg";
      const { error: photoErr } = await supabase.storage
        .from("talent_photos")
        .upload(path, buf, { contentType, upsert: false });
      if (photoErr) {
        // H4: photo upload failed AFTER CV (if any) succeeded — roll back
        // the CV so the partial submission doesn't leak storage.
        await rollbackUploadedFiles(
          supabase,
          uploadedPaths,
          "/api/hire-remote-profiles",
        );
        return NextResponse.json({ error: photoErr.message }, { status: 500 });
      }
      // H4: photo uploaded successfully — track for potential later rollback.
      uploadedPaths.push({ bucket: "talent_photos", path });
      photoPath = path;
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
        cv_path: cvPath,
        cv_text: cvText,
        photo_url: photoUrl,
        photo_path: photoPath,

        status: "pending",
        email_verified: false,
        id_verified: false,
        phone_verified: false,
      });

    if (insertError) {
      // H4: DB insert failed but uploaded files (if any) are already in
      // storage — roll them back so no orphan accumulates without a
      // matching DB row.
      await rollbackUploadedFiles(
        supabase,
        uploadedPaths,
        "/api/hire-remote-profiles",
      );
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
