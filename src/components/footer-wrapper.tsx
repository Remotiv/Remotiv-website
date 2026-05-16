"use client";

import { usePathname } from "next/navigation";
import { Footer } from "./footer";

const HIDDEN_PREFIXES = [
  "/admin",
  "/login",
  "/client/login",
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
];

export function FooterWrapper() {
  const pathname = usePathname();
  const shouldHide = HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
  if (shouldHide) return null;
  return <Footer />;
}
