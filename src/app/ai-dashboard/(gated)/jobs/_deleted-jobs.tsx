"use client";

import { ArrowLeft, RotateCcw, Trash } from "lucide-react";
import type { DeletedCompanyJobRow } from "@/app/ai-dashboard/lib/job-types";

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_120px_110px_150px_120px] items-center gap-4 px-[18px]";

function deletedAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

/**
 * The company-side recovery view.
 *
 * Takes its rows as a prop from a separate server action rather than filtering
 * the live list: the live list is filtered `deleted_at IS NULL` server-side,
 * and feeding tombstones into it would put them through its tab counts and
 * hero aggregates.
 *
 * Restore is the only action offered. Every other control a live job has —
 * edit, duplicate, close, archive, delete — is absent by construction rather
 * than by being disabled, because a tombstone must not be mutable at all.
 */
export function DeletedJobsPanel({
  jobs,
  canRestore,
  busyId,
  onRestore,
  onBack,
}: {
  jobs: DeletedCompanyJobRow[];
  canRestore: boolean;
  busyId: string | null;
  onRestore: (job: DeletedCompanyJobRow) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[630px]:flex-row min-[630px]:items-end min-[630px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Deleted jobs
          </h1>
          <p className="mt-2.5 max-w-[520px] text-[14.5px] leading-relaxed text-[var(--ai-t2)]">
            Deleting a job hides it from your workspace and from remotiv.work. Restoring one puts it
            back exactly as it was, applicants included.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
        >
          <ArrowLeft className="size-[15px]" strokeWidth={1.9} />
          Back to jobs
        </button>
      </div>

      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
        {jobs.length === 0 && (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-[18px] flex size-16 items-center justify-center rounded-[18px] bg-[var(--ai-inset)] text-[var(--ai-t3)]">
              <Trash className="size-7" strokeWidth={1.7} />
            </div>
            <h3 className="font-heading text-[19px] font-extrabold tracking-[-0.02em]">
              Nothing deleted
            </h3>
            <p className="mt-1.5 max-w-[340px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              Jobs you delete land here, so a role removed by mistake can be put back.
            </p>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="min-[1049px]:hidden">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="border-b border-[var(--ai-line)] px-[18px] py-4 last:border-b-0"
              >
                <p className="font-semibold text-[14.5px] text-[var(--ai-t1)]">{job.title}</p>
                <p className="mt-1 text-[12.5px] text-[var(--ai-t3)]">
                  {job.location || "—"} · deleted {deletedAgo(job.deleted_at).toLowerCase()}
                </p>
                <p className="mt-1 text-[12.5px] text-[var(--ai-t3)]">
                  {job.applicant_count} applicant{job.applicant_count === 1 ? "" : "s"}
                </p>
                {canRestore && (
                  <button
                    type="button"
                    onClick={() => onRestore(job)}
                    disabled={busyId === job.id}
                    className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-2 text-[13px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:opacity-50"
                  >
                    <RotateCcw className="size-[14px]" strokeWidth={2} />
                    {busyId === job.id ? "Restoring…" : "Restore"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="hidden overflow-x-auto min-[1049px]:block">
            <div className="min-w-[760px]">
              <div
                className={`${ROW_GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] py-[11px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]`}
              >
                <span>Job</span>
                <span>Status</span>
                <span>Applicants</span>
                <span>Deleted</span>
                <span />
              </div>

              {jobs.map((job) => (
                <div
                  key={job.id}
                  className={`${ROW_GRID} border-b border-[var(--ai-line)] py-[14px] last:border-b-0`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[14px] text-[var(--ai-t1)]">
                      {job.title}
                    </p>
                    <p className="mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
                      {job.location || "—"}
                    </p>
                  </div>
                  <span className="text-[13px] text-[var(--ai-t3)]">{job.status || "—"}</span>
                  <span className="text-[13px] text-[var(--ai-t2)]">{job.applicant_count}</span>
                  <span className="text-[13px] text-[var(--ai-t3)]">
                    {deletedAgo(job.deleted_at)}
                  </span>
                  <div className="flex justify-end">
                    {canRestore && (
                      <button
                        type="button"
                        onClick={() => onRestore(job)}
                        disabled={busyId === job.id}
                        className="inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-2 text-[13px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:opacity-50"
                      >
                        <RotateCcw className="size-[14px]" strokeWidth={2} />
                        {busyId === job.id ? "Restoring…" : "Restore"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
