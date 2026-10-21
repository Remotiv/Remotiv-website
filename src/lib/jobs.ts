// Server-side helpers for the public job surfaces.
//
// LIST_SELECT — the lean column projection used by the card-grid query. Skips
// `description` (potentially KB-sized free text) since the list view only
// shows title/company/location/tags. /api/jobs/route.ts imports this same
// constant so both surfaces stay in sync.
//
// getInitialJobs() — runs server-side from src/app/jobs/page.tsx with NO
// filters, returns the top-100-most-recent OPEN jobs (matches /api/jobs's
// default branch). Falls back to [] on Supabase error so the client gets
// the "Couldn't load positions. Retry" UX.
//
// getJobBySlug(): the job's own page, for its detail, layout and metadata.

import { cache } from "react";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * ── What the public may see of a job (F7) ────────────────────
 *
 * KEEP-lists, never deny-lists. The board's detail branch used to select "*"
 * and strip four names, so every column added since (scoring weights,
 * auto-shortlist thresholds, interview criteria, interviewer settings, booking
 * hours) went out to anyone who asked, and the next one would have too. Here a
 * column reaches the public only by being named, and each list holds exactly
 * what a public page renders today:
 *
 *   SUMMARY  job cards (/jobs, /api/jobs), the company filter, the careers
 *            index, the talent dashboard's latest roles. company_id stays: the
 *            board re-applies ?company= with it and the ownership star reads
 *            it. Filters and ordering (language, display_order, status,
 *            listed_on_remotiv) run in the query and need no selected column.
 *   DETAIL   the job's own page, both designs, its JSON-LD and metadata, and
 *            the apply modal's questions.
 *
 * Applied twice: the select names only these columns, and the readers below
 * copy only these keys, so a wider row (a "*" slipped back in) still cannot
 * leave. Screening questions leave in their public shape only: never `ideal`
 * (the employer's pass answers) or `numeric_mode`. /api/apply reads both from
 * the database itself.
 *
 * Rows come back typed as Job, which is wider (internal readers share it); only
 * these keys are present. Never read anything else from a public row.
 */
export const PUBLIC_JOB_SUMMARY_FIELDS = [
  "id",
  "title",
  "company",
  "company_rating",
  "location",
  "salary_min",
  "salary_max",
  "salary_currency",
  "contract_type",
  "work_type",
  "category",
  "experience_level",
  "positions",
  "created_at",
  "slug",
  "company_id",
] as const;

export const PUBLIC_JOB_DETAIL_FIELDS = [
  ...PUBLIC_JOB_SUMMARY_FIELDS,
  "description",
  "requirements",
  "responsibilities",
  "country",
  "city",
  "language",
  "screening_questions",
] as const;

/** The public question keys. Everything else on a question stays server-side. */
export const PUBLIC_SCREENING_QUESTION_FIELDS = [
  "id",
  "question",
  "type",
  "options",
  "essential",
] as const;

export const LIST_SELECT = PUBLIC_JOB_SUMMARY_FIELDS.join(",");
const DETAIL_SELECT = PUBLIC_JOB_DETAIL_FIELDS.join(",");

function pick(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in row) out[field] = row[field];
  return out;
}

/** A card's row: the summary keys only. */
export function toPublicJobSummary(row: Record<string, unknown>): Job {
  return pick(row, PUBLIC_JOB_SUMMARY_FIELDS) as unknown as Job;
}

/** A job page's row: the detail keys only, its questions in their public shape. */
export function toPublicJobDetail(row: Record<string, unknown>): Job {
  const out = pick(row, PUBLIC_JOB_DETAIL_FIELDS);
  out.screening_questions = (Array.isArray(row.screening_questions) ? row.screening_questions : [])
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === "object")
    .map((q) => pick(q, PUBLIC_SCREENING_QUESTION_FIELDS));
  return out as unknown as Job;
}

// isRemotivOwned is in lib/job-ownership.ts for the SAME reason: the /jobs list
// is a client component and cannot import a value from this module. Re-exported
// so server-side callers keep one import site and there is one implementation.
export { isRemotivOwned } from "@/lib/job-ownership";
// NumericMode + resolveNumericMode live in lib/screening.ts, which has no
// runtime imports — this module pulls in next/headers via getInitialJobs, so a
// client component cannot import a VALUE from here. Re-exported so server-side
// callers keep a single import site and there is one implementation of the rule.
export { type NumericMode, resolveNumericMode } from "@/lib/screening";

// The re-export above does not bind the name in this module's own scope, and
// ScreeningQuestion below references it. Type-only, so nothing is emitted.
import type { NumericMode } from "@/lib/screening";

export type ScreeningQuestion = {
  id: string;
  question: string; // <= 200 chars
  type: "yesno" | "numeric" | "multiple";
  // "Yes"/"No" for yesno · numeric-as-string for numeric · the ideal option
  // INDEX as a string ("0","1",…) for multiple. One consistent string type that
  // round-trips through the jsonb column unchanged.
  ideal: string;
  options: string[]; // [] unless type === "multiple"
  essential: boolean;
  /**
   * Numeric questions only. OPTIONAL, and that is the whole compatibility
   * story: every question already stored in jobs.screening_questions predates
   * this field, so an absent value has to mean something sensible — see
   * resolveNumericMode.
   */
  numeric_mode?: NumericMode;
};

// Frozen-at-apply-time snapshot of one screening answer, scored server-side in
// /api/apply and stored in job_applications.screening_answers (jsonb). The
// admin applications view reads this for display (no re-scoring).
export type ScreeningAnswerSnapshot = {
  question_id: string;
  question: string;
  type: "yesno" | "numeric" | "multiple";
  essential: boolean;
  ideal: string;
  answer: string;
  answer_label?: string;
  ideal_label?: string;
  matched: boolean;
  /**
   * False when the question was collected but never tested (numeric_mode
   * "none"). ABSENT on every snapshot written before this existed, and absent
   * means scored — so old rows read exactly as they always did.
   *
   * `matched` still has to carry a boolean, and for an unscored answer it is
   * written FALSE rather than true: anything reading only `matched` then
   * under-claims rather than over-claims, which is the safer direction when a
   * hiring decision is downstream. Readers that understand this field must
   * check it FIRST and ignore `matched` entirely when it is false — "wasn't a
   * test" is not the same as "failed the test".
   */
  scored?: boolean;
  /**
   * Which direction this numeric answer was tested in, frozen alongside the
   * rest of the snapshot so a display can name the operator without consulting
   * the job — whose question may since have been re-pointed or re-typed.
   *
   * Numeric answers only, and ABSENT on every snapshot written before the modes
   * existed. Absent is not ambiguous: until then `/api/apply`'s sole numeric
   * branch was `a >= ideal`, so a snapshot without this field was scored as a
   * minimum as a matter of historical fact, not assumption.
   */
  numeric_mode?: NumericMode;
};

export interface Job {
  id: string;
  title: string;
  company: string;
  company_rating: number;
  location: string;
  /** Split out of `location`. Null on rows written before the split. */
  country: string | null;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  positions: number;
  slug: string | null;
  /** Optional because list-view queries omit them for payload size. The job
   *  page (getJobBySlug) populates description + the two bullet lists. */
  description?: string | null;
  responsibilities: string | null;
  requirements: string | null;
  screening_questions: ScreeningQuestion[];
  display_order: number | null;
  // Ownership. Exactly one of these two tenant columns is set, or neither:
  //   company_id non-null → AI-product job (companies / /ai-dashboard)
  //   client_id  non-null → client-portal job (clients / /client)
  //   both null           → Remotiv-owned
  // created_by = the acting user who created the job. All three are
  // system-stamped, not user-editable form fields.
  client_id: string | null;
  company_id: string | null;
  created_by: string | null;
  status: string;
  created_at: string;
  /**
   * Did the company choose to list this role on remotiv.work/jobs?
   *
   * FALSE by default. It gates the shared board only — never the company's own
   * careers page and never the job's own URL. See listedOnRemotiv below.
   */
  listed_on_remotiv: boolean;
  /**
   * Public URL of the owning company's logo, or null.
   *
   * DERIVED, not a column — attachCompanyData fills it after the row query.
   * Null for Remotiv-owned jobs (company_id null), which keep the letter mark,
   * and for companies that have not uploaded one.
   */
  company_logo_url?: string | null;
  /**
   * Is the owning company Remotiv's own account?
   *
   * DERIVED like company_logo_url, from the same batch read. False for a job
   * with no company at all — those are Remotiv-owned by a different route, and
   * `isRemotivOwned` below is what combines the two into one answer.
   */
  company_is_internal?: boolean;
}

/**
 * Bucket holding company logos. Public-read, so a plain public URL is correct
 * and no signing is involved.
 *
 * The name is duplicated from the settings segment's constants module rather
 * than imported: that module lives inside the ai-dashboard product, and lib/
 * must not depend on one of the products that consumes it. Worth consolidating
 * into a shared constants module the next time either side is touched.
 */
const COMPANY_LOGO_BUCKET = "company-logos";

/**
 * Attach the two company facts a public job row needs, without a per-row join.
 *
 * Was attachCompanyLogos. It now also carries `is_internal`, so the name had to
 * move with it — a helper that silently decides ownership under a name about
 * logos is how the next reader misses it.
 *
 * /jobs is the hottest page on the site and LIST_SELECT deliberately avoids
 * embeds for payload size, so this resolves both in ONE extra query keyed on
 * the DISTINCT company ids in the batch — at most a handful for a page of 100
 * jobs, and an indexed primary-key lookup at that. Adding `is_internal` to the
 * existing select costs nothing: same query, same rows, one more column.
 *
 * Never throws: a logo is decoration, and a companies-table blip must not take
 * down the jobs list. On failure every row gets a null logo AND
 * `company_is_internal: false` — which hides the star rather than inventing
 * one, the same direction isInternalCompany failed in before this replaced it.
 */
export async function attachCompanyData<T extends { company_id: string | null }>(
  rows: T[],
): Promise<(T & { company_logo_url: string | null; company_is_internal: boolean })[]> {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean))] as string[];
  if (ids.length === 0) {
    return rows.map((r) => ({ ...r, company_logo_url: null, company_is_internal: false }));
  }

  const supabase = createServiceClient();
  const byId = new Map<string, string>();
  const internal = new Set<string>();

  try {
    const { data } = await supabase
      .from("companies")
      .select("id, logo_path, is_internal")
      .in("id", ids);

    for (const row of (data ?? []) as {
      id: string;
      logo_path: string | null;
      is_internal: boolean | null;
    }[]) {
      if (row.is_internal === true) internal.add(row.id);
      const path = (row.logo_path ?? "").trim();
      if (!path) continue;
      const url = supabase.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(path).data.publicUrl;
      if (url) byId.set(row.id, url);
    }
  } catch {
    // Fall through with an empty map — every card shows its letter.
  }

  return rows.map((r) => ({
    ...r,
    company_logo_url: (r.company_id && byId.get(r.company_id)) || null,
    company_is_internal: Boolean(r.company_id && internal.has(r.company_id)),
  }));
}

/**
 * Every job row a surface may show, except the recovery view: `deleted_at IS
 * NULL`.
 *
 * Deleting used to be a real DELETE, so every list got its exclusion from the
 * row's absence and no query said anything about it. Now the row survives, and
 * each list has to exclude it by name or a deleted job stays live. This helper
 * is the one place that spelling lives, so a caller opts out visibly.
 *
 * Deliberately separate from publiclyVisible: admin and ai-dashboard list
 * closed and archived jobs on purpose, but no surface lists a deleted one.
 */
type DeletionFilterable = {
  is(column: string, value: null): DeletionFilterable;
};

export function notDeleted<T>(query: T): T {
  return (query as DeletionFilterable).is("deleted_at", null) as T;
}

/**
 * The single source of truth for "is this job publicly visible":
 *
 *   status = 'open' AND archived_at IS NULL AND deleted_at IS NULL
 *
 * Archived is a separate axis from status on purpose: archived jobs are kept
 * for the company's records and are never public — a role withdrawn from the
 * site entirely, whatever its status. Admin, ai-dashboard, and other
 * company-facing surfaces deliberately do NOT use this helper: they
 * legitimately list closed and archived jobs — but never a deleted one, which
 * is why the deletion gate is composed in here rather than left to callers.
 *
 * `T` is deliberately UNCONSTRAINED. Any structural constraint naming the
 * builder's `eq`/`is` methods (generic `T extends { eq(...): T }` or a
 * non-generic recursive interface) makes tsc instantiate supabase-js's
 * conditional builder types against the parsed LIST_SELECT projection and
 * fail with TS2589 "excessively deep". So the narrowing happens inside the
 * body via a minimal interface instead — safe because both methods return
 * `this` at runtime, so the output really is the caller's builder.
 */
type VisibilityFilterable = {
  eq(column: string, value: string): VisibilityFilterable;
  is(column: string, value: null): VisibilityFilterable;
};

/** As above, for the boolean column — same TS2589 reasoning. */
type ListingFilterable = {
  eq(column: string, value: boolean): ListingFilterable;
};

export function publiclyVisible<T>(query: T): T {
  const filterable = notDeleted(query) as VisibilityFilterable;
  return filterable.eq("status", "open").is("archived_at", null) as T;
}

/**
 * Publicly visible AND on the shared Remotiv board.
 *
 * ── Why this is a second helper and not a line in the first ──
 *
 * publiclyVisible has fourteen callers and they do not all mean the same thing.
 * Some of them serve the job's OWN url and the company's OWN careers page:
 * getJobBySlug, the job's OG image, and the careers-page query. Folding the flag into
 * publiclyVisible would have taken an unlisted role off the company's careers
 * page and 404'd the link they had been circulating — turning "don't advertise
 * this on your board" into "delete my hiring page", which nobody asked for.
 *
 * So the flag lives here, and only the four surfaces that ARE the Remotiv board
 * use it:
 *
 *   getInitialJobs          the board itself
 *   GET /api/jobs           the board's data source
 *   sitemap.ts              no point indexing a role they did not list
 *   talent dashboard        "latest jobs" — the board under another name
 *
 * Everything else keeps publiclyVisible unchanged. The distinction is not
 * "public vs private"; it is "ours to advertise vs theirs to publish".
 */
export function listedOnRemotiv<T>(query: T): T {
  const filterable = publiclyVisible(query) as ListingFilterable;
  return filterable.eq("listed_on_remotiv", true) as T;
}

/**
 * The public board's first page of roles, or the fact that we could not look.
 *
 * The client already inferred this: "no filters AND no jobs" was treated as
 * "almost certainly a server fetch error" and given a Retry. Good instinct,
 * wrong in the inverse case — a board with genuinely nothing live told the
 * visitor the site was broken. A Read makes the two knowable rather than
 * guessed, and fixes the error in the direction nobody catalogued.
 */
export async function getInitialJobs(): Promise<Read<Job[]>> {
  const supabase = createServiceClient();

  const { data, error } = await listedOnRemotiv(supabase.from("jobs").select(LIST_SELECT))
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[jobs] getInitialJobs failed:", error.message);
    return unavailable();
  }

  return answered(await publicJobSummaries((data ?? []) as unknown as Record<string, unknown>[]));
}

/** Cards for a page of rows: the summary keys, then the two company facts. */
export async function publicJobSummaries(rows: Record<string, unknown>[]): Promise<Job[]> {
  return attachCompanyData(rows.map(toPublicJobSummary));
}

/**
 * One publicly visible job by its slug, or the fact that we could not look.
 *
 * `Read<Job | null>` rather than `Job | null`: `if (error || !data) return null`
 * gave a database failure and a deleted job the same answer, and every caller
 * turned that into a 404. A live job told the reader it did not exist.
 *
 * ── Wrapped in cache(), and why that is load-bearing ─────────
 *
 * Three things resolve the same slug on one request: generateMetadata, the
 * [slug] layout (which settles the 404 before anything streams), and the page.
 * Before the layout existed this was already two identical queries; cache()
 * makes all three one. It is React's per-request memo — AsyncLocalStorage
 * scoped, gone at the end of the render, demonstrated earlier on
 * getCompanyContext by counting executions — so it cannot serve one request's
 * job to another.
 *
 * The memo also carries a FAILED answer. That is what keeps the three callers
 * honest with each other: a lookup that could not be asked is `unavailable()`
 * for metadata, layout and page alike, so a database blip cannot be a 404 in
 * one place and a 200 in another.
 */
export const getJobBySlug = cache(async (slug: string): Promise<Read<Job | null>> => {
  if (!slug || slug.trim().length === 0) return answered(null);

  const supabase = createServiceClient();

  const { data, error } = await publiclyVisible(
    supabase.from("jobs").select(DETAIL_SELECT).eq("slug", slug),
  ).maybeSingle();

  if (error) {
    console.error("[jobs] getJobBySlug failed:", error.message);
    return unavailable();
  }
  if (!data) return answered(null);

  const [job] = await attachCompanyData([
    toPublicJobDetail(data as unknown as Record<string, unknown>),
  ]);
  return answered(job ?? null);
});
