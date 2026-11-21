/**
 * "Deletion pending" (#16): an applicant whose delete has started (every link
 * of theirs is closed) and not finished. The list row carries a pill; the
 * panel carries this banner with "Finish deletion" and, only once Google
 * failed to remove an event while connected (recorded on the row),
 * "Delete anyway", which opens a confirmation first.
 */

export const DELETION_PENDING_TITLE = "Deletion pending";
export const DELETION_PENDING_CALENDAR =
  "Deletion started. A calendar event could not be removed yet, so it is not finished. Try again.";
export const DELETION_PENDING_OTHER =
  "Deletion started but is not finished yet. Their links are closed. Try again.";
export const FINISH_DELETION = "Finish deletion";
export const DELETE_ANYWAY = "Delete anyway";
export const DELETE_ANYWAY_TITLE = "Delete anyway?";
export const DELETE_ANYWAY_BODY =
  "The calendar event stays in the host's Google Calendar until someone removes it there. A reminder stays in the bell until it is marked as removed.";

export type DeletionPending = {
  /** Google, while connected, could not remove an event: "Delete anyway" is offered. */
  calendarFailed: boolean;
  busy: boolean;
  onFinish: () => void;
  onDeleteAnyway: () => void;
};

const BUTTON =
  "rounded-lg border border-[var(--ai-amber-dot)] bg-white px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ai-amber-ink)] transition-colors hover:bg-white/70 disabled:opacity-50";

export function DeletionPendingBanner({ deletion }: { deletion: DeletionPending }) {
  return (
    <div
      role="status"
      data-deletion-pending
      className="mb-3.5 rounded-[12px] border border-[var(--ai-amber-dot)] bg-[var(--ai-amber-tint)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ai-amber-ink)]"
    >
      <p className="m-0 font-semibold">{DELETION_PENDING_TITLE}</p>
      <p className="m-0 mt-1">
        {deletion.calendarFailed ? DELETION_PENDING_CALENDAR : DELETION_PENDING_OTHER}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          data-deletion-finish
          disabled={deletion.busy}
          aria-busy={deletion.busy}
          onClick={deletion.onFinish}
          className={BUTTON}
        >
          {FINISH_DELETION}
        </button>
        {deletion.calendarFailed && (
          <button
            type="button"
            data-deletion-anyway
            disabled={deletion.busy}
            onClick={deletion.onDeleteAnyway}
            className={BUTTON}
          >
            {DELETE_ANYWAY}
          </button>
        )}
      </div>
    </div>
  );
}

export function DeletionPendingPill() {
  return (
    <span
      data-deletion-pending-pill
      className="shrink-0 rounded-full bg-[var(--ai-amber-tint)] px-2 py-px text-[10.5px] font-bold text-[var(--ai-amber-ink)]"
    >
      {DELETION_PENDING_TITLE}
    </span>
  );
}
