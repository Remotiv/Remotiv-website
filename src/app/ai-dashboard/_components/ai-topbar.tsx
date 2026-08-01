"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell, LogOut, Menu, Search } from "lucide-react";

// Breadcrumb tail per route. Keys are exact pathnames; the /ai-dashboard root
// is the Overview page.
const CRUMBS: Record<string, { section: string; page: string }> = {
  "/ai-dashboard": { section: "Workspace", page: "Overview" },
  "/ai-dashboard/jobs": { section: "Workspace", page: "Jobs" },
  "/ai-dashboard/applicants": { section: "Workspace", page: "Applicants" },
  "/ai-dashboard/team": { section: "Workspace", page: "Team" },
};

function getInitials(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase() || "?";
}

export function AiTopbar({
  name,
  email,
  onMenuClick,
}: {
  name: string;
  email: string;
  onMenuClick: () => void;
}) {
  const pathname = usePathname();
  const crumb = CRUMBS[pathname] ?? { section: "Workspace", page: "" };

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-30 flex h-[60px] shrink-0 items-center gap-4 border-b border-[var(--ai-line)] bg-[var(--ai-inset)]/80 px-4 backdrop-blur-xl min-[840px]:px-8">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] min-[840px]:hidden"
      >
        <Menu className="size-5" strokeWidth={2} />
      </button>

      <span className="truncate text-[13px] text-[var(--ai-t3)]">
        {crumb.section}
        {crumb.page && (
          <>
            {" · "}
            <b className="font-semibold text-[var(--ai-t1)]">{crumb.page}</b>
          </>
        )}
      </span>

      <div className="ml-auto hidden items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] min-[630px]:flex min-[630px]:w-[220px]">
        <Search className="size-[15px] shrink-0" strokeWidth={1.8} />
        <input
          type="search"
          aria-label="Search people"
          placeholder="Search people…"
          disabled
          className="w-full min-w-0 bg-transparent text-[13px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)] disabled:cursor-not-allowed"
        />
      </div>

      {/* Disabled until notifications exist. It previously had no handler and
          no disabled state — the one control in the product that looked live
          and did nothing. Same honest treatment as Archive and Weekly report. */}
      <button
        type="button"
        disabled
        aria-label="Notifications"
        title="Notifications arrive in a later release"
        className="relative ml-auto flex size-[34px] shrink-0 items-center justify-center rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] disabled:cursor-not-allowed disabled:opacity-55 min-[630px]:ml-0"
      >
        <Bell className="size-[18px]" strokeWidth={1.7} />
      </button>

      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((p) => !p)}
          aria-label={`Account menu for ${email}`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex size-[34px] items-center justify-center rounded-full bg-remotiv-green text-[12px] font-semibold text-[var(--ai-mint-ink)] ring-2 ring-transparent transition-all hover:ring-remotiv-green/40"
        >
          {getInitials(name, email)}
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-11 z-40 w-56 overflow-hidden rounded-xl border border-[var(--ai-line)] bg-white shadow-lg">
            <div className="px-4 py-3">
              <p className="truncate text-sm font-semibold text-[var(--ai-t1)]">
                {name}
              </p>
              <p className="truncate text-xs text-[var(--ai-t3)]">{email}</p>
            </div>
            <div className="border-t border-[var(--ai-line)]" />
            <form action="/ai-dashboard/logout" method="post">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-[var(--ai-t2)] transition-colors hover:bg-red-50 hover:text-[var(--ai-danger)]"
              >
                <LogOut className="size-4" strokeWidth={2} />
                Sign Out
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
