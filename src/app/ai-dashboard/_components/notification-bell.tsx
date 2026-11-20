"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check } from "lucide-react";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markCalendarCleanupRemoved,
  markNotificationRead,
} from "@/app/ai-dashboard/(gated)/notification-actions";
import type {
  CalendarCleanupAlert,
  CompanyNotification,
} from "@/app/ai-dashboard/(gated)/notification-types";
import { cleanupAlertText } from "./cleanup-copy";

/**
 * The topbar bell.
 *
 * Rendered with its first read by the gated layout, so the unread badge is
 * right before anyone clicks (#41; it loads on mount only when that read
 * failed), and read again on open so a panel left closed for an hour is not
 * stale. No polling — this is in-app only and a hiring workspace is not a
 * chat client.
 */

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86400000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** What fetchNotifications answers: the bell's first read, when the layout rendered it (#41). */
export type BellRead = {
  items: CompanyNotification[];
  unread: number;
  /** Lasting calendar-cleanup alerts (#56): pinned until resolved, never "read". */
  cleanups?: CalendarCleanupAlert[];
};

export function NotificationBell({ initial = null }: { initial?: BellRead | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CompanyNotification[]>(initial?.items ?? []);
  const [unread, setUnread] = useState(initial?.unread ?? 0);
  const [cleanups, setCleanups] = useState<CalendarCleanupAlert[]>(initial?.cleanups ?? []);
  const [clearing, setClearing] = useState<string | null>(null);
  /** The badge counts unread notifications and every open cleanup alert. */
  const badge = unread + cleanups.length;
  const [loading, setLoading] = useState(initial === null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchNotifications();
      setItems(result.items);
      setUnread(result.unread);
      setCleanups(result.cleanups ?? []);
    } catch {
      // A failed read leaves the badge as it was rather than blanking the
      // topbar — the bell is not worth an error state.
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount only when the layout could not render the first read (#41); the
  // panel still reads again every time it opens, as before.
  const renderedFirst = initial !== null;
  useEffect(() => {
    if (renderedFirst) return;
    void load();
  }, [load, renderedFirst]);

  useEffect(() => {
    if (!open) return;
    void load();
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  /** "Mark as removed": the row leaves only once the server has cleared it. */
  async function handleClearCleanup(id: string) {
    setClearing(id);
    const done = await markCalendarCleanupRemoved(id).catch(() => false);
    setClearing(null);
    if (done) setCleanups((prev) => prev.filter((c) => c.id !== id));
  }

  async function handleOpenItem(item: CompanyNotification) {
    // Optimistic: the row dims immediately, then the write follows. A failed
    // write leaves a read-looking row that reverts on the next load, which is
    // better than a click that appears to do nothing.
    if (!item.read) {
      setItems((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)),
      );
      setUnread((n) => Math.max(0, n - 1));
      await markNotificationRead(item.id);
    }
    if (item.href) {
      setOpen(false);
      router.push(item.href);
    }
  }

  async function handleMarkAll() {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await markAllNotificationsRead();
  }

  return (
    <div ref={panelRef} className="relative ml-auto shrink-0 min-[630px]:ml-0">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-label={badge > 0 ? `Notifications, ${badge} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="menu"
        className="relative flex size-[34px] items-center justify-center rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-line-strong)] hover:text-[var(--ai-t1)]"
      >
        <Bell className="size-[18px]" strokeWidth={1.7} />
        {badge > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-remotiv-purple px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-[var(--ai-page)]">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          /* Right-anchored and width-capped to the viewport so it never pushes
             the page sideways at 375px, where the topbar itself is only ~457
             design px wide once .ai-shell's 0.82 zoom is accounted for. */
          className="absolute right-0 top-[42px] z-[70] w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-[16px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_24px_60px_rgba(20,16,32,0.22)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ai-line)] px-4 py-3">
            <span className="text-[13px] font-bold text-[var(--ai-t1)]">
              Notifications
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => {
                  void handleMarkAll();
                }}
                className="shrink-0 text-[11.5px] font-bold text-remotiv-purple hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(420px,calc(var(--vh-full)*0.6))] overflow-y-auto">
            {/* Lasting alerts (#56): pinned first, cleared only by "Mark as
                removed" or by the host reconnecting the same account. */}
            {cleanups.map((alert) => (
              <div
                key={alert.id}
                data-calendar-cleanup
                className="border-b border-[var(--ai-line-soft)] bg-[var(--ai-amber-tint)] px-4 py-3"
              >
                <p className="m-0 text-[12.5px] font-semibold leading-snug text-[var(--ai-amber-ink)]">
                  {cleanupAlertText(alert)}
                </p>
                <button
                  type="button"
                  disabled={clearing === alert.id}
                  onClick={() => {
                    void handleClearCleanup(alert.id);
                  }}
                  className="mt-2 rounded-lg border border-[var(--ai-amber-dot)] bg-white/70 px-2.5 py-1 text-[11.5px] font-bold text-[var(--ai-amber-ink)] transition-colors hover:bg-white disabled:opacity-60"
                >
                  {clearing === alert.id ? "Marking…" : "Mark as removed"}
                </button>
              </div>
            ))}

            {loading && items.length === 0 && (
              <div className="px-4 py-6">
                <div className="h-3 w-2/3 animate-pulse rounded-full bg-[var(--ai-inset)]" />
              </div>
            )}

            {!loading && items.length === 0 && cleanups.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="m-0 text-[13px] font-semibold text-[var(--ai-t2)]">
                  Nothing yet
                </p>
                <p className="m-0 mt-1 text-[11.5px] leading-snug text-[var(--ai-t3)]">
                  Scores, stage changes and job updates for the roles you&apos;re on
                  will appear here.
                </p>
              </div>
            )}

            {items.map((item) => {
              const Row = item.href ? "button" : "div";
              return (
                <Row
                  key={item.id}
                  {...(item.href
                    ? {
                        type: "button" as const,
                        onClick: () => {
                          void handleOpenItem(item);
                        },
                      }
                    : {})}
                  className={`relative flex w-full items-start gap-2.5 border-b border-[var(--ai-line-soft)] px-4 py-3 text-left last:border-b-0 ${
                    item.href ? "cursor-pointer hover:bg-[var(--ai-inset)]" : ""
                  } ${item.read ? "bg-[var(--ai-surface)]" : "bg-[var(--ai-purple-tint)]/40"}`}
                >
                  {/* Unread is carried by BOTH a dot and the row tint — colour
                      alone would be the only signal for anyone who can't
                      distinguish the two backgrounds. */}
                  <span
                    className={`mt-[5px] size-[7px] shrink-0 rounded-full ${
                      item.read ? "bg-transparent" : "bg-remotiv-purple"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[12.5px] leading-snug ${
                        item.read
                          ? "font-medium text-[var(--ai-t2)]"
                          : "font-bold text-[var(--ai-t1)]"
                      }`}
                    >
                      {item.title}
                    </span>
                    {item.body && (
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--ai-t3)]">
                        {item.body}
                      </span>
                    )}
                    <span className="mt-1 block text-[11px] text-[var(--ai-t4)]">
                      {relative(item.createdAt)}
                    </span>
                  </span>
                  {item.read && (
                    <Check
                      className="mt-1 size-3 shrink-0 text-[var(--ai-t4)]"
                      strokeWidth={2.2}
                    />
                  )}
                </Row>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
