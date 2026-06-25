"use client";

import {
  Briefcase,
  Building2,
  ChevronDown,
  CirclePlus,
  Globe,
  type LucideIcon,
  Menu,
  Search,
  Sparkles,
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
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./navbar.module.css";

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
        href: "/become-a-talent",
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
        title: "Hire Freelancers",
        description: "Hire remote, pay by the hour",
        href: "/hire-remote",
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

interface NavbarProps {
  variant?: "home" | "default";
}

export function Navbar({ variant = "default" }: NavbarProps) {
  const isHome = variant === "home";
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Generic accordion state — replaces the old isServicesExpanded boolean.
  // null when no section is expanded; otherwise holds the expanded item's label.
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

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
            <DropdownMenu item={LOGIN_ITEM} />
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
              {renderMobileItem(LOGIN_ITEM)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
