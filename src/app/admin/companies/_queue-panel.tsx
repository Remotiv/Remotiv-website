"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Hourglass,
  RefreshCcw,
  Activity,
  HeartPulse,
  WifiOff,
} from "lucide-react";
import {
  QUEUE_STATUSES,
  WORKER_TICK_STALE_MS,
  WORKER_TICK_WARN_MS,
  type QueueHealth,
  type QueueJob,
  type QueueStatus,
} from "@/lib/queue-health-types";
import { retryDeadJob, retryDeadJobsOfType } from "./actions";

/**
 * Background queue health, across every company.
 *
 * Visual language is the admin console's own — gray scale, remotiv-purple
 * accent, the same rounded-2xl white card as the company list. Nothing is
 * imported from the company product: that segment carries a 0.82 zoom and its
 * own --ai-* token set, and pulling either in here would look like a foreign
 * object bolted onto the page.
 */

const STATUS_STYLE: Record<QueueStatus, { chip: string; dot: string; label: string }> = {
  queued:    { chip: "bg-sky-50 text-sky-700",     dot: "bg-sky-500",    label: "Queued" },
  running:   { chip: "bg-amber-50 text-amber-700", dot: "bg-amber-500",  label: "Running" },
  succeeded: { chip: "bg-green-50 text-green-700", dot: "bg-green-500",  label: "Succeeded" },
  failed:    { chip: "bg-orange-50 text-orange-700", dot: "bg-orange-500", label: "Failed" },
  dead:      { chip: "bg-red-50 text-red-700",     dot: "bg-red-500",    label: "Dead" },
};

const TYPE_LABEL: Record<string, string> = {
  ai_cv_score: "CV scoring",
  send_message: "Candidate email",
  interview_reminder: "Interview reminder",
  interview_expiry: "Interview expiry",
  transcribe: "Transcription",
  ai_scorecard: "Interview scoring",
  calendar_sync: "Calendar sync",
  interview_purge: "Interview retention",
  cv_purge: "CV retention",
  queue_sweep: "Queue row retention",
};

function label(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/** "3 days", "4h", "12m" — coarse on purpose; this is an age, not a clock. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function QueuePanel({ health }: { health: QueueHealth }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ success: boolean; error?: string; data?: { retried: number } }>) => {
    startTransition(async () => {
      const res = await fn();
      setNote(
        res.success
          ? { ok: true, text: `${res.data?.retried ?? 0} job(s) back on the queue.` }
          : { ok: false, text: res.error ?? "That didn't work." },
      );
      router.refresh();
    });
  };

  const typesWithDead = [...new Set(health.dead.map((j) => j.type))];
  const rows = Object.keys(health.counts).filter((t) =>
    QUEUE_STATUSES.some((s) => health.counts[t][s] > 0),
  );

  /*
   * Three liveness questions, answered in order of precision.
   *
   * "Worker last ticked" is the heartbeat the worker writes at the end of EVERY
   * tick, empty or not (migration 035). It is the real liveness signal, at the
   * cadence the worker actually runs. "Last job claimed" measures throughput
   * and is silent on an idle queue - it used to be the liveness tile and read
   * "never" in amber on a perfectly healthy idle system, because every terminal
   * transition nulls locked_at. "Worker self-scheduled" is the 24h maintenance
   * cadence, kept as the coarse backstop for the period before 035 is applied.
   */
  const tickAgeMs = health.lastTickAt ? Date.now() - new Date(health.lastTickAt).getTime() : null;
  const tickTone: "ok" | "warn" | "bad" =
    tickAgeMs === null || tickAgeMs > WORKER_TICK_STALE_MS
      ? "bad"
      : tickAgeMs > WORKER_TICK_WARN_MS
        ? "warn"
        : "ok";
  const maintenanceStale =
    !health.lastMaintenanceAt ||
    Date.now() - new Date(health.lastMaintenanceAt).getTime() > 36 * 3_600_000;

  /*
   * A failed read is not an empty queue. When any read failed the figures
   * below cannot be trusted, so every tile says so instead of showing a number
   * that would read as "all clear". Only the source CATEGORY is shown; the
   * database message stayed in the server log where it belongs.
   */
  const degraded = health.readErrors.length > 0;
  const unavailable = "unavailable";

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400">Operations · all companies</p>
          <h2 className="font-heading text-xl font-bold text-gray-900">
            Background queue
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {QUEUE_STATUSES.map((s) => (
            <span
              key={s}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${STATUS_STYLE[s].chip}`}
            >
              <span className={`size-1.5 rounded-full ${STATUS_STYLE[s].dot}`} />
              {STATUS_STYLE[s].label}
              <b className="font-bold tabular-nums">
                {health.totals[s].toLocaleString("en-GB")}
                {s === "succeeded" && "*"}
              </b>
            </span>
          ))}
        </div>
      </div>

      {note && (
        <p
          className={`mb-3 rounded-xl px-4 py-2.5 text-sm font-semibold ${
            note.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          {note.text}
        </p>
      )}

      {degraded && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0 text-red-600" strokeWidth={2} />
          <div className="text-sm">
            <p className="m-0 font-bold text-red-800">Health data could not be loaded.</p>
            <p className="m-0 mt-0.5 text-red-700">
              {health.readErrors.length} of the reads behind this panel failed
              {health.readErrors.length > 0 &&
                ` (${health.readErrors.map((e) => e.source).join(", ")})`}
              . The figures below are not a picture of the queue. Details are in the
              server log.
            </p>
          </div>
        </div>
      )}

      {/* ── The signals a stuck queue shows and a healthy one doesn't ── */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Signal
          icon={<HeartPulse className="size-4" strokeWidth={2} />}
          title="Worker last ticked"
          value={degraded ? unavailable : ago(health.lastTickAt)}
          sub={
            health.lastTickAt
              ? `Heartbeat written at the end of every tick, empty or not. Amber past ${Math.round(WORKER_TICK_WARN_MS / 60_000)} minutes, red past ${Math.round(WORKER_TICK_STALE_MS / 60_000)}.`
              : "No heartbeat yet. Either migration 035 is not applied or the worker has not ticked since it was."
          }
          tone={degraded ? "muted" : tickTone}
        />
        <Signal
          icon={<Hourglass className="size-4" strokeWidth={2} />}
          title="Oldest queued job"
          value={degraded ? unavailable : health.oldestQueued ? ago(health.oldestQueued.at) : "nothing queued"}
          sub={
            health.oldestQueued
              ? `${label(health.oldestQueued.type)} · waiting since ${stamp(health.oldestQueued.at)}`
              : "A draining queue and a stopped one look identical without this."
          }
          tone={degraded ? "muted" : health.oldestQueued ? "warn" : "ok"}
        />
        <Signal
          icon={<AlertTriangle className="size-4" strokeWidth={2} />}
          title="Stuck running"
          value={degraded ? unavailable : String(health.staleTotal)}
          sub={`Leased longer than ${Math.round(health.leaseTimeoutMs / 60_000)} minutes. The worker reclaims these on its next tick.`}
          tone={degraded ? "muted" : health.staleTotal > 0 ? "warn" : "ok"}
        />
        <Signal
          icon={<Activity className="size-4" strokeWidth={2} />}
          title="Last job claimed"
          value={degraded ? unavailable : ago(health.lastClaimAt)}
          sub="Throughput, not liveness: this is silent while the queue is empty, and terminal transitions clear it. Liveness is the heartbeat tile."
          tone={degraded ? "muted" : "ok"}
        />
        <Signal
          icon={<Clock className="size-4" strokeWidth={2} />}
          title="Worker self-scheduled"
          value={degraded ? unavailable : ago(health.lastMaintenanceAt)}
          sub="The 24h retention sweep the worker queues for itself. The coarse backstop for the period before the heartbeat existed."
          tone={degraded ? "muted" : maintenanceStale ? "warn" : "ok"}
        />
      </div>

      {/* ── Grid ── */}
      <div className="overflow-hidden rounded-2xl border border-black/[0.05] bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60 text-left">
                <th className="px-5 py-3 text-xs font-bold uppercase tracking-wide text-gray-400">
                  Job type
                </th>
                {QUEUE_STATUSES.map((s) => (
                  <th
                    key={s}
                    className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wide text-gray-400"
                  >
                    {STATUS_STYLE[s].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-500">
                    No jobs have ever run.
                  </td>
                </tr>
              )}
              {rows.map((type) => (
                <tr key={type} className="border-b border-gray-50 last:border-b-0">
                  <td className="px-5 py-3 font-semibold text-gray-800">
                    {label(type)}
                    <span className="ml-2 font-mono text-[11px] font-normal text-gray-400">
                      {type}
                    </span>
                  </td>
                  {QUEUE_STATUSES.map((s) => {
                    const n = health.counts[type][s];
                    return (
                      <td
                        key={s}
                        className={`px-4 py-3 text-right tabular-nums ${
                          n === 0
                            ? "text-gray-300"
                            : s === "dead"
                              ? "font-bold text-red-600"
                              : "text-gray-700"
                        }`}
                      >
                        {n.toLocaleString("en-GB")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-gray-100 bg-gray-50/60 px-5 py-2.5 text-[11.5px] leading-relaxed text-gray-500">
          *Succeeded is a planner estimate, never a row count — it is the column
          that grows without bound and the one nobody acts on. Every other
          column is exact.
          {Object.values(health.capped).some(Boolean) &&
            ` Some statuses hold more than ${health.rowCap} jobs; their per-type figures are a floor, and the totals above remain exact.`}
        </p>
      </div>

      {/* ── Stuck running ── */}
      {health.stale.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/70 px-5 py-3">
            <AlertTriangle className="size-4 text-amber-600" strokeWidth={2} />
            <h3 className="text-sm font-bold text-amber-800">
              Leased longer than the lease window ({health.stale.length})
            </h3>
            <span className="ml-auto text-xs text-amber-700">
              Left behind by a crashed invocation. Reclaimed automatically on the
              next worker tick — no action needed unless it persists.
            </span>
          </div>
          <ul className="divide-y divide-gray-50">
            {health.stale.map((j) => (
              <li key={j.id} className="px-5 py-3">
                <JobLine job={j} whenLabel="leased" when={j.lockedAt} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Dead letter ── */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-black/[0.05] bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-5 py-3">
          <h3 className="text-sm font-bold text-gray-900">
            Dead letter ({health.totals.dead})
          </h3>
          <span className="text-xs text-gray-500">
            Out of attempts. Nothing retries these on its own.
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {typesWithDead.map((type) => (
              <button
                key={type}
                type="button"
                disabled={pending}
                onClick={() => run(() => retryDeadJobsOfType(type))}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCcw className="size-3.5" strokeWidth={2} />
                Retry all {label(type).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {health.dead.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-gray-500">
            <CheckCircle className="size-4 text-green-500" strokeWidth={2} />
            Nothing in the dead letter queue.
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {health.dead.map((j) => (
              <li key={j.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <JobLine job={j} whenLabel="queued" when={j.createdAt} />
                    {j.lastError && (
                      <p className="mt-1.5 break-words rounded-lg bg-red-50 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-red-700">
                        {j.lastError}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => retryDeadJob(j.id))}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-remotiv-purple px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <RefreshCcw className="size-3.5" strokeWidth={2} />
                    Retry
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {health.capped.dead && (
          <p className="border-t border-gray-100 bg-gray-50/60 px-5 py-2.5 text-[11.5px] text-gray-500">
            Showing the {health.rowCap} most recent of {health.totals.dead}. Retry
            all of a type clears the rest.
          </p>
        )}
      </div>
    </section>
  );
}

function Signal({
  icon,
  title,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub: string;
  /**
   * ok: healthy. warn: worth a look. bad: the worker is not ticking. muted: the
   * read behind this tile failed, so the value is "unavailable" and must not
   * read as a healthy figure.
   */
  tone: "ok" | "warn" | "bad" | "muted";
}) {
  const titleTone = {
    ok: "text-gray-400",
    warn: "text-amber-600",
    bad: "text-red-600",
    muted: "text-gray-300",
  }[tone];
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-white p-4 shadow-sm">
      <div
        className={`mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide ${titleTone}`}
      >
        {icon}
        {title}
      </div>
      <p
        className={`m-0 font-heading text-lg font-bold ${
          tone === "muted" ? "text-gray-300 italic" : tone === "bad" ? "text-red-700" : "text-gray-900"
        }`}
      >
        {value}
      </p>
      <p className="m-0 mt-1 text-[11.5px] leading-relaxed text-gray-500">{sub}</p>
    </div>
  );
}

function JobLine({
  job,
  whenLabel,
  when,
}: {
  job: QueueJob;
  whenLabel: string;
  when: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <span className="font-semibold text-gray-800">{label(job.type)}</span>
        <span className="text-gray-300">·</span>
        <span className="text-gray-600">
          {job.companyName || (job.companyId ? "Unknown company" : "Workspace-wide")}
        </span>
        <span className="text-gray-300">·</span>
        <span className="text-gray-500">
          {job.attempts}/{job.maxAttempts} attempts
        </span>
        <span className="text-gray-300">·</span>
        <span className="text-gray-500">
          {whenLabel} {stamp(when)} ({ago(when)})
        </span>
      </div>
      {/* Ids only. See SAFE_PAYLOAD_KEYS in lib/queue-health.ts — the payload is
          filtered server-side through an allowlist, so an unrecognised key is
          counted here rather than printed. */}
      {(job.payload.length > 0 || job.payloadHasUnknown) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {job.payload.map((p) => (
            <span
              key={p.key}
              className="rounded bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-500"
            >
              {p.key}: {p.value}
            </span>
          ))}
          {job.payloadHasUnknown && (
            <span className="rounded bg-gray-50 px-1.5 py-0.5 text-[11px] italic text-gray-400">
              other fields hidden
            </span>
          )}
        </div>
      )}
    </>
  );
}
