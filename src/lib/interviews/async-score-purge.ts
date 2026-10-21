import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Retention for async interview scorecards: when a session passes its
 * delete_after date, its scores keep the NUMBERS and lose the WORDS, as live
 * scores do (live-score-purge.ts).
 *
 * Cleared from interview_answer_scores: reasoning, evidence, strengths and
 * concerns (each a claim with the candidate's quote; they go together, a claim
 * never outlives its quote) and missing. Cleared from interview_session_scores:
 * the summary and every criterion's quote. Kept: every score, confidence,
 * status, error, count and token figure, the AI's one-line verdict (it never
 * quotes), each criterion and whether it was shown, and every human
 * adjustment, its note included (the hiring company's own record).
 *
 * Enforced in three places, so no path can bring the words back:
 *
 *   purge.ts Phase 1      every run, over every session past delete_after, so
 *                         sessions purged before this existed are cleaned too
 *   interview-scoring.ts  a job for a session past delete_after scores nothing;
 *                         a job that started before it and writes after it
 *                         writes no words, then clears the session again in
 *                         case the purge ran between its check and its write
 *   review.ts             past delete_after the words never leave the server,
 *                         even before the purge has run
 *
 * Idempotent and resumable like the rest of the purge: a row is written only
 * while it still holds words, so a second run makes no writes.
 *
 * No `server-only` here: purge.ts and the scorer already are, and this stays
 * light enough for their tests to load.
 */

type Service = ReturnType<typeof createServiceClient>;

/** What a cleared answer score holds in place of the words. */
export const ANSWER_WORDS_CLEARED = {
  reasoning: null,
  evidence: [],
  strengths: [],
  concerns: [],
  missing: [],
} as const;

/** Past its retention date. Same rule as purge.ts Phase 1 (delete_after <= now). */
export function retentionPassed(deleteAfter: string | null | undefined, nowMs: number): boolean {
  if (typeof deleteAfter !== "string") return false;
  const at = Date.parse(deleteAfter);
  return Number.isFinite(at) && at <= nowMs;
}

const filled = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";

type AnswerWords = {
  answer_id: string;
  reasoning: unknown;
  evidence: unknown;
  strengths: unknown;
  concerns: unknown;
  missing: unknown;
};

const answerHoldsWords = (r: AnswerWords) =>
  [r.reasoning, r.evidence, r.strengths, r.concerns, r.missing].some(filled);

const criteriaQuoted = (criteria: unknown) =>
  Array.isArray(criteria) &&
  criteria.some((c) => c && typeof c === "object" && filled((c as { quote?: unknown }).quote));

/** Every criterion kept, with its quote emptied. */
export function clearCriteriaQuotes(criteria: unknown): unknown {
  if (!Array.isArray(criteria)) return criteria;
  return criteria.map((c) => (c && typeof c === "object" ? { ...c, quote: "" } : c));
}

/** Clear the words from these sessions' async scores. Returns how many rows were cleared. */
export async function purgeAsyncScoreWords(
  service: Service,
  sessionIds: string[],
): Promise<{ answers: number; sessions: number }> {
  const cleared = { answers: 0, sessions: 0 };
  if (sessionIds.length === 0) return cleared;

  const { data: answers, error: aErr } = await service
    .from("interview_answer_scores")
    .select("answer_id, reasoning, evidence, strengths, concerns, missing")
    .in("session_id", sessionIds);
  if (aErr) throw new Error(`purge: async answer scores: ${aErr.message}`);
  for (const row of (answers ?? []) as AnswerWords[]) {
    if (!answerHoldsWords(row)) continue;
    const { error } = await service
      .from("interview_answer_scores")
      .update(ANSWER_WORDS_CLEARED)
      .eq("answer_id", row.answer_id);
    if (error) throw new Error(`purge: clear async answer score words: ${error.message}`);
    cleared.answers += 1;
  }

  const { data: sessions, error: sErr } = await service
    .from("interview_session_scores")
    .select("session_id, summary, criteria")
    .in("session_id", sessionIds);
  if (sErr) throw new Error(`purge: async session scores: ${sErr.message}`);
  for (const row of (sessions ?? []) as {
    session_id: string;
    summary: unknown;
    criteria: unknown;
  }[]) {
    if (!filled(row.summary) && !criteriaQuoted(row.criteria)) continue;
    const { error } = await service
      .from("interview_session_scores")
      .update({ summary: null, criteria: clearCriteriaQuotes(row.criteria) })
      .eq("session_id", row.session_id);
    if (error) throw new Error(`purge: clear async session score words: ${error.message}`);
    cleared.sessions += 1;
  }
  return cleared;
}
