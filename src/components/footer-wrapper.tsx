"use client";

import { usePathname } from "next/navigation";
import { Footer } from "./footer";

const HIDDEN_PREFIXES = [
  "/admin",
  "/ai-dashboard", // hides footer on all /ai-dashboard/* product pages
  "/login",
  "/client", // hides footer on all /client/* pages
  "/client/login",
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
  "/talent/login",
  "/talent/dashboard",
];

export function FooterWrapper() {
  const pathname = usePathname();
  const shouldHide = HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
  if (shouldHide) return null;
  return <Footer />;
}
