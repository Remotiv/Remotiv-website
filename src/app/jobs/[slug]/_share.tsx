"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Share buttons and the toast they raise.
 *
 * A client component because two of the three actions need the browser —
 * clipboard access, and a popup for LinkedIn's composer. The reference's
 * buttons only raise a toast; these do the real thing and then say so.
 *
 * The toast lives here rather than at page level because this is its only
 * caller. If a second one appears, it moves up — not sideways into a copy.
 */

const ICONS = {
  linkedin: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7.5 10.5V17M7.5 7.4v.1M11.6 17v-3.6a2.2 2.2 0 0 1 4.4 0V17" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2" />
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.4" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
};

function ShareIcon({ kind }: { kind: keyof typeof ICONS }) {
  return (
    // Decorative: each button carries its own visible label.
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[kind]}
    </svg>
  );
}

export function ShareRole({ url, subject }: { url: string; subject: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2100);
  }, []);

  // A pending timeout that fires after unmount sets state on a dead component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied to clipboard");
    } catch {
      // Clipboard access is refused in some contexts and on some browsers.
      // Saying so beats a success message for something that did not happen.
      toast("Couldn't copy — select the address bar instead");
    }
  }

  return (
    <>
      <div className="share">
        <button
          type="button"
          onClick={() => {
            window.open(
              `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
              "_blank",
              "noopener,noreferrer",
            );
          }}
        >
          <ShareIcon kind="linkedin" />
          LinkedIn
        </button>
        <button type="button" onClick={copy}>
          <ShareIcon kind="link" />
          Copy link
        </button>
        <button
          type="button"
          onClick={() => {
            window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(url)}`;
          }}
        >
          <ShareIcon kind="mail" />
          Email
        </button>
      </div>

      {/* Always mounted so the .24s transition has something to animate; `show`
          is what moves it. aria-live so the confirmation is announced. */}
      <div className={`toast${message ? " show" : ""}`} role="status" aria-live="polite">
        {message}
      </div>
    </>
  );
}
