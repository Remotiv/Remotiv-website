"use client";

import { useEffect, useRef } from "react";
import "../interview.css";

/**
 * The interview's own error boundary (Phase 6, A6-24).
 *
 * Without this a crash mid-interview fell through to src/app/error.tsx: the
 * marketing crash page, with "Go to homepage" and a Remotiv sourcing inbox as
 * the contact - neither of which is where a candidate in an interview should
 * be sent. This one keeps the interview shell and says only what the code can
 * prove.
 *
 * ── What is provably preserved ───────────────────────────────
 *
 * An answer is written by /api/interview/confirm BEFORE the client is told
 * `ok: true` and marks it answered, and on reload `answered` is derived from
 * the server (lib/interviews/session.ts), so any answer that finished saving
 * is stored and will show as saved. An answer still recording, or one whose
 * upload had not confirmed, is NOT stored - that recording lives only in the
 * page's memory, which this boundary has just lost. The copy says both.
 *
 * ── Support path ─────────────────────────────────────────────
 *
 * The invitation came from the company's recruiter, not from Remotiv, and
 * this component cannot read the session, so the one address the candidate
 * certainly has is that invitation. Not the marketing homepage.
 */
export default function InterviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error("[interview] route error:", error.digest ?? error.message);
    headingRef.current?.focus();
  }, [error]);

  return (
    <div className="iv">
      <div className="iv-wrap">
        <div className="iv-sheet">
          <div className="iv-card" role="alert">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]"
            >
              This page hit a problem
            </h1>
            <p className="m-0 mb-3 text-[14px] leading-relaxed text-[var(--t2)]">
              Something went wrong on our side, not because of anything you did.
            </p>
            <p className="m-0 mb-3 text-[14px] leading-relaxed text-[var(--t2)]">
              Every answer that finished saving is stored and will show as saved when the page comes
              back. If you were in the middle of recording or saving an answer, that one recording
              was not kept - you will record it again.
            </p>
            <p className="m-0 mb-5 text-[13px] leading-relaxed text-[var(--t3)]">
              Try again below. If it keeps happening, open the same link in Chrome or Safari, or
              contact the recruiter who invited you.
            </p>
            <div className="iv-brow">
              <button type="button" className="iv-btn iv-primary" onClick={() => reset()}>
                Try again
              </button>
              <button
                type="button"
                className="iv-btn iv-ghost"
                onClick={() => window.location.reload()}
              >
                Reload the page
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
