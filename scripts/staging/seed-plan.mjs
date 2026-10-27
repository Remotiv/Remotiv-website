/**
 * The seed, as data. No network, no database, no clock, no randomness.
 *
 * buildPlan() returns every row the seed will write AND the manifest of what
 * the dashboard must therefore show. Separating the two matters: the manifest
 * is the INDEPENDENTLY GENERATED expected set that the harness compares a real
 * authenticated read against. If the harness derived its expectations by
 * re-running the dashboard's own filters, a wrong filter would agree with
 * itself and the comparison would prove nothing — that is the self-reference
 * failure this split exists to remove.
 *
 * ── Why these shapes and not an even spread ──────────────────
 *
 * An even distribution is the one shape that cannot find a pagination bug.
 * Give every job several full pages and no job ever lands on a page boundary,
 * so off-by-one errors at `from + PAGE - 1` never fire. The job tail below is
 * therefore deliberate: 999, 1000 and 1001 bracket the 1,000-row internal page
 * used by scopedApplicationIds and rescoreJob, and the single-row jobs cover
 * the partial-first-page case.
 *
 * Likewise the score mix. Production is skipped-heavy — 100 of 148 real rows
 * are skipped — and `effective_score` is NULL for any row that is not `scored`
 * and carries no human adjustment. A scored-heavy seed leaves almost every row
 * with a non-NULL score, so the NULLS LAST ordering that Best Match depends on
 * is barely touched. At the ratios below roughly four rows in five sort through
 * the NULL branch, which is what makes the Best Match assertions meaningful.
 *
 * ── Source pins ──────────────────────────────────────────────
 *
 * Every vocabulary below is copied from shipped source or from a live CHECK
 * constraint, and seed-plan.test.mjs re-reads those files and fails if a value
 * here has drifted. A seed that writes a status the constraint rejects fails
 * loudly at insert time; a seed that MISSES a status fails silently by never
 * exercising the surface, which is the failure the pins are aimed at.
 */

import { createHash } from "node:crypto";

/** communication_logs_status_check, in constraint order. All seven. */
export const MESSAGE_STATUSES = [
  "queued",
  "sent",
  "failed",
  "cancelled",
  "skipped",
  "delivered",
  "read",
];

/**
 * The status Messages hides, and the column that orphans a row.
 *
 * messages/actions.ts:80 and :104. The list applies `.neq("status", "cancelled")`
 * and `.not("application_id", "is", null)`, so cancelled rows and orphans are
 * written by the seed on purpose and expected to be ABSENT from every count.
 * Seeding neither would make the two exclusions untestable: a filter that is
 * never given a row to exclude passes whether or not it works.
 */
export const MESSAGE_HIDDEN_STATUS = "cancelled";
export const MESSAGE_ORPHAN_COLUMN = "application_id";

/** communication_logs.channel, from the two `.eq("channel", …)` filters in shipped code. */
export const MESSAGE_CHANNELS = ["email", "whatsapp"];

/**
 * communication_logs.event. "manual" is load-bearing — applyTab() splits
 * Written from Automatic on `event === "manual"` alone (messages/actions.ts:300),
 * so both sides must be populated or one of the three tabs is always empty.
 */
export const MESSAGE_EVENT_MANUAL = "manual";
/**
 * Automatic events, every one a member of communication_logs_event_check.
 *
 * The first 50-seed used "interview_invite" and "rejection", which the live
 * constraint rejects: its members are the product's lifecycle events, and the
 * nearest allowed values are "interview" and "rejected". The enum preflight
 * (scripts/staging/constraints.mjs) now checks every such value against the
 * dump before the first insert, so a wrong one is a listed preflight failure,
 * not a mid-table abort. These are a varied subset of the allowed set; the
 * Automatic tab only requires event !== "manual" and status !== "queued", so
 * the exact choice is free as long as each value is permitted.
 */
export const MESSAGE_EVENTS_AUTOMATIC = [
  "application_received",
  "interview",
  "rejected",
  "shortlisted",
  "booking_link",
  "offer",
];

/** application_scores_status_check. */
export const SCORE_STATUSES = ["pending", "scored", "failed", "skipped"];

/**
 * interview_sessions.status after migration 020 widened it.
 *
 * SIX, not the five in schema.sql — 020 added "abandoned". Only the first five
 * have a chip on the Interviews page, so `abandoned` is seeded ZERO times and
 * the exhaustiveness invariant below holds. See CHIP_STATUSES.
 */
export const SESSION_STATUSES = [
  "invited",
  "started",
  "submitted",
  "expired",
  "cancelled",
  "abandoned",
];

/**
 * The five status chips, which review.ts computes over live rows only.
 *
 * `cancelled` and `archived` are in HIDDEN_AT_ZERO (_interviews-client.tsx:130),
 * meaning the chip is NOT RENDERED when its count is zero. A seed with no
 * cancelled and no archived rows therefore produces a page with two fewer
 * elements, and a harness that sweeps `[data-tab]` would simply not see them
 * and report success over a smaller strip. That is the exact false-green this
 * seed prevents by writing both.
 */
export const CHIP_STATUSES = ["submitted", "started", "invited", "expired", "cancelled"];

/**
 * PIPELINE_STAGES, applicant-types.ts:21.
 *
 * The Applied tab also claims a NULL stage (actions.ts:763), but the column is
 * NOT NULL DEFAULT 'applied' in the production dump, so a NULL cannot be
 * written and the plan does not try. seed-plan.test.mjs pins that: if a future
 * dump shows the column nullable, the pin goes red and the NULL case should be
 * seeded. Until then the or() branch is untested, and the harness says so.
 */
export const PIPELINE_STAGES = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
  "rejected",
];

/** The internal page size of the paged reads under test (job-scope.ts:210, actions.ts:2369). */
export const INTERNAL_PAGE = 1000;

/**
 * jobs columns that are NOT NULL with no default, and the CHECK-listed values
 * used for them. Copied from the production dump's CREATE TABLE and pinned by
 * seed-plan.test.mjs, because a seed that fails at the first jobs insert on a
 * NOT NULL violation has cost a round trip to a free-tier database to learn
 * what the dump already said. `company` is the legacy free-text company name
 * and is set to the fixture company's name at insert time.
 */
export const JOB_REQUIRED = {
  location: "Remote",
  category: "Engineering",
  experience_level: "Intermediate",
};
/** jobs_status_check allows open, on_hold, closed. "published" is not a status. */
export const JOB_STATUS = "open";

/**
 * The job tail. One big job, then a real spread down to single-applicant jobs.
 *
 * 999 / 1000 / 1001 are the point of the list: they bracket INTERNAL_PAGE, so a
 * read that stops one row early, or asks for one row too many, shows up as a
 * missing or duplicated id rather than as a plausible-looking total.
 */
export const JOB_APPLICANT_COUNTS = [
  2500, 1500, 1200, 1001, 1000, 999, 800, 500, 250, 120, 60, 30, 17, 11, 7, 3, 1, 1,
];

export const TOTAL_APPLICANTS = JOB_APPLICANT_COUNTS.reduce((a, b) => a + b, 0);

/** The scale every constant in this file is stated at. buildPlan scales from it. */
export const FULL_SCALE = TOTAL_APPLICANTS;

/** The UI page sizes the NOT COVERED list is computed against (pinned by the test). */
export const APPLICANT_PAGE_SIZE = 20;
export const MESSAGES_PAGE_SIZE = 20;

/**
 * Apportion `total` across `weights` by the largest-remainder method.
 *
 * At total === sum(weights) every share is an integer and the result IS the
 * weights, so the full-scale plan is the fixed point and not a special case.
 * At a smaller total the shape is kept proportionally and the small jobs round
 * to zero, which is correct: a 50-applicant run has eight empty jobs, and the
 * dashboard has to handle an empty job anyway. No "test mode": the same
 * function produces 50 and 10,000, and a bug in it shows at both.
 */
export function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => (w * total) / sum);
  const floors = shares.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, i) => ({ i, r: s - Math.floor(s) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * Every count the plan uses, at `applicants` scale.
 *
 * Each is the full-scale constant times applicants / FULL_SCALE, rounded, so
 * at FULL_SCALE this returns the constants exactly (seed-plan.test.mjs pins
 * that) and at 50 it returns the same shape in miniature. Nothing is floored
 * to a minimum: if a ratio rounds to zero at the chosen scale, the feature it
 * exercises is simply NOT COVERED at that scale, and notCovered() says so,
 * rather than being covered by a token row the ratio did not ask for.
 */
export function scaled(applicants) {
  if (!Number.isInteger(applicants) || applicants <= 0) {
    throw new Error(`buildPlan needs a positive integer applicant count, got ${applicants}`);
  }
  const r = (full) => Math.round((full * applicants) / FULL_SCALE);
  return {
    applicants,
    jobCounts: apportion(JOB_APPLICANT_COUNTS, applicants),
    withoutScoreRow: r(APPLICATIONS_WITHOUT_SCORE_ROW),
    skippedWithAdjustment: r(SKIPPED_WITH_ADJUSTMENT),
    messages: r(MESSAGE_TOTAL),
    messageOrphans: r(MESSAGE_ORPHANS),
    messageCancelled: r(MESSAGE_CANCELLED),
    sessions: r(SESSION_TOTAL),
    sessionArchived: r(SESSION_ARCHIVED),
    applicationTie: r(APPLICATION_TIE_BLOCK),
    messageTie: r(MESSAGE_TIE_BLOCK),
  };
}

/**
 * What a run at this scale CANNOT exercise, stated so the harness prints it
 * as NOT COVERED and never as PASS. Every entry names the feature and the
 * number that falls short. Empty at full scale (pinned by the test).
 */
export function notCovered(manifest) {
  const s = manifest.scale;
  const out = [];
  const largest = Math.max(...s.jobCounts);
  if (largest <= INTERNAL_PAGE) {
    out.push(
      `the ${INTERNAL_PAGE.toLocaleString("en-US")}-row internal page boundary (job-scope.ts:210, actions.ts:2369): the largest job has ${largest} applicants`,
    );
  }
  if (manifest.scopedApplicationIds.length <= INTERNAL_PAGE) {
    out.push(
      `#25 chunking across the ${INTERNAL_PAGE.toLocaleString("en-US")}-row internal page: the scoped set has ${manifest.scopedApplicationIds.length} ids`,
    );
  }
  if (s.applicationTie < APPLICANT_PAGE_SIZE) {
    out.push(
      `a UI page boundary inside a created_at tie block on Applicants: the tie block is ${s.applicationTie} rows, the page is ${APPLICANT_PAGE_SIZE}`,
    );
  }
  if (s.messageTie < MESSAGES_PAGE_SIZE) {
    out.push(
      `#23 page boundary inside a created_at tie block on Messages: the tie block is ${s.messageTie} rows, the page is ${MESSAGES_PAGE_SIZE}`,
    );
  }
  const smallestTie = Math.min(...Object.values(manifest.bestMatch.tiedGroups));
  if (smallestTie < APPLICANT_PAGE_SIZE) {
    out.push(
      `Best Match ties spanning a UI page: the smallest tie group is ${smallestTie} rows, the page is ${APPLICANT_PAGE_SIZE}`,
    );
  }
  if (s.skippedWithAdjustment === 0) {
    out.push("the skipped-with-human-adjustment effective_score branch: 0 such rows at this scale");
  }
  if (largest < JOB_APPLICANT_COUNTS[0]) {
    out.push(
      `the ${JOB_APPLICANT_COUNTS[0].toLocaleString("en-US")}-applicant single job: the largest job has ${largest}`,
    );
  }
  return out;
}

/**
 * Score status mix, pinned to production's skipped-heavy shape.
 *
 * Only the skipped share is measured (100 of 148 real rows). The split of the
 * remaining 48 across scored/pending/failed is NOT measured and is a documented
 * choice, not a claim about production — stated here so nobody later reads it
 * as one.
 */
export const SCORE_MIX = { skipped: 0.6757, scored: 0.2162, pending: 0.0676, failed: 0.0405 };

/** Applications deliberately given NO application_scores row at all — a third NULL path. */
export const APPLICATIONS_WITHOUT_SCORE_ROW = 1000;

/**
 * Skipped rows carrying a human adjustment.
 *
 * effective_score is NULL when status is not "scored" AND human_adjusted_score
 * is null. A skipped row WITH an adjustment is therefore non-NULL despite its
 * status, which is the branch effective-score-gate.test.ts exists for and the
 * one a seed of pure-skipped rows would never produce.
 */
export const SKIPPED_WITH_ADJUSTMENT = 50;

/** Score values repeated many times over, so Best Match must break ties. */
export const TIED_SCORES = [91, 78, 64, 55, 42];

export const MESSAGE_TOTAL = 6000;
export const MESSAGE_ORPHANS = 400;
export const MESSAGE_CANCELLED = 600;

export const SESSION_TOTAL = 1400;
export const SESSION_ARCHIVED = 150;

/** Rows sharing ONE created_at, in each table: the block a page boundary must fall inside. */
export const APPLICATION_TIE_BLOCK = 500;
export const MESSAGE_TIE_BLOCK = 300;

/**
 * A UUID that is a pure function of its label.
 *
 * Two runs produce byte-identical ids, so a harness failure can be reproduced
 * instead of re-rolled, and the manifest the harness compares against can be
 * regenerated without reading the database. No Math.random, no Date.now.
 */
export function uuidFrom(label) {
  const h = createHash("sha256").update(`remotiv-staging:${label}`).digest("hex");
  const v = `4${h.slice(13, 16)}`;
  const n = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${n}-${h.slice(20, 32)}`;
}

/** A fixed epoch, so created_at never depends on when the seed ran. */
const EPOCH = Date.parse("2026-01-05T09:00:00.000Z");

/** Minute i after the epoch. Collisions are introduced deliberately, below. */
const at = (i) => new Date(EPOCH + i * 60_000).toISOString();

/**
 * Add database-required columns to a planned row, and refuse to CHANGE one.
 *
 * seed.mjs has to widen these rows before inserting them — `email`, `token_hash`
 * and `expires_at` are columns the database requires and the plan deliberately
 * does not model, because the manifest makes no claim about them.
 *
 * It must never widen `status`, `created_at`, `archived_at`, `event` or any id,
 * because the manifest's counts and id sets are derived from the plan's values
 * for exactly those fields. An overwrite there would leave the manifest
 * describing data that was never written, and the harness would then compare a
 * real read against a fiction — agreeing or disagreeing for reasons that have
 * nothing to do with the query under test. That is the same false-green shape as
 * a check over an empty set, so it throws, naming the key.
 *
 * Lives here rather than in seed.mjs because seed.mjs calls main() at module
 * scope and cannot be imported by a test. A guard no test can reach is a guard
 * nobody can prove.
 */
export function enrich(row, extra) {
  for (const key of Object.keys(extra)) {
    if (key in row) {
      throw new Error(
        `enrich() tried to overwrite \`${key}\`, which the plan already set. The ` +
          `manifest's counts are derived from the plan's value, so overwriting it at ` +
          `insert time would make every harness assertion compare against data that ` +
          `was never written.`,
      );
    }
  }
  return { ...row, ...extra };
}

/**
 * Builds every row and the manifest of what must therefore be visible.
 *
 * `applicants` is REQUIRED. There is no default, so nothing can seed 10,000
 * rows because a flag was forgotten, and nothing can seed 50 and be read as
 * the full run: the manifest records the scale and the harness prints what
 * that scale leaves NOT COVERED.
 *
 * @param {{companyId: string, companyName: string, applicants: number, scopedJobIndexes?: number[]}} opts
 */
export function buildPlan({ companyId, companyName, applicants, scopedJobIndexes = [0, 3, 4] }) {
  if (typeof companyName !== "string" || companyName === "") {
    throw new Error("buildPlan needs companyName: jobs.company is NOT NULL free text");
  }
  const scale = scaled(applicants);
  const jobs = scale.jobCounts.map((count, j) => ({
    id: uuidFrom(`job:${j}`),
    company_id: companyId,
    company: companyName,
    title: `Staging Role ${String(j).padStart(2, "0")}`,
    ...JOB_REQUIRED,
    // NULL means ENABLED on both read paths (cv-scoring.ts:1527 reads === false,
    // applicants/actions.ts:1147 reads !== false). Explicit false, always.
    ai_cv_scoring_enabled: false,
    applicantCount: count,
  }));

  const applications = [];
  const applicationIdsByJob = {};

  let n = 0;
  for (const [j, job] of jobs.entries()) {
    const ids = [];
    for (let k = 0; k < job.applicantCount; k++) {
      const id = uuidFrom(`application:${j}:${k}`);
      ids.push(id);
      applications.push({
        id,
        job_id: job.id,
        company_id_snapshot: companyId,
        job_title_snapshot: job.title,
        first_name: `Cand${String(n).padStart(5, "0")}`,
        // A surname shared by many rows, so a name search cannot be satisfied
        // by one row and a tie cannot be broken by the name.
        last_name: n % 8 === 0 ? "Okonkwo" : `Sur${String(n % 400).padStart(3, "0")}`,
        // Every stage, cycled, so each stage chip has rows and the seven sum to
        // the total. Never NULL: the column is NOT NULL in the dump (see
        // PIPELINE_STAGES above).
        pipeline_stage: PIPELINE_STAGES[n % PIPELINE_STAGES.length],
        // 500 rows share one timestamp. created_at is the only sort key on the
        // Messages list and on nine other paged reads, so a block of exact ties
        // is what turns "no unique tiebreaker" from theory into a measurement.
        created_at: n < scale.applicationTie ? at(0) : at(n),
      });
      n += 1;
    }
    applicationIdsByJob[job.id] = ids;
  }

  const scores = [];
  const scorable = applications.slice(0, applications.length - scale.withoutScoreRow);
  const want = {
    skipped: Math.round(scorable.length * SCORE_MIX.skipped),
    scored: Math.round(scorable.length * SCORE_MIX.scored),
    pending: Math.round(scorable.length * SCORE_MIX.pending),
  };
  want.failed = scorable.length - want.skipped - want.scored - want.pending;

  const statusFor = (i) => {
    if (i < want.skipped) return "skipped";
    if (i < want.skipped + want.scored) return "scored";
    if (i < want.skipped + want.scored + want.pending) return "pending";
    return "failed";
  };

  for (const [i, app] of scorable.entries()) {
    const status = statusFor(i);
    const tied = TIED_SCORES[i % TIED_SCORES.length];
    // Only the first SKIPPED_WITH_ADJUSTMENT skipped rows carry an adjustment,
    // which is what makes their effective_score non-NULL despite the status.
    const adjusted = status === "skipped" && i < scale.skippedWithAdjustment ? tied : null;
    scores.push({
      id: uuidFrom(`score:${app.id}`),
      application_id: app.id,
      job_id: app.job_id,
      company_id: companyId,
      status,
      overall_score: status === "scored" ? tied : null,
      human_adjusted_score: adjusted,
      ai_model: "staging-synthetic",
      prompt_version: "staging-0",
    });
  }

  const messages = [];
  for (let i = 0; i < scale.messages; i++) {
    const orphan = i < scale.messageOrphans;
    const cancelled = !orphan && i < scale.messageOrphans + scale.messageCancelled;
    const visibleIndex = i - scale.messageOrphans - scale.messageCancelled;

    let status;
    if (cancelled) {
      status = MESSAGE_HIDDEN_STATUS;
    } else if (orphan) {
      // Orphans span every status INCLUDING cancelled, so the orphan filter is
      // tested independently of the status filter rather than only alongside it.
      status = MESSAGE_STATUSES[i % MESSAGE_STATUSES.length];
    } else {
      const visible = MESSAGE_STATUSES.filter((s) => s !== MESSAGE_HIDDEN_STATUS);
      status = visible[visibleIndex % visible.length];
    }

    const manual = i % 3 === 0;
    messages.push({
      id: uuidFrom(`message:${i}`),
      company_id: companyId,
      application_id: orphan ? null : applications[i % applications.length].id,
      channel: MESSAGE_CHANNELS[i % MESSAGE_CHANNELS.length],
      status,
      event: manual
        ? MESSAGE_EVENT_MANUAL
        : MESSAGE_EVENTS_AUTOMATIC[i % MESSAGE_EVENTS_AUTOMATIC.length],
      to_address: `staging+${i}@example.invalid`,
      subject: `Staging message ${i}`,
      // 300 messages share one timestamp, for the same reason as applications.
      created_at: i < scale.messageTie ? at(0) : at(i),
    });
  }

  const visibleMessages = messages.filter(
    (m) => m.application_id !== null && m.status !== MESSAGE_HIDDEN_STATUS,
  );
  const notQueued = (m) => m.status !== "queued";

  const sessions = [];
  for (let i = 0; i < scale.sessions; i++) {
    const archived = i < scale.sessionArchived;
    sessions.push({
      id: uuidFrom(`session:${i}`),
      application_id: applications[i].id,
      job_id: applications[i].job_id,
      company_id: companyId,
      // Archived rows are drawn from the chip statuses too, so "archived" is a
      // dimension rather than a sixth status.
      status: CHIP_STATUSES[i % CHIP_STATUSES.length],
      archived_at: archived ? at(i) : null,
      created_at: at(i),
    });
  }
  const liveSessions = sessions.filter((s) => s.archived_at === null);

  const effectiveNonNull = scores.filter(
    (s) => s.status === "scored" || s.human_adjusted_score !== null,
  ).length;

  const manifest = {
    companyId,
    /** The scale this plan was built at. The harness prints what it leaves NOT COVERED. */
    scale,
    jobIds: jobs.map((j) => j.id),
    applicationIdsByJob,
    applicationIdsAll: applications.map((a) => a.id),

    /**
     * The #25 expected answer: every application id on the scoped member's
     * jobs. Generated here from what the seed wrote, NOT by a second read of
     * the query under test. A read that deterministically drops the same rows
     * agrees with itself on every attempt and would pass a two-read comparison.
     */
    scopedJobIds: scopedJobIndexes.map((j) => jobs[j].id),
    scopedApplicationIds: scopedJobIndexes.flatMap((j) => applicationIdsByJob[jobs[j].id]),

    messages: {
      visibleIds: visibleMessages.map((m) => m.id),
      expectedAll: visibleMessages.length,
      expectedScheduled: visibleMessages.filter((m) => m.status === "queued").length,
      expectedWritten: visibleMessages.filter(
        (m) => m.event === MESSAGE_EVENT_MANUAL && notQueued(m),
      ).length,
      expectedAutomatic: visibleMessages.filter(
        (m) => m.event !== MESSAGE_EVENT_MANUAL && notQueued(m),
      ).length,
      seededCancelled: messages.filter(
        (m) => m.status === MESSAGE_HIDDEN_STATUS && m.application_id !== null,
      ).length,
      seededOrphans: messages.filter((m) => m.application_id === null).length,
    },

    interviews: {
      expectedLiveTotal: liveSessions.length,
      expectedArchived: sessions.length - liveSessions.length,
      byStatus: Object.fromEntries(
        CHIP_STATUSES.map((s) => [s, liveSessions.filter((r) => r.status === s).length]),
      ),
    },

    bestMatch: {
      effectiveNonNull,
      effectiveNull: applications.length - effectiveNonNull,
      tiedGroups: Object.fromEntries(
        TIED_SCORES.map((v) => [
          v,
          scores.filter((s) => s.status === "scored" && s.overall_score === v).length,
        ]),
      ),
    },
  };

  manifest.notCovered = notCovered(manifest);
  return { jobs, applications, scores, messages, sessions, manifest };
}
