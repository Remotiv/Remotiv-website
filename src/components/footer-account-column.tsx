"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type AuthState = {
  isLoggedIn: boolean;
  userId: string | null;
  email: string;
  fullName: string | null;
};

// Shared with navbar (src/components/navbar.tsx). When both surfaces are
// mounted on the same page, only ONE /api/me fetch happens per session —
// whichever loads first warms the cache and the other reads it.
const NAV_ROLE_CACHE_KEY = "remotiv_nav_role";

export function FooterAccountColumn() {
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>({
    isLoggedIn: false,
    userId: null,
    email: "",
    fullName: null,
  });
  const [role, setRole] = useState<"talent" | "employer" | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Initial check
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setAuthState({
          isLoggedIn: true,
          userId: user.id,
          email: user.email ?? "",
          fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
        });
      }
    });

    // Subscribe to auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setAuthState({
          isLoggedIn: true,
          userId: session.user.id,
          email: session.user.email ?? "",
          fullName: (session.user.user_metadata?.full_name as string | undefined) ?? null,
        });
      } else {
        setAuthState({ isLoggedIn: false, userId: null, email: "", fullName: null });
        setRole(null);
        try {
          sessionStorage.removeItem(NAV_ROLE_CACHE_KEY);
        } catch {
          // sessionStorage can throw in privacy modes — swallow.
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Resolve role for the logged-in user. Mirrors navbar.tsx — reads/writes
  // the same sessionStorage key so a single /api/me fetch serves both
  // components on pages where they coexist. Defaults to "employer" on any
  // error (the /account page works for any logged-in user).
  useEffect(() => {
    if (!authState.isLoggedIn || !authState.userId) return;
    const userId = authState.userId;
    let cancelled = false;

    try {
      const raw = sessionStorage.getItem(NAV_ROLE_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: string; role?: string };
        if (
          parsed.id === userId &&
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
            JSON.stringify({ id: userId, role: resolved }),
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
  }, [authState.isLoggedIn, authState.userId]);

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    try {
      sessionStorage.removeItem(NAV_ROLE_CACHE_KEY);
    } catch {
      // ignore
    }
    router.push("/");
    router.refresh();
  };

  const displayInitial = (authState.fullName?.charAt(0) || authState.email.charAt(0) || "?").toUpperCase();
  const truncatedEmail = authState.email.length > 22 ? authState.email.slice(0, 19) + "..." : authState.email;

  if (authState.isLoggedIn) {
    const isTalent = role === "talent";
    return (
      <div>
        <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-white">Account</h3>
        <ul className="space-y-2.5">
          <li>
            <div className="mb-1 flex items-center gap-1.5">
              <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#7E47FF] text-[9px] font-medium text-white">
                {displayInitial}
              </div>
              <span className="max-w-[140px] truncate text-[11px] text-[#888]">{truncatedEmail}</span>
            </div>
          </li>
          {isTalent ? (
            <>
              <li>
                <Link href="/talent/dashboard" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
                  Talent Dashboard
                </Link>
              </li>
              <li>
                <Link href="/talent/dashboard/edit" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
                  Edit Profile
                </Link>
              </li>
            </>
          ) : (
            <>
              <li>
                <Link href="/account" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
                  My Account
                </Link>
              </li>
              <li>
                <Link href="/browse-talent?view=saved" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
                  Saved Profiles
                </Link>
              </li>
            </>
          )}
          <li className="mt-2">
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-[#c14040] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-white">Account</h3>
      <ul className="space-y-2.5">
        <li>
          <Link href="/talent/login" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Talent Login
          </Link>
        </li>
        <li>
          <Link href="/signin" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Employer Login
          </Link>
        </li>
        <li>
          <Link href="/signup" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Sign up
          </Link>
        </li>
      </ul>
    </div>
  );
}
