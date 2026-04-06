"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

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

function ChevronSvg({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 opacity-45 transition-transform duration-200",
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
                className="block rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-remotiv-green/[0.09]"
              >
                <span className="block text-[0.82rem] font-bold text-[#111] leading-snug">
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

  return (
    <nav
      className={cn(
        "w-full z-[100]",
        isHome ? "absolute top-0 left-0" : "sticky top-0 bg-white shadow-sm",
      )}
    >
      <div className="mx-auto flex items-center justify-between px-14 py-[22px]">
        <Link href="/" className="font-heading text-[1.45rem] font-bold tracking-[0.01em]">
          <span className="text-remotiv-green">Remotiv.</span>
        </Link>

        <ul
          className={cn(
            "hidden list-none items-center gap-0.5 rounded-full border border-black/[0.08] bg-white/92 px-4 py-1.5 shadow-[0_4px_24px_rgba(0,0,0,0.07)] backdrop-blur-[16px] md:flex",
            isHome && "-translate-y-[9px]",
          )}
        >
          {NAV_ITEMS.map((item) => (
            <li key={item.label}>
              {item.hasDropdown ? (
                <ServicesDropdown />
              ) : (
                <Link href={item.href} className={NAV_LINK_CLASS}>
                  {item.label}
                </Link>
              )}
            </li>
          ))}
        </ul>

        <Link
          href="/book-a-meeting"
          className={cn(
            "rounded-[14px] bg-remotiv-green px-6 py-[11px] text-[0.92rem] font-semibold text-[#111] transition-all hover:bg-remotiv-green-light hover:-translate-y-0.5",
            isHome && "-translate-y-[6px] translate-x-[14px]",
          )}
        >
          Book A Meeting
        </Link>
      </div>
    </nav>
  );
}
