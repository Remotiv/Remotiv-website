"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  CheckCircle,
  Inbox,
  type LucideIcon,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  UserCheck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/app/admin/_components/_shared/use-focus-trap";
import {
  fetchTalentNotifications,
  markAllTalentNotificationsRead,
  markTalentNotificationRead,
  type TalentNotification,
} from "./notifications/actions";

const POLL_INTERVAL_MS = 30_000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const EVENT_ICON: Record<
  string,
  { Icon: LucideIcon; color: string; bg: string }
> = {
  client_decision: {
    Icon: CheckCircle,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  client_note: {
    Icon: MessageSquare,
    color: "text-blue-600",
    bg: "bg-blue-50",
  },
  stage_change: {
    Icon: ArrowRight,
    color: "text-remotiv-purple",
    bg: "bg-remotiv-purple/10",
  },
  // Positive event for talent — they got shortlisted.
  candidate_added: {
    Icon: Sparkles,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  new_inquiry: {
    Icon: Inbox,
    color: "text-remotiv-purple",
    bg: "bg-remotiv-purple/10",
  },
  profile_claimed: {
    Icon: UserCheck,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  profile_approved: {
    Icon: ShieldCheck,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  profile_rejected: {
    Icon: AlertCircle,
    color: "text-amber-600",
    bg: "bg-amber-50",
  },
};
const EVENT_ICON_DEFAULT = {
  Icon: Bell,
  color: "text-gray-500",
  bg: "bg-gray-100",
};

export function TalentNotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<TalentNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [marking, setMarking] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Tracks "user is currently mark-all-read'ing" so an in-flight 30s
  // poll can't wholesale-replace optimistic state and flicker the
  // unread count back up before the server acks.
  const markingRef = useRef(false);
  // Focus trap on the dropdown panel — adds Escape-to-close + Tab
  // containment that the admin bell doesn't have yet.
  const panelRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false));

  // Initial fetch + 30s polling for new notifications.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (markingRef.current) return;
      const result = await fetchTalentNotifications(20);
      if (cancelled || markingRef.current) return;
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
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  async function handleClick(n: TalentNotification) {
    if (!n.read_at) {
      const stamped = new Date().toISOString();
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read_at: stamped } : x)),
      );
      await markTalentNotificationRead(n.id);
    }
    if (n.link) {
      router.push(n.link);
      setOpen(false);
    }
  }

  async function handleMarkAllRead() {
    setMarking(true);
    markingRef.current = true;
    const stamped = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at ?? stamped })),
    );
    setUnreadCount(0);
    try {
      await markAllTalentNotificationsRead();
    } finally {
      setMarking(false);
      markingRef.current = false;
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-label={`Notifications${
          unreadCount > 0 ? ` (${unreadCount} unread)` : ""
        }`}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
      >
        <Bell className="size-4" strokeWidth={2} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-remotiv-purple px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          className="absolute right-0 top-11 z-40 flex max-h-[80vh] w-96 max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="font-heading text-sm font-bold text-gray-900">
              Notifications
            </p>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  disabled={marking}
                  className="text-[11px] font-semibold text-remotiv-purple transition-opacity hover:opacity-80 disabled:opacity-50"
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
                <Bell
                  className="mx-auto mb-2 size-8 text-gray-300"
                  strokeWidth={1.5}
                />
                <p className="text-sm font-medium text-gray-600">
                  No notifications yet
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  When a client shortlists you or an admin reviews your
                  profile, you&apos;ll see updates here.
                </p>
              </div>
            ) : (
              notifications.map((n) => {
                const meta = EVENT_ICON[n.event_type] ?? EVENT_ICON_DEFAULT;
                const { Icon, color, bg } = meta;
                return (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={`flex w-full gap-3 border-b border-gray-100 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                      !n.read_at ? "bg-remotiv-purple/[0.04]" : ""
                    }`}
                  >
                    <span
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full ${bg}`}
                    >
                      <Icon className={`size-4 ${color}`} strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm text-gray-900 ${
                          !n.read_at ? "font-bold" : "font-medium"
                        }`}
                      >
                        {n.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-gray-600">
                        {n.message}
                      </p>
                      <p className="mt-1 text-[10px] text-gray-400">
                        {formatTime(n.created_at)}
                      </p>
                    </div>
                    {!n.read_at && (
                      <span className="mt-2 size-2 shrink-0 rounded-full bg-remotiv-purple" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
