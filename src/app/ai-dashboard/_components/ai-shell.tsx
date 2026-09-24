"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { AiSidebar } from "./ai-sidebar";
import { AiTopbar } from "./ai-topbar";
import { HelpPanel } from "./help-panel";

/**
 * Client wrapper owning the state the sidebar and topbar share: whether the
 * mobile drawer is open, and whether Help is open. Everything else is passed
 * down from the gated layout's already-resolved CompanyContext.
 *
 * Help lives here rather than in the sidebar because the sidebar renders twice
 * — a desktop rail and a mobile drawer — and a panel owned by either one would
 * exist twice, or vanish with the drawer that opened it.
 */
export function AiShell({
  companyName,
  companyLogoUrl,
  role,
  userName,
  userEmail,
  jobCount,
  applicantCount,
  messageCount,
  interviewCount,
  children,
}: {
  companyName: string;
  companyLogoUrl: string | null;
  role: CompanyRole;
  userName: string;
  userEmail: string;
  // Undefined means the count could not be read, not zero — the sidebar
  // renders no badge for it rather than asserting a number nobody verified.
  jobCount: number | undefined;
  applicantCount: number | undefined;
  messageCount: number | undefined;
  interviewCount: number | undefined;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Stable so HelpPanel's Escape/scroll-lock effect does not re-run on every
  // shell render.
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  // Close on route change so users land on the new page cleanly.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Escape closes; body scroll locks while the drawer is open.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <div className="ai-shell ai-app-bg flex min-h-[var(--vh-full)] bg-[var(--ai-page)] font-sans text-[var(--ai-t1)]">
      <AiSidebar
        companyName={companyName}
        companyLogoUrl={companyLogoUrl}
        role={role}
        jobCount={jobCount}
        applicantCount={applicantCount}
        messageCount={messageCount}
        interviewCount={interviewCount}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onOpenHelp={() => setHelpOpen(true)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AiTopbar
          name={userName}
          email={userEmail}
          onMenuClick={() => setMobileOpen(true)}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      {helpOpen && <HelpPanel onClose={closeHelp} />}
    </div>
  );
}
