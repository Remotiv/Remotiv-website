import { NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { WORKER_TICK_STALE_MS } from "@/lib/queue-health-types";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is the background worker alive?
 *
 * ── Why a route, and why unauthenticated ─────────────────────
 *
 * A dead worker cannot raise its own alarm, so the evaluator has to live
 * outside it. This route is that evaluator's read side: an external uptime
 * monitor polls it and pages someone on a non-200. Monitors need a plain GET
 * with no headers, so there is no secret here. What it exposes is one boolean
 * and one age in seconds, and nothing else - no counts, no ids, no errors, no
 * hint of what the queue holds.
 *
 * ── What it reads ────────────────────────────────────────────
 *
 * The single worker_heartbeats row (migration 035), which the worker upserts at
 * the end of every tick INCLUDING an empty one. That is the point: before it,
 * an idle worker and a stopped one wrote the same nothing.
 *
 * ── What it never does ───────────────────────────────────────
 *
 * Write. A public route that mutates on request is an abuse surface, however
 * small, so the retrospective `worker_stale` notification is emitted by the
 * worker itself on recovery (authenticated by CRON_SECRET), not from here.
 *
 *   200  { ok: true,  ageSeconds }   heartbeat within WORKER_TICK_STALE_MS
 *   503  { ok: false, ageSeconds }   heartbeat older than that
 *   503  { ok: false, reason }       no heartbeat row, or the table unreadable
 *                                    (migration 035 not applied, or the
 *                                    database itself is down - both are
 *                                    "not healthy" to a monitor, on purpose)
 */
export async function GET(request: Request) {
  const rl = rateLimit(request, { bucketKey: "health-worker", max: 60 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, reason: "rate_limited" }, { status: 429 });
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("worker_heartbeats")
    .select("last_tick_at")
    .eq("id", "worker")
    .maybeSingle();

  if (error) {
    // Logged server-side with the real message; the monitor gets a category.
    console.error("[health/worker] heartbeat unreadable:", error.message);
    return NextResponse.json({ ok: false, reason: "heartbeat_unreadable" }, { status: 503 });
  }

  const row = data as { last_tick_at: string } | null;
  if (!row?.last_tick_at) {
    return NextResponse.json({ ok: false, reason: "no_heartbeat" }, { status: 503 });
  }

  const ageMs = Date.now() - new Date(row.last_tick_at).getTime();
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  const ok = Number.isFinite(ageMs) && ageMs <= WORKER_TICK_STALE_MS;

  return NextResponse.json({ ok, ageSeconds }, { status: ok ? 200 : 503 });
}
