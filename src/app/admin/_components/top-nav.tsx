"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, KeyRound, LogOut, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  type UserRole,
  ROLE_LABELS,
  ROLE_BADGE_STYLES,
} from "@/app/admin/lib/roles";

const TOP_NAV = [
  { label: "Dashboard", href: "/admin" },
  { label: "Talent", href: "/admin/talent" },
  { label: "Remote Talent", href: "/admin/remote-talent" },
  { label: "Jobs", href: "/admin/jobs" },
  { label: "Applications", href: "/admin/applications" },
  { label: "Search", href: "/admin/search" },
  { label: "Contacts", href: "/admin/contacts" },
  { label: "Bookings", href: "/admin/bookings" },
  { label: "Team", href: "/admin/team" },
];

const WALEED_EMAIL = "waleednzm@gmail.com";

const INITIALS_COLORS = [
  "#7E47FF", "#49D7A7", "#F59E0B", "#EF4444",
  "#3B82F6", "#EC4899", "#10B981", "#F97316",
];

function getInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

function getInitialsColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  }
  return INITIALS_COLORS[hash % INITIALS_COLORS.length];
}

export function TopNav({
  email,
  userRole = "viewer",
}: {
  email: string;
  userRole?: UserRole;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  const isWaleed = email === WALEED_EMAIL;
  const initials = isWaleed ? "" : getInitials(email);
  const initialsColor = isWaleed ? "" : getInitialsColor(email);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false);
      }
    }
    if (avatarOpen) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [avatarOpen]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-20 hidden h-16 items-center justify-between border-b border-gray-100 bg-white px-8 lg:flex">
      <span className="font-heading text-xl font-bold tracking-tight text-remotiv-purple">
        Remotiv.
      </span>

      <nav className="flex items-center gap-1">
        {TOP_NAV.map(({ label, href }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-remotiv-purple text-white"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <Link
          href="/admin/search"
          className="flex items-center gap-2 rounded-xl bg-gray-50 px-3.5 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100"
        >
          <Search className="size-4 text-gray-400" strokeWidth={2} />
          <span className="text-gray-400">Search</span>
        </Link>
        <button type="button" className="relative rounded-xl p-2 hover:bg-gray-50">
          <Bell className="size-5 text-gray-500" strokeWidth={2} />
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500" />
        </button>

        <div ref={avatarRef} className="relative">
          <button
            type="button"
            onClick={() => setAvatarOpen((p) => !p)}
            className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full ring-2 ring-transparent transition-all hover:ring-remotiv-purple/40"
          >
            {isWaleed ? (
              <Image
                src="/avatars/Waleed.png"
                alt="Profile"
                fill
                className="object-cover"
              />
            ) : (
              <span
                className="flex size-full items-center justify-center text-[0.7rem] font-bold text-white"
                style={{ background: initialsColor }}
              >
                {initials}
              </span>
            )}
          </button>

          {avatarOpen && (
            <div className="absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
              <div className="px-4 py-3">
                <p className="truncate text-xs text-gray-400">{email}</p>
                <span
                  className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_STYLES[userRole]}`}
                >
                  {ROLE_LABELS[userRole]}
                </span>
              </div>
              <div className="border-t border-gray-100" />
              <Link
                href="/admin/change-password"
                onClick={() => setAvatarOpen(false)}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
              >
                <KeyRound className="size-4" strokeWidth={2} />
                Change Password
              </Link>
              <div className="border-t border-gray-100" />
              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-gray-600 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <LogOut className="size-4" strokeWidth={2} />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
