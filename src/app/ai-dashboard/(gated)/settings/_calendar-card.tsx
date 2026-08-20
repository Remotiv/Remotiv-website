"use client";

import { AlertTriangle, Calendar, Check, ExternalLink } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { CalendarConnectionView } from "@/lib/calendar/connections";
import { disconnectCalendar } from "./calendar-actions";

/**
 * Calendar connections card.
 *
 * ── What this component can see ──────────────────────────────
 *
 * `CalendarConnectionView` and nothing else: provider, account email,
 * timezone, status, a short problem message, and when it was connected. There
 * is no token in this file's props, no token in the action's return type, and
 * no token anywhere in the client bundle — connections.ts is `server-only`, so
 * importing the store here would fail the build rather than leak.
 *
 * ── Why Connect is a link, not a button with an onClick ──────
 *
 * The consent flow has to be a top-level navigation, and an <a> is that
 * natively. Routing it through JavaScript would mean the consent URL passes
 * through client code for no benefit.
 */

const CARD_CLS =
  "mb-4 overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] last:mb-0";
const FOOT_CLS =
  "flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-3.5";

/**
 * Callback outcomes, mapped to sentences THIS file owns.
 *
 * The route only ever puts a short code in the query string. Rendering a
 * provider's own error text would mean echoing an attacker-influenceable
 * string into the page; a fixed map cannot do that.
 */
const OUTCOMES: Record<string, { tone: "good" | "bad"; message: string }> = {
  connected: { tone: "good", message: "Google Calendar connected." },
  connected_no_timezone: {
    tone: "bad",
    message:
      "Connected, but Google did not report a timezone for this calendar. Set one in Google Calendar, then reconnect.",
  },
  cancelled: { tone: "bad", message: "Connection cancelled — nothing was changed." },
  expired: { tone: "bad", message: "That took too long and the request expired. Try again." },
  invalid_state: {
    tone: "bad",
    message: "That request could not be verified. Start again from this page.",
  },
  member_mismatch: {
    tone: "bad",
    message: "That request was started by a different account. Start again from this page.",
  },
  not_signed_in: {
    tone: "bad",
    message: "Your session ended before the connection finished. Try again.",
  },
  no_member: {
    tone: "bad",
    message: "This account has no team member record, so a calendar cannot be attached to it yet.",
  },
  unavailable: {
    tone: "bad",
    message: "Calendar connections are not configured on this deployment.",
  },
  exchange_failed: { tone: "bad", message: "Google refused the connection. Try again." },
  store_failed: { tone: "bad", message: "The connection could not be saved. Try again." },
  provider_error: { tone: "bad", message: "Google reported a problem with the request." },
};

const STATUS_COPY: Record<CalendarConnectionView["status"], string> = {
  active: "Connected",
  revoked: "Needs reconnecting",
  error: "Not working",
};

export function CalendarCard({ initial }: { initial: CalendarConnectionView[] }) {
  const [connections, setConnections] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; message: string } | null>(null);

  // The callback route redirects back with ?calendar=<code>.
  const outcome = OUTCOMES[useSearchParams().get("calendar") ?? ""] ?? null;
  const banner = notice ?? outcome;

  const google = connections.find((c) => c.provider === "google") ?? null;

  const onDisconnect = () => {
    startTransition(async () => {
      const result = await disconnectCalendar("google");
      setConnections(result.connections);
      setNotice(
        result.ok
          ? {
              tone: result.revokedAtProvider ? "good" : "bad",
              message: result.revokedAtProvider
                ? "Google Calendar disconnected."
                : "Disconnected here, but Google did not confirm the revocation. Remove Remotiv from your Google account permissions to be sure.",
            }
          : { tone: "bad", message: "Could not disconnect. Try again." },
      );
    });
  };

  return (
    <section className={CARD_CLS}>
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <div>
          <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
            Your calendar
          </h2>
          <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
            Connect your own calendar so interview times can be offered against your real
            availability.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-mint-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-mint-ink)]">
          Just you
        </span>
      </div>

      <div className="px-6 pb-[22px] pt-[18px]">
        {banner && (
          <p
            className={`mb-4 flex items-start gap-2.5 rounded-[12px] border px-3.5 py-3 text-[12.5px] leading-relaxed ${
              banner.tone === "good"
                ? "border-[var(--ai-mint-ink)]/20 bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]"
                : "border-amber-300/50 bg-amber-50 text-amber-800"
            }`}
          >
            {banner.tone === "good" ? (
              <Check className="mt-px size-4 shrink-0" strokeWidth={2.4} />
            ) : (
              <AlertTriangle className="mt-px size-4 shrink-0" strokeWidth={2.2} />
            )}
            <span>{banner.message}</span>
          </p>
        )}

        {google ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-[var(--ai-line)] px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-[var(--ai-inset)] text-[var(--ai-t2)]">
                <Calendar className="size-[18px]" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="m-0 truncate text-sm font-bold text-[var(--ai-t1)]">
                  {google.providerLabel}
                </p>
                <p className="m-0 mt-0.5 truncate text-[12px] text-[var(--ai-t3)]">
                  {google.account || "Connected account"}
                  {google.timezone ? ` · ${google.timezone}` : ""}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span
                className={`whitespace-nowrap rounded-full px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] ${
                  google.status === "active"
                    ? "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]"
                    : "bg-amber-100 text-amber-800"
                }`}
              >
                {STATUS_COPY[google.status]}
              </span>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={pending}
                className="rounded-[11px] border border-[var(--ai-line-strong)] px-3.5 py-2 text-[12.5px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[#E0524B] hover:text-[#E0524B] disabled:opacity-60"
              >
                {pending ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-dashed border-[var(--ai-line-strong)] px-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-[var(--ai-inset)] text-[var(--ai-t4)]">
                <Calendar className="size-[18px]" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="m-0 text-sm font-bold text-[var(--ai-t1)]">No calendar connected</p>
                <p className="m-0 mt-0.5 text-[12px] text-[var(--ai-t3)]">
                  Remotiv will read your busy times and add interviews you accept.
                </p>
              </div>
            </div>
            {/* A real navigation, not a fetch — the consent screen must own the tab. */}
            <a
              href="/api/calendar/google/start"
              className="inline-flex shrink-0 items-center gap-2 rounded-[11px] bg-remotiv-purple px-4 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6D38F0]"
            >
              Connect Google Calendar
              <ExternalLink className="size-[14px]" strokeWidth={2.2} />
            </a>
          </div>
        )}

        {google?.problem && (
          <p className="m-0 mt-3 text-[12px] leading-relaxed text-amber-800">{google.problem}</p>
        )}
      </div>

      <div className={FOOT_CLS}>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--ai-t3)]">
          Times are stored in UTC and shown in the calendar's own timezone, so a booking survives
          daylight saving and a laptop set to the wrong zone.
        </p>
      </div>
    </section>
  );
}
