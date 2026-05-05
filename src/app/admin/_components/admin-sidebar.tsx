"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  CalendarDays,
  Users,
  LogOut,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const NAV_LINKS = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/contacts", label: "Contacts", icon: MessageSquare },
  { href: "/admin/bookings", label: "Bookings", icon: CalendarDays },
  { href: "/admin/team", label: "Team", icon: Users },
];

export function AdminSidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-gray-100 bg-white">
      <div className="flex items-center border-b border-gray-100 px-6 py-5">
        <span style={{ fontFamily: "'Sora', sans-serif", color: "#7E47FF", fontSize: "1.375rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
          Remotiv.
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-0.5">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-[#49D7A7]/10 font-semibold text-[#49D7A7]"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
                  }`}
                >
                  <Icon
                    className={`size-4 shrink-0 ${active ? "text-[#49D7A7]" : "text-gray-400"}`}
                    strokeWidth={2}
                  />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-gray-100 px-4 py-4">
        <p className="mb-3 truncate text-xs text-gray-400">{email}</p>
        <button
          type="button"
          onClick={handleSignOut}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-red-50 hover:text-red-500"
        >
          <LogOut className="size-4" strokeWidth={2} />
          Sign out
        </button>
      </div>
    </aside>
  );
}