import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { queueApplicationReceived } from "@/lib/email/candidate/triggers";
import type { ScreeningQuestion } from "@/lib/jobs";
import { enqueue } from "@/lib/jobs-queue";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { extractPdfTextServer, stripInvalidPgChars } from "@/lib/pdf-text";
import { type NumericMode, resolveNumericMode } from "@/lib/screening";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidEmail } from "@/lib/validators";

// LinkedIn URL gate — applied to every submission regardless of `source`.
// Defense in depth: the bulk-upload UI already blocks invalid rows, but a
// direct API call (e.g. from a script) must not be able to slip through.
const LINKEDIN_URL_PATTERN = /linkedin\.com/i;

// jobId, when present, MUST be a real UUID. Otherwise it'd be interpolated
// directly into the storage path (folder = jobId ?? "manual"), allowing
// `../` or other injection patterns to escape the bucket layout.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defensive bounds against weaponised inputs:
//   - 5 MB raw PDF (matches the Supabase bucket upload limit)
//   - 100 KB extracted text (more than any real CV)
//   - per-text-field length caps below
const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 100;
const MAX_JOB_TITLE_LENGTH = 200;
const MAX_PHONE_LENGTH = 50;
const MAX_NOTES_LENGTH = 2000;

// Phase 2b — wizard fields. Caps mirror /api/talent/route.ts FIELD_MAX (29-46)
// so an applicant's payload is interchangeable with a /join-as-talent submit.
// Named APPLY_FIELD_MAX to avoid confusion with the existing MAX_* set above.
const APPLY_FIELD_MAX = {
  jobTitle: 200,
  roleCategory: 60,
  degree: 200,
  institution: 200,
  city: 100,
  country: 100,
  summary: 2000,
  skill: 50,
  expField: 200,
  experienceDescription: 1000,
};
const MAX_SKILLS = 30;
const MAX_EXPERIENCES = 30;

// Enum coercion sets — values match /api/talent/route.ts:55-62 verbatim so
// the same wizard pill choice validates the same way on both routes. Strategy
// (Option 2 from the audit): empty stays NULL; an unrecognised NON-empty value
// snaps to the default. The wizard's pills prevent invalid non-empty values in
// the happy path; this guards stale-cached clients + direct API calls.
const VALID_AVAILABILITY = ["Available Now", "Not Available"];
const DEFAULT_AVAILABILITY = "Available Now";
const VALID_WORK_TYPE = ["Full-time", "Part-time", "Contract", "Any"];
const DEFAULT_WORK_TYPE = "Full-time";
const VALID_NOTICE_PERIOD = ["Immediate", "2 Weeks", "1 Month", "Negotiable"];
const DEFAULT_NOTICE_PERIOD = "Immediate";
const VALID_WORK_LOCATION = ["Remote", "Hybrid", "Onsite"];
const DEFAULT_WORK_LOCATION = "Remote";

// Shared error message — never leaks Supabase/Postgres details to the client.
// Real failures are logged server-side via console.error.
const GENERIC_ERROR_MESSAGE = "Submission failed. Please try again.";
const GENERIC_INVALID_MESSAGE = "Invalid submission.";

// Storage bucket + DB table names — single source of truth.
const CV_BUCKET = "cvs";
const APPLICATIONS_TABLE = "job_applications";

function nullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Mirror of /api/talent/route.ts:70-74. Returns null on missing, non-string,
// or non-numeric input — so callers can clamp/null in one shape.
function intOrNull(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Mirror of /api/hire-remote-profiles/route.ts:40-49. Generic JSON parse with
// silent fallback — used for skills + employment_history. Garbage in / parse
// failure → fallback, never throws.
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

// Rich, frozen-at-apply-time snapshot of the candidate's screening answers.
// Scored entirely against the SERVER's questions (source of truth) — only the
// answer string comes from the client. Pure + never-throws: bad/missing input
// yields answer:"" / matched:false. Mirrors the modal's matching exactly
// (yesno equal · numeric per numeric_mode · multiple index-equal).
type ScreeningAnswerSnapshot = {
  question_id: string;
  question: string;
  type: "yesno" | "numeric" | "multiple";
  essential: boolean;
  ideal: string;
  answer: string;
  answer_label?: string;
  ideal_label?: string;
  matched: boolean;
  /** Absent = scored. False only for a numeric_mode 'none' question — collected
   *  but never tested, so `matched` carries no meaning and must be ignored. */
  scored?: boolean;
  /** Numeric answers only. Absent on pre-mode rows, which were all minimums. */
  numeric_mode?: NumericMode;
};

function buildScreeningSnapshot(
  questions: ScreeningQuestion[],
  answerMap: Map<string, string>,
): ScreeningAnswerSnapshot[] {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  return questions.slice(0, 10).map((q) => {
    const answer = (answerMap.get(q.id) ?? "").trim();
    let matched = false;
    // Only ever set false, and only by a numeric_mode 'none' question. Absent
    // from the snapshot otherwise, so every other answer serialises exactly as
    // it did before this existed.
    let scored = true;
    // Frozen so a display can name the operator later without re-reading the
    // job, whose question may since have been re-typed. Numeric answers only.
    let numeric_mode: NumericMode | undefined;
    let answer_label: string | undefined;
    let ideal_label: string | undefined;

    if (q.type === "yesno") {
      matched = answer !== "" && answer === q.ideal;
    } else if (q.type === "numeric") {
      // resolveNumericMode covers questions stored before numeric_mode existed.
      const mode = resolveNumericMode(q);
      numeric_mode = mode;
      if (mode === "none") {
        // Collected, not tested. `matched` stays false so a reader that only
        // knows about `matched` under-claims rather than over-claims.
        scored = false;
      } else {
        const a = Number(answer);
        const ideal = Number(q.ideal);
        const comparable = answer !== "" && Number.isFinite(a) && Number.isFinite(ideal);
        matched = comparable && (mode === "min" ? a >= ideal : a <= ideal);
      }
    } else if (q.type === "multiple") {
      matched = answer !== "" && String(answer) === String(q.ideal);
      const ai = Number(answer);
      const ii = Number(q.ideal);
      const opts = Array.isArray(q.options) ? q.options : [];
      if (Number.isInteger(ai) && ai >= 0 && ai < opts.length) answer_label = opts[ai];
      if (Number.isInteger(ii) && ii >= 0 && ii < opts.length) ideal_label = opts[ii];
    }

    return {
      question_id: String(q.id),
      question: String(q.question ?? ""),
      type: q.type,
      essential: Boolean(q.essential),
      ideal: String(q.ideal ?? ""),
      answer,
      ...(answer_label !== undefined ? { answer_label } : {}),
      ...(ideal_label !== undefined ? { ideal_label } : {}),
      matched,
      ...(scored ? {} : { scored }),
      ...(numeric_mode ? { numeric_mode } : {}),
    };
  });
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "apply" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // Short reference emitted on every 500 path — both in the JSON response
  // and in the matching server log line — so a failing candidate can quote
  // it back and the log can be grepped directly.
  const errorId = crypto.randomUUID().slice(0, 8);

  try {
    const form = await request.formData();

    const jobId = nullable(form.get("job_id"));
    const jobTitle = nullable(form.get("job_title_manual"));
    const firstName = nullable(form.get("first_name"));
    const lastName = nullable(form.get("last_name"));
    const rawEmail = nullable(form.get("email"));
    const email = rawEmail ? normalizeEmail(rawEmail) : null;
    const phone = nullable(form.get("phone"));
    const linkedin = nullable(form.get("linkedin_url"));
    const notes = nullable(form.get("notes"));
    const cvText = nullable(form.get("cv_text"));
    /*
     * Attribution — where this applicant came from. Every field OPTIONAL.
     *
     * `nullable` already yields null for a missing, non-string or blank value,
     * so a form omitting all four behaves exactly as it did before this
     * existed. Nothing here validates or throws: a malformed value is stored as
     * a short string or not at all, because an application must never fail
     * because a browser refused localStorage.
     *
     * Read under `attribution_*`, NOT `source`: that field already means
     * job_application|manual_upload on this route and its column carries a
     * CHECK for exactly those two values. See the report.
     */
    const attrSource = nullable(form.get("attribution_source"));
    const attrDetail = nullable(form.get("attribution_detail"));
    const attrReferrer = nullable(form.get("attribution_referrer"));
    const attrLanding = nullable(form.get("attribution_landing_path"));
    // Guard the `source` field: only accept the two known string values.
    const sourceRaw = form.get("source");
    const source: "job_application" | "manual_upload" =
      sourceRaw === "manual_upload" ? "manual_upload" : "job_application";
    // Guard the `cv` field: must be a File, not a string. A renamed field
    // (e.g. text) would otherwise type-assert through and crash on .size.
    const cvFieldValue = form.get("cv");
    const cvFile = cvFieldValue instanceof File ? cvFieldValue : null;

    // JOB-005 — two admin-only claims share this one gate:
    //   · source=manual_upload skips the duplicate check and the JOB-002
    //     visibility gate below;
    //   · job_title_manual makes the route INSERT a placeholder row into the
    //     jobs table, and that insert is keyed on the field alone — it fires
    //     whatever `source` says, so it needs its own trigger here.
    // The only sender of either is the admin applications dashboard; the
    // public apply modal sends job_id + source-less job_application only.
    // Same pattern as /api/check-duplicate: requireAdmin throws on no
    // session / no active admin_users row / bad role, and the bare catch
    // fails CLOSED on every failure mode, auth outages included.
    // Deliberately a 403 rather than a silent downgrade — a downgrade would
    // hide the spoof attempt and give confusing half-candidate behaviour.
    // Placed before any CV processing, storage upload, or jobs-table insert
    // so a rejected request writes nothing anywhere. The plain candidate
    // path (job_id + job_application) never enters this branch and makes
    // zero auth calls.
    if (source === "manual_upload" || jobTitle !== null) {
      try {
        await requireAdmin();
      } catch {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    if (!firstName || !cvFile) {
      return NextResponse.json({ error: "First name and CV are required." }, { status: 400 });
    }

    // Length caps on every user-supplied text field. Reject early — before
    // any DB read or storage write — so an attacker can't pad rows or stall
    // queries with multi-MB strings. Generic message so we don't tell them
    // which field tripped.
    if (
      firstName.length > MAX_NAME_LENGTH ||
      (lastName !== null && lastName.length > MAX_NAME_LENGTH) ||
      (jobTitle !== null && jobTitle.length > MAX_JOB_TITLE_LENGTH) ||
      (phone !== null && phone.length > MAX_PHONE_LENGTH) ||
      (notes !== null && notes.length > MAX_NOTES_LENGTH)
    ) {
      return NextResponse.json({ error: GENERIC_INVALID_MESSAGE }, { status: 400 });
    }

    // jobId, when present, MUST be a real UUID — see UUID_REGEX comment.
    if (jobId !== null && !UUID_REGEX.test(jobId)) {
      return NextResponse.json({ error: GENERIC_INVALID_MESSAGE }, { status: 400 });
    }

    // Email is optional on /apply (job application can be anonymised), but if
    // provided it must be a real-looking address — we use it for duplicate
    // detection and downstream contact.
    if (email !== null && !isValidEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    if (cvFile.size > MAX_CV_FILE_BYTES) {
      return NextResponse.json({ error: "CV file is too large (max 5 MB)." }, { status: 413 });
    }

    // Magic-byte check: PDF files start with "%PDF" (0x25 0x50 0x44 0x46).
    // Don't trust the client-supplied content type — a renamed .html or .exe
    // would otherwise sail through the upload step.
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

    // Server-side CV text extraction (unpdf). Prefer client-sent cv_text
    // (admin bulk upload still extracts in the browser); otherwise extract
    // from the PDF bytes we already have in cvBuffer. Double-wrapped so a
    // failure — including an unexpected module-load/runtime error — can
    // NEVER 500 or block the application. On any failure the row still
    // inserts with cv_text=null and a cv_text_status of 'failed'/'skipped'.
    let resolvedCvText: string | null = cvText;
    let cvTextStatus: "pending" | "completed" | "failed" | "skipped" = "pending";
    let cvTextError: string | null = null;

    if (resolvedCvText && resolvedCvText.trim()) {
      // Client (admin bulk) already supplied text — trust it, skip server extraction.
      cvTextStatus = "completed";
    } else {
      try {
        const result = await extractPdfTextServer(cvBuffer);
        resolvedCvText = result.text;
        cvTextStatus = result.status;
        cvTextError = result.error;
      } catch (err) {
        // Belt-and-braces: the helper is never-throws, but if the module
        // itself fails to load at runtime (the pdf-parse failure mode),
        // degrade gracefully here.
        console.error("[apply] cv extraction call failed:", err);
        resolvedCvText = null;
        cvTextStatus = "failed";
        cvTextError = "extract_call_failed";
      }
    }

    // Truncate parsed CV text before it ends up in Postgres / search blobs.
    const boundedCvText =
      resolvedCvText && resolvedCvText.length > MAX_CV_TEXT_LENGTH
        ? resolvedCvText.slice(0, MAX_CV_TEXT_LENGTH)
        : resolvedCvText;

    if (!linkedin || !LINKEDIN_URL_PATTERN.test(linkedin)) {
      return NextResponse.json({ error: "Valid LinkedIn URL required" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // JOB-002 — visibility gate. A candidate must only be able to apply to a
    // job the public pages would actually show; a closed, archived, or
    // placeholder job must not accept direct POSTs. The rule matches
    // publiclyVisible in src/lib/jobs.ts (status === "open" && archived_at
    // IS NULL) but deliberately stays a ROW check rather than the query
    // helper: the row is fetched unconditionally so a missing job can 404
    // while an existing-but-hidden job 410s — filtering in the query would
    // collapse both into "no row".
    //
    // Scoped exactly like the dedup check below: manual_upload is exempt
    // (admins backfill candidates onto withdrawn roles, and the manual-title
    // branch creates its placeholder as status "closed" — gating it would
    // break bulk upload outright). `source` is client-supplied, but the
    // JOB-005 admin gate above 403s any manual_upload claim from a
    // non-admin, so the exemption is no longer spoofable. Placed BEFORE the
    // CV storage upload so a rejection can't strand an orphan PDF.
    if (source !== "manual_upload" && jobId !== null) {
      const { data: visRow, error: visError } = await supabase
        .from("jobs")
        .select("status, archived_at")
        .eq("id", jobId)
        .maybeSingle();

      if (visError) {
        // Fail closed — an unverifiable job must not accept applications.
        console.error(`[/api/apply][${errorId}] job visibility lookup failed:`, visError);
        return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, errorId }, { status: 500 });
      }

      if (!visRow) {
        return NextResponse.json({ error: "Job not found." }, { status: 404 });
      }

      const vis = visRow as { status: string | null; archived_at: string | null };
      if (vis.status !== "open" || vis.archived_at !== null) {
        return NextResponse.json(
          { error: "This role is no longer accepting applications." },
          { status: 410 },
        );
      }
    }

    // 0. Same-job duplicate check — only for public job applications. The admin
    //    "Manual Upload" flow already shows a soft warning panel and lets the
    //    admin opt in, so we don't want to block submissions there.
    //
    //    Bridge-flow change: dedup is now scoped to (email|phone, job_id).
    //    A candidate applying to the same job twice with the same email or
    //    phone is blocked; applying to a DIFFERENT job with the same details
    //    is allowed. This is required for the apply → join-as-talent bridge
    //    (we want repeat applicants across jobs to keep getting the bridge
    //    CTA on each application). Skip the check entirely when there's no
    //    job_id (manual-title submissions with placeholder job).
    if (source !== "manual_upload" && jobId !== null) {
      const normalizedPhone = normalizePhone(phone ?? "");

      // Email match — case-insensitive lookup scoped to this job.
      let emailMatch: { id: string; created_at: string | null } | null = null;
      if (email) {
        const { data } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id, created_at")
          .ilike("email", email.trim())
          .eq("job_id", jobId)
          .maybeSingle();
        emailMatch = (data as { id: string; created_at: string | null } | null) ?? null;
      }

      // Phone match — fetch a slice of recent rows for this job and
      // normalise in JS, since we can't apply normalizePhone in SQL without
      // a generated column.
      let phoneMatch: { id: string; created_at: string | null } | null = null;
      if (normalizedPhone.length >= 7) {
        const { data: phoneRecords } = await supabase
          .from(APPLICATIONS_TABLE)
          .select("id, phone, created_at")
          .eq("job_id", jobId)
          .not("phone", "is", null)
          .order("created_at", { ascending: false })
          .limit(100);

        const records = (phoneRecords ?? []) as Array<{
          id: string;
          phone: string | null;
          created_at: string | null;
        }>;
        const found = records.find((r) => normalizePhone(r.phone ?? "") === normalizedPhone);
        phoneMatch = found ? { id: found.id, created_at: found.created_at } : null;
      }

      const dupMatch = emailMatch ?? phoneMatch;
      if (dupMatch) {
        return NextResponse.json(
          {
            error: "duplicate_application",
            message: "You have already applied to this job.",
            appliedAt: dupMatch.created_at,
          },
          { status: 409 },
        );
      }
    }

    // 1. Upload CV to storage. K1: filename is a UUID — no PII in the path,
    //    no guessable timestamp/email pattern. Folder still groups by job for
    //    operational find-ability.
    const folder = jobId ?? "manual";
    const path = `${folder}/${crypto.randomUUID()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(CV_BUCKET)
      .upload(path, cvBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      console.error(`[/api/apply][${errorId}] storage upload failed:`, uploadError);
      return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, errorId }, { status: 500 });
    }

    // 3. If a manual job title was typed, create a placeholder job and link it.
    //    Job title from a dropdown is referenced via job_id directly.
    let resolvedJobId: string | null = jobId;
    if (!resolvedJobId && jobTitle) {
      const { data: jobRow } = await supabase
        .from("jobs")
        .insert({
          title: stripInvalidPgChars(jobTitle),
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

    // Screening questions — fetched from the SERVER job row (source of truth)
    // so scoring can't be spoofed by the client. job missing / no questions →
    // [] → snapshot []. Never throws.
    let serverScreeningQuestions: ScreeningQuestion[] = [];
    // Frozen at apply time so the company still sees this applicant after the
    // job row is deleted (job_id is ON DELETE SET NULL). Null for Remotiv-owned
    // and placeholder jobs — those simply aren't company-scoped.
    let companyIdSnapshot: string | null = null;
    if (resolvedJobId) {
      const { data: jobQ } = await supabase
        .from("jobs")
        .select("screening_questions, company_id")
        .eq("id", resolvedJobId)
        .maybeSingle();
      const raw = (jobQ as { screening_questions?: unknown } | null)?.screening_questions;
      serverScreeningQuestions = Array.isArray(raw) ? (raw as ScreeningQuestion[]) : [];
      companyIdSnapshot = (jobQ as { company_id?: string | null } | null)?.company_id ?? null;
    }

    // Phase 2b — parse the wizard's new fields just before the INSERT. Placed
    // AFTER the dedup + CV upload + placeholder-job blocks so a malformed
    // payload on these new fields can't waste a storage upload or trip the
    // dedup-by-email gate. None of these branches reject: empties stay NULL,
    // garbage enum values coerce to the safe default, JSON parse failures
    // fall back to []. This is intentional — the wizard's UI is the gate.
    const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

    const applicantJobTitle = cap(
      nullable(form.get("applicant_job_title")),
      APPLY_FIELD_MAX.jobTitle,
    );
    const roleCategory = cap(nullable(form.get("role_category")), APPLY_FIELD_MAX.roleCategory);
    const degree = cap(nullable(form.get("degree")), APPLY_FIELD_MAX.degree);
    const institution = cap(nullable(form.get("institution")), APPLY_FIELD_MAX.institution);
    const city = cap(nullable(form.get("city")), APPLY_FIELD_MAX.city);
    const country = cap(nullable(form.get("country")), APPLY_FIELD_MAX.country);
    const summary = cap(nullable(form.get("summary")), APPLY_FIELD_MAX.summary);

    const yearsParsed = intOrNull(form.get("years_experience"));
    const yearsExperience = yearsParsed == null ? null : Math.max(0, Math.min(70, yearsParsed));

    const rawAvailability = nullable(form.get("availability"));
    const availability = rawAvailability
      ? VALID_AVAILABILITY.includes(rawAvailability)
        ? rawAvailability
        : DEFAULT_AVAILABILITY
      : null;

    const rawWorkType = nullable(form.get("work_type"));
    const workType = rawWorkType
      ? VALID_WORK_TYPE.includes(rawWorkType)
        ? rawWorkType
        : DEFAULT_WORK_TYPE
      : null;

    const rawNoticePeriod = nullable(form.get("notice_period"));
    const noticePeriod = rawNoticePeriod
      ? VALID_NOTICE_PERIOD.includes(rawNoticePeriod)
        ? rawNoticePeriod
        : DEFAULT_NOTICE_PERIOD
      : null;

    const rawWorkLocation = nullable(form.get("work_location"));
    const workLocation = rawWorkLocation
      ? VALID_WORK_LOCATION.includes(rawWorkLocation)
        ? rawWorkLocation
        : DEFAULT_WORK_LOCATION
      : null;

    const skillsRaw = safeJson<unknown>(form.get("skills"), []);
    const skills: string[] = Array.isArray(skillsRaw)
      ? (skillsRaw as unknown[])
          .filter((s): s is string => typeof s === "string")
          .slice(0, MAX_SKILLS)
          .map((s) => s.slice(0, APPLY_FIELD_MAX.skill))
      : [];

    type EmploymentEntry = {
      title: string;
      company: string;
      start: string;
      end: string;
      description: string;
      skills: string[];
    };
    const empRaw = safeJson<unknown>(form.get("employment_history"), []);
    const employmentHistory: EmploymentEntry[] = Array.isArray(empRaw)
      ? (empRaw as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
          .map((e) => ({
            title:
              typeof e.title === "string"
                ? (e.title as string).slice(0, APPLY_FIELD_MAX.expField)
                : "",
            company:
              typeof e.company === "string"
                ? (e.company as string).slice(0, APPLY_FIELD_MAX.expField)
                : "",
            start:
              typeof e.start === "string"
                ? (e.start as string).slice(0, APPLY_FIELD_MAX.expField)
                : "",
            end:
              typeof e.end === "string" ? (e.end as string).slice(0, APPLY_FIELD_MAX.expField) : "",
            description:
              typeof e.description === "string"
                ? (e.description as string).slice(0, APPLY_FIELD_MAX.experienceDescription)
                : "",
            skills: Array.isArray(e.skills)
              ? (e.skills as unknown[])
                  .filter((s): s is string => typeof s === "string")
                  .slice(0, MAX_SKILLS)
                  .map((s) => (s as string).slice(0, APPLY_FIELD_MAX.skill))
              : [],
          }))
          .filter((row) => row.title || row.company)
          .slice(0, MAX_EXPERIENCES)
      : [];

    // Screening answers — read the client's submitted answers (answer strings
    // only), key them by question id, then score against the server questions.
    // safeJson never throws; non-string ids/answers are coerced or skipped.
    // Answer strings are user-derived and land in JSONB, so they are stripped
    // of NUL/control chars here — BEFORE snapshot construction — so a PDF-
    // paste or clipboard artifact can't fail the whole insert.
    const rawScreeningAnswers = safeJson<unknown>(form.get("screening_answers"), []);
    const screeningAnswerMap = new Map<string, string>();
    if (Array.isArray(rawScreeningAnswers)) {
      for (const item of rawScreeningAnswers) {
        if (item && typeof item === "object") {
          const id = (item as { id?: unknown }).id;
          const ans = (item as { answer?: unknown }).answer;
          if (typeof id === "string") {
            const answerStr = typeof ans === "string" ? ans : String(ans ?? "");
            screeningAnswerMap.set(id, stripInvalidPgChars(answerStr));
          }
        }
      }
    }
    const screeningSnapshot = buildScreeningSnapshot(serverScreeningQuestions, screeningAnswerMap);

    // Sanitize every user-derived string that reaches Postgres. Applied
    // HERE — after all validation, length caps, and enum coercion — so a
    // shortened sanitized value can't sneak past a rejection threshold.
    // extractPdfTextServer already sanitizes the server-extraction path;
    // this covers the client-sent cv_text branch and every wizard/basic
    // field. Length-neutral for well-formed input; only strips NUL and
    // C0 controls that Postgres rejects (SQLSTATE 22P05).
    const strip = (v: string | null): string | null => (v === null ? null : stripInvalidPgChars(v));

    const cleanEmpHistory = employmentHistory.map((row) => ({
      title: stripInvalidPgChars(row.title),
      company: stripInvalidPgChars(row.company),
      start: stripInvalidPgChars(row.start),
      end: stripInvalidPgChars(row.end),
      description: stripInvalidPgChars(row.description),
      skills: row.skills.map(stripInvalidPgChars),
    }));

    // CV retention. Set ONLY for company applications — a null
    // company_id_snapshot is a Remotiv-owned row (talent pool, or an applicant
    // to Remotiv's own listing) whose CV is the marketplace itself, and a null
    // date means keep forever. This is the only place the 24 months is
    // computed; the purge reads the stored column and never derives a date, so
    // changing this constant affects future applications and nothing already
    // written. Pure arithmetic on a value already in hand — it cannot throw.
    const CV_RETENTION_MONTHS = 24;
    const cvDeleteAfter = companyIdSnapshot
      ? new Date(new Date().setMonth(new Date().getMonth() + CV_RETENTION_MONTHS)).toISOString()
      : null;

    // 4. Insert application (service role bypasses RLS). We capture the
    //    inserted row id so the bridge-token issuance below can reference it
    //    via talent_claim_tokens.candidate_id.
    const { data: insertedRow, error: insertError } = await supabase
      .from(APPLICATIONS_TABLE)
      .insert({
        job_id: resolvedJobId,
        first_name: stripInvalidPgChars(firstName),
        last_name: strip(lastName),
        email: strip(email),
        phone: strip(phone),
        linkedin_url: stripInvalidPgChars(linkedin),
        cv_url: null,
        cv_path: path,
        cv_text: strip(boundedCvText),
        cv_text_status: cvTextStatus,
        cv_text_error: cvTextError,
        status: "new",
        source,
        notes: strip(notes),
        applicant_job_title: strip(applicantJobTitle),
        role_category: strip(roleCategory),
        years_experience: yearsExperience,
        degree: strip(degree),
        institution: strip(institution),
        city: strip(city),
        country: strip(country),
        availability,
        work_type: workType,
        notice_period: noticePeriod,
        work_location: workLocation,
        summary: strip(summary),
        skills: skills.map(stripInvalidPgChars),
        employment_history: cleanEmpHistory,
        screening_answers: screeningSnapshot,
        company_id_snapshot: companyIdSnapshot,
        cv_delete_after: cvDeleteAfter,
        // Attribution. `strip` is the same NUL/control-char guard every other
        // text column here uses, and `cap` is the existing length helper — both
        // reused rather than reintroduced. All three are nullable, and a missing
        // value writes NULL exactly as before this existed.
        source_detail: cap(strip(attrDetail ?? attrSource), 120),
        referrer: cap(strip(attrReferrer), 120),
        landing_path: cap(strip(attrLanding), 200),
      })
      .select("id")
      .single();

    if (insertError || !insertedRow) {
      console.error(
        `[/api/apply][${errorId}] DB insert failed: code=${insertError?.code} msg=${insertError?.message} details=${insertError?.details} hint=${insertError?.hint}`,
        insertError,
      );
      // Rollback: the CV is already in storage but its DB row never landed.
      // Delete the orphaned object so storage doesn't accumulate junk PDFs.
      // Wrap the cleanup so its own failure can't mask the original 500.
      try {
        await supabase.storage.from(CV_BUCKET).remove([path]);
      } catch (cleanupErr) {
        // [CV_ORPHAN] is the production grep tag — search logs for this
        // marker to surface every storage object whose rollback failed.
        console.error(`[CV_ORPHAN][/api/apply][${errorId}] rollback delete failed`, {
          path,
          bucket: CV_BUCKET,
          error: cleanupErr,
        });
      }
      return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, errorId }, { status: 500 });
    }

    const applicationId = (insertedRow as { id: string }).id;

    // 4b. Queue AI CV scoring. Company-owned jobs only — a Remotiv-owned
    //     application has no company to score for. Failure MUST NOT fail the
    //     application: the candidate has already applied, and an unscored CV
    //     is a missing convenience, not a lost submission. Logged, never
    //     surfaced, same contract as the bridge token below.
    if (resolvedJobId && companyIdSnapshot) {
      try {
        const queued = await enqueue({
          type: "ai_cv_score",
          payload: { applicationId },
          companyId: companyIdSnapshot,
        });
        if (!queued.ok) {
          console.error("[/api/apply] cv scoring enqueue failed (non-fatal):", queued.error);
        }
      } catch (queueErr) {
        console.error("[/api/apply] cv scoring enqueue threw (non-fatal):", queueErr);
      }
    }

    // 4c. Tell the candidate we got it. Same non-fatal contract as the
    //     scoring enqueue above — queueApplicationReceived never throws and
    //     logs its own failures, so a queue outage costs a courtesy email and
    //     never an application.
    await queueApplicationReceived(applicationId, companyIdSnapshot);

    // 5. Issue a bridge token so the success modal can offer
    //    "Complete your profile" → /join-as-talent?token=… . Reuses the
    //    talent_claim_tokens infrastructure with source_table='job_applications'
    //    (the source_table CHECK was widened to accept this value — see
    //    src/lib/supabase/schema.sql talent_claim_tokens migration).
    //
    //    Failure here MUST NOT fail the application. The candidate already
    //    successfully applied; we just can't offer the bridge. We log and
    //    fall through with bridgeToken=null. The success modal degrades
    //    gracefully to the original 3-second auto-close.
    let bridgeToken: string | null = null;
    try {
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { error: tokenErr } = await supabase.from("talent_claim_tokens").insert({
        token_hash: token,
        candidate_id: applicationId,
        source_table: "job_applications",
        status: "pending",
        expires_at: expiresAt,
      });
      if (tokenErr) {
        console.error("[/api/apply] bridge token insert failed (non-fatal):", tokenErr);
      } else {
        bridgeToken = token;
      }
    } catch (tokenThrow) {
      console.error("[/api/apply] bridge token threw (non-fatal):", tokenThrow);
    }

    return NextResponse.json({
      success: true,
      applicationId,
      bridgeToken,
    });
  } catch (err) {
    console.error(`[/api/apply][${errorId}] unexpected error:`, err);
    return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, errorId }, { status: 500 });
  }
}
