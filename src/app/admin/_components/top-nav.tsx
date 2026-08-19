"use client";

import {
  Briefcase,
  Building2,
  CalendarDays,
  ChartLine,
  FileText,
  Handshake,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquare,
  Search,
  Sparkles,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ROLE_BADGE_STYLES, ROLE_LABELS, type UserRole } from "@/app/admin/lib/roles";
import { getAvatarUrl } from "@/lib/avatars";
import { NotificationsBell } from "./notifications-bell";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** When true, only super_admin sees this link. DISPLAY ONLY — see below. */
  superAdminOnly?: boolean;
};

type NavGroup = {
  /** null renders the items with no heading, at the top of the rail. */
  heading: string | null;
  items: ReadonlyArray<NavItem>;
};

/**
 * The rail, grouped by PRODUCT.
 *
 * ── Why grouped ─────────────────────────────────────────────
 *
 * The flat bar this replaces held twelve items spanning four products in an
 * order that scrambled them: the marketplace's three sat at positions 2, 4 and
 * 6 with other products interleaved. Worse, "Clients" (marketplace customers)
 * and "Companies" (AI-dashboard tenants) sat ADJACENT and read as a pair —
 * they belong to different products entirely, and that adjacency is the
 * specific confusion this grouping exists to remove.
 *
 * Dashboard and Search stay ungrouped at the top because they genuinely span
 * every product; putting them under a heading would claim an ownership they
 * do not have.
 *
 * ── superAdminOnly is NOT access control ────────────────────
 *
 * It decides what is DRAWN, nothing else. Every page enforces its own guard —
 * /admin/layout.tsx checks the admin_users row on every request, and each page
 * re-checks its own permissions. Hiding a link stops it being advertised; it
 * does not stop anyone reaching the route by typing it, and this file must
 * never be mistaken for the thing that does.
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    heading: null,
    items: [
      { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
      { label: "Search", href: "/admin/search", icon: Search },
    ],
  },
  {
    heading: "Marketplace",
    items: [
      { label: "Talent", href: "/admin/talent", icon: Users },
      { label: "Clients", href: "/admin/clients", icon: Building2, superAdminOnly: true },
      { label: "Client Batches", href: "/admin/client-batches", icon: Layers },
    ],
  },
  {
    heading: "Hire Remote",
    items: [
      { label: "Remote Talent", href: "/admin/remote-talent", icon: UserPlus },
      { label: "Hire Requests", href: "/admin/hire-requests", icon: Handshake },
    ],
  },
  {
    heading: "Companies",
    items: [
      { label: "Companies", href: "/admin/companies", icon: Sparkles, superAdminOnly: true },
      { label: "Jobs", href: "/admin/jobs", icon: Briefcase },
      { label: "Applications", href: "/admin/applications", icon: FileText },
      // Cross-company by design, so the route enforces super_admin server-side
      // in BOTH the page and the action. This flag only stops it being
      // advertised to admins who would be redirected away from it.
      {
        label: "Platform analytics",
        href: "/admin/analytics",
        icon: ChartLine,
        superAdminOnly: true,
      },
    ],
  },
  {
    heading: "Platform",
    items: [
      { label: "Contacts", href: "/admin/contacts", icon: MessageSquare },
      // /admin/bookings is a real, working page that the old flat bar never
      // linked — reachable only from a dead sidebar component.
      { label: "Bookings", href: "/admin/bookings", icon: CalendarDays },
      { label: "Team", href: "/admin/team", icon: Users },
    ],
  },
];

/**
 * Visual constants, mirroring the company dashboard's sidebar by VALUE.
 *
 * Deliberately re-declared here rather than imported from ai-dashboard/**:
 * the two halves should look like one product, but coupling admin's chrome to
 * the dashboard's would mean a change intended for one silently reshaping the
 * other. The dashboard's own values live behind `--ai-sidebar`, a variable
 * scoped to `.ai-shell` and therefore not in scope here anyway.
 *
 * Kept in step by hand. If the dashboard's rail changes, these four constants
 * are the whole surface to update.
 */
const RAIL_SURFACE = "#141020";
const RAIL_LINK =
  "flex items-center gap-[11px] rounded-[10px] px-2.5 py-2.5 text-[13.5px] font-medium transition-colors";
const RAIL_LINK_ACTIVE = "bg-remotiv-purple font-semibold text-white";
const RAIL_LINK_IDLE = "text-white/60 hover:bg-white/[0.06] hover:text-white";
const RAIL_HEADING =
  "px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35";

/**
 * Is this the route the rail should highlight?
 *
 * A prefix match on every item EXCEPT /admin, so /admin/jobs/123 highlights
 * Jobs. Dashboard is exact-matched because "/admin" prefixes every other
 * route and would otherwise stay lit on every page.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const WALEED_EMAIL = "waleednzm@gmail.com";

const INITIALS_COLORS = [
  "#7E47FF",
  "#49D7A7",
  "#F59E0B",
  "#EF4444",
  "#3B82F6",
  "#EC4899",
  "#10B981",
  "#F97316",
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

export function TopNav({ email, userRole = "viewer" }: { email: string; userRole?: UserRole }) {
  const pathname = usePathname();

  const [avatarOpen, setAvatarOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  const isWaleed = email === WALEED_EMAIL;
  const initials = isWaleed ? "" : getInitials(email);
  const initialsColor = isWaleed ? "" : getInitialsColor(email);

  /*
   * Filter items first, then drop any group left empty — a heading with no
   * rows under it reads as a broken section rather than an absent one.
   */
  const visibleGroups = NAV_GROUPS.map((group) => ({
    heading: group.heading,
    items: group.items.filter((item) => !item.superAdminOnly || userRole === "super_admin"),
  })).filter((group) => group.items.length > 0);

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

  const railNav = (onNavigate?: () => void) => (
    <nav className="flex flex-col gap-0.5">
      {visibleGroups.map((group) => (
        <div key={group.heading ?? "top"} className="flex flex-col gap-0.5">
          {group.heading && <div className={RAIL_HEADING}>{group.heading}</div>}
          {group.items.map(({ label, href, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`${RAIL_LINK} ${active ? RAIL_LINK_ACTIVE : RAIL_LINK_IDLE}`}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const accountMenu = (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#1D1830] shadow-lg">
      <div className="px-4 py-3">
        <p className="truncate text-xs text-white/50">{email}</p>
        <span
          className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_STYLES[userRole]}`}
        >
          {ROLE_LABELS[userRole]}
        </span>
      </div>
      <div className="border-t border-white/10" />
      <Link
        href="/admin/change-password"
        onClick={() => setAvatarOpen(false)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
      >
        <KeyRound className="size-4" strokeWidth={2} />
        Change Password
      </Link>
      <div className="border-t border-white/10" />
      <form action="/admin/logout" method="post">
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white/70 transition-colors hover:bg-red-500/15 hover:text-red-300"
        >
          <LogOut className="size-4" strokeWidth={2} />
          Sign Out
        </button>
      </form>
    </div>
  );

  return (
    <>
      {/* ── Desktop rail (lg+) ──
          FIXED, not sticky-in-flow: TopNav is rendered by each dashboard
          component above its own <main>, so a rail in normal flow would stack
          above the content instead of beside it. The matching left offset is
          applied once in admin/layout.tsx, which is the only place that wraps
          every admin page. */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col px-4 pb-[18px] pt-[22px] lg:flex"
        style={{ background: RAIL_SURFACE }}
      >
        <Link href="/admin" className="flex items-center gap-2.5 px-2 pb-[22px] pt-1">
          <span className="font-heading text-[21px] font-extrabold tracking-[-0.02em] text-white">
            Remotiv<span className="text-remotiv-green">.</span>
          </span>
        </Link>

        <div className="min-h-0 flex-1 overflow-y-auto">{railNav()}</div>

        {/* The bell stays OUTSIDE the nav list, as it was in the old bar —
            it is a notification surface, not a destination. */}
        <div className="mt-3 shrink-0 border-t border-white/10 pt-3">
          <div ref={avatarRef} className="relative">
            {avatarOpen && (
              <div className="absolute bottom-full left-0 z-40 mb-2 w-[204px]">{accountMenu}</div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAvatarOpen((p) => !p)}
                aria-label={`Account menu for ${email}`}
                aria-expanded={avatarOpen}
                aria-haspopup="menu"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-2 transition-colors hover:bg-white/[0.06]"
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <UserAvatar
                    email={email}
                    isWaleed={isWaleed}
                    initials={initials}
                    initialsColor={initialsColor}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-white/70">
                  {email}
                </span>
              </button>
              <NotificationsBell />
            </div>
          </div>
        </div>
      </aside>

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

      {/* ── Mobile drawer + overlay — same groups, same treatment ── */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 lg:hidden ${
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto px-4 pb-[18px] pt-[22px] shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          mobileOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ background: RAIL_SURFACE }}
        aria-hidden={!mobileOpen}
      >
        <div className="flex shrink-0 items-center justify-between pb-[18px]">
          <span className="font-heading text-[21px] font-extrabold tracking-[-0.02em] text-white">
            Remotiv<span className="text-remotiv-green">.</span>
          </span>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="flex size-11 items-center justify-center rounded-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        <div className="mb-[18px] flex shrink-0 items-center gap-3 rounded-xl border border-white/[0.09] bg-white/[0.06] px-[11px] py-[9px]">
          <span className="relative flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-full">
            <UserAvatar
              email={email}
              isWaleed={isWaleed}
              initials={initials}
              initialsColor={initialsColor}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-tight text-white">{email}</p>
            <span
              className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_STYLES[userRole]}`}
            >
              {ROLE_LABELS[userRole]}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1">{railNav(() => setMobileOpen(false))}</div>

        <div className="mt-3 shrink-0 border-t border-white/10 pt-3">
          <Link
            href="/admin/change-password"
            onClick={() => setMobileOpen(false)}
            className={`${RAIL_LINK} ${RAIL_LINK_IDLE} min-h-11`}
          >
            <KeyRound className="size-[18px] shrink-0" strokeWidth={1.7} />
            Change Password
          </Link>
          <form action="/admin/logout" method="post">
            <button
              type="submit"
              className={`${RAIL_LINK} min-h-11 w-full text-white/60 hover:bg-red-500/15 hover:text-red-300`}
            >
              <LogOut className="size-[18px] shrink-0" strokeWidth={1.7} />
              Sign Out
            </button>
          </form>
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
  email,
  isWaleed,
  initials,
  initialsColor,
}: {
  email?: string;
  isWaleed: boolean;
  initials: string;
  initialsColor: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const altText = email ? `Profile picture for ${email}` : "Profile picture";

  if (isWaleed && !imgFailed) {
    return (
      <Image
        src={getAvatarUrl("Waleed", "Khan")}
        alt={altText}
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
