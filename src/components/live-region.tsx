"use client";

import { type ReactNode, useCallback, useState } from "react";

/**
 * Two permanently mounted live regions and a function to speak through them
 * (Phase 6, A6-1 / A6-17).
 *
 * Live regions announce CHANGES to a region that already exists. A region
 * that mounts with its text already inside is not reliably announced, which
 * is why every `{toast && <div role="status">…}` in the dashboard was silent
 * on some screen readers. These regions render from the first paint and only
 * their text changes.
 *
 * Repeating the same message ("Answer 2 saved" then "Answer 3 saved" is fine,
 * but "Couldn't save" twice is not a change) is handled by alternating a
 * zero-width space on every announcement, so the DOM text always differs.
 *
 * Marked exempt from useModalFocus's inert pass so announcements keep working
 * while a modal is open.
 */
export type Announce = (text: string, options?: { assertive?: boolean }) => void;

type Slot = { text: string; seq: number };

export function useAnnouncer(): { announce: Announce; regions: ReactNode } {
  const [polite, setPolite] = useState<Slot>({ text: "", seq: 0 });
  const [assertive, setAssertive] = useState<Slot>({ text: "", seq: 0 });

  const announce = useCallback<Announce>((text, options) => {
    const setter = options?.assertive ? setAssertive : setPolite;
    setter((prev) => ({ text, seq: prev.seq + 1 }));
  }, []);

  const regions = <LiveRegions polite={polite} assertive={assertive} />;
  return { announce, regions };
}

function LiveRegions({ polite, assertive }: { polite: Slot; assertive: Slot }) {
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-inert-exempt=""
      >
        {polite.text}
        {polite.seq % 2 === 1 ? "​" : ""}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        data-inert-exempt=""
      >
        {assertive.text}
        {assertive.seq % 2 === 1 ? "​" : ""}
      </div>
    </>
  );
}
