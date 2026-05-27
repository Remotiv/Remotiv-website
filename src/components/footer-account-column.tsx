"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type AuthState = {
  isLoggedIn: boolean;
  email: string;
  fullName: string | null;
};

export function FooterAccountColumn() {
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>({
    isLoggedIn: false,
    email: "",
    fullName: null,
  });
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Initial check
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setAuthState({
          isLoggedIn: true,
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
          email: session.user.email ?? "",
          fullName: (session.user.user_metadata?.full_name as string | undefined) ?? null,
        });
      } else {
        setAuthState({ isLoggedIn: false, email: "", fullName: null });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  const displayInitial = (authState.fullName?.charAt(0) || authState.email.charAt(0) || "?").toUpperCase();
  const truncatedEmail = authState.email.length > 22 ? authState.email.slice(0, 19) + "..." : authState.email;

  if (authState.isLoggedIn) {
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
          <li>
            <Link href="/talent/login" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
              Talent Login
            </Link>
          </li>
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
          <Link href="/signin" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Login
          </Link>
        </li>
        <li>
          <Link href="/signup" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Sign up
          </Link>
        </li>
        <li>
          <Link href="/talent/login" className="text-sm text-[#555] transition-colors hover:text-remotiv-green">
            Talent Login
          </Link>
        </li>
      </ul>
    </div>
  );
}
