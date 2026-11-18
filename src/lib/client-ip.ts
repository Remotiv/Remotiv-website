/**
 * The caller's IP, from headers only the platform can set (#58).
 *
 * On Vercel the edge strips any client-supplied x-vercel-forwarded-for and
 * x-real-ip and sets its own, so those are trusted. x-forwarded-for is NOT:
 * a client can prepend anything to it, and a limiter keyed on it gives an
 * attacker a fresh bucket per request.
 *
 * On Vercel with neither trusted header the answer is null, and a caller that
 * limits by IP must refuse (fail closed). Off Vercel (local dev, the staging
 * preview) there is no edge to trust, so the left-most x-forwarded-for, or
 * "local", is used: those environments are not exposed to the internet.
 */
export function trustedClientIp(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined>,
): string | null {
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  if (env.VERCEL === "1") return null;
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
