import { CV_WEIGHT_DEFAULT } from "@/lib/weights";

/**
 * What one recorded answer is marked against.
 *
 * ── The frozen scheme ────────────────────────────────────────
 *
 * Since migration 028 a session carries `scoring_snapshot`: per question, the
 * competency, rubric and weight as they stood at invite. That is the marking
 * scheme the candidate was actually assessed under, and when it exists nothing
 * else is consulted - not the live interview_questions rows, which every job
 * save deletes and reinserts.
 *
 * ── Legacy sessions, and the rule that replaced position fallback ────
 *
 * A session invited before 028 has no scoring snapshot. For it:
 *   · the question TEXT still comes from questions_snapshot (frozen) - never
 *     from a live row;
 *   · the snapshot's question id is matched against the live rows. Found →
 *     that row's competency, rubric and weight apply (same id means the job
 *     has not been re-saved since the invite, so it is the same question);
 *   · NOT found → competency null, rubric null, weight Normal. Nothing is
 *     borrowed from whatever question now sits at the same position. The
 *     model then scores the transcript against the question text and the
 *     generic bands only - a neutral, no-rubric assessment, which is the
 *     honest one when the rubric that applied cannot be recovered. The
 *     review page shows no competency label for that answer, and the rollup
 *     treats it as one Normal-weight vote.
 *
 * The position fallback this replaced is why AI-6 exists: it could mark answer
 * 2 with question 3's rubric after a reorder. It is gone for every path.
 *
 * Pure. Tested in question-meta.test.ts.
 */

export type ScoringSnapshotEntry = {
  position: number;
  question_id: string | null;
  competency: string | null;
  rubric: string | null;
  weight: number | null;
};

export type SnapshotQuestion = {
  id?: string;
  position?: number;
  question?: string | null;
};

export type LiveQuestion = {
  id: string;
  position: number;
  question: string | null;
  competency: string | null;
  rubric: string | null;
  weight: number | null;
};

export type QuestionMeta = {
  questionText: string;
  competency: string | null;
  rubric: string | null;
  weight: number;
  /** Where the marking scheme came from, for the log and for tests. */
  source: "scoring_snapshot" | "live_by_id" | "none";
};

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function weightOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : CV_WEIGHT_DEFAULT;
}

/** Shape-check the stored jsonb; anything unrecognisable is left out. */
export function readScoringSnapshot(raw: unknown): ScoringSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ScoringSnapshotEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.position !== "number") continue;
    out.push({
      position: e.position,
      question_id: typeof e.question_id === "string" ? e.question_id : null,
      competency: text(e.competency) || null,
      rubric: text(e.rubric) || null,
      weight: typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : null,
    });
  }
  return out;
}

export function resolveQuestionMeta(
  answer: { position: number; question_text: string | null },
  questionsSnapshot: SnapshotQuestion[],
  scoringSnapshot: ScoringSnapshotEntry[] | null,
  live: LiveQuestion[],
): QuestionMeta {
  const snap = questionsSnapshot.find((q) => q.position === answer.position);
  // Snapshot first, then the answer's own snapshotted text, then nothing. The
  // live row is NOT a source of question text: scoring against the wrong
  // question is the worst failure available here.
  const questionText = text(snap?.question) || text(answer.question_text);

  if (scoringSnapshot && scoringSnapshot.length > 0) {
    const frozen =
      scoringSnapshot.find((s) => s.position === answer.position) ??
      (snap?.id ? scoringSnapshot.find((s) => s.question_id === snap.id) : undefined);
    if (frozen) {
      return {
        questionText,
        competency: frozen.competency,
        rubric: frozen.rubric,
        weight: weightOf(frozen.weight),
        source: "scoring_snapshot",
      };
    }
    // A snapshot that does not cover this position is treated like no
    // snapshot at all for this answer - fall through to the legacy rule.
  }

  const byId = snap?.id ? live.find((q) => q.id === snap.id) : undefined;
  if (byId) {
    return {
      questionText,
      competency: text(byId.competency) || null,
      rubric: text(byId.rubric) || null,
      weight: weightOf(byId.weight),
      source: "live_by_id",
    };
  }

  return {
    questionText,
    competency: null,
    rubric: null,
    weight: CV_WEIGHT_DEFAULT,
    source: "none",
  };
}
