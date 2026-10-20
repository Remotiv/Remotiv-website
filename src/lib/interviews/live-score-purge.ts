import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Retention for live interview scores (migration 042): when a live session's
 * content is purged, its scores keep the NUMBERS and lose the WORDS.
 *
 * Cleared from every question in live_interview_scores.questions: the
 * rationale (it describes what the candidate said) and the quotes (they ARE
 * what the candidate said). Kept: every score, status, reason, confidence,
 * weight and count, and the overall. The hiring record survives, as it does
 * for the turns (purge.ts); the candidate's words do not.
 *
 * Idempotent and resumable like the rest of the purge: a row is touched only
 * while one of its questions still holds a rationale or a quote, so a second
 * run does nothing. The write is a compare-and-set on `rev`; a row a scorer
 * changed in between is left for the next run, which clears it then. The
 * scorer itself never writes words for a purged session (live-scoring.ts).
 *
 * No `server-only` here: purge.ts already is, and this stays light enough for
 * its tests to load without the scorer.
 */

type Service = ReturnType<typeof createServiceClient>;

type ScoreQuestion = { rationale?: string | null; quotes?: unknown[]; content_purged?: boolean };

const holdsWords = (q: ScoreQuestion) =>
  (q.rationale ?? null) !== null || (Array.isArray(q.quotes) && q.quotes.length > 0);

/** Clear the words from these due sessions' live scores. Returns how many rows were cleared. */
export async function purgeLiveScoreWords(service: Service, sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const { data, error } = await service
    .from("live_interview_scores")
    .select("session_id, questions, rev")
    .in("session_id", sessionIds);
  if (error) throw new Error(`purge: live scores: ${error.message}`);
  let cleared = 0;
  for (const row of (data ?? []) as {
    session_id: string;
    questions: ScoreQuestion[];
    rev: number;
  }[]) {
    if (!Array.isArray(row.questions) || !row.questions.some(holdsWords)) continue;
    const questions = row.questions.map((q) =>
      holdsWords(q) ? { ...q, rationale: null, quotes: [], content_purged: true } : q,
    );
    const { data: landed, error: e } = await service
      .from("live_interview_scores")
      .update({ questions, rev: row.rev + 1, updated_at: new Date().toISOString() })
      .eq("session_id", row.session_id)
      .eq("rev", row.rev)
      .select("session_id");
    if (e) throw new Error(`purge: clear live score words: ${e.message}`);
    if (((landed ?? []) as unknown[]).length > 0) cleared += 1;
  }
  return cleared;
}
