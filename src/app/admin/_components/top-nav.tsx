"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import { Bell, Search, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const TOP_NAV = [
  { label: "Dashboard", href: "/admin" },
  { label: "Talent", href: "/admin/profiles" },
  { label: "Jobs", href: "/admin/jobs" },
  { label: "Contacts", href: "/admin/contacts" },
  { label: "Bookings", href: "/admin/bookings" },
  { label: "Team", href: "/admin/team" },
];

export function TopNav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false);
      }
    }
    if (avatarOpen) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [avatarOpen]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-20 hidden h-16 items-center justify-between border-b border-gray-100 bg-white px-8 lg:flex">
      <span className="font-heading text-xl font-bold tracking-tight text-[#7E47FF]">
        Remotiv.
      </span>

      <nav className="flex items-center gap-1">
        {TOP_NAV.map(({ label, href }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-[#7E47FF] text-white"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-xl bg-gray-50 px-3.5 py-2">
          <Search className="size-4 text-gray-400" strokeWidth={2} />
          <input
            placeholder="Search"
            className="w-32 bg-transparent text-sm text-gray-600 outline-none placeholder:text-gray-400"
          />
        </div>
        <button type="button" className="relative rounded-xl p-2 hover:bg-gray-50">
          <Bell className="size-5 text-gray-500" strokeWidth={2} />
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500" />
        </button>
        <div ref={avatarRef} className="relative">
          <button
            type="button"
            onClick={() => setAvatarOpen((p) => !p)}
            className="relative size-9 overflow-hidden rounded-full ring-2 ring-transparent transition-all hover:ring-[#7E47FF]/40"
          >
            <Image
              src="/avatars/Waleed.png"
              alt="Profile"
              fill
              className="object-cover"
            />
          </button>
          {avatarOpen && (
            <div className="absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
              <div className="px-4 py-3">
                <p className="truncate text-xs text-gray-400">{email}</p>
              </div>
              <div className="border-t border-gray-100" />
              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-gray-600 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <LogOut className="size-4" strokeWidth={2} />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
