"use client";

import { ChevronDown, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./navbar.module.css";

const NAV_ITEMS: readonly {
  label: string;
  href: string;
  hasDropdown?: boolean;
}[] = [
  { label: "Become a talent", href: "/become-a-talent" },
  { label: "Services", href: "#", hasDropdown: true },
  { label: "Browse Talent", href: "/browse-talent" },
  { label: "Jobs", href: "/jobs" },
  { label: "AI Matching", href: "/ai-matching" },
];

const SERVICES = [
  {
    title: "Recruitment",
    subtitle: "End-to-end hiring",
    href: "/services/recruitment",
  },
  {
    title: "Staff Augmentation",
    subtitle: "Scale your team fast",
    href: "/services/staff-augmentation",
  },
  {
    title: "Dedicated Team",
    subtitle: "Full team, your product",
    href: "/services/dedicated-team",
  },
  {
    title: "Payroll Services",
    subtitle: "Compliant & hassle-free",
    href: "/services/payroll",
  },
];

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

function ServicesDropdown() {
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

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper for dropdown
    <span className="relative" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" aria-expanded={open} className={NAV_LINK_CLASS}>
        Services
        <ChevronSvg open={open} />
      </button>
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-[calc(100%+14px)] z-[200] w-[400px] -translate-x-1/2 opacity-0 transition-all duration-200",
          open && "pointer-events-auto opacity-100",
        )}
      >
        <div className="relative rounded-[18px] border border-black/[0.08] bg-white/[0.98] p-2 shadow-[0_16px_48px_rgba(0,0,0,0.12)] backdrop-blur-[20px]">
          <div className="absolute -top-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 border-l border-t border-black/[0.08] bg-white" />
          <div className="grid grid-cols-2 gap-1">
            {SERVICES.map((service) => (
              <Link
                key={service.href}
                href={service.href}
                aria-current={pathname === service.href ? "page" : undefined}
                className="block rounded-xl px-3 py-[9px] text-left transition-colors hover:bg-remotiv-green/[0.09]"
              >
                <span className="block text-[0.82rem] font-bold text-[#111] leading-[1.3]">
                  {service.title}
                </span>
                <span className="block text-[0.73rem] font-normal text-[#aaa]">
                  {service.subtitle}
                </span>
              </Link>
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
  const [isServicesExpanded, setIsServicesExpanded] = useState(false);
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
        setIsServicesExpanded(false);
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
    setIsServicesExpanded(false);
  }

  return (
    <>
      <nav
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
              {item.hasDropdown ? (
                <ServicesDropdown />
              ) : (
                <Link
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                  className={NAV_LINK_CLASS}
                >
                  {item.label}
                </Link>
              )}
            </li>
          ))}
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
            {NAV_ITEMS.map((item) => {
              if (item.hasDropdown) {
                return (
                  <div key={item.label} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => setIsServicesExpanded((prev) => !prev)}
                      aria-expanded={isServicesExpanded}
                      className={MOBILE_LINK_CLASS}
                    >
                      Services
                      <ChevronDown
                        className={cn(
                          "size-5 transition-transform duration-200",
                          isServicesExpanded && "rotate-180",
                        )}
                      />
                    </button>
                    {isServicesExpanded && (
                      <div className="flex flex-col gap-1 pt-2 pb-3 pl-6">
                        {SERVICES.map((service) => (
                          <Link
                            key={service.href}
                            href={service.href}
                            onClick={closeMenu}
                            aria-current={pathname === service.href ? "page" : undefined}
                            className="rounded-lg px-4 py-3 font-sans text-[0.95rem] font-medium text-[#444] transition-colors hover:bg-black/[0.04] hover:text-[#111]"
                          >
                            {service.title}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={closeMenu}
                  aria-current={pathname === item.href ? "page" : undefined}
                  className={MOBILE_LINK_CLASS}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
