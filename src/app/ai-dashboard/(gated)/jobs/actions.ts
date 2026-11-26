"use server";

import { revalidatePath } from "next/cache";
import { actionFailed, actionIncomplete } from "@/app/ai-dashboard/lib/action-errors";
import { getCompanyContext, requireCompanyRole } from "@/app/ai-dashboard/lib/company-guards";
import {
  assertPublishableQuestions,
  namedList,
  oneOf,
  SCORING_ENUM_FALLBACKS,
  SCORING_RELEVANT_COLUMNS,
  sanitizeQuestions,
  scoringInputsChanged,
} from "@/app/ai-dashboard/lib/job-patch";
import {
  getJobScope,
  isEmptyScope,
  type JobScope,
  readJobScope,
  roleAllowsJobAction,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import {
  AUTOSHORTLIST_SOURCES,
  type CompanyJobInput,
  type CompanyJobRow,
  CV_WEIGHT_DEFAULT,
  CV_WEIGHT_DIMENSIONS,
  CV_WEIGHT_MAX,
  CV_WEIGHT_MIN,
  type DeletedCompanyJobRow,
  INTERVIEW_CRITERIA_MAX,
  INTERVIEW_DURATION_MAX,
  INTERVIEW_DURATION_MIN,
  JOB_CATEGORIES,
  JOB_CONTRACT_TYPES,
  JOB_CURRENCIES,
  JOB_EXPERIENCE_LEVELS,
  JOB_INTERVIEWER_NAME_MAX,
  JOB_STATUSES,
  JOB_TEXT_MAX,
  JOB_WORK_TYPES,
  type JobStatus,
  liveInterviewPatch,
  MUST_HAVE_MAX,
  normaliseInterviewDuration,
  snapWeight,
  suggestCriteria,
} from "@/app/ai-dashboard/lib/job-types";
import {
  type DraftedQuestion,
  draftAiGuidedQuestions,
  type GeneratedQuestion,
  generateInterviewQuestions,
} from "@/lib/ai/interview-questions";
import { generateJobDescription, type JdBrief } from "@/lib/ai/jd-generate";
import { proposeSplit } from "@/lib/ai/jd-split";
import { generateScoringCriteria } from "@/lib/ai/scoring-criteria";
import { generateScreeningQuestions } from "@/lib/ai/screening-questions";
import { parseRules } from "@/lib/calendar/availability";
import {
  LIVE_QUESTION_COUNT_REFUSAL,
  LIVE_QUESTION_LIST_NOT_YET,
  LIVE_QUESTION_LIST_SAVE_ENABLED,
  QUESTIONS_NOT_SAVED,
  QUESTIONS_NOT_UPDATED,
} from "@/lib/interviews/live-question-list";
import {
  DRAFT_FAILED,
  DRAFT_RATE_LIMITED,
  fairnessBlockMessage,
  firstFairnessBlock,
} from "@/lib/interviews/question-fairness";
import { MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "@/lib/interviews/question-mix";
import {
  ANSWER_SECONDS_MAX,
  ANSWER_SECONDS_MIN,
  COMPETENCY_MAX,
  type InterviewKind,
  type InterviewLengthId,
  type InterviewQuestionInput,
  MAX_QUESTIONS,
  PREP_SECONDS_MAX,
  PREP_SECONDS_MIN,
  QUESTION_TEXT_MAX,
  RUBRIC_MAX,
} from "@/lib/interviews/types";
import { applyGroups, mergeJobText, needsModelSplit, parseJobDescription } from "@/lib/jd/parse";
import type { JdGroup } from "@/lib/jd/partition";
import { composeLocation } from "@/lib/job-location";
import type { ScreeningQuestion } from "@/lib/jobs";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import { notifyCompany } from "@/lib/notifications/company";
import { slugify, uniqueSlug } from "@/lib/slug";
import { pageAll } from "@/lib/supabase/paging";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Row/input types live in lib/job-types.ts.
type MutationResult<T = undefined> =
  /**
   * `warning` is for work that is genuinely secondary to the mutation but
   * whose failure the user must still see — currently only the interview
   * question sync, which must not fail a job save but must not be silent
   * either. Optional, so every existing caller is unaffected.
   */
  { success: true; data: T; warning?: string } | { success: false; error: string };

const JOB_COLUMNS =
  "id, title, location, category, experience_level, contract_type, work_type, status, slug, salary_min, salary_max, salary_currency, positions, created_at, archived_at";

/** Remotiv stamps every company job with the same rating — companies must
 *  never be able to set their own star rating on the public card. */
const COMPANY_JOB_RATING = 4.5;

// ── Validation ───────────────────────────────────────────────

// oneOf, sanitizeQuestions, assertPublishableQuestions and namedList live in
// lib/job-patch.ts with scoringInputsChanged, so the normalisers and the
// comparison that depends on them are one tested module.

/**
 * Interviewer display name for the async interview (async_interview_name).
 * The AI Video Interview's interviewer is always Sarah and has no name field.
 *
 * The name only means anything while its toggle is on, so an off toggle writes
 * NULL rather than leaving a name behind that nothing reads and the UI would
 * later resurrect if the toggle came back on months later. Trimmed, capped at
 * JOB_INTERVIEWER_NAME_MAX, and an empty result collapses to null so the
 * column never holds "".
 *
 * Truncation, not rejection: the input's maxLength already stops typing, and a
 * forged over-length payload isn't worth failing an otherwise valid publish.
 */
function interviewerName(value: string | undefined, enabled: boolean): string | null {
  if (!enabled) return null;
  return (value ?? "").trim().slice(0, JOB_INTERVIEWER_NAME_MAX) || null;
}

/**
 * Build the writable column patch from wizard input. Mirrors the admin
 * buildPatch's required-field rules. Deliberately returns ONLY editable
 * columns — ownership/identity columns are stamped by the caller so no client
 * value can ever reach them.
 */
/**
 * One question list as the save received it: null when it may be saved, else
 * the refusal. Left out (undefined) is fine: that list is untouched.
 */
function checkQuestionList(list: unknown, noun: string, label: string): string | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return QUESTIONS_UNREADABLE;
  const asked = askedIn(list as InterviewQuestionInput[]);
  if (asked > MAX_QUESTIONS) {
    return `A job can have at most ${MAX_QUESTIONS} ${label}. Remove ${asked - MAX_QUESTIONS} to save.`;
  }
  return firstFairnessBlock(list as InterviewQuestionInput[], noun);
}

const QUESTIONS_UNREADABLE = "Those interview questions couldn't be read. Nothing was saved.";

/** Questions with text: what a save keeps. */
function askedIn(list: readonly InterviewQuestionInput[]): number {
  return list.filter((q) => (q?.question ?? "").trim().length > 0).length;
}

/**
 * AI Video Interview on and no live list sent (a client from before step 6):
 * the job's STORED live questions must already be 4 to 8. Read for a job the
 * caller's company owns and may act on (updateCompanyJob checks both first).
 */
async function liveCountRefusal(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
  companyId: string,
  input: CompanyJobInput,
): Promise<string | null> {
  if (input.avatar_interview_enabled !== true || input.live_interview_questions !== undefined) {
    return null;
  }
  const { data, error } = await supabase
    .from("interview_questions")
    .select("id")
    .eq("job_id", jobId)
    .eq("company_id", companyId)
    .eq("interview_kind", "live")
    .limit(50);
  if (error) return actionFailed("save those changes", error);
  const n = (data ?? []).length;
  return n >= MIN_JOB_QUESTIONS && n <= MAX_JOB_QUESTIONS ? null : LIVE_QUESTION_COUNT_REFUSAL;
}

function buildPatch(
  input: CompanyJobInput,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "Job title is required." };
  /*
   * `location` is COMPOSED from country + city when a country is given, and
   * left exactly as it was when one is not.
   *
   * That second half is the whole protection for rows written before the split.
   * Opening one for editing shows two blank inputs — we deliberately do not
   * parse the old string back into them, because a wrong guess would silently
   * rewrite a live job's display text on save. So a save that never touched the
   * new inputs must carry the old string through untouched.
   */
  const country = (input.country ?? "").trim();
  const city = (input.city ?? "").trim();
  const location = composeLocation({ country, city }) ?? (input.location ?? "").trim();
  if (!location) return { ok: false, error: "Location is required." };

  /*
   * A duration outside 10-240 is REFUSED, not silently nulled.
   *
   * bookingPatch would turn it into null — "not decided" — and the job would
   * save cleanly while quietly discarding what the recruiter typed. That is
   * the worse failure: they set 300, saw a successful save, and would find out
   * only when a candidate was offered 30-minute slots. A refusal here names
   * the range while the number is still on screen.
   */
  if (
    input.interview_duration_minutes !== null &&
    input.interview_duration_minutes !== undefined &&
    normaliseInterviewDuration(input.interview_duration_minutes) === null
  ) {
    return {
      ok: false,
      error: `Interview length must be between ${INTERVIEW_DURATION_MIN} and ${INTERVIEW_DURATION_MAX} minutes.`,
    };
  }

  const currency = (input.salary_currency ?? "").trim().toUpperCase();
  if (!(JOB_CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, error: "Currency is required (USD or PKR)." };
  }

  // Salary hidden → both columns null, so the public card shows no pay.
  const showSalary = input.show_salary !== false;
  const min = showSalary && input.salary_min ? Number.parseInt(input.salary_min, 10) : null;
  const max = showSalary && input.salary_max ? Number.parseInt(input.salary_max, 10) : null;
  if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max) && max < min) {
    return { ok: false, error: "Maximum salary must be at or above the minimum." };
  }

  const positions = Math.max(1, Number.parseInt(input.positions, 10) || 1);
  const status = oneOf<JobStatus>(input.status, JOB_STATUSES, "open");

  // "More options". Coerced, never trusted: `!== false` lands on TRUE and
  // `=== true` lands on FALSE when a field is absent, which reproduces each
  // column's DB default for a client that predates these options.
  const avatarOn = input.avatar_interview_enabled === true;
  const asyncOn = input.async_interview_enabled === true;

  // AI Video Interview needs no name: the interviewer is always Sarah
  // (LIVE_INTERVIEWER_NAME, 24 Nov). jobs.avatar_interviewer_name is no longer
  // written; the column stays, unused.
  // The two question lists (082): the async interview's (interview_questions)
  // and the AI Video Interview's (live_interview_questions). A list left out
  // is untouched and [] clears it, so each list GIVEN is checked here, before
  // the job is written: an array, at most MAX_QUESTIONS that are not blank,
  // and the question fairness check, on both lists, always (#58 commit 5: an
  // async-only job is checked too).
  if (input.live_interview_questions !== undefined && !LIVE_QUESTION_LIST_SAVE_ENABLED) {
    return { ok: false, error: LIVE_QUESTION_LIST_NOT_YET };
  }
  for (const [list, noun, label] of [
    [input.interview_questions, "Question", "interview questions"],
    [input.live_interview_questions, "AI Video Interview question", "AI Video Interview questions"],
  ] as const) {
    const refused = checkQuestionList(list, noun, label);
    if (refused) return { ok: false, error: refused };
  }
  // AI Video Interview on: 4 to 8 live questions, the range the live invite
  // accepts. Off: any number is kept, none included. A save that sends no
  // live list is checked against what is stored (liveCountRefusal).
  if (avatarOn && Array.isArray(input.live_interview_questions)) {
    const n = askedIn(input.live_interview_questions);
    if (n < MIN_JOB_QUESTIONS || n > MAX_JOB_QUESTIONS) {
      return { ok: false, error: LIVE_QUESTION_COUNT_REFUSAL };
    }
  }

  // AI Video Interview mode, length and hiring challenges (074). Checked here,
  // whatever the browser sent; a field it left out is not in the patch.
  const live = liveInterviewPatch(input);
  if (!live.ok) return { ok: false, error: live.error };

  const screeningQuestions = sanitizeQuestions(input.screening_questions);
  if (status === "open") {
    const unpublishable = assertPublishableQuestions(screeningQuestions);
    if (unpublishable) return { ok: false, error: unpublishable };
  }

  // Length ceiling enforced server-side too — the textarea's maxLength only
  // stops typing, not a direct action call with a forged payload.
  const longFields: ReadonlyArray<[string, string]> = [
    ["Description", input.description ?? ""],
    ["Responsibilities", input.responsibilities ?? ""],
    ["Requirements", input.requirements ?? ""],
  ];
  for (const [label, value] of longFields) {
    if (value.length > JOB_TEXT_MAX) {
      return {
        ok: false,
        error: `${label} is too long (${value.length.toLocaleString()} characters). The limit is ${JOB_TEXT_MAX.toLocaleString()}.`,
      };
    }
  }

  return {
    ok: true,
    patch: {
      title,
      location,
      category: oneOf(input.category, JOB_CATEGORIES, SCORING_ENUM_FALLBACKS.category),
      experience_level: oneOf(
        input.experience_level,
        JOB_EXPERIENCE_LEVELS,
        SCORING_ENUM_FALLBACKS.experience_level,
      ),
      contract_type: oneOf(input.contract_type, JOB_CONTRACT_TYPES, "Full time"),
      work_type: oneOf(input.work_type, JOB_WORK_TYPES, "Remote"),
      language: "English",
      positions,
      salary_currency: currency,
      salary_min: min !== null && Number.isFinite(min) ? min : null,
      salary_max: max !== null && Number.isFinite(max) ? max : null,
      description: (input.description ?? "").trim() || null,
      responsibilities: (input.responsibilities ?? "").trim() || null,
      requirements: (input.requirements ?? "").trim() || null,
      screening_questions: screeningQuestions,
      status,
      allow_rerecord: input.allow_rerecord !== false,
      ai_cv_scoring_enabled: input.ai_cv_scoring_enabled !== false,
      measure_relevancy: input.measure_relevancy === true,
      avatar_interview_enabled: avatarOn,
      async_interview_enabled: asyncOn,
      async_interview_name: interviewerName(input.async_interview_name, asyncOn),
      send_rejection_email: input.send_rejection_email === true,
      // `=== true` so an absent field lands on FALSE, matching the column
      // default. A client that predates this option must not opt itself in.
      listed_on_remotiv: input.listed_on_remotiv === true,
      country: country || null,
      city: city || null,
      scoring_must_haves: namedList(input.scoring_must_haves, MUST_HAVE_MAX),
      interview_criteria: namedList(input.interview_criteria, INTERVIEW_CRITERIA_MAX),
      ...bookingPatch(input),
      ...cvWeightPatch(input),
      ...autoshortlistPatch(input),
      ...live.patch,
    },
  };
}

/**
 * The four CV weights, clamped, with null preserved as null.
 *
 * `null` is a VALUE here, not an absence: it means equal weighting, which the
 * scorer implements as "leave the model's overall alone". Coercing it to a
 * number would silently switch weighting on for every job that never asked for
 * it, so anything that is not a finite number in range lands as null.
 */
/**
 * Interview duration and per-job booking hours — wizard step 5.
 *
 * ── Why this takes CompanyJobInput, not Record<string, unknown> ──
 *
 * It used to take the loose type, and that is precisely how it shipped dead.
 * The body gated on `"interview_duration_minutes" in input` while neither key
 * existed on CompanyJobInput, so both branches were unreachable and the
 * function returned {} on every save — for a whole session, silently, with
 * TypeScript perfectly happy. `Record<string, unknown>` accepts an object that
 * can never contain what the body is looking for; that is the entire failure.
 *
 * Typed against the form model, a key that is not on the model is a compile
 * error at the property access, and the `in` checks are gone because a typed
 * field is always present — its VALUE carries "not decided", as null.
 *
 * ── Why null is written, not omitted ─────────────────────────
 *
 * Null means "not decided for this job": the duration inherits whatever the
 * default is when a booking link is sent, and the hours inherit the host's
 * Settings hours. Writing a concrete value on every save would freeze today's
 * default onto every job and exempt them all from a later change. Clearing a
 * field must also persist, so null is written rather than skipped — omitting
 * it would make an override impossible to remove once set.
 *
 * The duration is re-validated here even though the form already did: this is
 * the last thing between a client-supplied object and a CHECK constraint, and
 * a 23514 is not a message anyone can act on. `normaliseInterviewDuration` is
 * the SAME function the form and the edit read path use, so the three cannot
 * disagree about what 10-240 means.
 *
 * Out of range becomes null — "not decided" — rather than being clamped to the
 * nearest bound. Clamping would silently store 240 for someone who typed 300
 * and show them a number they never chose.
 */
function bookingPatch(input: CompanyJobInput): Record<string, unknown> {
  return {
    interview_duration_minutes: normaliseInterviewDuration(input.interview_duration_minutes),
    // Validated through the SAME parser availability reads with, so a
    // malformed range cannot be stored here and silently dropped there — the
    // two would otherwise disagree about what the recruiter saved.
    booking_hours_override: (() => {
      const rules = parseRules(input.booking_hours_override);
      return rules.length > 0 ? rules : null;
    })(),
  };
}

function cvWeightPatch(input: CompanyJobInput): Record<string, number | null> {
  const patch: Record<string, number | null> = {};
  for (const { key } of CV_WEIGHT_DIMENSIONS) {
    patch[key] = clampWeight(input[key]);
  }
  return patch;
}

function clampWeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < CV_WEIGHT_MIN || rounded > CV_WEIGHT_MAX) return null;
  return rounded;
}

/**
 * Auto-shortlist source and thresholds.
 *
 * Switching the feature OFF nulls both thresholds rather than leaving them
 * behind. A stored threshold with no source is invisible in the UI and would
 * reappear the moment someone switched the feature back on months later,
 * flagging candidates against a number nobody remembers choosing.
 *
 * A source that is on but whose threshold is out of range lands as null, and
 * the scorer treats a missing threshold as "do not flag" — never as a default.
 * The safe direction for an unreadable bar is to flag nobody.
 */
function autoshortlistPatch(input: CompanyJobInput): Record<string, string | number | null> {
  const source = (AUTOSHORTLIST_SOURCES as readonly string[]).includes(
    input.autoshortlist_source ?? "",
  )
    ? (input.autoshortlist_source as string)
    : null;

  if (!source) {
    return {
      autoshortlist_source: null,
      autoshortlist_cv_threshold: null,
      autoshortlist_interview_threshold: null,
    };
  }

  return {
    autoshortlist_source: source,
    // Written only for the sources that can actually use them, so the stored
    // row cannot imply a bar that is never consulted.
    autoshortlist_cv_threshold:
      source === "cv" || source === "both"
        ? clampThreshold(input.autoshortlist_cv_threshold)
        : null,
    autoshortlist_interview_threshold:
      source === "interview" || source === "both"
        ? clampThreshold(input.autoshortlist_interview_threshold)
        : null,
  };
}

/**
 * Did the CV weighting actually move?
 *
 * Compared against the STORED row, not the form's initial state, for the same
 * reason scoringInputsChanged is: opening the wizard and saving without
 * touching anything must not queue a recompute over every scorecard, and a
 * colleague's concurrent edit must not be missed.
 *
 * `?? null` on both sides so undefined-vs-null cannot read as a change — the
 * patch always carries all four keys, but a row written before the columns
 * existed does not.
 */
function cvWeightsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return CV_WEIGHT_DIMENSIONS.some(({ key }) => (before[key] ?? null) !== (after[key] ?? null));
}

/** The estimate's window. Matches the handoff's "last 30 days". */
const ESTIMATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on ids pulled for the union in estimateAutoshortlistReach.
 *
 * The number is explicitly an estimate shown while someone drags a mark, so a
 * bounded approximation on a very large workspace is the right trade — but the
 * bound is stated here rather than left to PostgREST's implicit 1000, which
 * would truncate silently at a number nobody chose.
 */
const ESTIMATE_ID_CAP = 2000;

function clampThreshold(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

/**
 * Company-qualified slug: `acme-technologies-senior-frontend-engineer`.
 * Unlike the admin's title-only slug this stays unambiguous when two companies
 * post the same role. The -2/-3 probe loop remains as a backstop, and the
 * caller still catches 23505 because probe-then-insert isn't atomic.
 */
async function buildSlug(
  supabase: ReturnType<typeof createServiceClient>,
  companyName: string,
  title: string,
): Promise<string> {
  const base = [slugify(companyName), slugify(title)].filter(Boolean).join("-");
  return uniqueSlug(supabase, { table: "jobs", base, fallback: "job" });
}

function revalidateJobSurfaces(): void {
  revalidatePath("/ai-dashboard/jobs");
  revalidatePath("/jobs");
}

// ── Reads ────────────────────────────────────────────────────

/**
 * Applications per job, counted by the database in one read (#82).
 *
 * `job_applications!inner(count)` returns each job that has at least one
 * matching application, with the count; a job it leaves out has none, so it
 * counts 0. The embedded `company_id_snapshot` filter is the tenant boundary:
 * an application from another company pointing at our job is not counted, and
 * !inner is what makes that filter restrict the rows. The jobs carry the same
 * company, live-or-deleted and scope filters as the caller's own read.
 *
 * This replaced one head count per listed job, fired all at once, which had no
 * company filter and turned a failed count into a confident 0. A failed read
 * here throws (pageAll), and the caller reports the whole list unavailable.
 * The same shape as Overview's role cards (#32), verified on staging against
 * the per-job counts it replaces (identical at 10,003 applications).
 */
async function applicantCountsByJob(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  scope: JobScope,
  deleted: boolean,
): Promise<Map<string, number>> {
  const rows = await pageAll<{ id: string; job_applications: { count: number }[] | null }>(
    (from, to) => {
      let q = service
        .from("jobs")
        .select("id, job_applications!inner(count)")
        .eq("company_id", companyId)
        .eq("job_applications.company_id_snapshot", companyId);
      q = deleted ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
      if (scope.scoped) q = q.in("id", scope.jobIds);
      return q.order("id").range(from, to);
    },
    { scope: "jobs", label: deleted ? "deleted applicant counts" : "applicant counts" },
  );
  const counts = new Map<string, number>();
  for (const r of rows) {
    const n = r.job_applications?.[0]?.count;
    if (typeof n !== "number")
      throw new Error("[jobs] applicant counts: a job came back with no count");
    counts.set(r.id, n);
  }
  return counts;
}

/** Every job owned by the viewer's company. Readable by any active member. */
export async function fetchCompanyJobs(): Promise<Read<CompanyJobRow[]>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /*
   * Per-job scoping. A recruiter or hiring manager sees only the jobs they are
   * on the hiring team for; owner and admin see everything.
   *
   * The empty case short-circuits rather than issuing `.in("id", [])` — an
   * empty IN list is both a malformed request and, if a builder ever dropped
   * it, an unfiltered query. Returning [] is the same answer, safely.
   */
  // readJobScope, not getJobScope (#24): getJobScope turns a failed
  // hiring-team read into "assigned to no roles", and the page then tells a
  // hiring manager to ask for an assignment they already have. A failed read
  // is reported as one, so the page shows its own load-failed state.
  const scopeRead = await readJobScope(ctx);
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;
  // An answer: assigned to no roles means no roles to list.
  if (scope.scoped && scope.jobIds.length === 0) return answered([]);

  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("company_id", ctx.companyId)
      .is("deleted_at", null);
    if (scope.scoped) q = q.in("id", scope.jobIds);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      // id is a unique final term, so jobs sharing a created_at cannot
      // straddle a page boundary and come back twice or not at all (#54).
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("[jobs] fetchCompanyJobs failed:", error);
      // Not an empty workspace. Returning [] made a company with live roles
      // see "No jobs yet — post your first role", which does not merely
      // under-report: it invites a duplicate of a role they already have.
      return unavailable();
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  if (rows.length === 0) return answered([]);

  let counts: Map<string, number>;
  try {
    counts = await applicantCountsByJob(service, ctx.companyId, scope, false);
  } catch (err) {
    console.error(
      "[jobs] fetchCompanyJobs counts failed:",
      err instanceof Error ? err.message : err,
    );
    // Unavailable, never 0: a role card saying nobody applied, on no evidence.
    return unavailable();
  }

  return answered(
    rows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? "",
      location: (r.location as string) ?? "",
      category: (r.category as string) ?? "",
      experience_level: (r.experience_level as string) ?? "",
      contract_type: (r.contract_type as string) ?? "",
      work_type: (r.work_type as string) ?? "",
      status: (r.status as JobStatus) ?? "open",
      slug: (r.slug as string | null) ?? null,
      salary_min: (r.salary_min as number | null) ?? null,
      salary_max: (r.salary_max as number | null) ?? null,
      salary_currency: (r.salary_currency as string | null) ?? null,
      positions: (r.positions as number) ?? 1,
      created_at: (r.created_at as string) ?? "",
      archived_at: (r.archived_at as string | null) ?? null,
      applicant_count: counts.get(r.id as string) ?? 0,
    })),
  );
}

/**
 * The company's soft-deleted jobs, for the recovery view only.
 *
 * A separate action rather than widening `fetchCompanyJobs`, which filters
 * `deleted_at IS NULL` server-side. Letting tombstones into that list would
 * put them through its tab counts, hero bars and attention lists — six
 * aggregates, each a chance to leak a deleted job into a number. Keeping them
 * in their own query means they cannot reach any of it.
 *
 * Scoped the same way as the live list: a recruiter sees only roles they are on
 * the hiring team for, and that membership survives a soft delete.
 */
export async function fetchDeletedCompanyJobs(): Promise<Read<DeletedCompanyJobRow[]>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  // readJobScope for the same reason as fetchCompanyJobs (#24): a failed
  // hiring-team read would otherwise say "you have deleted nothing".
  const scopeRead = await readJobScope(ctx);
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;
  if (scope.scoped && scope.jobIds.length === 0) return answered([]);

  let q = service
    .from("jobs")
    .select("id, title, location, status, deleted_at")
    .eq("company_id", ctx.companyId)
    .not("deleted_at", "is", null);
  if (scope.scoped) q = q.in("id", scope.jobIds);

  const { data, error } = await q.order("deleted_at", { ascending: false }).limit(200);

  if (error) {
    console.error("[jobs] fetchDeletedCompanyJobs failed:", error);
    // Same reasoning as the live list: an empty recovery view would say "you
    // have deleted nothing" to someone who deleted something by accident.
    return unavailable();
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return answered([]);

  let counts: Map<string, number>;
  try {
    counts = await applicantCountsByJob(service, ctx.companyId, scope, true);
  } catch (err) {
    console.error(
      "[jobs] fetchDeletedCompanyJobs counts failed:",
      err instanceof Error ? err.message : err,
    );
    return unavailable();
  }

  return answered(
    rows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? "",
      location: (r.location as string) ?? "",
      status: (r.status as string) ?? "",
      deleted_at: (r.deleted_at as string) ?? "",
      applicant_count: counts.get(r.id as string) ?? 0,
    })),
  );
}

// ── Mutations ────────────────────────────────────────────────

/**
 * Put the creator on the job's hiring team.
 *
 * Without this a recruiter posts a job and immediately cannot see it — their
 * own visibility depends on team membership, and a brand-new job has none.
 * Owner and admin are seeded too: they do not need it for access, but the
 * Hiring team section should show who opened the role rather than reading
 * empty on every new job.
 *
 * Non-fatal. A job that exists with nobody on its team is recoverable from the
 * drawer; a job that failed to be created because a label row failed is not.
 */
async function seedHiringTeam(
  supabase: ReturnType<typeof createServiceClient>,
  ctx: { companyId: string; memberId: string | null; role: string },
  jobId: string,
): Promise<void> {
  if (!ctx.memberId) return;
  try {
    await supabase.from("job_hiring_team").insert({
      job_id: jobId,
      company_id: ctx.companyId,
      member_id: ctx.memberId,
      team_role: ctx.role === "hiring_manager" ? "hiring_manager" : "recruiter",
      added_by: ctx.memberId,
    });
  } catch (err) {
    console.error("[jobs] hiring team seed failed (non-fatal):", err);
  }
}

/**
 * Save a job's two question lists in ONE call to replace_interview_questions
 * (migration 082), which validates both, locks the job by company, and
 * replaces each list given in one transaction: any failure keeps both lists
 * exactly as they were.
 *
 * A list left out is passed as NULL and its rows are untouched; [] clears it.
 * Positions are assigned by the function, 1..n in list order. Blank rows are
 * dropped here, as before: a recruiter who added a question and changed their
 * mind. Live questions all count equally in v1, so they are stored at Normal
 * (2); the live invite freezes weight 1, the live scorer's own unit. A blank
 * competency or scoring guide is stored as null, which every reader treats as
 * none.
 *
 * Rows get fresh ids on every save. That is safe because an answer snapshots
 * its question_text and every invite freezes its questions (see
 * interview_answers.question_text and loadQuestionsSnapshot).
 *
 * Never throws, and the job save it follows still succeeds: the job's other
 * fields are already saved by then, so a failure is a warning, never a failed
 * save that would make the recruiter redo everything.
 */
async function syncInterviewQuestions(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
  companyId: string,
  input: Pick<CompanyJobInput, "interview_questions" | "live_interview_questions">,
  /** The warning if it fails: a new job's (none kept) or an edit's (previous kept). */
  failure: string,
): Promise<string | null> {
  const asyncList = rpcQuestions(input.interview_questions, "async");
  const liveList = rpcQuestions(input.live_interview_questions, "live");
  if (asyncList === null && liveList === null) return null;

  try {
    const { error } = await supabase.rpc("replace_interview_questions", {
      p_job_id: jobId,
      p_company_id: companyId,
      p_async: asyncList,
      p_live: liveList,
    });
    if (error) {
      // The code only: the database's text names the job and the rule.
      console.error(`[jobs] interview questions not saved (${error.code ?? "unknown"})`);
      return failure;
    }
  } catch {
    console.error("[jobs] interview question save threw");
    return failure;
  }
  return null;
}

/** One list in the function's shape, or null (left out: untouched). */
function rpcQuestions(inputs: InterviewQuestionInput[] | undefined, kind: InterviewKind) {
  if (!Array.isArray(inputs)) return null;
  return inputs
    .map((q) => ({
      question: (q.question ?? "").trim().slice(0, QUESTION_TEXT_MAX),
      competency: (q.competency ?? "").trim().slice(0, COMPETENCY_MAX) || null,
      rubric: (q.rubric ?? "").trim().slice(0, RUBRIC_MAX) || null,
      prep_seconds: clampInt(q.prepSeconds, PREP_SECONDS_MIN, PREP_SECONDS_MAX, 30),
      answer_seconds: clampInt(q.answerSeconds, ANSWER_SECONDS_MIN, ANSWER_SECONDS_MAX, 120),
      // Async: snapped to a stop (snapWeight), never clamped to a range. Live:
      // Normal, every question equal in v1.
      weight: kind === "live" ? CV_WEIGHT_DEFAULT : snapWeight(q.weight),
      required: q.required !== false,
    }))
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_QUESTIONS);
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Split the job description before it is written, if it is not split already.
 *
 * ── Why this is on the server and not only in the wizard ─────
 *
 * The wizard also asks the model, on blur, and writes the answer into the box.
 * That is a nicety: it lets the recruiter SEE the headings before publishing.
 * It is not a mechanism you can depend on, because the call takes a couple of
 * seconds and nothing stops them clicking Publish in that window — the header
 * carries a Publish button on every step, so "paste, publish" is two clicks and
 * about a second. Whichever way that race fell decided whether the job got
 * three columns or one, for the same paste and the same clicks.
 *
 * Doing it here removes the race rather than narrowing it. Every write goes
 * through create or update, both of which come here first, so the same text
 * always produces the same job.
 *
 * ── The double path cannot produce two answers ───────────────
 *
 * `needsModelSplit` is the guard, and it is what makes the two paths one. It
 * asks whether the text ARRIVING here is already split:
 *
 *   the wizard's call landed first → the columns hold headings, mergeJobText
 *     rebuilds a box that parses as "split", and this returns untouched. No
 *     second call, so no second opinion to disagree with the first.
 *   the wizard's call did not land → the box is unsplit, and this is the only
 *     call that happens.
 *
 * Exactly one split per job, whichever path got there. The client is
 * additionally stopped from applying a late result once a submit has begun —
 * see the wizard — so it cannot leave the form showing a split the database
 * does not have.
 *
 * ── It cannot fail the save ──────────────────────────────────
 *
 * `proposeSplit` never throws and returns null on every failure. A null returns
 * the input exactly as the recruiter wrote it and the job saves unsplit, which
 * is what would have happened before any of this existed. The cost is up to
 * TIMEOUT_MS of latency on the first save of an unsplit description, and none
 * on any save after that.
 */
async function splitIfNeeded(input: CompanyJobInput): Promise<CompanyJobInput> {
  const box = mergeJobText(input);
  if (!box.trim() || !needsModelSplit(parseJobDescription(box))) return input;

  const { groups, failure } = await proposeSplit(box);
  if (!groups) {
    console.warn(`[jd_split] server: no proposal (${failure}) — saving as written`);
    return input;
  }

  const parsed = parseJobDescription(applyGroups(box, groups));
  if (parsed.outcome !== "split") return input;

  return {
    ...input,
    description: parsed.description,
    responsibilities: parsed.responsibilities.join("\n"),
    requirements: parsed.requirements.join("\n"),
  };
}

export async function createCompanyJob(
  input: CompanyJobInput,
): Promise<MutationResult<{ id: string; slug: string | null }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const built = buildPatch(await splitIfNeeded(input));
  if (!built.ok) return { success: false, error: built.error };
  // A new job stores no live questions, so AI Video Interview on with none
  // sent is 0: refused, as buildPatch refuses a sent list outside 4 to 8.
  if (input.avatar_interview_enabled === true && input.live_interview_questions === undefined) {
    return { success: false, error: LIVE_QUESTION_COUNT_REFUSAL };
  }

  const supabase = createServiceClient();
  const slug = await buildSlug(supabase, ctx.company.name, built.patch.title as string);

  const { data, error } = await supabase
    .from("jobs")
    // Identity + ownership are stamped here, never taken from `input`:
    // buildPatch only ever returns editable columns, so a client-supplied
    // company / company_rating / company_id / created_by / slug is impossible.
    .insert({
      ...built.patch,
      company: ctx.company.name,
      company_rating: COMPANY_JOB_RATING,
      company_id: ctx.companyId,
      created_by: ctx.user.id,
      client_id: null,
      display_order: null,
      slug,
    })
    .select("id, slug")
    .single();

  if (error) {
    // The slug probe isn't atomic — a concurrent post can take the candidate
    // between probe and insert.
    if (error.code === "23505") {
      return {
        success: false,
        error: "That job link was just taken. Try again.",
      };
    }
    return { success: false, error: actionFailed("create that job", error) };
  }

  const row = data as { id: string; slug: string | null };
  await seedHiringTeam(supabase, ctx, row.id);
  const questionWarning = await syncInterviewQuestions(
    supabase,
    row.id,
    ctx.companyId,
    input,
    QUESTIONS_NOT_SAVED,
  );

  revalidateJobSurfaces();
  return {
    success: true,
    data: { id: row.id, slug: row.slug },
    ...(questionWarning ? { warning: questionWarning } : {}),
  };
}

/** Re-fetch the target and confirm it belongs to the caller's company. */
async function assertOwned(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
  companyId: string,
): Promise<
  { ok: true; title: string; current: Record<string, unknown> } | { ok: false; error: string }
> {
  const { data } = await supabase
    .from("jobs")
    .select(
      // The weight columns ride along so updateCompanyJob can tell whether the
      // weighting actually moved. They are NOT in SCORING_RELEVANT_COLUMNS on
      // purpose — they trigger a recompute, never a staleness bump.
      `id, company_id, criteria_version, ${SCORING_RELEVANT_COLUMNS.join(", ")}, ${CV_WEIGHT_DIMENSIONS.map((d) => d.key).join(", ")}`,
    )
    .eq("id", jobId)
    // A deleted job is not mutable. This one filter is what stops every caller
    // below it — edit, status, archive, delete — from reviving a tombstone, and
    // it answers with "not in your workspace" exactly as a hard delete did.
    .is("deleted_at", null)
    .maybeSingle();

  const row = data as
    | (Record<string, unknown> & { id: string; company_id: string | null; title: string })
    | null;
  if (!row || row.company_id !== companyId) {
    return { ok: false, error: "Job not found in your workspace." };
  }
  return { ok: true, title: row.title, current: row };
}

export async function updateCompanyJob(
  jobId: string,
  input: CompanyJobInput,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const built = buildPatch(await splitIfNeeded(input));
  if (!built.ok) return { success: false, error: built.error };

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }
  const liveRefused = await liveCountRefusal(supabase, jobId, ctx.companyId, input);
  if (liveRefused) return { success: false, error: liveRefused };

  // Bump criteria_version when anything the SCORER reads changed.
  //
  // The column existed and handleAiCvScore stamped it onto every scorecard, but
  // nothing ever incremented it — so job_criteria_version was frozen at 1 and a
  // scorecard judged against last month's requirements was indistinguishable
  // from one judged against today's. Incrementing here is what makes staleness
  // detectable at all; the applicants drawer compares the two and offers a
  // re-score.
  //
  // Compared against what is actually STORED rather than against the form's
  // initial state: a no-op save (open the wizard, change nothing, save) must not
  // invalidate every existing scorecard, and a concurrent edit by a colleague
  // must not be missed. scoringInputsChanged normalises the stored row through
  // the same functions that built this patch before comparing - the stored
  // jsonb comes back with keys in Postgres's order, not ours, and for a while
  // that alone read as a criteria change on every save.
  const patch: Record<string, unknown> = { ...built.patch };
  const scoringChanged = scoringInputsChanged(owned.current, patch);
  if (scoringChanged) {
    const currentVersion = Number(owned.current.criteria_version ?? 1);
    patch.criteria_version = (Number.isFinite(currentVersion) ? currentVersion : 1) + 1;
  }

  // built.patch carries editable columns only — company, company_rating,
  // company_id, created_by and slug are absent by construction, so an edit can
  // never re-point a job at another tenant or change its public URL.
  const { error } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: actionFailed("save those changes", error) };

  /*
   * ── Weights moved: recompute, don't re-score ──
   *
   * Enqueued only when a weight actually CHANGED, compared against what was
   * stored rather than against the form's initial state — a no-op save must not
   * queue a sweep over every scorecard the job has.
   *
   * Non-fatal: the job HAS been saved, and a failed enqueue must not report the
   * save as failed. The stored overalls stay on the previous weighting until a
   * recompute runs, which is stale arithmetic rather than a wrong scorecard.
   */
  if (cvWeightsChanged(owned.current, patch)) {
    try {
      const queued = await enqueue({
        type: JOB_TYPES.CV_SCORE_RECOMPUTE,
        payload: { jobId },
        companyId: ctx.companyId,
      });
      if (!queued.ok) {
        console.error("[jobs] reweight enqueue failed (non-fatal):", queued.error);
      }
    } catch (err) {
      console.error("[jobs] reweight enqueue threw (non-fatal):", err);
    }
  }

  const questionWarning = await syncInterviewQuestions(
    supabase,
    jobId,
    ctx.companyId,
    input,
    QUESTIONS_NOT_UPDATED,
  );

  revalidateJobSurfaces();
  return {
    success: true,
    data: undefined,
    ...(questionWarning ? { warning: questionWarning } : {}),
  };
}

/**
 * Step 9's live estimate: how many current applicants these marks would flag.
 *
 * ── Counted on the server, never in the client ───────────────
 *
 * The wizard has a page of rows at most; the answer is about the whole
 * workspace. Counting client-side would mean shipping every score to the
 * browser and would disagree with the Flagged badge, which is also a server
 * count. `count: "exact", head: true` returns the number in Content-Range
 * without transferring a single row.
 *
 * ── Scoping is the security-critical part ────────────────────
 *
 * Company first, then the caller's job scope through the SAME resolver the
 * applicants list uses — getJobScope / scopeJobIds. A hiring manager restricted
 * to two jobs must not learn how many applicants sit on the other forty. An
 * empty scope returns zero rather than falling through to an unfiltered count.
 *
 * ── Bounded ──────────────────────────────────────────────────
 *
 * Last 30 days, matching what the handoff specifies, so the number stays
 * meaningful on a long-lived workspace and the query stays on the created_at
 * index. Debouncing is the caller's job — this is one round trip per call.
 *
 * ── A job with no applicants yet ─────────────────────────────
 *
 * Returns `{ matched: 0, total: 0 }`. The count is over the WORKSPACE, not the
 * job being edited, which is deliberate: a brand-new job has no applicants by
 * definition, so scoping the estimate to it would always read "0 of 0" and
 * teach the recruiter nothing about where their marks sit. Reading the
 * workspace answers the question they are actually asking — "is this mark
 * strict or loose for the kind of people we see?" The UI should say "in this
 * workspace" rather than implying the number is about this job.
 *
 * A workspace with no applicants at all also returns zeroes, and the caller
 * should render the neutral "no applicants yet to estimate against" state
 * rather than a misleading "0 of 0 would be flagged".
 */
export async function estimateAutoshortlistReach(input: {
  source: string;
  cvThreshold: number | null;
  interviewThreshold: number | null;
}): Promise<{ matched: number; total: number }> {
  const ctx = await getCompanyContext();
  const scope = await getJobScope(ctx);
  const EMPTY = { matched: 0, total: 0 };
  if (isEmptyScope(scope)) return EMPTY;

  const source = (AUTOSHORTLIST_SOURCES as readonly string[]).includes(input.source)
    ? input.source
    : null;
  if (!source) return EMPTY;

  const service = createServiceClient();
  const allowedJobIds = scopeJobIds(scope);
  const since = new Date(Date.now() - ESTIMATE_WINDOW_MS).toISOString();

  /*
   * The denominator: applicants in scope, in the window. Counted separately
   * from the numerator rather than derived, so "N of M" is two honest counts
   * over the same predicate rather than one count and an assumption.
   */
  let totalQuery = service
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .eq("company_id_snapshot", ctx.companyId)
    .gte("created_at", since);
  if (allowedJobIds) totalQuery = totalQuery.in("job_id", allowedJobIds);

  const { count: total } = await totalQuery;
  if (!total) return EMPTY;

  /*
   * The numerator, one query per enabled source.
   *
   * `both` means EITHER mark flags, so the two sets can overlap and their
   * counts cannot simply be added. The ids are fetched and unioned in a Set
   * instead — bounded by ESTIMATE_ID_CAP so a huge workspace cannot pull an
   * unbounded list into memory for a number that is explicitly an estimate.
   */
  const matched = new Set<string>();

  if ((source === "cv" || source === "both") && typeof input.cvThreshold === "number") {
    let q = service
      .from("application_scores")
      .select("application_id")
      .eq("company_id", ctx.companyId)
      .eq("status", "scored")
      .gte("overall_score", input.cvThreshold)
      .gte("created_at", since)
      .limit(ESTIMATE_ID_CAP);
    if (allowedJobIds) q = q.in("job_id", allowedJobIds);
    const { data } = await q;
    for (const r of (data ?? []) as { application_id: string | null }[]) {
      if (r.application_id) matched.add(r.application_id);
    }
  }

  if (
    (source === "interview" || source === "both") &&
    typeof input.interviewThreshold === "number"
  ) {
    /*
     * Interview scores hang off the SESSION, which carries the application.
     * Two hops rather than a join: PostgREST embeds need a declared FK and
     * would silently drop rows whose session no longer exists.
     */
    const sessionQuery = service
      .from("interview_session_scores")
      .select("session_id")
      .eq("company_id", ctx.companyId)
      .eq("status", "scored")
      .gte("overall_score", input.interviewThreshold)
      .limit(ESTIMATE_ID_CAP);
    const { data: scoreRows } = await sessionQuery;
    const sessionIds = ((scoreRows ?? []) as { session_id: string | null }[])
      .map((r) => r.session_id)
      .filter((id): id is string => Boolean(id));

    if (sessionIds.length > 0) {
      // Chunked: the .in() list travels in the URL, which has a practical
      // ceiling well below ESTIMATE_ID_CAP.
      for (let i = 0; i < sessionIds.length; i += 200) {
        let sq = service
          .from("interview_sessions")
          .select("application_id")
          .eq("company_id", ctx.companyId)
          .in("id", sessionIds.slice(i, i + 200));
        if (allowedJobIds) sq = sq.in("job_id", allowedJobIds);
        const { data } = await sq;
        for (const r of (data ?? []) as { application_id: string | null }[]) {
          if (r.application_id) matched.add(r.application_id);
        }
      }
    }
  }

  return { matched: matched.size, total };
}

/**
 * One of a job's question lists, for the wizard's edit-mode prefill: the
 * async interview's ('async') or the AI Video Interview's ('live', 082).
 */
export async function fetchInterviewQuestions(
  jobId: string,
  kind: InterviewKind,
): Promise<InterviewQuestionInput[]> {
  const ctx = await getCompanyContext();
  if (!jobId || !(await roleAllowsJobAction(ctx, jobId))) return [];

  const { data } = await createServiceClient()
    .from("interview_questions")
    .select(
      "id, position, question, competency, rubric, prep_seconds, answer_seconds, weight, required",
    )
    .eq("job_id", jobId)
    .eq("company_id", ctx.companyId)
    .eq("interview_kind", kind)
    .order("position", { ascending: true })
    .limit(MAX_QUESTIONS);

  return (
    (data ?? []) as {
      id: string;
      question: string | null;
      competency: string | null;
      rubric: string | null;
      prep_seconds: number | null;
      answer_seconds: number | null;
      weight: number | null;
      required: boolean | null;
    }[]
  ).map((q) => ({
    id: q.id,
    question: q.question ?? "",
    competency: q.competency ?? "",
    rubric: q.rubric ?? "",
    prepSeconds: String(q.prep_seconds ?? 30),
    answerSeconds: String(q.answer_seconds ?? 120),
    // Snapped on the way in as well as on the way out, so a legacy row at 3 or
    // 5 opens on the stop the screen will render rather than on a value no
    // button can represent.
    weight: String(snapWeight(q.weight)),
    required: q.required !== false,
  }));
}

export async function updateCompanyJobStatus(
  jobId: string,
  status: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    return { success: false, error: "Invalid status." };
  }

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  // Draft → Published never goes through buildPatch, so without this a job
  // could carry an unset threshold onto the public site by the back door.
  // Re-read what's actually stored rather than trusting anything client-side.
  if (status === "open") {
    const { data: stored } = await supabase
      .from("jobs")
      .select("screening_questions")
      .eq("id", jobId)
      .maybeSingle();
    const unpublishable = assertPublishableQuestions(
      sanitizeQuestions((stored as { screening_questions?: unknown } | null)?.screening_questions),
    );
    if (unpublishable) {
      return { success: false, error: `${unpublishable} Open the job to fix it.` };
    }
  }

  const { error } = await supabase
    .from("jobs")
    .update({ status })
    .eq("id", jobId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: actionFailed("change that job's status", error) };

  // 'on_hold' is the product's Draft; moving a job back to it is routine
  // editing rather than an event the team needs told about.
  if (status === "open" || status === "closed") {
    await notifyCompany({
      companyId: ctx.companyId,
      type: status === "open" ? "job_published" : "job_closed",
      title: status === "open" ? `“${owned.title}” is live` : `“${owned.title}” was closed`,
      body:
        status === "open"
          ? `${ctx.memberName} published it - it's on remotiv.work now.`
          : `${ctx.memberName} closed it. It no longer accepts applications.`,
      jobId,
      href: "/ai-dashboard/jobs",
      actorMemberId: ctx.memberId,
    });
  }

  revalidateJobSurfaces();
  return { success: true, data: undefined };
}

/**
 * Archive or restore a job.
 *
 * Archiving is deliberately NOT a status change. A closed job is a finished
 * role that still has a public page a candidate may have bookmarked; an
 * archived job is withdrawn from the site entirely and kept only for the
 * company's records. Keeping them on separate columns means restoring a job
 * puts it back exactly as it was — a Published job that was archived returns
 * Published, without us having to remember what it used to be.
 *
 * A PUBLISHED job may be archived, and doing so takes it off the public site
 * immediately. That is allowed on purpose: the alternative is forcing a company
 * to close a role first, which writes a status they may not mean and which
 * would then need undoing by hand on restore. The confirm dialog says plainly
 * that the public post disappears.
 *
 * Applicants are untouched. They are scoped on company_id_snapshot, never
 * through jobs, so archiving a role hides the listing and nobody who applied
 * to it.
 */
export async function setCompanyJobArchived(
  jobId: string,
  archived: boolean,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  const { error } = await supabase
    .from("jobs")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", jobId)
    .eq("company_id", ctx.companyId);

  if (error) {
    return { success: false, error: actionFailed("change that job's archive status", error) };
  }

  if (archived) {
    await notifyCompany({
      companyId: ctx.companyId,
      type: "job_archived",
      title: `“${owned.title}” was archived`,
      body: `${ctx.memberName} archived it. Its applicants are still in your workspace.`,
      jobId,
      href: "/ai-dashboard/jobs",
      actorMemberId: ctx.memberId,
    });
  }

  // Same revalidation as a status change: the public list, the detail page and
  // the company careers view all have to drop (or regain) the job at once.
  revalidateJobSurfaces();
  return { success: true, data: undefined };
}

export async function deleteCompanyJob(jobId: string): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  // Still snapshotted, even though a soft delete keeps job_id intact and
  // jobs.title would resolve. Applications orphaned by the hard DELETE this
  // replaced already read their title from here, and leaving it unstamped
  // would make tombstoned jobs a second class whose applicant lists depend on
  // a row we promise to hide. It also survives a later purge.
  const { error: snapErr } = await supabase
    .from("job_applications")
    .update({ job_title_snapshot: owned.title })
    .eq("job_id", jobId);
  if (snapErr) return { success: false, error: actionFailed("delete that job", snapErr) };

  // `.is("deleted_at", null)` makes this idempotent: a double-submit stamps
  // once and the second call is a no-op rather than moving the timestamp.
  const { error } = await supabase
    .from("jobs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("company_id", ctx.companyId)
    .is("deleted_at", null);

  // The title snapshots above have already been written when this fails, so
  // this is not a "nothing was changed" case.
  if (error) return { success: false, error: actionIncomplete("delete that job", error) };

  revalidateJobSurfaces();
  return { success: true, data: undefined };
}

/**
 * Put a soft-deleted job back, scoped to the caller's company.
 *
 * Deliberately does NOT use `assertOwned` — that filters `deleted_at IS NULL`
 * and is therefore blind to the only rows this function exists to touch. The
 * ownership check is repeated inline instead, against a query that sees
 * tombstones.
 *
 * Same gate as `deleteCompanyJob` on the reasoning that whoever can hide a job
 * can unhide it, and `roleAllowsJobAction` reads `job_hiring_team`, which a soft
 * delete leaves intact — so a recruiter keeps access to a role they deleted.
 */
export async function restoreCompanyJob(jobId: string): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, company_id")
    .eq("id", jobId)
    .not("deleted_at", "is", null)
    .maybeSingle();

  const row = data as { company_id: string | null } | null;
  if (!row || row.company_id !== ctx.companyId) {
    return { success: false, error: "That job isn't in your workspace." };
  }
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  const { error } = await supabase
    .from("jobs")
    .update({ deleted_at: null })
    .eq("id", jobId)
    .eq("company_id", ctx.companyId)
    .not("deleted_at", "is", null);
  if (error) return { success: false, error: actionIncomplete("restore that job", error) };

  revalidateJobSurfaces();
  return { success: true, data: undefined };
}

/** Copy an existing job into a fresh Draft. Ownership-checked like the rest. */
export async function duplicateCompanyJob(jobId: string): Promise<MutationResult<{ id: string }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select(
      // The "More options" columns copy across too — a duplicate that silently
      // reverted to scoring-on would contradict the original's setting. The
      // step 8/9 columns copy for exactly the same reason: a copy that dropped
      // the weighting would score its applicants differently from the original
      // with nothing on screen to explain why. The AI Video Interview mode,
      // length and hiring challenges (074) copy too, and only ever within the
      // company: the company check below refuses any other company's job.
      "company_id, title, location, category, experience_level, contract_type, work_type, language, positions, salary_min, salary_max, salary_currency, description, responsibilities, requirements, screening_questions, allow_rerecord, ai_cv_scoring_enabled, measure_relevancy, avatar_interview_enabled, async_interview_enabled, async_interview_name, cv_weight_requirements, cv_weight_experience, cv_weight_domain, cv_weight_responsibilities, autoshortlist_source, autoshortlist_cv_threshold, autoshortlist_interview_threshold, scoring_must_haves, interview_criteria, interview_duration_minutes, booking_hours_override, live_interview_mode, live_interview_minutes, live_hiring_challenges",
    )
    .eq("id", jobId)
    // Duplicating a tombstone would mint a live Draft from content someone
    // deleted, under a new id that no restore view accounts for.
    .is("deleted_at", null)
    .maybeSingle();

  const source = data as (Record<string, unknown> & { company_id: string | null }) | null;
  if (!source || source.company_id !== ctx.companyId) {
    return { success: false, error: "Job not found in your workspace." };
  }
  if (!(await roleAllowsJobAction(ctx, jobId))) {
    return { success: false, error: "Job not found in your workspace." };
  }

  const title = `${source.title as string} (copy)`;
  const slug = await buildSlug(supabase, ctx.company.name, title);
  const { company_id: _ignored, ...copyable } = source;

  const { data: created, error } = await supabase
    .from("jobs")
    .insert({
      ...copyable,
      title,
      // Duplicates always land as Draft so a copy can't accidentally go live.
      status: "on_hold",
      company: ctx.company.name,
      company_rating: COMPANY_JOB_RATING,
      company_id: ctx.companyId,
      created_by: ctx.user.id,
      client_id: null,
      display_order: null,
      slug,
    })
    .select("id")
    .single();

  if (error) return { success: false, error: actionFailed("duplicate that job", error) };

  const copyId = (created as { id: string }).id;
  await seedHiringTeam(supabase, ctx, copyId);

  revalidateJobSurfaces();
  return { success: true, data: { id: copyId } };
}

/**
 * Ask the model where a pasted job description's sections begin and end.
 *
 * ── Why this is an action and not a route ────────────────────
 *
 * It runs behind `getCompanyContext`, so it is a model call only a signed-in
 * member of a workspace can make. An open endpoint that forwards arbitrary text
 * to Anthropic on our key is a bill and an abuse surface; this is neither.
 *
 * ── It cannot fail loudly ────────────────────────────────────
 *
 * `proposeSplit` never throws — missing key, timeout, bad JSON and an invalid
 * partition all come back as a `failure` string. This adds one more: a caller
 * who is not in a workspace. Every one of them means the same thing to the
 * screen, which falls back to asking the recruiter directly. Publishing a job
 * never waits on this and never fails because of it.
 */
export async function proposeJobDescriptionSplit(box: string): Promise<{
  groups: JdGroup[] | null;
  failure: string | null;
}> {
  try {
    await getCompanyContext();
  } catch {
    return { groups: null, failure: "not_in_workspace" };
  }
  const outcome = await proposeSplit(typeof box === "string" ? box : "");
  return { groups: outcome.groups, failure: outcome.failure };
}

/**
 * Write a first-draft job description from what step 1 already holds.
 *
 * Behind `getCompanyContext` for the same reason the split is: an open endpoint
 * that generates text on our Anthropic key is a bill and an abuse surface.
 *
 * Never throws. `generateJobDescription` returns a named failure for every path
 * — no key, timeout, empty, or a draft without usable headings — and this adds
 * the one it cannot know about. All of them mean the same thing to the wizard:
 * the box is left alone and the recruiter writes it themselves.
 */
export async function generateJobDescriptionDraft(brief: JdBrief): Promise<{
  text: string | null;
  failure: string | null;
}> {
  try {
    await getCompanyContext();
  } catch {
    return { text: null, failure: "not_in_workspace" };
  }
  const outcome = await generateJobDescription({
    title: typeof brief?.title === "string" ? brief.title : "",
    location: typeof brief?.location === "string" ? brief.location : "",
    category: brief?.category ?? null,
    experienceLevel: brief?.experienceLevel ?? null,
    contractType: brief?.contractType ?? null,
    workType: brief?.workType ?? null,
    positions: typeof brief?.positions === "number" ? brief.positions : null,
    // Passed through and never stored — see JdBrief.requirements.
    requirements: typeof brief?.requirements === "string" ? brief.requirements : null,
  });
  return { text: outcome.text, failure: outcome.failure };
}

/**
 * Propose interview questions from the job description the recruiter wrote.
 *
 * Behind `getCompanyContext` like the other two model calls. Never throws:
 * `generateInterviewQuestions` names every failure and this adds the one it
 * cannot know about. All of them leave step 5 exactly as it was.
 */
export async function suggestInterviewQuestions(input: {
  title: string;
  description: string;
  responsibilities: string;
  requirements: string;
  length: InterviewLengthId;
}): Promise<{ questions: GeneratedQuestion[] | null; failure: string | null }> {
  try {
    await getCompanyContext();
  } catch {
    return { questions: null, failure: "not_in_workspace" };
  }
  const outcome = await generateInterviewQuestions({
    title: typeof input?.title === "string" ? input.title : "",
    description: typeof input?.description === "string" ? input.description : "",
    responsibilities: typeof input?.responsibilities === "string" ? input.responsibilities : "",
    requirements: typeof input?.requirements === "string" ? input.requirements : "",
    length: input?.length ?? "standard",
  });
  return { questions: outcome.questions, failure: outcome.failure };
}

/** A draft as the review panel shows it: the block message, when the fairness check found one. */
export type QuestionDraft = Omit<DraftedQuestion, "issue"> & { blocked: string | null };

/**
 * AI-Guided "Draft questions with AI" (job wizard step 5). The same permission
 * as editing the job: owner, admin or recruiter, and for a saved job, one the
 * caller may act on. Rate limited (job-question-draft), one model call per
 * press. Writes NOTHING: the drafts go to the review panel, and only "Use these
 * questions" then saving the job puts them on it.
 *
 * Inputs are exactly title, description, required skills, seniority and hiring
 * challenges (DraftInput): never a CV, a candidate or the scoring criteria.
 */
export async function draftInterviewQuestions(input: {
  jobId?: string | null;
  title: string;
  description: string;
  requiredSkills: string;
  seniority: string;
  hiringChallenges: string;
  count: number;
}): Promise<{ drafts: QuestionDraft[] | null; error: string | null }> {
  let ctx: Awaited<ReturnType<typeof requireCompanyRole>>;
  try {
    ctx = await requireCompanyRole("owner", "admin", "recruiter");
  } catch {
    return { drafts: null, error: "You don't have permission to edit this job." };
  }
  const jobId = typeof input?.jobId === "string" && input.jobId ? input.jobId : null;
  if (jobId) {
    const owned = await assertOwned(createServiceClient(), jobId, ctx.companyId);
    if (!owned.ok || !(await roleAllowsJobAction(ctx, jobId))) {
      return { drafts: null, error: "That job isn't in your workspace." };
    }
  }
  // Per recruiter: each press is one model call, and 10 in 10 minutes covers
  // regenerating while reading. Loaded here, not at the top: the limiter starts
  // a cleanup timer on import, and no other job action needs it.
  const { rateLimitByKey } = await import("@/app/api/_lib/rate-limit");
  const rate = rateLimitByKey(`job-question-draft:${ctx.user.id}`, {
    max: 10,
    windowMs: 10 * 60_000,
    group: "security",
  });
  if (!rate.ok) {
    return { drafts: null, error: DRAFT_RATE_LIMITED };
  }
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const outcome = await draftAiGuidedQuestions({
    title: text(input?.title),
    description: text(input?.description),
    requiredSkills: text(input?.requiredSkills),
    seniority: text(input?.seniority),
    hiringChallenges: text(input?.hiringChallenges),
    count: Number(input?.count),
  });
  if (!outcome.questions) {
    console.warn(`[jobs] question draft failed (${outcome.failure})`);
    return { drafts: null, error: DRAFT_FAILED };
  }
  return {
    drafts: outcome.questions.map(({ issue, ...q }, i) => ({
      ...q,
      blocked: issue ? fairnessBlockMessage(i + 1, q.question, issue.topic, issue.part) : null,
    })),
    error: null,
  };
}

/**
 * Propose screening questions from the job description.
 *
 * Behind `getCompanyContext` like the other generators. Never throws, and every
 * failure leaves step 4 exactly as it was.
 *
 * What comes back still passes through `sanitizeQuestions` on save like any
 * hand-written question — the generator's own coercion is there so the
 * recruiter never SEES a question the server would reshape, not instead of it.
 */
export async function suggestScreeningQuestions(input: {
  title: string;
  description: string;
  responsibilities: string;
  requirements: string;
}): Promise<{ questions: ScreeningQuestion[] | null; failure: string | null }> {
  try {
    await getCompanyContext();
  } catch {
    return { questions: null, failure: "not_in_workspace" };
  }
  const outcome = await generateScreeningQuestions({
    title: typeof input?.title === "string" ? input.title : "",
    description: typeof input?.description === "string" ? input.description : "",
    responsibilities: typeof input?.responsibilities === "string" ? input.responsibilities : "",
    requirements: typeof input?.requirements === "string" ? input.requirements : "",
  });
  return { questions: outcome.questions, failure: outcome.failure };
}

/**
 * Propose scoring criteria from the job description.
 *
 * Offered on step 6 only when `suggestCriteria` — the instant, no-call path —
 * yields fewer than MUST_HAVE_MAX CV must-haves. On a tidily written job the
 * heuristic already fills the step and there is nothing to call a model about.
 *
 * ── The floor ────────────────────────────────────────────────
 *
 * A result that offers FEWER CV must-haves than the heuristic already does is
 * rejected whole, and the step keeps what it had.
 *
 * This never fired in forty panel-job generations across the 20-job corpus. It
 * is here anyway: that corpus is one author's house style, and the guard is for
 * the job description written by someone whose style we have not measured. It
 * costs one array length.
 *
 * Note what it does NOT guard. The model returning three where the heuristic
 * found one is the normal, wanted case, and the two lists rarely share wording
 * — the heuristic selects whole lines that fit under MUST_HAVE_MAX_LENGTH, the
 * model restates the ones that do not. So this compares COUNTS, which is the
 * axis the panel exists to improve, and says nothing about which is better
 * written. That judgement is the recruiter's, and they can see both.
 */
export async function suggestScoringCriteria(input: {
  title: string;
  description: string;
  responsibilities: string;
  requirements: string;
}): Promise<{ cv: string[] | null; interview: string[] | null; failure: string | null }> {
  try {
    await getCompanyContext();
  } catch {
    return { cv: null, interview: null, failure: "not_in_workspace" };
  }

  const responsibilities =
    typeof input?.responsibilities === "string" ? input.responsibilities : "";
  const requirements = typeof input?.requirements === "string" ? input.requirements : "";

  const outcome = await generateScoringCriteria({
    title: typeof input?.title === "string" ? input.title : "",
    description: typeof input?.description === "string" ? input.description : "",
    responsibilities,
    requirements,
  });
  if (outcome.failure) return { cv: null, interview: null, failure: outcome.failure };

  /*
   * Clamped to MUST_HAVE_MAX because the heuristic is uncapped: a job whose
   * requirements yield six selectable lines cannot be matched by a generator
   * that may return three, and comparing raw counts would reject every
   * maxed-out result. Three against six is the best available answer; two
   * against six is genuinely worse and is rejected.
   */
  const heuristic = suggestCriteria({ requirements, responsibilities, existing: [] });
  if (outcome.cv.length < Math.min(heuristic.cv.length, MUST_HAVE_MAX)) {
    console.warn(
      `[scoring-criteria] below the heuristic floor: ${outcome.cv.length} < ${heuristic.cv.length}`,
    );
    return { cv: null, interview: null, failure: "below_heuristic" };
  }

  return { cv: outcome.cv, interview: outcome.interview, failure: null };
}
