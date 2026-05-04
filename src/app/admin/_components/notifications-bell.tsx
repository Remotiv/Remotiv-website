"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  fetchNotifications,
  markAllAsRead,
  markNotificationAsRead,
  type AdminNotification,
} from "@/app/admin/notifications/actions";

const POLL_INTERVAL_MS = 30_000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function eventIcon(type: string): string {
  switch (type) {
    case "client_decision": return "✅";
    case "client_note":     return "💬";
    case "stage_change":    return "🔄";
    case "candidate_added": return "👤";
    default:                return "🔔";
  }
}

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [marking, setMarking] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Initial fetch + 30s polling for new notifications.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await fetchNotifications(20);
      if (cancelled) return;
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  async function handleClick(n: AdminNotification) {
    if (!n.read_at) {
      const stamped = new Date().toISOString();
      // Optimistic: update local state, then call the server.
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read_at: stamped } : x)),
      );
      await markNotificationAsRead(n.id);
    }
    if (n.link) {
      router.push(n.link);
      setOpen(false);
    }
  }

  async function handleMarkAllRead() {
    setMarking(true);
    const stamped = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at ?? stamped })),
    );
    setUnreadCount(0);
    await markAllAsRead();
    setMarking(false);
  }

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className="relative rounded-xl p-2 hover:bg-gray-50"
      >
        <Bell className="size-5 text-gray-500" strokeWidth={2} />
        {unreadCount > 0 && (
          <span className="absolute right-0 top-0 flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-40 flex max-h-[80vh] w-96 max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-xl">
          <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="font-heading text-sm font-bold text-gray-900">Notifications</p>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  disabled={marking}
                  className="text-[11px] font-semibold text-[#7E47FF] transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  Mark all read
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-gray-400 transition-colors hover:text-gray-600"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Bell className="mx-auto mb-2 size-8 text-gray-300" strokeWidth={1.5} />
                <p className="text-sm font-medium text-gray-600">No notifications yet</p>
                <p className="mt-1 text-xs text-gray-400">
                  You&apos;ll see client activity here.
                </p>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`flex w-full gap-3 border-b border-gray-100 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                    !n.read_at ? "bg-[#7E47FF]/[0.04]" : ""
                  }`}
                >
                  <span aria-hidden className="shrink-0 text-xl leading-none">
                    {eventIcon(n.event_type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm text-gray-900 ${
                        !n.read_at ? "font-bold" : "font-medium"
                      }`}
                    >
                      {n.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-600">{n.message}</p>
                    <p className="mt-1 text-[10px] text-gray-400">
                      {formatTime(n.created_at)}
                    </p>
                  </div>
                  {!n.read_at && (
                    <span className="mt-2 size-2 shrink-0 rounded-full bg-[#7E47FF]" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
