"use client";

import {
  Bookmark,
  Briefcase,
  Building2,
  ChevronDown,
  CirclePlus,
  Globe,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  Search,
  Sparkles,
  SquarePen,
  TrendingUp,
  User,
  UserCheck,
  UserPlus,
  Users,
  Video,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import styles from "./navbar.module.css";

// Logged-in account menu data. Two role variants; both end with a Sign out
// action rendered as a button (handled in <AccountMenu />, not in this array).
const EMPLOYER_MENU: NavChild[] = [
  {
    icon: User,
    title: "My Account",
    description: "Subscription & credits",
    href: "/account",
  },
  {
    icon: Bookmark,
    title: "Saved Profiles",
    description: "Your shortlist",
    href: "/browse-talent?view=saved",
  },
];

const TALENT_MENU: NavChild[] = [
  {
    icon: LayoutDashboard,
    title: "Talent Dashboard",
    description: "View your profile",
    href: "/talent/dashboard",
  },
  {
    icon: SquarePen,
    title: "Edit Profile",
    description: "Update your details",
    href: "/talent/dashboard/edit",
  },
];

// sessionStorage cache key — keyed by user id so a sign-in / sign-out swap
// invalidates correctly. Cleared on SIGNED_OUT and inside handleSignOut.
const NAV_ROLE_CACHE_KEY = "remotiv_nav_role";

// Data shapes for the data-driven mega-menu. `children` presence → dropdown;
// `soon: true` (or missing href) → renders a non-clickable row with a badge.
type NavChild = {
  icon: LucideIcon;
  title: string;
  description: string;
  href?: string;
  soon?: boolean;
};

type NavItem = {
  label: string;
  href?: string;
  children?: NavChild[];
};

const NAV_ITEMS: readonly NavItem[] = [
  {
    label: "For Talent",
    children: [
      {
        icon: UserPlus,
        title: "Join as Talent",
        description: "Get hired by top companies",
        href: "/join-as-talent",
      },
      {
        icon: Briefcase,
        title: "Join as Freelancer",
        description: "Find remote freelance work",
        href: "/remote-ready",
      },
    ],
  },
  {
    label: "Services",
    children: [
      {
        icon: Users,
        title: "Recruitment",
        description: "End-to-end hiring, done for you",
        href: "/services/recruitment",
      },
      {
        icon: TrendingUp,
        title: "Staff Augmentation",
        description: "Scale your team on demand",
        href: "/services/staff-augmentation",
      },
      {
        icon: UserCheck,
        title: "Dedicated Team",
        description: "A full remote team, managed",
        href: "/services/dedicated-team",
      },
      {
        icon: Wallet,
        title: "Payroll Services",
        description: "Pay global talent, compliantly",
        href: "/services/payroll",
      },
    ],
  },
  {
    label: "For Companies",
    children: [
      {
        icon: Search,
        title: "Find Talent",
        description: "Browse our talent pool",
        href: "/browse-talent",
      },
      {
        icon: Globe,
        title: "Find Freelancers",
        description: "Hire remote, pay by the hour",
        href: "/find-freelancers",
      },
      {
        icon: Sparkles,
        title: "AI Talent Match",
        description: "Let AI find your best fit",
        href: "/ai-matching",
      },
      {
        icon: Video,
        title: "AI Video Interviews",
        description: "Automated screening interviews",
        soon: true,
      },
    ],
  },
  {
    label: "Browse Jobs",
    href: "/jobs",
  },
];

const LOGIN_ITEM: NavItem = {
  label: "Login",
  children: [
    {
      icon: User,
      title: "Talent Login",
      description: "Manage your profile & jobs",
      href: "/talent/login",
    },
    {
      icon: Building2,
      title: "Employer Login",
      description: "Browse, save & hire talent",
      href: "/signin",
    },
    {
      icon: CirclePlus,
      title: "Sign up",
      description: "Create a free account",
      href: "/signup",
    },
  ],
};

const NAV_LINK_CLASS =
  "flex items-center gap-1 whitespace-nowrap rounded-full px-3.5 py-[7px] text-[0.88rem] font-medium text-[#444] transition-colors hover:bg-black/[0.04] hover:text-[#111]";

const MOBILE_LINK_CLASS =
  "flex items-center justify-between rounded-xl px-4 py-4 font-heading text-[1.25rem] font-semibold text-[#111] transition-colors hover:bg-black/[0.04]";

function ChevronSvg({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 opacity-[0.45] transition-transform duration-200",
        open && "rotate-180 opacity-70",
      )}
    >
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DesktopRow({
  child,
  pathname,
}: {
  child: NavChild;
  pathname: string | null;
}) {
  const Icon = child.icon;
  const rowClass =
    "flex items-start gap-3 rounded-xl px-3 py-[10px] text-left transition-colors hover:bg-remotiv-green/[0.09]";
  const iconBox =
    "flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white text-[#111]";
  const inner = (
    <>
      <span className={iconBox}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="block text-[0.82rem] font-bold text-[#111] leading-[1.3]">
            {child.title}
          </span>
          {child.soon && (
            <span className="inline-flex items-center rounded-full bg-remotiv-purple/[0.12] px-2 py-[1px] text-[0.62rem] font-semibold text-remotiv-purple">
              Soon
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[0.73rem] font-normal text-[#aaa]">
          {child.description}
        </span>
      </span>
    </>
  );

  if (child.soon || !child.href) {
    return (
      <div className={cn(rowClass, "cursor-default opacity-90 hover:bg-transparent")}>
        {inner}
      </div>
    );
  }

  return (
    <Link
      href={child.href}
      aria-current={pathname === child.href ? "page" : undefined}
      className={rowClass}
    >
      {inner}
    </Link>
  );
}

function DropdownMenu({ item }: { item: NavItem }) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const pathname = usePathname();
  const children = item.children ?? [];
  const isTwoCol = children.length > 2;

  function show() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }

  function hide() {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper for dropdown
    <span className="relative" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" aria-expanded={open} className={NAV_LINK_CLASS}>
        {item.label}
        <ChevronSvg open={open} />
      </button>
      <div
        className={cn(
          "pointer-events-none absolute right-0 top-[calc(100%+14px)] z-[200] -translate-y-1 opacity-0 transition-all duration-200",
          isTwoCol ? "w-[480px]" : "w-[320px]",
          open && "pointer-events-auto translate-y-0 opacity-100",
        )}
      >
        <div className="relative rounded-[18px] border border-black/[0.08] bg-white/[0.98] p-2 shadow-[0_16px_48px_rgba(0,0,0,0.12)] backdrop-blur-[20px]">
          <div className="absolute -top-[5px] right-6 size-2.5 rotate-45 border-l border-t border-black/[0.08] bg-white" />
          <div className={cn("grid gap-1", isTwoCol ? "grid-cols-2" : "grid-cols-1")}>
            {children.map((child) => (
              <DesktopRow key={child.title} child={child} pathname={pathname} />
            ))}
          </div>
        </div>
      </div>
    </span>
  );
}

// Live account menu — shown in place of the LOGIN dropdown when authUser is set.
// Reuses the DropdownMenu hover/focus + 150ms close timing and panel styling.
function AccountMenu({
  authUser,
  role,
  onSignOut,
}: {
  authUser: { email: string | null; fullName: string | null };
  role: "talent" | "employer" | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const pathname = usePathname();

  function show() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }
  function hide() {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }

  const initial = (
    authUser.fullName?.charAt(0) ||
    authUser.email?.charAt(0) ||
    "?"
  ).toUpperCase();
  // Default to EMPLOYER_MENU while role is still resolving — /account works
  // for any logged-in user, so the brief default is harmless.
  const accountLinks = role === "talent" ? TALENT_MENU : EMPLOYER_MENU;
  const roleLabel = role === "talent" ? "Talent" : "Employer";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper for dropdown
    <span
      className="relative inline-flex animate-in fade-in duration-200"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-1.5 rounded-full px-1 py-0.5 transition-colors hover:bg-black/[0.04]"
      >
        <span className="flex size-[26px] items-center justify-center rounded-full bg-remotiv-purple text-[0.72rem] font-semibold text-white">
          {initial}
        </span>
        <ChevronSvg open={open} />
      </button>
      <div
        className={cn(
          "pointer-events-none absolute right-0 top-[calc(100%+14px)] z-[200] w-[280px] -translate-y-1 opacity-0 transition-all duration-200",
          open && "pointer-events-auto translate-y-0 opacity-100",
        )}
      >
        <div className="relative rounded-[18px] border border-black/[0.08] bg-white/[0.98] p-2 shadow-[0_16px_48px_rgba(0,0,0,0.12)] backdrop-blur-[20px]">
          <div className="absolute -top-[5px] right-3 size-2.5 rotate-45 border-l border-t border-black/[0.08] bg-white" />
          <div className="px-3 pt-2 pb-2">
            <div className="truncate text-[0.78rem] font-semibold text-[#111]">
              {authUser.email ?? "Signed in"}
            </div>
            <div className="text-[0.7rem] font-normal text-[#aaa]">{roleLabel}</div>
          </div>
          <div className="my-1 border-t border-black/[0.06]" />
          <div className="grid grid-cols-1 gap-1">
            {accountLinks.map((child) => (
              <DesktopRow key={child.title} child={child} pathname={pathname} />
            ))}
          </div>
          <div className="my-1 border-t border-black/[0.06]" />
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-start gap-3 rounded-xl px-3 py-[10px] text-left transition-colors hover:bg-red-50"
          >
            <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white text-red-600">
              <LogOut className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.82rem] font-bold text-red-600 leading-[1.3]">
                Sign out
              </span>
              <span className="mt-0.5 block text-[0.73rem] font-normal text-[#aaa]">
                End your session
              </span>
            </span>
          </button>
        </div>
      </div>
    </span>
  );
}

// Mobile equivalent of <AccountMenu> — flat list (no accordion) so the user
// sees their identity + the role-appropriate links + Sign out at a glance.
function MobileAccountBlock({
  authUser,
  role,
  pathname,
  onLink,
  onSignOut,
}: {
  authUser: { email: string | null; fullName: string | null };
  role: "talent" | "employer" | null;
  pathname: string | null;
  onLink: () => void;
  onSignOut: () => void;
}) {
  const initial = (
    authUser.fullName?.charAt(0) ||
    authUser.email?.charAt(0) ||
    "?"
  ).toUpperCase();
  const accountLinks = role === "talent" ? TALENT_MENU : EMPLOYER_MENU;
  const roleLabel = role === "talent" ? "Talent" : "Employer";
  const rowClass =
    "flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-black/[0.04]";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-3 py-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-remotiv-purple text-[1rem] font-semibold text-white">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.95rem] font-semibold text-[#111]">
            {authUser.email ?? "Signed in"}
          </div>
          <div className="text-[0.78rem] font-normal text-[#888]">{roleLabel}</div>
        </div>
      </div>
      <div className="flex flex-col gap-1 pt-1">
        {accountLinks.map((child) => {
          const Icon = child.icon;
          return (
            <Link
              key={child.title}
              href={child.href ?? "#"}
              onClick={onLink}
              aria-current={pathname === child.href ? "page" : undefined}
              className={rowClass}
            >
              <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white text-[#111]">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.95rem] font-semibold text-[#111] leading-[1.3]">
                  {child.title}
                </span>
                <span className="mt-0.5 block text-[0.78rem] font-normal text-[#888]">
                  {child.description}
                </span>
              </span>
            </Link>
          );
        })}
        <button type="button" onClick={onSignOut} className={cn(rowClass, "text-left")}>
          <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white text-red-600">
            <LogOut className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.95rem] font-semibold text-red-600 leading-[1.3]">
              Sign out
            </span>
            <span className="mt-0.5 block text-[0.78rem] font-normal text-[#888]">
              End your session
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

interface NavbarProps {
  variant?: "home" | "default";
}

export function Navbar({ variant = "default" }: NavbarProps) {
  const isHome = variant === "home";
  const pathname = usePathname();
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Generic accordion state — replaces the old isServicesExpanded boolean.
  // null when no section is expanded; otherwise holds the expanded item's label.
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  // Live auth state — null while unresolved AND while signed-out. The avatar
  // menu only renders when authUser is truthy, so the SSR-rendered logged-out
  // tree (Login dropdown) is what hydrates first → no hydration mismatch.
  const [authUser, setAuthUser] = useState<
    { id: string; email: string | null; fullName: string | null } | null
  >(null);
  const [role, setRole] = useState<"talent" | "employer" | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to the browser Supabase session — mirrors footer-account-column.
  // SIGNED_IN populates authUser; SIGNED_OUT clears authUser + role + the
  // sessionStorage cache key so the next sign-in re-fetches role.
  useEffect(() => {
    const supabase = createBrowserClient();
    let cancelled = false;

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (cancelled || !user) return;
      setAuthUser({
        id: user.id,
        email: user.email ?? null,
        fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setAuthUser({
          id: session.user.id,
          email: session.user.email ?? null,
          fullName:
            (session.user.user_metadata?.full_name as string | undefined) ?? null,
        });
      } else {
        setAuthUser(null);
        setRole(null);
        try {
          sessionStorage.removeItem(NAV_ROLE_CACHE_KEY);
        } catch {
          // sessionStorage can throw in privacy modes / SSR — swallow.
        }
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // Resolve role for the current authUser. Cached per user-id in sessionStorage
  // so we don't refetch on every navbar mount across pages. On error, default
  // to "employer" — /account works for any logged-in user, so this is safe.
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;

    try {
      const raw = sessionStorage.getItem(NAV_ROLE_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: string; role?: string };
        if (
          parsed.id === authUser.id &&
          (parsed.role === "talent" || parsed.role === "employer")
        ) {
          setRole(parsed.role);
          return () => {
            cancelled = true;
          };
        }
      }
    } catch {
      // ignore cache read errors and fall through to the network fetch
    }

    fetch("/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((j: { loggedIn?: boolean; role?: "talent" | "employer" }) => {
        if (cancelled) return;
        const resolved: "talent" | "employer" =
          j.loggedIn && (j.role === "talent" || j.role === "employer")
            ? j.role
            : "employer";
        setRole(resolved);
        try {
          sessionStorage.setItem(
            NAV_ROLE_CACHE_KEY,
            JSON.stringify({ id: authUser.id, role: resolved }),
          );
        } catch {
          // ignore cache write errors
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRole("employer");
      });

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  async function handleSignOut() {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    try {
      sessionStorage.removeItem(NAV_ROLE_CACHE_KEY);
    } catch {
      // ignore
    }
    router.push("/");
    router.refresh();
  }

  // Lock body scroll when overlay is open
  useEffect(() => {
    if (isMenuOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isMenuOpen]);

  // ESC key closes the overlay
  useEffect(() => {
    if (!isMenuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsMenuOpen(false);
        setExpandedLabel(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMenuOpen]);

  // Focus trap — when overlay is open, cycle Tab/Shift+Tab within it
  useEffect(() => {
    if (!isMenuOpen || !overlayRef.current) return;

    const overlay = overlayRef.current;
    const focusables = overlay.querySelectorAll<HTMLElement>(
      'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // Focus first element on open
    first.focus();

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [isMenuOpen]);

  function closeMenu() {
    setIsMenuOpen(false);
    setExpandedLabel(null);
  }

  function renderMobileItem(item: NavItem) {
    if (item.children) {
      const expanded = expandedLabel === item.label;
      return (
        <div key={item.label} className="flex flex-col">
          <button
            type="button"
            onClick={() =>
              setExpandedLabel((prev) => (prev === item.label ? null : item.label))
            }
            aria-expanded={expanded}
            className={MOBILE_LINK_CLASS}
          >
            {item.label}
            <ChevronDown
              className={cn(
                "size-5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </button>
          {expanded && (
            <div className="flex flex-col gap-1 pt-2 pb-3 pl-2">
              {item.children.map((child) => {
                const Icon = child.icon;
                const rowClass =
                  "flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-black/[0.04]";
                const inner = (
                  <>
                    <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white text-[#111]">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="block text-[0.95rem] font-semibold text-[#111] leading-[1.3]">
                          {child.title}
                        </span>
                        {child.soon && (
                          <span className="inline-flex items-center rounded-full bg-remotiv-purple/[0.12] px-2 py-[1px] text-[0.62rem] font-semibold text-remotiv-purple">
                            Soon
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[0.78rem] font-normal text-[#888]">
                        {child.description}
                      </span>
                    </span>
                  </>
                );
                if (child.soon || !child.href) {
                  return (
                    <div
                      key={child.title}
                      className={cn(rowClass, "cursor-default opacity-90")}
                    >
                      {inner}
                    </div>
                  );
                }
                return (
                  <Link
                    key={child.title}
                    href={child.href}
                    onClick={closeMenu}
                    aria-current={pathname === child.href ? "page" : undefined}
                    className={rowClass}
                  >
                    {inner}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    return (
      <Link
        key={item.label}
        href={item.href ?? "#"}
        onClick={closeMenu}
        aria-current={item.href && pathname === item.href ? "page" : undefined}
        className={MOBILE_LINK_CLASS}
      >
        {item.label}
      </Link>
    );
  }

  return (
    <>
      <nav
        data-nav={isHome ? undefined : ""}
        className={cn(
          "flex items-center justify-between",
          isHome
            ? "relative z-[100] px-14 py-[22px] max-md:px-6 max-md:py-[18px]"
            : "sticky top-0 z-[200] border-b border-black/[0.07] bg-white px-14 py-[18px] max-md:px-6",
        )}
      >
        <button
          type="button"
          onClick={() => setIsMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={isMenuOpen}
          className="flex size-11 items-center justify-center text-[#111] lg:hidden"
        >
          <Menu className="size-6" />
        </button>

        <Link
          href="/"
          className="inline-flex items-center font-heading text-[1.45rem] font-bold tracking-[0.01em] text-remotiv-green"
        >
          Remotiv<span className="font-extrabold">.</span>
        </Link>

        <ul
          className={cn(
            // Reference padding is 6px 16px (px-4 py-1.5 = 16px / 6px ✓).
            "hidden list-none items-center gap-0.5 rounded-full border border-black/[0.08] px-4 py-1.5 shadow-[0_4px_24px_rgba(0,0,0,0.07)] backdrop-blur-[16px] lg:flex",
            isHome ? "bg-white/[0.92]" : "bg-[rgba(238,238,232,0.95)]",
            // Float offset moved to a CSS module — see navbar.module.css.
            isHome && styles.navPillFloat,
          )}
        >
          {NAV_ITEMS.map((item) => (
            <li key={item.label} className="list-none">
              {item.children ? (
                <DropdownMenu item={item} />
              ) : (
                <Link
                  href={item.href ?? "#"}
                  aria-current={item.href && pathname === item.href ? "page" : undefined}
                  className={NAV_LINK_CLASS}
                >
                  {item.label}
                </Link>
              )}
            </li>
          ))}
          <li className="list-none" aria-hidden="true">
            <span className="mx-1 inline-block h-4 w-px bg-black/[0.1]" />
          </li>
          <li className="list-none">
            {authUser ? (
              <AccountMenu
                authUser={authUser}
                role={role}
                onSignOut={handleSignOut}
              />
            ) : (
              <DropdownMenu item={LOGIN_ITEM} />
            )}
          </li>
        </ul>

        <Link
          href="/book-a-meeting"
          className={cn(
            "hidden rounded-[14px] bg-remotiv-green px-6 py-[11px] text-[0.92rem] font-semibold text-[#111] hover:bg-[#3bc495] lg:inline-flex",
            // Float-up + slide-right + hover transitions live in the module.
            isHome && styles.btnLoginFloat,
          )}
        >
          Book a meeting
        </Link>
      </nav>

      {isMenuOpen && (
        <div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation menu"
          className="fixed inset-0 z-[300] flex flex-col bg-white lg:hidden"
        >
          <div className="flex items-center justify-between px-6 py-[18px]">
            <Link
              href="/"
              onClick={closeMenu}
              className="inline-flex items-center font-heading text-[1.45rem] font-bold tracking-[0.01em] text-remotiv-green"
            >
              Remotiv<span className="font-extrabold">.</span>
            </Link>
            <button
              type="button"
              onClick={closeMenu}
              aria-label="Close menu"
              className="flex size-11 items-center justify-center text-[#111]"
            >
              <X className="size-6" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-6 py-8">
            {NAV_ITEMS.map(renderMobileItem)}
            <div className="mt-2 border-t border-black/[0.08] pt-2">
              {authUser ? (
                <MobileAccountBlock
                  authUser={authUser}
                  role={role}
                  pathname={pathname}
                  onLink={closeMenu}
                  onSignOut={() => {
                    closeMenu();
                    void handleSignOut();
                  }}
                />
              ) : (
                renderMobileItem(LOGIN_ITEM)
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
