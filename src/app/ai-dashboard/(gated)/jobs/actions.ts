"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveNumericMode, type ScreeningQuestion } from "@/lib/jobs";
import { slugify, uniqueSlug } from "@/lib/slug";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import {
  canAccessJob,
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { notifyCompany } from "@/lib/notifications/company";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import {
  ANSWER_SECONDS_MAX,
  ANSWER_SECONDS_MIN,
  COMPETENCY_MAX,
  MAX_QUESTIONS,
  PREP_SECONDS_MAX,
  PREP_SECONDS_MIN,
  QUESTION_TEXT_MAX,
  RUBRIC_MAX,
  type InterviewQuestionInput,
} from "@/lib/interviews/types";
import {
  JOB_CATEGORIES,
  AUTOSHORTLIST_SOURCES,
  CV_WEIGHT_DIMENSIONS,
  CV_WEIGHT_MAX,
  CV_WEIGHT_MIN,
  JOB_CONTRACT_TYPES,
  JOB_CURRENCIES,
  JOB_EXPERIENCE_LEVELS,
  JOB_INTERVIEWER_NAME_MAX,
  JOB_STATUSES,
  JOB_TEXT_MAX,
  JOB_WORK_TYPES,
  type CompanyJobInput,
  type CompanyJobRow,
  type JobStatus,
} from "@/app/ai-dashboard/lib/job-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Row/input types live in lib/job-types.ts.
type MutationResult<T = undefined> =
  /**
   * `warning` is for work that is genuinely secondary to the mutation but
   * whose failure the user must still see — currently only the interview
   * question sync, which must not fail a job save but must not be silent
   * either. Optional, so every existing caller is unaffected.
   */
  | { success: true; data: T; warning?: string }
  | { success: false; error: string };

const JOB_COLUMNS =
  "id, title, location, category, experience_level, contract_type, work_type, status, slug, salary_min, salary_max, salary_currency, positions, created_at, archived_at";

/** Remotiv stamps every company job with the same rating — companies must
 *  never be able to set their own star rating on the public card. */
const COMPANY_JOB_RATING = 4.5;

// ── Validation ───────────────────────────────────────────────

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Server-side cleanup of the screening-questions array — mirrors the admin
 * sanitizeQuestions exactly so both surfaces write the identical jsonb shape
 * that /api/apply re-reads and scores against. Empty result ([]) is valid.
 *
 * An unset/invalid `ideal` now stores "" rather than coercing to "0".
 *
 * That coercion was the bug: /api/apply matches numeric answers with
 * `answer >= ideal`, the answer field can't go below 0, so `>= 0` passed
 * EVERY candidate. A manager applicant answering 0 years leading teams,
 * 0 team size and 0 years Agile met all three "thresholds".
 *
 * "" is the honest "not set yet", and it is fail-CLOSED for yesno and
 * multiple (`answer === ""` never matches a real answer). It is NOT
 * fail-closed for numeric — `Number("")` is 0, not NaN, which reproduces the
 * same tautology — so assertPublishableQuestions below keeps "" off any job
 * that is actually open. Drafts keep it, so a half-built question survives a
 * save instead of being silently dropped.
 */
function sanitizeQuestions(input: unknown): ScreeningQuestion[] {
  if (!Array.isArray(input)) return [];

  const cleaned: ScreeningQuestion[] = [];
  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Partial<ScreeningQuestion>;

    const question = (typeof q.question === "string" ? q.question : "")
      .trim()
      .slice(0, 200);
    if (!question) continue;

    const type = q.type;
    if (type !== "yesno" && type !== "numeric" && type !== "multiple") continue;

    const id = typeof q.id === "string" && q.id ? q.id : crypto.randomUUID();
    const essential = q.essential === true;

    if (type === "yesno") {
      // Defaults to "Yes" — the one type where a default is honest rather than
      // a hidden decision. Screening questions are near-universally phrased so
      // that Yes is the good answer ("Do you have a work permit?"), and there
      // are only two options, both visible in the select. Numeric and multiple
      // choice keep their no-default rule: those have no natural right answer,
      // and inventing one is what shipped the 0-threshold bug.
      const ideal = q.ideal === "No" ? "No" : "Yes";
      cleaned.push({ id, question, type, ideal, options: [], essential });
    } else if (type === "numeric") {
      // "collect this number, don't filter on it" IS the mode now — a company
      // asking current salary or times-terminated wants a ceiling or nothing,
      // and forcing a floor on those made them write a meaningless threshold.
      const mode = resolveNumericMode(q);

      if (mode === "none") {
        // No threshold to store, so `ideal` is cleared rather than left to
        // carry a stale number that nothing reads but the drawer might show.
        cleaned.push({
          id,
          question,
          type,
          ideal: "",
          options: [],
          essential,
          numeric_mode: "none",
        });
      } else {
        // `> 0` for BOTH directions. A minimum of 0 passes everyone (the answer
        // field can't go below 0); a maximum of 0 demands exactly 0, which is a
        // threshold nobody means to set from a number input defaulting to empty.
        const n = Number.parseFloat(String(q.ideal ?? ""));
        const ideal = Number.isFinite(n) && n > 0 ? String(n) : "";
        cleaned.push({
          id,
          question,
          type,
          ideal,
          options: [],
          essential,
          numeric_mode: mode,
        });
      }
    } else {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter((o) => o.length > 0);
      if (options.length < 2) continue; // multiple requires >= 2 options
      // No fallback to index 0 either: "the first option" was never a choice
      // the company made, just what an unset field happened to mean.
      const idx = Number.parseInt(String(q.ideal ?? ""), 10);
      const ideal =
        Number.isInteger(idx) && idx >= 0 && idx < options.length ? String(idx) : "";
      cleaned.push({ id, question, type, ideal, options, essential });
    }
  }
  return cleaned;
}

/**
 * Publish gate for screening questions.
 *
 * A question whose `ideal` is "" scores nothing meaningful, so it must not
 * reach a public job. Returns an error string naming the offender, or null.
 *
 * Only enforced for status 'open'. Drafts are allowed to be half-built —
 * that is what a draft is — and 'closed' jobs take no new applications.
 */
function assertPublishableQuestions(
  questions: ScreeningQuestion[],
): string | null {
  // A numeric_mode 'none' question has an empty `ideal` BY DESIGN — there is no
  // threshold to set — so it is the one legitimate empty and must not be caught
  // by the unset check below.
  const unset = questions.find(
    (q) =>
      q.ideal === "" &&
      !(q.type === "numeric" && resolveNumericMode(q) === "none"),
  );
  if (!unset) return null;

  if (unset.type === "numeric") {
    const bound = resolveNumericMode(unset) === "max" ? "maximum" : "minimum";
    return `Screening question "${unset.question}" needs a ${bound} above 0, or set it to collect the number without a threshold, before this job can be published.`;
  }
  // yesno can no longer reach here — sanitizeQuestions defaults it to "Yes",
  // including legacy rows stored with "". Kept in the map so the record stays
  // exhaustive over the type union rather than silently losing a case if the
  // default is ever removed.
  const NEEDS: Record<"multiple" | "yesno", string> = {
    multiple: "needs its ideal option chosen",
    yesno: "needs an ideal answer chosen",
  };
  return `Screening question "${unset.question}" ${NEEDS[unset.type]} before this job can be published.`;
}

/**
 * Interviewer display name for one of the two interview options.
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
 * Columns the SCORER reads. Editing any of them changes what a scorecard was
 * judged against, so criteria_version bumps and every existing score for the
 * job becomes stale.
 *
 * Taken from the job SELECT in handleAiCvScore, not from intuition — if that
 * select ever grows a column, this list has to grow with it or staleness goes
 * undetected again.
 *
 * `title` is included even though it reads like mere labelling: buildUserMessage
 * puts it at the top of the job block, and re-titling "Junior Analyst" to "Head
 * of Analytics" genuinely changes the seniority the model judges against.
 *
 * Deliberately EXCLUDED — the scorer never reads them, so they cannot make a
 * scorecard stale: location, work_type, contract_type, positions, salary_*,
 * show_salary, status, and the five interview/scoring option columns.
 *
 * ── The four cv_weight_* columns are ALSO excluded, deliberately ──
 *
 * They ARE read by the scorer, so this is the one exception to the rule above
 * and it needs justifying. criteria_version marks a scorecard stale because the
 * MODEL WAS ASKED A DIFFERENT QUESTION — new requirements, a new seniority, new
 * screening questions — so its judgement no longer applies and only a re-run
 * can fix it. Re-weighting asks the model nothing new. The dimension scores,
 * the evidence, the quotes and the reasoning are all still exactly right; only
 * the arithmetic that combines them into one number has changed.
 *
 * Marking every score stale would therefore invite a full re-score — real money
 * and real latency — to recompute something derivable from data already stored.
 * Worse, it would read as "your scorecards are wrong" when they are not.
 *
 * The honest consequence, and it is a real one: after a weight change, stored
 * overalls were computed under the OLD weighting until each application is
 * re-scored. If that divergence starts to matter, the fix is to recompute the
 * overall from the stored dimension_scores — no model call needed — not to
 * bump criteria_version. See applyCvWeights, which is already a pure function
 * over (overall, dimensions, weights) precisely so it can be reused that way.
 */
const SCORING_RELEVANT_COLUMNS = [
  "title",
  "description",
  "responsibilities",
  "requirements",
  "experience_level",
  "category",
  "screening_questions",
] as const;

/** Deep-equal enough for these columns: scalars and the questions jsonb. */
function scoringInputsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return SCORING_RELEVANT_COLUMNS.some(
    (col) => JSON.stringify(before[col] ?? null) !== JSON.stringify(after[col] ?? null),
  );
}

/**
 * Build the writable column patch from wizard input. Mirrors the admin
 * buildPatch's required-field rules. Deliberately returns ONLY editable
 * columns — ownership/identity columns are stamped by the caller so no client
 * value can ever reach them.
 */
function buildPatch(input: CompanyJobInput):
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string } {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "Job title is required." };
  const location = (input.location ?? "").trim();
  if (!location) return { ok: false, error: "Location is required." };

  const currency = (input.salary_currency ?? "").trim().toUpperCase();
  if (!(JOB_CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, error: "Currency is required (USD or PKR)." };
  }

  // Salary hidden → both columns null, so the public card shows no pay.
  const showSalary = input.show_salary !== false;
  const min = showSalary && input.salary_min
    ? Number.parseInt(input.salary_min, 10)
    : null;
  const max = showSalary && input.salary_max
    ? Number.parseInt(input.salary_max, 10)
    : null;
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
      category: oneOf(input.category, JOB_CATEGORIES, "Engineering"),
      experience_level: oneOf(input.experience_level, JOB_EXPERIENCE_LEVELS, "Intermediate"),
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
      avatar_interviewer_name: interviewerName(input.avatar_interviewer_name, avatarOn),
      async_interview_enabled: asyncOn,
      async_interview_name: interviewerName(input.async_interview_name, asyncOn),
      send_rejection_email: input.send_rejection_email === true,
      ...cvWeightPatch(input),
      ...autoshortlistPatch(input),
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
function autoshortlistPatch(
  input: CompanyJobInput,
): Record<string, string | number | null> {
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
  return CV_WEIGHT_DIMENSIONS.some(
    ({ key }) => (before[key] ?? null) !== (after[key] ?? null),
  );
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

/** Every job owned by the viewer's company. Readable by any active member. */
export async function fetchCompanyJobs(): Promise<CompanyJobRow[]> {
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
  const scope = await getJobScope(ctx);
  if (scope.scoped && scope.jobIds.length === 0) return [];

  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("company_id", ctx.companyId);
    if (scope.scoped) q = q.in("id", scope.jobIds);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("[jobs] fetchCompanyJobs failed:", error);
      return [];
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  if (rows.length === 0) return [];

  // Applicant counts, one HEAD count per job in parallel. Counting per job
  // rather than fetching rows keeps the payload flat regardless of volume.
  const counts = await Promise.all(
    rows.map(async (r) => {
      try {
        const { count } = await service
          .from("job_applications")
          .select("id", { count: "exact", head: true })
          .eq("job_id", r.id as string);
        return count ?? 0;
      } catch {
        return 0;
      }
    }),
  );

  return rows.map((r, i) => ({
    id: r.id as string,
    title: (r.title as string) ?? "",
    location: (r.location as string) ?? "",
    category: (r.category as string) ?? "",
    experience_level: (r.experience_level as string) ?? "",
    contract_type: (r.contract_type as string) ?? "",
    work_type: (r.work_type as string) ?? "",
    status: ((r.status as JobStatus) ?? "open"),
    slug: (r.slug as string | null) ?? null,
    salary_min: (r.salary_min as number | null) ?? null,
    salary_max: (r.salary_max as number | null) ?? null,
    salary_currency: (r.salary_currency as string | null) ?? null,
    positions: (r.positions as number) ?? 1,
    created_at: (r.created_at as string) ?? "",
    archived_at: (r.archived_at as string | null) ?? null,
    applicant_count: counts[i],
  }));
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
 * Replace a job's interview questions with the list the wizard submitted.
 *
 * Delete-then-insert rather than a per-row diff. `position` is what the
 * candidate page orders by and what interview_answers keys against, so a
 * reorder changes almost every row anyway; a diff would be more code for the
 * same writes and a real chance of leaving two rows claiming position 3.
 *
 * Rows are rebuilt with fresh ids on every save. That is safe TODAY because
 * an answer snapshots its question_text, so an answered interview survives the
 * question being re-saved — see interview_answers.question_text. It would stop
 * being safe the moment anything joins answers back to interview_questions.id
 * for display, and this comment is the warning for whoever does that.
 *
 * Never throws: a job that saved must not appear to have failed because its
 * question list did. The wizard re-reads the list on the next open.
 */
async function syncInterviewQuestions(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
  companyId: string,
  inputs: InterviewQuestionInput[] | undefined,
): Promise<string | null> {
  if (!Array.isArray(inputs)) return null;

  const clean = inputs
    .map((q) => ({
      question: (q.question ?? "").trim().slice(0, QUESTION_TEXT_MAX),
      competency: (q.competency ?? "").trim().slice(0, COMPETENCY_MAX),
      rubric: (q.rubric ?? "").trim().slice(0, RUBRIC_MAX),
      prep_seconds: clampInt(q.prepSeconds, PREP_SECONDS_MIN, PREP_SECONDS_MAX, 30),
      answer_seconds: clampInt(q.answerSeconds, ANSWER_SECONDS_MIN, ANSWER_SECONDS_MAX, 120),
      weight: clampInt(q.weight, 1, 5, 1),
      required: q.required !== false,
    }))
    // A blank row is someone who added a question and changed their mind, not
    // a question. Dropped rather than stored empty for a candidate to read.
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_QUESTIONS);

  /*
   * Returns a message instead of swallowing.
   *
   * This used to log to the server console and return void, so a recruiter
   * whose questions failed to save was told the job saved — and only found
   * out when a candidate opened an interview with no questions in it, or when
   * sendInterviewInvite refused with "add interview questions first".
   *
   * The job save still succeeds: the questions are secondary to the role, and
   * failing the whole save would lose the rest of the recruiter's work. But
   * the caller now gets something to show.
   */
  try {
    // The DELETE error was previously not checked at all — a failure here
    // leaves the OLD questions in place while the insert adds the new ones,
    // which is worse than either outcome alone.
    const { error: delErr } = await supabase
      .from("interview_questions")
      .delete()
      .eq("job_id", jobId)
      .eq("company_id", companyId);

    if (delErr) {
      console.error("[jobs] interview question delete failed:", delErr.message);
      return "The role saved, but its interview questions could not be updated. Open the job and save them again.";
    }

    if (clean.length === 0) return null;

    const { error } = await supabase.from("interview_questions").insert(
      clean.map((q, i) => ({
        ...q,
        job_id: jobId,
        company_id: companyId,
        position: i + 1,
      })),
    );
    if (error) {
      console.error("[jobs] interview question sync failed:", error.message);
      // The delete succeeded, so the job now has NO questions. Said plainly,
      // because it changes what the recruiter must do next.
      return "The role saved, but its interview questions did not. The job currently has no questions — open it and add them again.";
    }
  } catch (err) {
    console.error("[jobs] interview question sync threw:", err);
    return "The role saved, but its interview questions could not be updated. Open the job and save them again.";
  }

  return null;
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function createCompanyJob(
  input: CompanyJobInput,
): Promise<MutationResult<{ id: string; slug: string | null }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const built = buildPatch(input);
  if (!built.ok) return { success: false, error: built.error };

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
    return { success: false, error: error.message };
  }

  const row = data as { id: string; slug: string | null };
  await seedHiringTeam(supabase, ctx, row.id);
  const questionWarning = await syncInterviewQuestions(
    supabase,
    row.id,
    ctx.companyId,
    input.interview_questions,
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
  | { ok: true; title: string; current: Record<string, unknown> }
  | { ok: false; error: string }
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

  const built = buildPatch(input);
  if (!built.ok) return { success: false, error: built.error };

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await canAccessJob(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

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
  // must not be missed.
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

  if (error) return { success: false, error: error.message };

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
    input.interview_questions,
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
    let sessionQuery = service
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

/** A job's interview questions, for the wizard's edit-mode prefill. */
export async function fetchInterviewQuestions(
  jobId: string,
): Promise<InterviewQuestionInput[]> {
  const ctx = await getCompanyContext();
  if (!jobId || !(await canAccessJob(ctx, jobId))) return [];

  const { data } = await createServiceClient()
    .from("interview_questions")
    .select("id, position, question, competency, rubric, prep_seconds, answer_seconds, weight, required")
    .eq("job_id", jobId)
    .eq("company_id", ctx.companyId)
    .order("position", { ascending: true })
    .limit(MAX_QUESTIONS);

  return ((data ?? []) as {
    id: string;
    question: string | null;
    competency: string | null;
    rubric: string | null;
    prep_seconds: number | null;
    answer_seconds: number | null;
    weight: number | null;
    required: boolean | null;
  }[]).map((q) => ({
    id: q.id,
    question: q.question ?? "",
    competency: q.competency ?? "",
    rubric: q.rubric ?? "",
    prepSeconds: String(q.prep_seconds ?? 30),
    answerSeconds: String(q.answer_seconds ?? 120),
    weight: String(q.weight ?? 1),
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
  if (!(await canAccessJob(ctx, jobId))) {
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
      sanitizeQuestions((stored as { screening_questions?: unknown } | null)
        ?.screening_questions),
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

  if (error) return { success: false, error: error.message };

  // 'on_hold' is the product's Draft; moving a job back to it is routine
  // editing rather than an event the team needs told about.
  if (status === "open" || status === "closed") {
    await notifyCompany({
      companyId: ctx.companyId,
      type: status === "open" ? "job_published" : "job_closed",
      title:
        status === "open"
          ? `“${owned.title}” is live`
          : `“${owned.title}” was closed`,
      body:
        status === "open"
          ? `${ctx.memberName} published it — it's on remotiv.work now.`
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
  if (!(await canAccessJob(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  const { error } = await supabase
    .from("jobs")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", jobId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

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

export async function deleteCompanyJob(
  jobId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const owned = await assertOwned(supabase, jobId, ctx.companyId);
  if (!owned.ok) return { success: false, error: owned.error };
  // Assignment is re-checked server-side against the hiring team; the job id
  // came from the client and proves nothing. Same message as not-found, so a
  // probe cannot tell "exists but not yours" from "doesn't exist".
  if (!(await canAccessJob(ctx, jobId))) {
    return { success: false, error: "That job isn't in your workspace." };
  }

  // Snapshot the job title onto every application BEFORE deleting the job.
  // Once the FK's ON DELETE SET NULL fires we lose the link back to jobs.title,
  // so applicant lists would render a blank job column. If the snapshot write
  // fails, abort — preserving the title is the whole point.
  const { error: snapErr } = await supabase
    .from("job_applications")
    .update({ job_title_snapshot: owned.title })
    .eq("job_id", jobId);
  if (snapErr) return { success: false, error: snapErr.message };

  const { error } = await supabase
    .from("jobs")
    .delete()
    .eq("id", jobId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidateJobSurfaces();
  return { success: true, data: undefined };
}

/** Copy an existing job into a fresh Draft. Ownership-checked like the rest. */
export async function duplicateCompanyJob(
  jobId: string,
): Promise<MutationResult<{ id: string }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select(
      // The "More options" columns copy across too — a duplicate that silently
      // reverted to scoring-on would contradict the original's setting. The
      // step 8/9 columns copy for exactly the same reason: a copy that dropped
      // the weighting would score its applicants differently from the original
      // with nothing on screen to explain why.
      "company_id, title, location, category, experience_level, contract_type, work_type, language, positions, salary_min, salary_max, salary_currency, description, responsibilities, requirements, screening_questions, allow_rerecord, ai_cv_scoring_enabled, measure_relevancy, avatar_interview_enabled, avatar_interviewer_name, async_interview_enabled, async_interview_name, cv_weight_requirements, cv_weight_experience, cv_weight_domain, cv_weight_responsibilities, autoshortlist_source, autoshortlist_cv_threshold, autoshortlist_interview_threshold",
    )
    .eq("id", jobId)
    .maybeSingle();

  const source = data as (Record<string, unknown> & { company_id: string | null }) | null;
  if (!source || source.company_id !== ctx.companyId) {
    return { success: false, error: "Job not found in your workspace." };
  }
  if (!(await canAccessJob(ctx, jobId))) {
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

  if (error) return { success: false, error: error.message };

  const copyId = (created as { id: string }).id;
  await seedHiringTeam(supabase, ctx, copyId);

  revalidateJobSurfaces();
  return { success: true, data: { id: copyId } };
}
