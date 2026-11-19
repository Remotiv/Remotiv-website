"use client";

import { useState } from "react";
import type { CancelNotice } from "@/lib/calendar/cancel-notice";
import { retryCancellationNotice } from "./cancel-notice-actions";

const NOTE =
  "m-0 mt-2.5 rounded-xl bg-[var(--ai-danger-tint)] px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-[var(--ai-danger)]";

/**
 * After a cancellation whose candidate email did not go (#59, QA #104): says
 * so, and offers a Retry when there is an email row to retry. The Retry can
 * never send twice (retryCancellationNotice). Renders nothing for a notice
 * that was sent.
 */
export function CancelNoticeNote({
  notice,
  onResolved,
}: {
  notice: CancelNotice | null;
  /** The candidate has been notified: the note goes and the caller says so. */
  onResolved: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!notice || notice.candidate === "sent") return null;
  if (notice.candidate === "no_address") {
    return (
      <p className={NOTE} role="status">
        Interview cancelled. The candidate has no email address, so they were not told.
      </p>
    );
  }
  const logId = notice.logId;

  async function retry() {
    if (!logId) return;
    setBusy(true);
    setRetryError(null);
    try {
      const result = await retryCancellationNotice({ bookingId: notice?.bookingId ?? "", logId });
      if (result.success) {
        onResolved("The candidate has been notified.");
        return;
      }
      setRetryError(result.error);
    } catch (err) {
      console.error("[applicants] retryCancellationNotice threw:", err);
      setRetryError("The email could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={NOTE} role="alert">
      <span>Interview cancelled, but the candidate notification failed.</span>
      {logId && (
        <button
          type="button"
          onClick={retry}
          disabled={busy}
          aria-busy={busy}
          className="ml-2 underline underline-offset-2 disabled:opacity-60"
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
      )}
      {retryError && <span className="mt-1 block font-normal">{retryError}</span>}
    </div>
  );
}
