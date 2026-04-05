"use client";

import { ChevronDown } from "lucide-react";
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
    subtitle: "Find the perfect candidates for your team",
    href: "/services/recruitment",
  },
  {
    title: "Staff Augmentation",
    subtitle: "Scale your team with skilled professionals",
    href: "/services/staff-augmentation",
  },
  {
    title: "Dedicated Team",
    subtitle: "Build a fully managed remote team",
    href: "/services/dedicated-team",
  },
  {
    title: "Payroll Services",
    subtitle: "Streamline your global payroll operations",
    href: "/services/payroll",
  },
];

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
    // biome-ignore lint/a11y/noStaticElementInteractions: hover wrapper for dropdown menu
    <span className="relative" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100/80"
      >
        Services
        <ChevronDown
          className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
        />
      </button>
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-full z-50 w-72 -translate-x-1/2 pt-2 opacity-0 transition-all duration-200",
          open && "pointer-events-auto opacity-100",
        )}
      >
        <div className="rounded-2xl border border-gray-100 bg-white p-2 shadow-xl">
          {SERVICES.map((service) => (
            <Link
              key={service.href}
              href={service.href}
              className="block rounded-xl px-4 py-3 text-left transition-colors hover:bg-gray-50"
            >
              <span className="block text-sm font-semibold text-gray-900">{service.title}</span>
              <span className="block text-xs text-gray-500">{service.subtitle}</span>
            </Link>
          ))}
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
        "w-full z-50",
        isHome ? "absolute top-0 left-0" : "sticky top-0 bg-white shadow-sm",
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-heading text-2xl font-bold">
          <span className="text-remotiv-green">Remotiv.</span>
        </Link>

        <div
          className={cn(
            "hidden items-center gap-1 rounded-full border border-white/60 bg-white/80 px-2 py-1.5 shadow-lg backdrop-blur-md lg:flex",
            isHome && "-translate-y-[9px]",
          )}
        >
          {NAV_ITEMS.map((item) =>
            item.hasDropdown ? (
              <ServicesDropdown key={item.label} />
            ) : (
              <Link
                key={item.label}
                href={item.href}
                className="rounded-full px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100/80"
              >
                {item.label}
              </Link>
            ),
          )}
        </div>

        <Link
          href="/book-a-meeting"
          className={cn(
            "rounded-full bg-remotiv-green px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-remotiv-green-light",
            isHome && "-translate-y-[6px] translate-x-[14px]",
          )}
        >
          Book A Meeting
        </Link>
      </div>
    </nav>
  );
}
