import "server-only";
import { JOB_TYPES, LEASE_TIMEOUT_MS } from "@/lib/jobs-queue";
import {
  QUEUE_STATUSES,
  type QueueHealth,
  type QueueJob,
  type QueueStatus,
} from "@/lib/queue-health-types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * A read-only health snapshot of background_jobs, for the super-admin view.
 *
 * ── Why this is not a SELECT * ───────────────────────────────
 *
 * `succeeded` grows without bound — every CV scored, every email sent, every
 * transcript — while the statuses an operator can act on stay small. So the
 * two are read completely differently, and no query here can return more than
 * ROW_CAP rows however large the table gets:
 *
 *   queued / running / failed / dead
 *       One request each, capped at ROW_CAP rows, with `count=exact` so the
 *       TRUE total arrives in the Content-Range header even when only a page
 *       of rows comes back. That single header is what makes a bounded query
 *       able to report an unbounded number honestly.
 *
 *   succeeded
 *       Never fetched as rows. One HEAD per type with `count=estimated`, which
 *       uses the planner's estimate rather than counting every row — the whole
 *       point being that this is the column nobody acts on and the one that
 *       would be expensive to count exactly.
 *
 * PostgREST aggregates (`select=type,status,count()`) would collapse this into
 * one query and are DISABLED on this project — verified against the live API,
 * which answers PGRST123 "Use of aggregate functions is not allowed". If they
 * are ever enabled, the four capped reads below collapse into one GROUP BY and
 * this comment is the reason to go and do it.
 *
 * ── Indexes this assumes ─────────────────────────────────────
 *
 * Every filter below is on `status`, `type`, `created_at` or `locked_at`. With
 * an index on (status) and (status, created_at) these are index scans; without
 * one they are sequential scans of the whole table, which is exactly what this
 * file is trying to avoid. See the report for the DDL — index existence cannot
 * be checked through PostgREST.
 */

/** Nothing here ever returns more than this many rows. */
const ROW_CAP = 200;

/**
 * Types whose presence means the worker's own scheduler is alive.
 *
 * All three are self-scheduled on the same 24h cadence, so any one of them
 * appearing proves the tick ran. Reading the newest across all three rather
 * than one makes the signal survive a single sweep being paused or failing.
 */
const MAINTENANCE_TYPES = [
  JOB_TYPES.INTERVIEW_PURGE,
  JOB_TYPES.CV_PURGE,
  JOB_TYPES.QUEUE_SWEEP,
];

/** The known types, in the order they run in a candidate's lifecycle. */
export const QUEUE_TYPES: readonly string[] = [
  JOB_TYPES.AI_CV_SCORE,
  JOB_TYPES.SEND_MESSAGE,
  JOB_TYPES.INTERVIEW_REMINDER,
  JOB_TYPES.INTERVIEW_EXPIRY,
  JOB_TYPES.TRANSCRIBE,
  JOB_TYPES.AI_SCORECARD,
  JOB_TYPES.CALENDAR_SYNC,
  JOB_TYPES.INTERVIEW_PURGE,
  JOB_TYPES.CV_PURGE,
  JOB_TYPES.QUEUE_SWEEP,
];

/**
 * Payload keys this view is allowed to render.
 *
 * Checked against every payload in the live table before writing this: the
 * only values present are UUIDs (`applicationId`, `answerId`, `sessionId`) and
 * one enum-like string (`event: "application_received"`). No names, no emails,
 * no free text — so nothing needed redacting today.
 *
 * It is an ALLOWLIST rather than a denylist because that judgement is about
 * today's payloads. A handler added next year could put a candidate's name in
 * one, and a denylist would leak it to this screen the day it shipped; an
 * allowlist renders "1 more field" instead and stays quiet until someone
 * decides otherwise.
 */
const SAFE_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "applicationId",
  "answerId",
  "sessionId",
  "event",
]);

function safePayload(raw: unknown): {
  pairs: { key: string; value: string }[];
  hasUnknown: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { pairs: [], hasUnknown: false };
  }
  const pairs: { key: string; value: string }[] = [];
  let hasUnknown = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) {
      hasUnknown = true;
      continue;
    }
    // Scalars only. An allowlisted key holding an object would still be
    // stringified into something unreviewed, so it is treated as unknown.
    if (typeof value === "string" || typeof value === "number") {
      pairs.push({ key, value: String(value).slice(0, 80) });
    } else {
      hasUnknown = true;
    }
  }
  return { pairs, hasUnknown };
}

type Service = ReturnType<typeof createServiceClient>;

const SELECT =
  "id, type, status, attempts, max_attempts, last_error, created_at, run_after, locked_at, company_id, payload";

type RawJob = {
  id: string;
  type: string | null;
  status: string | null;
  attempts: number | null;
  max_attempts: number | null;
  last_error: string | null;
  created_at: string;
  run_after: string | null;
  locked_at: string | null;
  company_id: string | null;
  payload: unknown;
};

function toJob(r: RawJob, names: Map<string, string>): QueueJob {
  const { pairs, hasUnknown } = safePayload(r.payload);
  return {
    id: r.id,
    type: r.type ?? "unknown",
    status: r.status ?? "unknown",
    attempts: r.attempts ?? 0,
    maxAttempts: r.max_attempts ?? 3,
    lastError: r.last_error,
    createdAt: r.created_at,
    runAfter: r.run_after,
    lockedAt: r.locked_at,
    companyId: r.company_id,
    companyName: r.company_id ? (names.get(r.company_id) ?? null) : null,
    payload: pairs,
    payloadHasUnknown: hasUnknown,
  };
}

/** One capped page of a status, plus that status's true total. */
async function readStatus(
  service: Service,
  status: QueueStatus,
): Promise<{ rows: RawJob[]; total: number }> {
  const { data, count } = await service
    .from("background_jobs")
    .select(SELECT, { count: "exact" })
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(ROW_CAP);
  return { rows: (data ?? []) as RawJob[], total: count ?? 0 };
}

export async function readQueueHealth(): Promise<QueueHealth> {
  const service = createServiceClient();
  const staleCutoff = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();

  const [
    queued,
    running,
    failed,
    dead,
    succeededPerType,
    oldest,
    staleCount,
    lastClaim,
    lastMaintenance,
  ] = await Promise.all([
    readStatus(service, "queued"),
    readStatus(service, "running"),
    readStatus(service, "failed"),
    readStatus(service, "dead"),
    // HEAD-only, planner estimate: the unbounded column, never counted row by
    // row and never fetched.
    Promise.all(
      QUEUE_TYPES.map(async (type) => {
        const { count } = await service
          .from("background_jobs")
          .select("id", { count: "estimated", head: true })
          .eq("status", "succeeded")
          .eq("type", type);
        return [type, count ?? 0] as const;
      }),
    ),
    service
      .from("background_jobs")
      .select("created_at, type")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1),
    // Authoritative regardless of ROW_CAP — the stale list below may be a page,
    // this number never is.
    service
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running")
      .lt("locked_at", staleCutoff),
    service
      .from("background_jobs")
      .select("locked_at")
      .not("locked_at", "is", null)
      .order("locked_at", { ascending: false })
      .limit(1),
    service
      .from("background_jobs")
      .select("created_at")
      .in("type", MAINTENANCE_TYPES)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  // Company names for whatever landed in the two detail lists. Bounded by
  // ROW_CAP * 2 ids, de-duplicated, and skipped entirely when there are none.
  const ids = [
    ...new Set(
      [...dead.rows, ...running.rows]
        .map((r) => r.company_id)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await service
      .from("companies")
      .select("id, name")
      .in("id", ids.slice(0, 400));
    for (const c of (data ?? []) as { id: string; name: string | null }[]) {
      names.set(c.id, c.name ?? "");
    }
  }

  const counts: Record<string, Record<QueueStatus, number>> = {};
  const blank = (): Record<QueueStatus, number> => ({
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  });
  for (const type of QUEUE_TYPES) counts[type] = blank();

  for (const [type, n] of succeededPerType) {
    counts[type] ??= blank();
    counts[type].succeeded = n;
  }
  for (const [status, page] of [
    ["queued", queued],
    ["running", running],
    ["failed", failed],
    ["dead", dead],
  ] as const) {
    for (const r of page.rows) {
      const type = r.type ?? "unknown";
      counts[type] ??= blank();
      counts[type][status] += 1;
    }
  }

  const totals: Record<QueueStatus, number> = {
    queued: queued.total,
    running: running.total,
    succeeded: succeededPerType.reduce((sum, [, n]) => sum + n, 0),
    failed: failed.total,
    dead: dead.total,
  };

  const oldestRow = ((oldest.data ?? []) as { created_at: string; type: string }[])[0];
  const claimRow = ((lastClaim.data ?? []) as { locked_at: string }[])[0];
  const maintRow = ((lastMaintenance.data ?? []) as { created_at: string }[])[0];

  return {
    counts,
    totals,
    capped: {
      queued: queued.total > ROW_CAP,
      running: running.total > ROW_CAP,
      failed: failed.total > ROW_CAP,
      dead: dead.total > ROW_CAP,
    },
    dead: dead.rows.map((r) => toJob(r, names)),
    stale: running.rows
      .filter((r) => r.locked_at !== null && r.locked_at < staleCutoff)
      .map((r) => toJob(r, names)),
    staleTotal: staleCount.count ?? 0,
    oldestQueued: oldestRow
      ? { at: oldestRow.created_at, type: oldestRow.type }
      : null,
    lastClaimAt: claimRow?.locked_at ?? null,
    lastMaintenanceAt: maintRow?.created_at ?? null,
    leaseTimeoutMs: LEASE_TIMEOUT_MS,
    rowCap: ROW_CAP,
  };
}

export { QUEUE_STATUSES };
export type { QueueHealth, QueueJob, QueueStatus };
