import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Auto-shortlist — flag a candidate whose score clears the job's threshold.
 *
 * ── FLAG ONLY. The stage is never touched ────────────────────
 *
 * This writes `shortlist_flagged_at` and `shortlist_flag_reason` on the
 * application and nothing else. It does not move `pipeline_stage`, it does not
 * send anything to the candidate, and there is no path from here to a rejection
 * — a score below the threshold does nothing at all, deliberately. The AI
 * raises a hand; a person decides.
 *
 * That asymmetry is the whole design. An automated shortlist that is wrong
 * costs a recruiter thirty seconds of reading; an automated rejection that is
 * wrong costs a candidate the job and nobody ever finds out. So one exists and
 * the other never will.
 *
 * ── Called from both scorers ─────────────────────────────────
 *
 * handleAiCvScore after a CV scorecard lands, and handleAiScorecard after the
 * interview rollup. Both go through this one function so "what counts as
 * flagged" cannot drift between them.
 *
 * ── Never throws ─────────────────────────────────────────────
 *
 * A flag is a courtesy attached to a score that has already been stored.
 * Failing the scoring job because the flag write failed would discard a real
 * scorecard to preserve a hint about it. Same contract as notifyCompany and
 * recordUsage.
 *
 * ── Placement note ───────────────────────────────────────────
 *
 * `src/lib/interviews/` is an imperfect home for something the CV path also
 * calls; `src/lib/shortlist.ts` would read better. It lives here because the
 * task's scoping rules named this directory, and moving it later is a rename
 * with no behavioural risk.
 */

export type ShortlistSource = "cv" | "interview";

type JobShortlistConfig = {
  autoshortlist_source: string | null;
  autoshortlist_cv_threshold: number | null;
  autoshortlist_interview_threshold: number | null;
};

/**
 * Does a score from `source` clear this job's bar?
 *
 * `both` means EITHER source can flag, each against its own threshold — not
 * both together. A strong CV has to be able to surface before any interview
 * exists, and an AND rule would make the CV threshold unreachable for every
 * candidate who has not recorded one.
 *
 * Exported for its own sake: this is the entire policy, and it is worth being
 * able to assert on without a database.
 */
export function clearsThreshold(
  job: JobShortlistConfig,
  source: ShortlistSource,
  score: number,
): { ok: true; threshold: number } | { ok: false; why: string } {
  const configured = (job.autoshortlist_source ?? "").trim();
  if (!configured) return { ok: false, why: "auto-shortlist is off for this job" };

  const sourceAllowed =
    configured === "both" || configured === source;
  if (!sourceAllowed) {
    return { ok: false, why: `job flags on ${configured}, not ${source}` };
  }

  const threshold =
    source === "cv"
      ? job.autoshortlist_cv_threshold
      : job.autoshortlist_interview_threshold;

  /*
   * A source that is enabled but has no threshold does NOT fall back to a
   * default. A default here would start flagging candidates against a number
   * nobody chose, and the recruiter would have no way to know which number.
   */
  if (typeof threshold !== "number") {
    return { ok: false, why: `no ${source} threshold set on this job` };
  }

  if (score < threshold) {
    return { ok: false, why: `${score} is below the ${source} threshold of ${threshold}` };
  }

  return { ok: true, threshold };
}

/**
 * How much higher a repeat score from the SAME source must be to re-surface a
 * candidate whose flag was dismissed.
 *
 * ── What "materially different" means here ───────────────────
 *
 * Five points, and only upward. The number exists to separate two things a raw
 * `!==` cannot tell apart:
 *
 *   · Re-scoring drift. A CV re-scored after a job edit, or under a new prompt
 *     version, routinely moves a point or two on identical evidence. Treating
 *     that as new information would resurrect every dismissed candidate on the
 *     next re-score, and a dismissal that does not stay dismissed is worse than
 *     no dismissal at all.
 *   · A genuinely better result. 78 → 91 after a candidate's CV was replaced,
 *     or a re-score under changed weights, is something the recruiter has not
 *     seen and turned down.
 *
 * Downward moves NEVER re-flag, at any size: the recruiter has already declined
 * a higher number, so a lower one carries no new argument.
 */
export const SHORTLIST_REFLAG_DELTA = 5;

/** The stored reason, naming which score and what it was. */
export function flagReason(
  source: ShortlistSource,
  score: number,
  threshold: number,
): string {
  const label = source === "cv" ? "CV score" : "Interview score";
  return `${label} ${score} met the auto-shortlist threshold of ${threshold}.`;
}

/**
 * Should a dismissed candidate be surfaced again by this new score?
 *
 * ── Dismissal is "seen", not "never again" ───────────────────
 *
 * A dismissal is keyed on WHAT RAISED IT — the source and the score — rather
 * than on the application. Turning down a CV flag says "this CV, at 84, is not
 * worth my time"; it does not say "never tell me anything about this person
 * again", and an interview they subsequently record is exactly the new
 * information the recruiter would want.
 *
 * So two things re-surface a dismissed candidate, and nothing else does:
 *
 *   1. A DIFFERENT SOURCE. A dismissed CV flag never suppresses an interview
 *      flag, and vice versa. They are different evidence about different
 *      things.
 *   2. The SAME source, materially higher — see SHORTLIST_REFLAG_DELTA.
 *
 * Exported so the policy can be asserted without a database.
 */
export function shouldReflagAfterDismissal(
  dismissed: { source: string | null; score: number | null },
  source: ShortlistSource,
  score: number,
): boolean {
  // Dismissed with nothing recorded about what was dismissed — treat it as
  // spent rather than permanent. Reachable only for rows dismissed before the
  // columns carried values.
  if (!dismissed.source) return true;
  if (dismissed.source !== source) return true;
  if (typeof dismissed.score !== "number") return true;
  return score >= dismissed.score + SHORTLIST_REFLAG_DELTA;
}

/**
 * Flag one application if its score clears the job's bar.
 *
 * ── Idempotent, and first-flag-wins ──────────────────────────
 *
 * The UPDATE carries `.is("shortlist_flagged_at", null)`, so an application
 * that is already flagged matches zero rows and keeps its original timestamp
 * AND its original reason. That is deliberate in one specific direction the
 * brief calls out: a later, LOWER score must not overwrite the reason that
 * actually caused the flag. "Interview score 71" replacing "CV score 94" would
 * misrepresent why the candidate was surfaced.
 *
 * It also makes concurrent scorers safe without coordination — CV and interview
 * scoring can land in the same instant and exactly one wins the row, the same
 * conditional-UPDATE trick the expiry handler uses.
 *
 * ── Dismissal is consulted, not obeyed blindly ───────────────
 *
 * A prior dismissal is read first and checked against
 * shouldReflagAfterDismissal. Re-flagging CLEARS the dismissal columns, because
 * the dismissal has been superseded — leaving them would make the next
 * dismissal ambiguous about which flag it referred to.
 */
export async function maybeFlagForShortlist(input: {
  applicationId: string;
  companyId: string;
  job: JobShortlistConfig;
  source: ShortlistSource;
  score: number;
}): Promise<void> {
  try {
    const verdict = clearsThreshold(input.job, input.source, input.score);
    if (!verdict.ok) {
      console.log(
        `[shortlist] not flagging ${input.applicationId} — ${verdict.why}`,
      );
      return;
    }

    const service = createServiceClient();

    const { data: currentRow } = await service
      .from("job_applications")
      .select(
        "shortlist_flagged_at, shortlist_dismissed_source, shortlist_dismissed_score",
      )
      .eq("id", input.applicationId)
      .eq("company_id_snapshot", input.companyId)
      .maybeSingle();

    const current = currentRow as {
      shortlist_flagged_at: string | null;
      shortlist_dismissed_source: string | null;
      shortlist_dismissed_score: number | null;
    } | null;

    if (!current) {
      console.log(`[shortlist] ${input.applicationId} not found for this company`);
      return;
    }

    /*
     * `shortlist_dismissed_source` IS the dismissal marker.
     *
     * There is no shortlist_dismissed_at column, so "has this been dismissed?"
     * is answered by whether we recorded WHAT was dismissed. That is the more
     * useful of the two facts anyway — a timestamp alone could not tell a later
     * flag whether it carried new information — but it does mean a dismissal we
     * could not attribute records nothing and therefore suppresses nothing. See
     * dismissShortlistFlag.
     */
    if (
      current.shortlist_dismissed_source &&
      !shouldReflagAfterDismissal(
        {
          source: current.shortlist_dismissed_source,
          score: current.shortlist_dismissed_score,
        },
        input.source,
        input.score,
      )
    ) {
      console.log(
        `[shortlist] ${input.applicationId} stays dismissed — ${input.source} ${input.score} is not materially above the dismissed ${current.shortlist_dismissed_source} ${current.shortlist_dismissed_score}`,
      );
      return;
    }

    const { data, error } = await service
      .from("job_applications")
      .update({
        shortlist_flagged_at: new Date().toISOString(),
        shortlist_flag_reason: flagReason(input.source, input.score, verdict.threshold),
        // The dismissal has been superseded by new evidence.
        shortlist_dismissed_source: null,
        shortlist_dismissed_score: null,
      })
      .eq("id", input.applicationId)
      // Tenancy: the score's company must own the application.
      .eq("company_id_snapshot", input.companyId)
      // The idempotency guard. Zero rows means already flagged — leave it be.
      .is("shortlist_flagged_at", null)
      .select("id");

    if (error) {
      console.error(`[shortlist] flag write failed for ${input.applicationId}:`, error.message);
      return;
    }

    if ((data ?? []).length === 0) {
      console.log(
        `[shortlist] ${input.applicationId} was already flagged — reason left as it was`,
      );
      return;
    }

    console.log(
      `[shortlist] flagged ${input.applicationId} on ${input.source} score ${input.score}`,
    );
  } catch (err) {
    console.error("[shortlist] failed (non-fatal):", err);
  }
}

/**
 * Parse the source and score back out of a stored flag reason.
 *
 * The reason is the only record of WHAT was flagged — there is no
 * shortlist_flag_source column — so dismissal recovers them from the sentence
 * flagReason wrote. Kept adjacent to flagReason so the two cannot drift: change
 * one wording and this stops matching, which the fallback below turns into a
 * permanent dismissal rather than a crash.
 *
 * Returns nulls when the reason is absent or unparseable, and
 * shouldReflagAfterDismissal treats a null source as "spent" — so the failure
 * direction is a candidate who CAN re-surface, never one silently buried.
 */
export function parseFlagReason(reason: string | null): {
  source: ShortlistSource | null;
  score: number | null;
} {
  const text = (reason ?? "").trim();
  if (!text) return { source: null, score: null };

  const source: ShortlistSource | null = text.startsWith("CV score")
    ? "cv"
    : text.startsWith("Interview score")
      ? "interview"
      : null;

  const match = text.match(/\b(\d{1,3})\b/);
  const score = match ? Number(match[1]) : null;

  return {
    source,
    score: typeof score === "number" && score >= 0 && score <= 100 ? score : null,
  };
}

/**
 * Dismiss a flag: record that it was SEEN, and against what.
 *
 * ── Clears the flag, keeps the evidence ──────────────────────
 *
 * `shortlist_flagged_at` goes null, so the chip disappears and the partial
 * index stays small. What replaces it is a record of what was turned down —
 * source and score — which is precisely what lets a later flag decide whether
 * it is telling the recruiter something new. A dismissal that stored only a
 * timestamp would have to be either permanent or worthless.
 *
 * `shortlist_flag_reason` is deliberately KEPT, so the drawer can still say
 * "dismissed — was flagged for CV score 94" rather than losing the history the
 * moment someone clicks the X.
 *
 * Guarded on the flag being present, so dismissing twice is a no-op and cannot
 * overwrite an earlier dismissal's recorded score with a later flag's.
 *
 * ── An unattributable dismissal suppresses NOTHING ───────────
 *
 * `shortlist_dismissed_source` doubles as the "was this dismissed" marker,
 * because there is no dismissed_at column. So if the reason cannot be parsed —
 * only possible for a hand-written or pre-existing reason, since flagReason
 * always produces a parseable one — the dismissal records null and the next
 * qualifying score flags again immediately.
 *
 * That is the deliberate failure direction. A recruiter seeing a dismissed
 * suggestion return is mildly irritating; a candidate silently buried by a
 * dismissal nobody can account for is the failure that matters.
 */
export async function dismissShortlistFlag(input: {
  applicationId: string;
  companyId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = createServiceClient();

  const { data: currentRow } = await service
    .from("job_applications")
    .select("shortlist_flag_reason")
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    .maybeSingle();

  const reason = (currentRow as { shortlist_flag_reason: string | null } | null)
    ?.shortlist_flag_reason ?? null;
  const raised = parseFlagReason(reason);

  const { data, error } = await service
    .from("job_applications")
    .update({
      shortlist_flagged_at: null,
      shortlist_dismissed_source: raised.source,
      shortlist_dismissed_score: raised.score,
    })
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    // Only a live flag can be dismissed. Zero rows means it was already gone.
    .not("shortlist_flagged_at", "is", null)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if ((data ?? []).length === 0) return { ok: true }; // Already dismissed.

  console.log(
    `[shortlist] dismissed ${input.applicationId} (was ${raised.source ?? "unknown"} ${raised.score ?? "?"})`,
  );
  return { ok: true };
}
