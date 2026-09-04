"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Share controls and the toast they raise.
 *
 * Shared by BOTH white-label surfaces — the job page and the careers page — so
 * it lives beside the shell rather than under one route. It sat in
 * jobs/[slug]/ while the job page was its only caller, and the note it carried
 * said "if a second one appears, it moves up". One did.
 *
 * ── LinkedIn is an ANCHOR, not window.open ───────────────────
 *
 * It used to be `window.open(url, "_blank", "noopener,noreferrer")`. Passing a
 * features string makes the browser open a POPUP rather than a tab, and the
 * popup is where this broke: /sharing/share-offsite/ requires an authenticated
 * session, and a popup does not reliably carry the profile the user is signed
 * into. What they saw was LinkedIn's home page with nothing attached.
 *
 * The URL was never wrong. Opened directly in a signed-in tab the composer
 * appears with the full preview, and the endpoint still forwards its `url`
 * through the login redirect (verified: it 302s to /uas/login with the
 * parameter intact). So this is a plain anchor — what the editorial job page
 * always used, and what never had the problem.
 *
 * ── The other two do NOT share that mechanism ────────────────
 *
 * Copy uses `navigator.clipboard`; Email sets `window.location.href` to a
 * mailto:. Neither opens a window, so neither could have had this bug, and each
 * already handles its own failure: the clipboard call is wrapped and says so
 * when refused, and a mailto: with no registered handler does nothing and
 * leaves the page where it was.
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
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ShareIcon kind="linkedin" />
          LinkedIn
        </a>
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
