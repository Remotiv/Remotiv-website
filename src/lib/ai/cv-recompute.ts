import "server-only";
import { applyCvWeights, type CvWeights } from "@/lib/ai/cv-scoring";
import { skipJob } from "@/lib/job-skip";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Recompute stored CV overalls after a job's weights change.
 *
 * ── No model call, no cost, no prompt version ────────────────
 *
 * Everything needed is already on the row. `dimension_scores` holds the four
 * numbers the model returned, and the weighting is pure arithmetic over them —
 * so a weight change is a recomputation, not a re-score. Nothing here talks to
 * Anthropic, `prompt_version` and `job_criteria_version` are left exactly as
 * they were, and the evidence, quotes, reasoning and verdict are untouched.
 * The model was asked the same question and gave the same answer; only the way
 * we combine it changed.
 *
 * This is the alternative to bumping criteria_version, which would have marked
 * every scorecard stale and invited a full paid re-score to recompute something
 * derivable from stored data.
 *
 * ── Why a background job and not an inline loop ──────────────
 *
 * updateCompanyJob is a server action with a recruiter waiting on it. A job
 * with a few thousand applicants would page through as many score rows, and
 * saving a weight change is not the moment to block on that. The queue also
 * gives it retries, and re-running is free because the computation is
 * deterministic from stored data — running it twice produces the same numbers.
 *
 * ── A HUMAN ADJUSTMENT IS NEVER TOUCHED ──────────────────────
 *
 * `human_adjusted_score`, `human_feedback`, `adjusted_by`, `adjusted_by_name`
 * and `adjusted_at` are not in the update patch at all, so no code path here
 * can overwrite one. The UPDATE writes exactly one column: overall_score.
 *
 * Rows WITH an adjustment are still recomputed, deliberately. The two columns
 * answer different questions — overall_score is "what the AI says under the
 * current weighting", human_adjusted_score is "what a person decided" — and the
 * UI already prefers the human's (`human_adjusted_score ?? overall_score`), so
 * the person's decision continues to win everywhere it is displayed. Freezing
 * the AI number on adjusted rows would create a second class of scorecard whose
 * overall_score silently means something different from every other row's.
 *
 * The honest cost: a recruiter who adjusted 70 → 80 may later see the AI number
 * underneath read 78. The adjustment still stands; only the baseline it was
 * made against moved.
 */

/** Rows fetched per batch. */
const PAGE = 200;

/** Backstop so a pathological job cannot hold a worker slot forever. */
const MAX_ROWS = 20_000;

export type CvRecomputePayload = { jobId: string };

type ScoreRow = {
  id: string;
  overall_score: number | null;
  dimension_scores: unknown;
};

export async function handleCvRecompute(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as CvRecomputePayload;
  const jobId = payload?.jobId;

  if (typeof jobId !== "string" || !jobId) {
    throw new Error(`cv_score_recompute: payload has no jobId (job ${job.id})`);
  }

  const service = createServiceClient();

  const { data: jobData } = await service
    .from("jobs")
    .select(
      "id, company_id, cv_weight_requirements, cv_weight_experience, cv_weight_domain, cv_weight_responsibilities",
    )
    .eq("id", jobId)
    .maybeSingle();

  const jobRow = jobData as
    | ({ id: string; company_id: string | null } & CvWeights)
    | null;

  if (!jobRow) {
    skipJob("cv_score_recompute", job.id, `job ${jobId} no longer exists`);
    return;
  }

  const weights: CvWeights = {
    cv_weight_requirements: jobRow.cv_weight_requirements,
    cv_weight_experience: jobRow.cv_weight_experience,
    cv_weight_domain: jobRow.cv_weight_domain,
    cv_weight_responsibilities: jobRow.cv_weight_responsibilities,
  };

  /*
   * ── Clearing weights does NOT restore the model's original number ──
   *
   * applyCvWeights returns its `modelOverall` argument unchanged when no weight
   * is set, and the only overall we still have is the one the LAST weighting
   * produced — the model's raw holistic number was overwritten when the score
   * was first stored and is not recoverable from this table.
   *
   * So a job going weighted → unweighted keeps its last weighted numbers rather
   * than reverting. Sweeping every row to write back the value it already holds
   * is pure noise, so that case returns early and says so. Making this properly
   * reversible needs somewhere to keep the raw model overall — see the report.
   */
  const anyWeightSet = Object.values(weights).some(
    (v) => typeof v === "number" && v > 0,
  );
  if (!anyWeightSet) {
    skipJob(
      "cv_score_recompute",
      job.id,
      `job ${jobId} has no weights set — stored overalls are left as they are (the model's original number is not recoverable)`,
    );
    return;
  }

  let seen = 0;
  let changed = 0;

  for (;;) {
    if (seen >= MAX_ROWS) {
      console.warn(
        `[cv_score_recompute] stopped at the ${MAX_ROWS}-row ceiling for job ${jobId}`,
      );
      break;
    }

    /*
     * Offset paging is CORRECT here, unlike the expiry sweep: this loop does not
     * change whether a row matches the filter — a recomputed row is still a
     * 'scored' row for this job — so the result set is stable across pages and
     * the window can advance.
     */
    const { data, error } = await service
      .from("application_scores")
      .select("id, overall_score, dimension_scores")
      .eq("job_id", jobId)
      .eq("company_id", jobRow.company_id ?? "")
      .eq("status", "scored")
      .order("id", { ascending: true })
      .range(seen, seen + PAGE - 1);

    if (error) {
      throw new Error(`cv_score_recompute: read failed: ${error.message}`);
    }

    const batch = (data ?? []) as ScoreRow[];
    if (batch.length === 0) break;

    for (const row of batch) {
      seen++;
      const dims = normaliseDimensions(row.dimension_scores);
      // No stored dimensions means nothing to weight — an old row, or a
      // scorecard written before the column carried the four entries. Left
      // exactly as it is rather than being recomputed to something arbitrary.
      if (dims.length === 0) continue;

      const next = applyCvWeights(row.overall_score ?? 0, dims, weights);
      if (next === row.overall_score) continue;

      const { error: updErr } = await service
        .from("application_scores")
        // ONE column. human_adjusted_score and its companions are absent from
        // this object by design — see the module comment.
        .update({ overall_score: next })
        .eq("id", row.id)
        .eq("company_id", jobRow.company_id ?? "");

      if (updErr) {
        throw new Error(
          `cv_score_recompute: update failed for score ${row.id}: ${updErr.message}`,
        );
      }
      changed++;
    }

    if (batch.length < PAGE) break;
  }

  console.log(
    `[cv_score_recompute] job ${jobId}: examined ${seen}, rewrote ${changed}`,
  );
}

/** Pull `{dimension, score}` out of the stored jsonb, ignoring anything else. */
function normaliseDimensions(
  raw: unknown,
): { dimension: string; score: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { dimension: string; score: number }[] = [];
  for (const entry of raw) {
    const d = entry as { dimension?: unknown; score?: unknown };
    if (typeof d?.dimension !== "string") continue;
    if (typeof d?.score !== "number" || !Number.isFinite(d.score)) continue;
    out.push({ dimension: d.dimension, score: d.score });
  }
  return out;
}
