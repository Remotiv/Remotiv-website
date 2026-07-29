"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { AiSidebar } from "./ai-sidebar";
import { AiTopbar } from "./ai-topbar";

/**
 * Client wrapper owning the one piece of state the sidebar and topbar share:
 * whether the mobile drawer is open. Everything else is passed down from the
 * gated layout's already-resolved CompanyContext.
 */
export function AiShell({
  companyName,
  role,
  userName,
  userEmail,
  children,
}: {
  companyName: string;
  role: CompanyRole;
  userName: string;
  userEmail: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

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
    <div className="ai-shell flex min-h-screen bg-[var(--ai-page)] font-sans text-[var(--ai-t1)]">
      <AiSidebar
        companyName={companyName}
        role={role}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AiTopbar
          name={userName}
          email={userEmail}
          onMenuClick={() => setMobileOpen(true)}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
