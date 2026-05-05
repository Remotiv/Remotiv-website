"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Briefcase,
  Building2,
  FileText,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquare,
  Search,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { NotificationsBell } from "./notifications-bell";
import {
  type UserRole,
  ROLE_LABELS,
  ROLE_BADGE_STYLES,
} from "@/app/admin/lib/roles";
import { getAvatarUrl } from "@/lib/avatars";

type NavItem = {
  label: string;
  href: string;
  /** Lucide icon — only rendered in the mobile drawer. */
  icon: LucideIcon;
  /** When true, only super_admin sees this link. */
  superAdminOnly?: boolean;
};

const TOP_NAV: ReadonlyArray<NavItem> = [
  { label: "Dashboard",      href: "/admin",                icon: LayoutDashboard },
  { label: "Talent",         href: "/admin/talent",         icon: Users },
  { label: "Remote Talent",  href: "/admin/remote-talent",  icon: UserPlus },
  { label: "Clients",        href: "/admin/clients",        icon: Building2,    superAdminOnly: true },
  { label: "Client Batches", href: "/admin/client-batches", icon: Layers },
  { label: "Jobs",           href: "/admin/jobs",           icon: Briefcase },
  { label: "Applications",   href: "/admin/applications",   icon: FileText },
  { label: "Search",         href: "/admin/search",         icon: Search },
  { label: "Contacts",       href: "/admin/contacts",       icon: MessageSquare },
  { label: "Team",           href: "/admin/team",           icon: Users },
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  const isWaleed = email === WALEED_EMAIL;
  const initials = isWaleed ? "" : getInitials(email);
  const initialsColor = isWaleed ? "" : getInitialsColor(email);

  const visibleNav = TOP_NAV.filter(
    (item) => !item.superAdminOnly || userRole === "super_admin",
  );

  // Click-outside for desktop avatar dropdown
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false);
      }
    }
    if (avatarOpen) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [avatarOpen]);

  // Mobile drawer: Escape closes, body scroll locks while open
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  // Close drawer on route change so users land on the new page cleanly
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <>
      {/* ── Desktop bar (lg+) — unchanged from original ── */}
      <header className="sticky top-0 z-20 hidden h-16 items-center justify-between border-b border-gray-100 bg-white px-8 lg:flex">
        <span className="font-heading text-xl font-bold tracking-tight text-remotiv-purple">
          Remotiv.
        </span>

        <nav className="flex items-center gap-1">
          {visibleNav.map(({ label, href }) => {
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
          <NotificationsBell />

          <div ref={avatarRef} className="relative">
            <button
              type="button"
              onClick={() => setAvatarOpen((p) => !p)}
              className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full ring-2 ring-transparent transition-all hover:ring-remotiv-purple/40"
            >
              <UserAvatar isWaleed={isWaleed} initials={initials} initialsColor={initialsColor} />
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

      {/* ── Mobile bar (<lg) — logo + bell + hamburger ── */}
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-gray-100 bg-white px-4 lg:hidden">
        <Link
          href="/admin"
          className="font-heading text-xl font-bold tracking-tight text-remotiv-purple"
        >
          Remotiv.
        </Link>
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="flex size-11 items-center justify-center rounded-xl text-gray-700 transition-colors hover:bg-gray-50"
          >
            <Menu className="size-6" strokeWidth={2} />
          </button>
        </div>
      </header>

      {/* ── Mobile drawer + overlay ── */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 lg:hidden ${
          mobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col bg-white shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          mobileOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!mobileOpen}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-100 px-4">
          <span className="font-heading text-xl font-bold tracking-tight text-remotiv-purple">
            Remotiv.
          </span>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="flex size-11 items-center justify-center rounded-xl text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        {/* User identity strip */}
        <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-4">
          <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <UserAvatar isWaleed={isWaleed} initials={initials} initialsColor={initialsColor} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-800">
              {email}
            </p>
            <span
              className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_STYLES[userRole]}`}
            >
              {ROLE_LABELS[userRole]}
            </span>
          </div>
        </div>

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <ul className="flex flex-col gap-0.5">
            {visibleNav.map(({ label, href, icon: Icon }) => {
              const active = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-[#7E47FF]/10 font-semibold text-[#7E47FF]"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                    }`}
                  >
                    <Icon
                      className={`size-4 shrink-0 ${active ? "text-[#7E47FF]" : "text-gray-400"}`}
                      strokeWidth={2}
                    />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer actions */}
        <div className="shrink-0 border-t border-gray-100 px-3 py-3">
          <Link
            href="/admin/change-password"
            onClick={() => setMobileOpen(false)}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
          >
            <KeyRound className="size-4 text-gray-400" strokeWidth={2} />
            Change Password
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-600 transition-colors hover:bg-red-50 hover:text-red-500"
          >
            <LogOut className="size-4 text-gray-400" strokeWidth={2} />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}

/**
 * Top-right user avatar. Super-admin gets a deterministic image from the
 * /public/avatars pool via the shared util; everyone else gets a colored
 * initials chip derived from their email. The pool image falls back to
 * the initials chip on load failure so missing files never render broken.
 */
function UserAvatar({
  isWaleed,
  initials,
  initialsColor,
}: {
  isWaleed: boolean;
  initials: string;
  initialsColor: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  if (isWaleed && !imgFailed) {
    return (
      <Image
        src={getAvatarUrl("Waleed", "Khan")}
        alt="Profile"
        fill
        sizes="40px"
        className="object-cover"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <span
      className="flex size-full items-center justify-center text-[0.7rem] font-bold text-white"
      style={{ background: isWaleed ? "#7E47FF" : initialsColor }}
    >
      {isWaleed ? "WK" : initials}
    </span>
  );
}
