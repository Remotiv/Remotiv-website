import type { InterviewQuestionInput } from "@/lib/interviews/types";
import type { ScreeningQuestion } from "@/lib/jobs";

/**
 * Company-facing job types.
 *
 * Enum option lists mirror src/app/admin/jobs/actions.ts EXACTLY — the same
 * `jobs` table backs both surfaces and the public /jobs page, so a value that
 * only exists here would render as an unknown tag publicly.
 */

/**
 * Company-facing job categories. Wider than the admin form's six, because
 * companies post outside Remotiv's engineering-led curation.
 *
 * `jobs.category` is free text — /api/apply already inserts "Other" for
 * manual-title applications, a value absent from the admin union, and that
 * path has been live without failing. So new values need no migration.
 *
 * "Other" is always LAST; everything before it is ordered by how often we
 * expect it to be picked.
 */
export const JOB_CATEGORIES = [
  "Engineering",
  "Design",
  "Product",
  "Data",
  "Sales",
  "Marketing",
  "Customer Support",
  "Operations",
  "Finance & Accounting",
  "HR & Recruiting",
  "Content & Writing",
  "Other",
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

export const JOB_EXPERIENCE_LEVELS = ["Entry", "Intermediate", "Expert"] as const;
export type JobExperienceLevel = (typeof JOB_EXPERIENCE_LEVELS)[number];

export const JOB_CONTRACT_TYPES = ["Full time", "Part time", "Contract"] as const;
export type JobContractType = (typeof JOB_CONTRACT_TYPES)[number];

export const JOB_WORK_TYPES = ["Remote", "On-site", "Hybrid"] as const;
export type JobWorkType = (typeof JOB_WORK_TYPES)[number];

export const JOB_CURRENCIES = ["USD", "PKR"] as const;
export type JobCurrency = (typeof JOB_CURRENCIES)[number];

/**
 * Free-text ceiling for description / responsibilities / requirements.
 *
 * NOT a DB requirement — all three columns are unbounded `text`. It's a
 * product guard: without it a paste can push megabytes through the job row and
 * onto the public /jobs detail page. Enforced in BOTH places, because
 * `maxLength` on a textarea is trivially bypassed by a direct action call.
 */
export const JOB_TEXT_MAX = 10_000;

/** Show the live counter only once the user is close to the ceiling. */
export const JOB_TEXT_COUNTER_FROM = 9_000;

/**
 * Ceiling for the two interviewer display names.
 *
 * Like JOB_TEXT_MAX this is a product guard, not a DB one — both columns are
 * unbounded `text`. These are person-sized labels a candidate reads at the top
 * of an interview ("Aisha, Talent Partner"), so 60 leaves room for a name plus
 * a short role while keeping the string from wrapping the interview header.
 * Over-length input is TRUNCATED rather than rejected: it's a display label,
 * not content, so silently capping loses nothing worth failing a publish over.
 */
export const JOB_INTERVIEWER_NAME_MAX = 60;

/**
 * DB status enum. The design speaks Published/Draft/Closed; the column only has
 * these three values, so the UI maps onto them (see JOB_STATUS_LABELS).
 * Critically, ONLY 'open' is public — getInitialJobs filters status='open' —
 * so both 'on_hold' and 'closed' are invisible on remotiv.work/jobs.
 */
export const JOB_STATUSES = ["open", "on_hold", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** UI vocabulary → DB status. 'on_hold' is our Draft: never public, editable. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  open: "Published",
  on_hold: "Draft",
  closed: "Closed",
};

/** One row of the company Jobs table. */
export type CompanyJobRow = {
  id: string;
  title: string;
  location: string;
  category: string;
  experience_level: string;
  contract_type: string;
  work_type: string;
  status: JobStatus;
  slug: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  positions: number;
  created_at: string;
  /**
   * ISO timestamp, or null when the job is live in the workspace.
   *
   * Archived is orthogonal to status, not a fourth value of it: a job keeps
   * whatever status it had, and archiving only decides whether it appears in
   * the list and on the public site. That is why it is a separate column and a
   * separate tab rather than JOB_STATUSES gaining a member.
   */
  archived_at: string | null;
  /** Count of job_applications pointing at this job. */
  applicant_count: number;
};

/** The wizard's single form model. Strings mirror the admin form's contract:
 *  everything arrives as text and is coerced/validated server-side. */
/**
 * Interview duration bounds, matching the widened CHECK constraints on
 * jobs.interview_duration_minutes and interview_bookings.duration_minutes.
 *
 * Free-form between these, not a fixed pair: a screening call is 15 minutes
 * and a technical round is 45, and forcing both into 30 or 60 made the field
 * describe the product rather than the interview.
 *
 * Declared HERE, not in lib/calendar, because the wizard is a client component
 * and every module under src/lib/calendar is `server-only` — importing the
 * bounds from there would fail the build. The form and the server clamp
 * against the same two numbers, so neither can drift from the constraint.
 */
export const INTERVIEW_DURATION_MIN = 10;
export const INTERVIEW_DURATION_MAX = 240;

/** The two common cases, offered as one-tap presets. NOT the allowed set. */
export const INTERVIEW_DURATION_PRESETS = [30, 60] as const;

/**
 * Narrow anything to a storable duration, or null.
 *
 * The single place the range is enforced. Both the wizard's save path and the
 * edit page's read path call it, so a value the form accepts is exactly a value
 * the constraint accepts — a 300 typed into the custom box becomes a legible
 * refusal rather than SQLSTATE 23514 arriving from a layer nobody was looking
 * at.
 *
 * Non-integers are rejected rather than rounded: 22.5 minutes is a typo, and
 * silently storing 23 would put a number on the page nobody entered.
 */
export function normaliseInterviewDuration(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < INTERVIEW_DURATION_MIN || value > INTERVIEW_DURATION_MAX) return null;
  return value;
}

/** One weekday window, in minutes from local midnight. Mirrors availability_rules. */
export type JobBookingHours = {
  /** 0 = Sunday, matching availability_rules.weekday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type CompanyJobInput = {
  title: string;
  location: string;
  category: string;
  experience_level: string;
  contract_type: string;
  work_type: string;
  positions: string;
  description: string;
  responsibilities: string;
  requirements: string;
  salary_currency: string;
  salary_min: string;
  salary_max: string;
  /** false → salary columns are written as null (hidden on the public post). */
  show_salary: boolean;
  screening_questions: ScreeningQuestion[];
  status: JobStatus;

  /*
   * "More options" — per-job interview and scoring behaviour. Defaults here
   * mirror the `jobs` column defaults exactly, so a job created before these
   * columns existed and a job created by a client that omits them both land on
   * the same behaviour.
   *
   * Only ai_cv_scoring_enabled is read by shipped code today (the /api/apply →
   * ai_cv_score path). The other four are stored now and consumed when video
   * interviews ship; the wizard labels them as such rather than pretending.
   */
  allow_rerecord: boolean;
  ai_cv_scoring_enabled: boolean;
  measure_relevancy: boolean;
  avatar_interview_enabled: boolean;
  /** Meaningful only while avatar_interview_enabled — stored null otherwise. */
  avatar_interviewer_name: string;
  async_interview_enabled: boolean;
  /** Meaningful only while async_interview_enabled — stored null otherwise. */
  async_interview_name: string;
  /**
   * Send an automated rejection email for this job, two days after a candidate
   * is moved to Rejected.
   *
   * Per-JOB, seeded from the company default at creation and independent
   * afterwards — changing the company setting must never retroactively switch
   * automated rejections on for jobs that were posted without them.
   */
  send_rejection_email: boolean;

  /**
   * Per-dimension CV weighting — wizard step 8.
   *
   * NULL MEANS EQUAL WEIGHTING, which is defined as *today's behaviour*: the
   * model's own holistic overall_score is kept untouched. That is deliberately
   * NOT the same as "compute a flat mean of the four dimensions" — the prompt
   * tells the model its overall is a holistic judgement anchored to bands and
   * explicitly not an average, so a flat mean would come out different and every
   * existing job's next score would shift. Equal weighting therefore means
   * "don't intervene", which is what makes a backfill unnecessary.
   *
   * A weight is only applied when at least one of the four is set.
   */
  cv_weight_requirements: number | null;
  cv_weight_experience: number | null;
  cv_weight_domain: number | null;
  cv_weight_responsibilities: number | null;

  /**
   * Auto-shortlist — wizard step 9.
   *
   * `null` source means the feature is off for this job, which is the default
   * and what every existing job has.
   */
  autoshortlist_source: AutoshortlistSource | null;
  autoshortlist_cv_threshold: number | null;
  autoshortlist_interview_threshold: number | null;

  /**
   * Named must-haves the scorer reports on explicitly — wizard step 7.
   *
   * A LIST, deliberately, and never a free-text box. Nine prompt versions went
   * into removing hard rules, auto-rejection and keyword gates from the scorer;
   * a textarea handed to the prompt lets a company reinstate all three in one
   * sentence ("reject anyone under five years"). Named items give them the
   * control they actually want — "say whether this person has done X" — without
   * a channel for rewriting the rubric.
   *
   * Empty is valid and is the default: a job with no must-haves scores exactly
   * as it did before this existed.
   */
  scoring_must_haves: string[];

  /**
   * Behavioural traits checked against the interview TRANSCRIPT — step 7.
   *
   * A separate list from scoring_must_haves on purpose, and the two never fall
   * back to one another. "Comfortable picking up the phone without being told"
   * is a real thing an employer wants, and no CV on earth states it — checked
   * against a CV it returns not-found for every candidate, which is noise on
   * every scorecard and makes the feature look broken. Checked against what
   * someone actually said in an interview, it is answerable.
   *
   * Meaningful only when the job has interview questions. Empty is the default.
   */
  interview_criteria: string[];

  /**
   * How long a LIVE interview runs — 30 or 60 minutes.
   *
   * Governs the booking page a candidate is sent, not the async video round
   * above; the two are different products and a job may use either, both, or
   * neither. The column is CHECK-constrained to 30 and 60, so the wizard offers
   * exactly those and nothing else.
   *
   * NULLABLE, and null is not 30. Null means "not decided for this job" and
   * inherits whatever the default is at the time a link is sent. Writing 30 on
   * every save would freeze today's default onto every job and quietly exempt
   * them all from a later change.
   */
  interview_duration_minutes: number | null;

  /**
   * Booking hours for THIS job only, overriding the host's Settings hours.
   *
   * NULL IS THE NORMAL CASE and the default. Almost every job wants the
   * recruiter's own hours; the override exists for the role that does not — a
   * night-shift support job interviewed in the candidate's evening — without
   * rewriting the recruiter's defaults for every other job they run.
   *
   * Same shape as availability_rules: minutes from local midnight against a
   * weekday, never timestamps. A weekly intention resolves to a different
   * instant on a clock-change day, so storing instants would shift the whole
   * week twice a year.
   */
  booking_hours_override: JobBookingHours[] | null;

  /**
   * Interview questions for the video round.
   *
   * NOT a jobs column — these live in their own `interview_questions` table,
   * one row per question. They ride along on the form model because the wizard
   * edits them on the same screen as the job, and the actions sync the table
   * after the job row lands. buildPatch never sees them: it allow-lists the
   * columns it writes, so a form field that is not a column cannot leak in.
   */
  interview_questions: InterviewQuestionInput[];
};

export const EMPTY_JOB_INPUT: CompanyJobInput = {
  title: "",
  location: "",
  category: "Engineering",
  experience_level: "Expert",
  contract_type: "Full time",
  work_type: "Remote",
  positions: "1",
  description: "",
  responsibilities: "",
  requirements: "",
  salary_currency: "PKR",
  salary_min: "",
  salary_max: "",
  show_salary: true,
  screening_questions: [],
  status: "open",
  allow_rerecord: true,
  ai_cv_scoring_enabled: true,
  measure_relevancy: false,
  avatar_interview_enabled: false,
  avatar_interviewer_name: "",
  async_interview_enabled: false,
  async_interview_name: "",
  // Off by default. An automated rejection carrying a company's name is
  // switched on deliberately, never inherited by accident.
  send_rejection_email: false,
  // Null across the board: equal weighting, i.e. the model's overall stands.
  cv_weight_requirements: null,
  cv_weight_experience: null,
  cv_weight_domain: null,
  cv_weight_responsibilities: null,
  // Off. Auto-shortlist flags candidates for a human to look at, and that is
  // switched on deliberately rather than inherited.
  autoshortlist_source: null,
  autoshortlist_cv_threshold: null,
  autoshortlist_interview_threshold: null,
  scoring_must_haves: [],
  interview_criteria: [],
  // Null, not 30 and not []: "not decided", which inherits the default in
  // force when a booking link is sent rather than freezing today's.
  interview_duration_minutes: null,
  booking_hours_override: null,
  interview_questions: [],
};

/**
 * How many must-haves a job may carry.
 *
 * THREE. Not five: a cap of five invites listing everything that came to mind,
 * and everything being essential is indistinguishable from nothing being. Three
 * forces the choice the step exists to ask for.
 *
 * It is also a prompt-safety measure — a long list is how a set of named
 * requirements drifts back into free-form guidance, which is the thing this
 * whole design avoids.
 *
 * Read by BOTH the wizard's cap and the server-side clamp in jobs/actions.ts,
 * so the two cannot disagree about the limit.
 */
export const MUST_HAVE_MAX = 3;

/** Longest single must-have. Past this it stops being a named thing. */
export const MUST_HAVE_MAX_LENGTH = 90;

/**
 * Behavioural criteria per job. Three, for the same reason must-haves are three.
 */
export const INTERVIEW_CRITERIA_MAX = 3;

/**
 * Markers that a line describes a PERSON rather than a record.
 *
 * ── Why this list and not a classifier ───────────────────────
 *
 * The distinction that matters is narrow and lexical: job descriptions signal
 * "attitude" with a small, stable vocabulary — second person, comfort verbs,
 * working-style adverbs, communication nouns. Nothing here needs to understand
 * the sentence, only to notice that it is describing how somebody IS rather
 * than what they have done.
 *
 * Worked example, the one that shipped and produced not-found on every
 * candidate: "you're comfortable picking up the phone and following up without
 * being told to". Three independent hits — `you're`, `comfortable`, and
 * `without being told` — so it lands in the interview list and never reaches
 * the CV miner. That is the behaviour to preserve if this list is ever edited.
 */
const TRAIT_MARKERS: readonly RegExp[] = [
  // Second person — a job description addressing the candidate is describing
  // them, not listing a record: "you're comfortable…", "you thrive…".
  /\byou(?:'|\u2019)?(?:re|ll|ve|d)?\b/i,
  /\byour\b/i,
  // Comfort, appetite and disposition.
  /\b(?:comfortable|confident|willing|eager|keen|happy to|enjoy|enjoys|thrive|thrives|passionate|motivated|self[- ]?starter|self[- ]?motivated|proactive|driven|hungry|curious|resilient|adaptable|flexible|positive|friendly|personable|approachable|patient|empathetic|humble)\b/i,
  // Working style, and the phrase that gave this its name.
  /\b(?:without being told|under pressure|independently|autonomously|on your own|take initiative|takes initiative|ownership mindset|work ethic|attitude|mindset|team player|can[- ]do)\b/i,
  // Communication and interpersonal work — real, and a transcript evidences it.
  /\b(?:communicat\w*|collaborat\w*|interpersonal|rapport|articulate|listens?|listening|storytell\w*|stakeholder management)\b/i,
];

/**
 * Signals that a line names something a CV can actually carry.
 *
 * Used for ORDERING, never for filtering — a genuine requirement written
 * plainly ("Manage the regional sales pipeline") has none of these and must
 * still be offered. It only decides what gets pre-filled first, which matters
 * because the top three are seeded automatically.
 */
const CHECKABLE_SIGNALS: readonly RegExp[] = [
  /\d/, // "5+ years", "team of 8"
  /\b[A-Z][A-Za-z]*(?:\.[a-z]+|\+\+|#)\b/, // Node.js, C++, C#
  /\b[A-Z]{2,}\b/, // SQL, AWS, CRM, B2B
  /\b(?:years?|degree|bsc|msc|mba|certified|certification|licen[cs]ed)\b/i,
  /\b(?:built|build|shipped|ship|led|lead|managed|manage|delivered|deliver|designed|design|implemented|implement|migrated|launched|scaled|owned)\b/i,
];

function checkabilityScore(line: string): number {
  return CHECKABLE_SIGNALS.reduce((n, re) => n + (re.test(line) ? 1 : 0), 0);
}

/**
 * Openers that make a line read as the tail of a sentence rather than a claim.
 *
 * Secondary to the split fix above, not a substitute for it: the fragments this
 * catches are ones an employer actually typed that way ("and ideally some
 * Kubernetes"), which is different from one the miner manufactured. Kept to
 * coordinating conjunctions and continuation prepositions — words that cannot
 * open a standalone requirement — so a gerund ("Handling escalations…") or a
 * lowercase-styled description is still offered.
 *
 * Deliberately NOT "starts with a lowercase letter". Plenty of job descriptions
 * are written in sentence case throughout, and the real trait example —
 * "you're comfortable picking up the phone and following up without being told
 * to" — is a whole line that happens to start lowercase. Rejecting on case
 * would throw away good suggestions to catch a class the split fix already
 * eliminated.
 */
const CONTINUATION_OPENERS =
  /^(?:and|or|but|nor|plus|with|without|including|excluding|such as|as well as|which|that|who|whom|whose|then|also|e\.g\.|i\.e\.)\b/i;

/** Does this line stand on its own as a claim about a candidate? */
function readsAsStandalone(line: string): boolean {
  if (CONTINUATION_OPENERS.test(line)) return false;
  // A trailing conjunction is the other half of the same problem: the line was
  // cut before its object.
  if (/\b(?:and|or|with|including)$/i.test(line)) return false;
  return true;
}

/** Which list a candidate line belongs in. Never both. */
export function classifyCriterion(line: string): "cv" | "interview" {
  return TRAIT_MARKERS.some((re) => re.test(line)) ? "interview" : "cv";
}

/**
 * Candidate must-haves mined from what the company already wrote.
 *
 * ── How the text is split ────────────────────────────────────
 *
 * Requirements first, then responsibilities — requirements are what a scorer
 * judges against, so they make the better suggestions and should appear first.
 * Both are split on NEWLINES and on common bullet markers, never on sentence
 * punctuation: "5+ years in Node.js, React, and Postgres" is one requirement,
 * and splitting on commas would produce three meaningless fragments.
 *
 * Then each line is stripped of its bullet or numbering, trimmed, and filtered:
 *   · shorter than 12 chars — "Nice to have", a heading, a stray word
 *   · longer than MUST_HAVE_MAX_LENGTH — a paragraph, not a named thing
 *   · duplicates, compared case-insensitively
 *   · anything already added
 *
 * ── A description with nothing to offer ──────────────────────
 *
 * Returns an empty array, and the UI says so rather than rendering an empty
 * row: suggestions are a convenience, and a job written as one prose paragraph
 * is entitled to have none. Typing a must-have by hand is always available and
 * is the primary path — these chips only save keystrokes.
 */
export function suggestCriteria(input: {
  requirements: string;
  responsibilities: string;
  /** Already on either list — neither is offered twice, nor offered across. */
  existing: string[];
}): { cv: string[]; interview: string[] } {
  const taken = new Set(input.existing.map((v) => v.trim().toLowerCase()).filter(Boolean));
  const cv: { line: string; score: number }[] = [];
  const interview: string[] = [];

  for (const source of [input.requirements, input.responsibilities]) {
    /*
     * Newlines and GLYPH bullets only.
     *
     * `(?:^|\s)[-*]\s` used to be in this set and had to go: a hyphen is a
     * bullet at the start of a line and a DASH in the middle of one, and the
     * pattern could not tell them apart. "Build integrations with third-party
     * APIs - handling authentication, data mapping, and error conditions" was
     * cut in two, and the second half — "handling authentication, data mapping,
     * and error conditions" — was offered as a must-have. It evidenced
     * correctly and still read as broken, which is worse than not suggesting
     * it: a fragment in the employer's own list looks like the product mangled
     * their words.
     *
     * Nothing is lost by dropping it. A leading "- " or "* " is stripped from
     * each line below, so real bullet lists still work; only a mid-sentence
     * dash stops being a boundary. •, · and ▪ stay because they are never
     * punctuation — a line containing one is unambiguously a list.
     */
    for (const rawLine of (source ?? "").split(/\r?\n|[•·▪]/)) {
      const line = rawLine
        // Leading numbering ("1.", "2)") and stray bullet glyphs.
        .replace(/^\s*(?:\d+[.)]|[-*•·▪])\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
        // A trailing full stop reads wrong on a chip.
        .replace(/[.;,]$/, "");

      if (line.length < 12 || line.length > MUST_HAVE_MAX_LENGTH) continue;
      if (!readsAsStandalone(line)) continue;
      const key = line.toLowerCase();
      if (taken.has(key)) continue;
      taken.add(key);

      if (classifyCriterion(line) === "interview") {
        if (interview.length < 6) interview.push(line);
      } else {
        cv.push({ line, score: checkabilityScore(line) });
      }
    }
  }

  /*
   * Most-checkable first, stably.
   *
   * The top three are PRE-FILLED, so ordering is not cosmetic — it decides what
   * a recruiter is handed without asking. A line carrying a number, a named
   * tool or a concrete verb is the one most likely to produce a real quote from
   * a CV, so it goes first. Ties keep source order, which puts requirements
   * ahead of responsibilities.
   */
  const ordered = cv
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((entry) => entry.line)
    .slice(0, 6);

  return { cv: ordered, interview };
}

/**
 * Which score can flag a candidate for shortlisting.
 *
 * `both` means EITHER clearing its own threshold flags — not both together. A
 * strong CV should surface before an interview exists, and requiring both would
 * make the CV threshold unreachable for every candidate who has not recorded
 * one yet.
 */
export const AUTOSHORTLIST_SOURCES = ["cv", "interview", "both"] as const;
export type AutoshortlistSource = (typeof AUTOSHORTLIST_SOURCES)[number];

export const AUTOSHORTLIST_SOURCE_LABELS: Record<AutoshortlistSource, string> = {
  cv: "CV score only",
  interview: "Interview score only",
  both: "Either score",
};

/** Sensible starting point when a recruiter switches auto-shortlist on. */
export const AUTOSHORTLIST_DEFAULT_THRESHOLD = 80;

/**
 * The four CV dimensions a company can weight, and the label each one carries
 * in the wizard.
 *
 * `key` is the `jobs` column; `dimension` is the name the scorer uses in
 * dimension_scores. The two differ (cv_weight_experience ↔ experience_depth)
 * and pairing them here is what stops the weighting from silently matching
 * nothing — see applyCvWeights, which looks dimensions up through this table.
 */
export const CV_WEIGHT_DIMENSIONS = [
  {
    key: "cv_weight_requirements",
    dimension: "requirements_match",
    label: "Requirements match",
    hint: "Against the job's stated requirements.",
  },
  {
    key: "cv_weight_experience",
    dimension: "experience_depth",
    label: "Experience depth",
    hint: "Seniority and depth against the level sought.",
  },
  {
    key: "cv_weight_domain",
    dimension: "domain_relevance",
    label: "Domain relevance",
    hint: "Same industry or technical area as this role.",
  },
  {
    key: "cv_weight_responsibilities",
    dimension: "responsibilities_fit",
    label: "Responsibilities fit",
    hint: "Have they demonstrably done these things?",
  },
] as const;

export type CvWeightKey = (typeof CV_WEIGHT_DIMENSIONS)[number]["key"];

/**
 * The four stops of the weighting control: Less · Normal · More · Most.
 *
 * ── Multipliers are fractional; the columns are int ──────────
 *
 * The design specifies 0.5 / 1 / 2 / 3 against Normal. `cv_weight_*` and
 * `interview_questions.weight` are integer columns, so the stored value is the
 * multiplier DOUBLED: 1 / 2 / 4 / 6.
 *
 * Doubling rather than, say, storing the ordinal 1–4 keeps the stored number a
 * real multiplier. Every consumer divides by the total — applyCvWeights and the
 * interview rollup both do — so scaling all weights by a constant factor is
 * mathematically invisible: a set of {1,2,4,6} produces exactly the shares
 * {0.5,1,2,3} would. An ordinal would NOT, because 1..4 are not proportional to
 * 0.5..3, and the existing rollup would silently start weighting differently.
 *
 * It round-trips exactly because the map is a bijection over the four stops:
 * 0.5↔1, 1↔2, 2↔4, 3↔6. A job saved as Less reopens as Less.
 */
export const WEIGHT_STOPS = [
  { label: "Less", multiplier: 0.5, stored: 1 },
  { label: "Normal", multiplier: 1, stored: 2 },
  { label: "More", multiplier: 2, stored: 4 },
  { label: "Most", multiplier: 3, stored: 6 },
] as const;

export type WeightStop = (typeof WEIGHT_STOPS)[number];

/** Normal. What every dimension and question sits on until someone moves it. */
export const CV_WEIGHT_DEFAULT = 2;

/** Bounds for the stored int, used by the server-side clamp. */
export const CV_WEIGHT_MIN = 1;
export const CV_WEIGHT_MAX = 6;

/**
 * Stored int → the stop it represents.
 *
 * Falls back to Normal for anything unrecognised rather than throwing: a row
 * carrying a legacy value (the column allowed 1–5 briefly) must still open the
 * wizard, and Normal is the neutral reading.
 */
export function stopForStored(stored: number | null | undefined): WeightStop {
  const found = WEIGHT_STOPS.find((s) => s.stored === stored);
  return found ?? WEIGHT_STOPS[1];
}

/** The multiplier a stored int represents, for display and the share bar. */
export function multiplierForStored(stored: number | null | undefined): number {
  return stopForStored(stored).multiplier;
}

/**
 * Share of the total score each dimension carries, as whole percentages.
 *
 * This is what the step-8 stacked bar renders and what its status line reads
 * from. Computed from the MULTIPLIERS rather than the stored ints — identical
 * ratios either way, but the multipliers are what the copy talks about.
 *
 * Percentages are rounded so they add to exactly 100: the largest share absorbs
 * the rounding drift, because a bar whose key reads 33/33/33 under a full-width
 * bar is the kind of detail that makes a reader distrust the whole number.
 */
export function weightShares(stored: (number | null | undefined)[]): number[] {
  const multipliers = stored.map(multiplierForStored);
  const total = multipliers.reduce((sum, m) => sum + m, 0);
  if (total <= 0) return stored.map(() => 0);

  const raw = multipliers.map((m) => (m / total) * 100);
  const rounded = raw.map((v) => Math.round(v));
  const drift = 100 - rounded.reduce((sum, v) => sum + v, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] > raw[biggest]) biggest = i;
    }
    rounded[biggest] += drift;
  }
  return rounded;
}

/** True when every weight is the same stop — the "nothing to reset" state. */
export function weightsAreEqual(stored: (number | null | undefined)[]): boolean {
  if (stored.length === 0) return true;
  const first = stopForStored(stored[0]).stored;
  return stored.every((s) => stopForStored(s).stored === first);
}
