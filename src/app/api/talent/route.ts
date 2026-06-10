import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAvatarUrl } from "@/lib/avatars";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { isValidEmail } from "@/app/admin/lib/validators";

export const runtime = "nodejs";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

// Defensive bounds against weaponised inputs:
//   - 10 MB raw CV file
//   - 100 KB extracted text (more than any real CV)
const MAX_CV_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 100_000;

// Phase 2 security: per-field length caps to stop an attacker bloating a
// single submission to 10+ MB by POSTing a giant `summary` (or similar).
// Generous enough that no legitimate user will hit them; client-side caps
// are tighter still.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB (mirrors client cap)
const FIELD_MAX = {
  name: 80,
  email: 254,
  phone: 40,
  city: 100,
  country: 100,
  url: 300,
  degree: 200,
  institution: 200,
  jobTitle: 200,
  industry: 100,
  roleCategory: 60,
  summary: 5000,
  skill: 50,
  expField: 200,
};
const MAX_SKILLS = 30;
const MAX_EXPERIENCES = 30;

// Phase 2 security: enum value sets. The CLIENT sends the LABEL strings
// (see *_LABEL maps in /become-a-talent/page.tsx and the FormData appends
// at handleSubmit) — NOT the camelCase radio keys. So these arrays match
// the labels exactly. Invalid values are coerced to the client's default
// rather than rejected, to avoid breaking the happy path on any future
// label drift.
const VALID_AVAILABILITY = ["Available Now", "Not Available"];
const DEFAULT_AVAILABILITY = "Available Now";
const VALID_WORK_TYPE = ["Full-time", "Part-time", "Contract", "Any"];
const DEFAULT_WORK_TYPE = "Full-time";
const VALID_NOTICE_PERIOD = ["Immediate", "2 Weeks", "1 Month", "Negotiable"];
const DEFAULT_NOTICE_PERIOD = "Immediate";
const VALID_WORK_LOCATION = ["Remote", "Hybrid", "Onsite"];
const DEFAULT_WORK_LOCATION = "Remote";

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

// Phase 2 B3 + B4: `slug()` and `fileExt()` helpers removed — they were
// only used to build the OLD predictable photo path `${slug(email)}-${timestamp}.${ext}`.
// Photos now use `crypto.randomUUID()` + a MIME-derived extension, so no
// user-controlled filename data goes into the storage path.

// Phase 2 H1: clamp a text field to a max length (no-op on null).
function cap(s: string | null, max: number): string | null {
  return s == null ? null : s.slice(0, max);
}

// Phase 2 H3: parse + validate a URL string against an allowed-host whitelist.
// Accepts schemeless inputs ("linkedin.com/in/foo") by prepending https://.
// Returns the normalized URL string when valid, null when invalid/empty.
// Hosts match the exact host OR any subdomain (e.g. "pk.linkedin.com").
function validUrl(raw: string | null, allowedHosts: string[]): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProto);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const ok = allowedHosts.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "talent" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    const form = await request.formData();

    // Phase 2 H1 + A-caps: every text field is clamped at parse time so a
    // single submission can't bloat the DB row with a multi-megabyte value.
    const firstName       = cap(nullable(form.get("first_name")), FIELD_MAX.name);
    const lastName        = cap(nullable(form.get("last_name")),  FIELD_MAX.name);
    const rawEmail        = cap(nullable(form.get("email")),      FIELD_MAX.email);
    const email           = rawEmail ? normalizeEmail(rawEmail) : null;
    const rawPhone        = cap(nullable(form.get("phone")),      FIELD_MAX.phone);
    const normalisedPhone = rawPhone ? normalizePhone(rawPhone) : "";
    const phone           = normalisedPhone || null;
    const city            = cap(nullable(form.get("city")),       FIELD_MAX.city);
    const country         = cap(nullable(form.get("country")),    FIELD_MAX.country);
    // Phase 2 H3: linkedin (REQUIRED by client) + github (optional) validated
    // against a host whitelist + scheme check. linkedinRaw kept around so the
    // required-field check below can distinguish "blank" from "invalid".
    const linkedinRaw     = cap(nullable(form.get("linkedin_url")), FIELD_MAX.url);
    const linkedin        = validUrl(linkedinRaw, ["linkedin.com"]);
    const githubRaw       = cap(nullable(form.get("github_url")),   FIELD_MAX.url);
    const githubUrl       = validUrl(githubRaw, ["github.com"]);
    const jobTitle        = cap(nullable(form.get("job_title")),    FIELD_MAX.jobTitle);
    const roleCategory    = cap(nullable(form.get("role_category")), FIELD_MAX.roleCategory);
    // Phase 2 A5: clamp years_experience to a sane 0–70 range; null stays null.
    const yearsParsed     = intOrNull(form.get("years_experience"));
    const yearsExperience = yearsParsed == null
      ? null
      : Math.max(0, Math.min(70, yearsParsed));
    const industry        = cap(nullable(form.get("industry")),    FIELD_MAX.industry);
    const degree          = cap(nullable(form.get("degree")),      FIELD_MAX.degree);
    const institution     = cap(nullable(form.get("institution")), FIELD_MAX.institution);
    const summary         = cap(nullable(form.get("summary")),     FIELD_MAX.summary);
    // Phase 2 A4: enum-validate the preference fields. Server receives the
    // LABEL strings (e.g. "Available Now", "Full-time", "2 Weeks", "Remote")
    // from page.tsx's *_LABEL maps. Invalid → coerce to the client's default
    // rather than reject — never break a borderline-valid submission.
    const rawAvailability = nullable(form.get("availability"));
    const availability    = rawAvailability && VALID_AVAILABILITY.includes(rawAvailability)
      ? rawAvailability : DEFAULT_AVAILABILITY;
    const rawWorkType     = nullable(form.get("work_type"));
    const workType        = rawWorkType && VALID_WORK_TYPE.includes(rawWorkType)
      ? rawWorkType : DEFAULT_WORK_TYPE;
    const rawNoticePeriod = nullable(form.get("notice_period"));
    const noticePeriod    = rawNoticePeriod && VALID_NOTICE_PERIOD.includes(rawNoticePeriod)
      ? rawNoticePeriod : DEFAULT_NOTICE_PERIOD;
    const rawWorkLocation = nullable(form.get("work_location"));
    const workLocation    = rawWorkLocation && VALID_WORK_LOCATION.includes(rawWorkLocation)
      ? rawWorkLocation : DEFAULT_WORK_LOCATION;
    // Phase 2 A6: clamp salary range to 0..100_000_000 (rupees) — guards
    // against negative or absurd values; null stays null.
    const salaryMinParsed = intOrNull(form.get("salary_min"));
    const salaryMin       = salaryMinParsed == null
      ? null
      : Math.max(0, Math.min(100_000_000, salaryMinParsed));
    const salaryMaxParsed = intOrNull(form.get("salary_max"));
    const salaryMax       = salaryMaxParsed == null
      ? null
      : Math.max(0, Math.min(100_000_000, salaryMaxParsed));
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
    // Phase 2 A2: cap skills array length + per-skill length.
    skills = skills.slice(0, MAX_SKILLS).map((s) => s.slice(0, FIELD_MAX.skill));

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
    // Phase 2 A3: cap experience array length + per-field string length +
    // per-entry nested skills array. Preserves the exact ExperienceItem
    // shape the insert at L262 expects (jsonb experience column).
    experience = experience.slice(0, MAX_EXPERIENCES).map((e) => ({
      title:   e.title.slice(0,   FIELD_MAX.expField),
      company: e.company.slice(0, FIELD_MAX.expField),
      start:   e.start.slice(0,   FIELD_MAX.expField),
      end:     e.end.slice(0,     FIELD_MAX.expField),
      dates:   e.dates.slice(0,   FIELD_MAX.expField),
      skills:  e.skills.slice(0, MAX_SKILLS).map((s) => s.slice(0, FIELD_MAX.skill)),
    }));

    const cvFile    = form.get("cv")    as File | null;
    const photoFile = form.get("photo") as File | null;

    if (!firstName || !email) {
      return NextResponse.json(
        { error: "First name and email are required." },
        { status: 400 },
      );
    }
    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 },
      );
    }

    // Phase 2 A1: mirror the client's Step 1 + Step 2 required-field gates
    // server-side. The client validators (validateStep1Fields /
    // validateStep2Fields in /become-a-talent/page.tsx) require: lastName,
    // phone, city, country, linkedin (valid URL), degree, institution, and
    // ≥1 experience entry. Without these server checks an attacker hitting
    // the API directly could submit a profile with only firstName + email.
    if (!lastName) {
      return NextResponse.json({ error: "Last name is required." }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ error: "A valid phone number is required." }, { status: 400 });
    }
    if (!city) {
      return NextResponse.json({ error: "City is required." }, { status: 400 });
    }
    if (!country) {
      return NextResponse.json({ error: "Country is required." }, { status: 400 });
    }
    // Phase 2 H3: linkedin is required + must validate. linkedinRaw is the
    // pre-validation value — if it was non-empty but failed validUrl(), the
    // user submitted a malformed/non-linkedin URL.
    if (!linkedinRaw) {
      return NextResponse.json(
        { error: "LinkedIn URL is required." },
        { status: 400 },
      );
    }
    if (!linkedin) {
      return NextResponse.json(
        { error: "Please enter a valid LinkedIn URL (linkedin.com/in/...)." },
        { status: 400 },
      );
    }
    if (!degree) {
      return NextResponse.json(
        { error: "Degree / qualification is required." },
        { status: 400 },
      );
    }
    if (!institution) {
      return NextResponse.json(
        { error: "Institution / university is required." },
        { status: 400 },
      );
    }
    if (experience.length === 0) {
      return NextResponse.json(
        { error: "At least one work experience entry is required." },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1+2. Phase 4 J3: duplicate-by-email + duplicate-by-phone in parallel.
    // Both queries are independent (the 409 decision below combines them).
    // Sequential = sum of latencies; parallel = max. Saves 50-150 ms.
    // The `if`-guards (email present, normalisedPhone ≥ 7 digits) are kept
    // defensively even though Phase 2 required-field checks above already
    // guarantee both — if the guard fails, that branch resolves to a no-op.
    const [emailDupeResult, phoneDupeResult] = await Promise.all([
      email
        ? supabase
            .from("talent_profiles")
            .select("id")
            .eq("email", email)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Duplicate-by-phone — fetch the latest 100 phone-bearing rows and
      // normalise both sides in JS (we can't apply normalizePhone in SQL
      // without a generated column). Same pattern as /api/apply.
      normalisedPhone.length >= 7
        ? supabase
            .from("talent_profiles")
            .select("id, phone")
            .not("phone", "is", null)
            .order("created_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: null }),
    ]);

    const emailMatch: { id: string } | null =
      (emailDupeResult.data as { id: string } | null) ?? null;

    let phoneMatch: { id: string } | null = null;
    if (phoneDupeResult.data) {
      const records = phoneDupeResult.data as Array<{ id: string; phone: string | null }>;
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

    // 2 + 3. Phase 4 F1: validate both files upfront (CPU-only — caps, MIME,
    // magic-bytes), then run the two storage uploads in parallel. Previously
    // photo and CV uploaded sequentially (sum of latencies); now they upload
    // concurrently (max of latencies). Saves 100-1000 ms when both files
    // are present.
    //
    // Validation MUST stay before the parallel upload — size/MIME/magic-byte
    // gating is per-file CPU work, and a rejection here should still return
    // a per-file error without touching storage. ONLY the two network upload
    // calls run in parallel.
    //
    // Orphan tradeoff (deferred): if photo upload succeeds but CV upload
    // fails (or vice versa), one orphan object stays in storage. This was
    // also possible with the sequential code (photo could succeed then CV
    // fail). Cleanup is out of scope this round.

    // -------- Photo: validate + prepare upload args --------
    let photoUploadArgs:
      | { path: string; buffer: ArrayBuffer; contentType: string }
      | null = null;
    if (photoFile && photoFile.size > 0) {
      // Phase 2 H2: server-side 2 MB cap (client also caps at 2 MB but a
      // direct API caller could POST a huge image otherwise — lambda OOM /
      // bandwidth DoS). 413 Payload Too Large per the CV pattern.
      if (photoFile.size > MAX_PHOTO_BYTES) {
        return NextResponse.json(
          { error: "Photo must be under 2 MB." },
          { status: 413 },
        );
      }
      // Reject anything that isn't a common image type. We accept jpeg/jpg/png/webp/gif.
      if (photoFile.type && !ALLOWED_IMAGE_TYPES.includes(photoFile.type)) {
        return NextResponse.json(
          { error: `Unsupported photo type: ${photoFile.type}. Use JPG, PNG, WEBP, or GIF.` },
          { status: 400 },
        );
      }
      // Read the bytes ONCE — used by both the magic-byte check below and
      // the storage upload, so we don't pay arrayBuffer() twice.
      const buf = await photoFile.arrayBuffer();
      const photoBytes = new Uint8Array(buf);
      // Phase 2 B2: magic-byte check. Client-supplied MIME can be spoofed
      // (a .php with Content-Type: image/jpeg passes the whitelist above).
      // Detect by leading signature bytes:
      //   JPG/JPEG : FF D8 FF
      //   PNG      : 89 50 4E 47  ("\x89PNG")
      //   WebP     : 52 49 46 46  ("RIFF" — full RIFF/WEBP magic is at offset 0/8)
      //   GIF      : 47 49 46     ("GIF")
      const isJpg = photoBytes.length >= 3 &&
        photoBytes[0] === 0xff && photoBytes[1] === 0xd8 && photoBytes[2] === 0xff;
      const isPng = photoBytes.length >= 4 &&
        photoBytes[0] === 0x89 && photoBytes[1] === 0x50 &&
        photoBytes[2] === 0x4e && photoBytes[3] === 0x47;
      const isWebp = photoBytes.length >= 4 &&
        photoBytes[0] === 0x52 && photoBytes[1] === 0x49 &&
        photoBytes[2] === 0x46 && photoBytes[3] === 0x46;
      const isGif = photoBytes.length >= 3 &&
        photoBytes[0] === 0x47 && photoBytes[1] === 0x49 && photoBytes[2] === 0x46;
      if (!isJpg && !isPng && !isWebp && !isGif) {
        return NextResponse.json(
          { error: "Photo must be a valid JPG, PNG, WebP, or GIF image." },
          { status: 400 },
        );
      }
      // Phase 2 B3 + B4: derive extension from the validated MIME (NOT from
      // the user-supplied filename) AND use a randomUUID path (NOT a
      // predictable email-slug + timestamp) so the public storage URL can't
      // be enumerated or filename-spoofed (e.g. attack.jpg.html).
      const photoExt = isJpg ? "jpg" : isPng ? "png" : isWebp ? "webp" : "gif";
      const photoContentType = isJpg ? "image/jpeg"
        : isPng ? "image/png"
        : isWebp ? "image/webp"
        : "image/gif";
      photoUploadArgs = {
        path: `talent/photos/${crypto.randomUUID()}.${photoExt}`,
        buffer: buf,
        contentType: photoContentType,
      };
    }

    // -------- CV: validate + prepare upload args --------
    //    Magic-byte gate: PDFs start with "%PDF" (0x25 0x50 0x44 0x46). The
    //    front-end accepts only PDF; this enforces the same on the server.
    let cvUploadArgs:
      | { path: string; buffer: Buffer }
      | null = null;
    if (cvFile && cvFile.size > 0) {
      if (cvFile.size > MAX_CV_FILE_BYTES) {
        return NextResponse.json(
          { error: "CV file is too large (max 10 MB)." },
          { status: 413 },
        );
      }
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
      cvUploadArgs = {
        path: `talent/cvs/${crypto.randomUUID()}.pdf`,
        buffer: cvBuffer,
      };
    }

    // -------- Run both uploads concurrently --------
    const [photoUploadResult, cvUploadResult] = await Promise.all([
      photoUploadArgs
        ? supabase.storage
            .from("talent_photos")
            .upload(photoUploadArgs.path, photoUploadArgs.buffer, {
              contentType: photoUploadArgs.contentType,
              upsert: false,
            })
        : Promise.resolve(null),
      cvUploadArgs
        ? supabase.storage
            .from("cvs")
            .upload(cvUploadArgs.path, cvUploadArgs.buffer, {
              contentType: "application/pdf",
              upsert: false,
            })
        : Promise.resolve(null),
    ]);

    // -------- Per-file error handling (Phase 2 E1 generic messages preserved) --------
    if (photoUploadResult?.error) {
      // Phase 2 E1: log the real Supabase error server-side; return a
      // generic message to the client so DB / storage internals don't leak.
      console.error("[talent] photo upload failed:", photoUploadResult.error);
      return NextResponse.json(
        { error: "Could not upload photo. Please try again." },
        { status: 500 },
      );
    }
    if (cvUploadResult?.error) {
      // Phase 2 E1: log full Supabase error server-side, return generic.
      console.error("[talent] cv upload failed:", cvUploadResult.error);
      return NextResponse.json(
        { error: "Could not upload CV. Please try again." },
        { status: 500 },
      );
    }

    // -------- Capture public URLs (getPublicUrl is sync — no parallel needed) --------
    let avatarUrl: string;
    if (photoUploadArgs) {
      const { data: pUrl } = supabase.storage.from("talent_photos").getPublicUrl(photoUploadArgs.path);
      avatarUrl = pUrl.publicUrl;
    } else {
      // Deterministic gender-aware fallback. Same name → same avatar.
      avatarUrl = getAvatarUrl(firstName, lastName);
    }

    let cvUrl: string | null = null;
    let cvPath: string | null = null;
    if (cvUploadArgs) {
      const { data: cUrl } = supabase.storage.from("cvs").getPublicUrl(cvUploadArgs.path);
      cvUrl = cUrl.publicUrl;
      cvPath = cvUploadArgs.path;
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
      cv_path: cvPath,
      cv_text:
        cvText && cvText.length > MAX_CV_TEXT_LENGTH
          ? cvText.slice(0, MAX_CV_TEXT_LENGTH)
          : cvText,
      status: "pending",
    });

    if (insertError) {
      // Phase 2 E1: log full Postgres/Supabase error (constraint name,
      // column, code) server-side; return a generic client message so DB
      // schema details aren't reconnaissance-leaked over the public API.
      console.error("[talent] insert failed:", insertError);
      return NextResponse.json(
        { error: "Could not save your profile. Please try again." },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    // Phase 2 E1: catch-all generic response; full error to server logs.
    console.error("[talent] unexpected error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
