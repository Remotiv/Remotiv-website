import "server-only";
import { retentionPassed } from "@/lib/interviews/async-score-purge";
import {
  type EnqueueTranscribe,
  markTurnFailed,
  queueLiveTranscription,
  settleLiveOutcome,
} from "@/lib/interviews/live-transcribe";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Heal live interview turns stuck `pending` (#15): the live counterpart of
 * transcribe-recovery.ts, which async answers have had since Phase 5.
 *
 * ── Why ──────────────────────────────────────────────────────
 *
 * A candidate turn leaves `pending` only when its transcribe job writes a
 * transcript or marks it failed. If that never happens, nothing else would: the
 * enqueue at ingest failed, the job died before giving up, or the job gave up
 * and its own failure write was refused. The outcome then stays undecided for
 * good (live_outcome.final needs every turn settled), no person is asked to
 * look, and nothing is scored.
 *
 * ── Where and how often ──────────────────────────────────────
 *
 * Inline in the worker tick, beside the async sweep: one small read per tick,
 * job lookups only for the sessions it finds. A write this sweep cannot make is
 * counted and tried again on the next tick.
 *
 * ── The state machine, per candidate turn pending for RECOVERY_AGE_MS ──
 *
 *   no transcribe job for the turn     queue one (queueLiveTranscription,
 *                                      the same path ingest uses)
 *   a job queued or running            live: leave it
 *   only finished jobs                 mark the turn failed: dead, failed, or
 *                                      succeeded without writing, the job will
 *                                      not run again. The outcome is settled,
 *                                      so needs_review is set and a person can
 *                                      retry the turn or leave its question out
 *                                      (live-recovery.ts), never scored as 0.
 *
 * Restarted first attempts and sessions past retention are left alone: the
 * handler deliberately transcribes neither, and they are never scored.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Transcripts, file paths. Turn and session ids and counts only.
 */

type Service = ReturnType<typeof createServiceClient>;

/** How long a turn may sit `pending` before the sweep looks at it. */
export const LIVE_RECOVERY_AGE_MS = 10 * 60_000;
/** Turns examined per tick. */
export const LIVE_RECOVERY_BATCH = 20;
/** What a turn settled by this sweep says. */
export const LIVE_RECOVERY_FAILED_SENTENCE = "Transcription did not finish for this turn.";

export type LiveTurnRecoverySummary = {
  scanned: number;
  queued: number;
  live: number;
  failed: number;
  skipped: number;
  errors: number;
};

export type LiveTurnRecoveryDeps = {
  /** The queue's enqueue; loaded on use by default. */
  enqueue?: EnqueueTranscribe;
  now?: () => number;
  /** Settles a session's outcome after turns are marked; settleLiveOutcome by default. */
  settle?: (service: Service, sessionId: string) => Promise<unknown>;
};

type PendingTurn = { id: string; session_id: string };

export async function runLiveTurnRecovery(
  service: Service,
  deps: LiveTurnRecoveryDeps = {},
): Promise<LiveTurnRecoverySummary> {
  const now = deps.now ?? Date.now;
  const summary: LiveTurnRecoverySummary = {
    scanned: 0,
    queued: 0,
    live: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };

  const { data, error } = await service
    .from("interview_turns")
    .select("id, session_id")
    .eq("speaker", "candidate")
    .eq("transcript_status", "pending")
    .not("media_path", "is", null)
    .is("content_purged_at", null)
    .lt("created_at", new Date(now() - LIVE_RECOVERY_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(LIVE_RECOVERY_BATCH);
  if (error) throw new Error(`live turn recovery: pending read failed (${error.code ?? "db"})`);
  const turns = (data ?? []) as PendingTurn[];
  summary.scanned = turns.length;

  const bySession = new Map<string, PendingTurn[]>();
  for (const t of turns) bySession.set(t.session_id, [...(bySession.get(t.session_id) ?? []), t]);

  for (const [sessionId, mine] of bySession) {
    try {
      const { data: s, error: sErr } = await service
        .from("interview_sessions")
        .select("status, delete_after")
        .eq("id", sessionId)
        .maybeSingle();
      if (sErr) throw new Error("session read failed");
      const session = s as { status: string; delete_after: string | null } | null;
      if (
        !session ||
        session.status === "abandoned" ||
        retentionPassed(session.delete_after, now())
      ) {
        summary.skipped += mine.length;
        continue;
      }

      const { data: jobs, error: jErr } = await service
        .from("background_jobs")
        .select("status, payload")
        .eq("type", "transcribe")
        .eq("payload->>sessionId", sessionId);
      if (jErr) throw new Error("job read failed");
      const rows = (jobs ?? []) as { status: string; payload: { turnId?: string } }[];

      let needsQueue = false;
      let marked = 0;
      for (const t of mine) {
        const forTurn = rows.filter((j) => j.payload?.turnId === t.id);
        if (forTurn.length === 0) {
          needsQueue = true;
        } else if (forTurn.some((j) => j.status === "queued" || j.status === "running")) {
          summary.live += 1;
        } else if (await markTurnFailed(service, t.id, LIVE_RECOVERY_FAILED_SENTENCE)) {
          marked += 1;
          console.warn(
            `[live-turn-recovery] turn ${t.id}: its job finished, still pending; marked failed`,
          );
        }
      }
      summary.failed += marked;

      if (needsQueue) {
        const enqueue =
          deps.enqueue ??
          ((await import("@/lib/jobs-queue")).enqueue as unknown as EnqueueTranscribe);
        const queued = await queueLiveTranscription(service, sessionId, enqueue);
        summary.queued += queued.queued;
        if (queued.failed > 0) {
          summary.errors += queued.failed;
          console.error(
            `[live-turn-recovery] session ${sessionId}: ${queued.failed} turn(s) not queued`,
          );
        }
      }
      if (marked > 0) await (deps.settle ?? settleLiveOutcome)(service, sessionId);
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[live-turn-recovery] session ${sessionId}: not recovered this tick (${(err as Error).message.slice(0, 120)})`,
      );
    }
  }
  return summary;
}
