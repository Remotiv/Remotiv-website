/**
 * The CV re-weighting job on a scorecard whose words the CV purge cleared (#91).
 *
 *   node --test src/lib/ai/cv-recompute-purged.test.ts
 *
 * handleCvRecompute reads only each dimension's name, score and unstated flag
 * (cv-recompute.ts normaliseDimensions), and the purge keeps exactly those. So
 * re-weighting a purged card must write the same overall as re-weighting the
 * card before the purge. This drives the real handler twice, once per card,
 * against a responder fake, and compares the overall each run writes.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleCvRecompute } = await import("./cv-recompute.ts");
const { clearDimensionWords } = await import("../cv-purge.ts");

const DIMENSIONS = [
  { dimension: "requirements_match", score: 70, reasoning: "Meets most", quote: "Led a team of 6" },
  { dimension: "experience_depth", score: 90, reasoning: "Eight years", quote: "2016-2024" },
  {
    dimension: "domain_relevance",
    score: 40,
    reasoning: "B2B",
    quote: "B2B sales",
    unstated: true,
  },
  { dimension: "responsibilities_fit", score: 60, reasoning: "Close", quote: "Owned pipeline" },
];

/** One recompute run over one card; returns the overall it wrote, or null when it wrote none. */
async function recompute(dimensionScores: unknown): Promise<number | null> {
  const service = fakeService((table: string, calls: unknown[][]) => {
    if (table === "jobs") {
      return {
        data: {
          id: "job-1",
          company_id: "company-1",
          cv_weight_requirements: 3,
          cv_weight_experience: 1,
          cv_weight_domain: 1,
          cv_weight_responsibilities: 1,
        },
        error: null,
      };
    }
    if (calls.some((c) => c[0] === "update")) return { data: null, error: null };
    return {
      data: [{ id: "score-1", overall_score: 1, dimension_scores: dimensionScores }],
      error: null,
    };
  });
  (globalThis as { __cvScoringServiceForTests?: () => unknown }).__cvScoringServiceForTests = () =>
    service;
  const log = console.log;
  console.log = () => {};
  try {
    await handleCvRecompute({ id: "j-recompute", payload: { jobId: "job-1" } });
  } finally {
    console.log = log;
  }
  const update = service.queries.find(
    (q: { table: string; calls: unknown[][] }) =>
      q.table === "application_scores" && q.calls.some((c) => c[0] === "update"),
  );
  if (!update) return null;
  const values = update.calls.find((c: unknown[]) => c[0] === "update")[1] as {
    overall_score: number;
  };
  return values.overall_score;
}

test("#91: re-weighting a purged card writes the same overall as re-weighting it before the purge", async () => {
  const before = await recompute(DIMENSIONS);
  const after = await recompute(clearDimensionWords(DIMENSIONS));
  assert.equal(typeof before, "number", "the unpurged card was re-weighted");
  assert.notEqual(before, 1, "the weights moved the overall, so the comparison means something");
  assert.equal(after, before);
});

test("#91: the purge keeps every field the recompute reads, including unstated", () => {
  const cleared = clearDimensionWords(DIMENSIONS) as Record<string, unknown>[];
  assert.deepEqual(
    cleared.map(({ dimension, score, unstated }) => ({ dimension, score, unstated })),
    DIMENSIONS.map(({ dimension, score, unstated }) => ({ dimension, score, unstated })),
  );
});
