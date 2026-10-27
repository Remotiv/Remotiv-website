/**
 * The site's Content-Security-Policy and the related image allowlist, as pure
 * functions of ONE Supabase origin.
 *
 * ── Why this is derived, and why that is safe for production ──
 *
 * next.config.ts used to hard-code the production Supabase host into
 * connect-src, img-src, media-src and images.remotePatterns. That is correct
 * for production and wrong for the staging load test: a staging-pointed app
 * would serve pages whose CSP forbids the browser from talking to staging and
 * permits production. The host is now derived from NEXT_PUBLIC_SUPABASE_URL,
 * which the staging launcher sets to the staging project and Vercel sets to
 * production per environment.
 *
 * The production guarantee is that THIS derivation, given production's own
 * NEXT_PUBLIC_SUPABASE_URL, reproduces the exact string production shipped
 * before: one Supabase origin, no wildcard, no second host. csp.test.ts builds
 * the production configuration and asserts precisely that, so a staging
 * convenience cannot quietly widen production's headers. There is exactly ONE
 * interpolation point for the Supabase host in each directive, so a change that
 * admitted a second origin would change that assertion and go red.
 *
 * The fallback literal is reached only when NEXT_PUBLIC_SUPABASE_URL is unset,
 * which is neither production (set on Vercel) nor the staging launcher (which
 * sets it): a bare local build. It is the production host, and it is never a
 * fallback FROM a set staging value — a set value always wins, so staging can
 * never fall back to or permit production.
 */

/** Production's Supabase URL: the documented value, and the unset-env fallback. */
export const PRODUCTION_SUPABASE_URL = "https://jlezhdhzuyubhqvxdwvg.supabase.co";

/** The Supabase URL the build is configured with; the production host if unset. */
export function resolveSupabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  return url && url !== "" ? url : PRODUCTION_SUPABASE_URL;
}

/** The host of a Supabase URL, or a thrown error for anything that is not a URL. */
export function supabaseHost(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL");
  }
  if (host === "") throw new Error("NEXT_PUBLIC_SUPABASE_URL has no host");
  return host;
}

export type CspInput = {
  /** The single Supabase host every directive below is built around. */
  supabaseHost: string;
  /** upgrade-insecure-requests ships in production only (breaks plain-HTTP localhost dev). */
  isProduction: boolean;
};

/**
 * The base CSP directives, as an array. One Supabase host, spliced into
 * img-src and connect-src (https and wss) at a single point each.
 */
export function baseDirectives({ supabaseHost: host, isProduction }: CspInput): string[] {
  const https = `https://${host}`;
  const wss = `wss://${host}`;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://assets.calendly.com",
    "style-src 'self' 'unsafe-inline' https://assets.calendly.com",
    `img-src 'self' data: blob: ${https} https://*.calendly.com`,
    "font-src 'self' data:",
    `connect-src 'self' ${https} ${wss} https://calendly.com https://*.calendly.com`,
    "frame-src 'self' https://calendly.com https://*.calendly.com",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ];
}

/** The interview/dashboard CSP: the base plus media-src for the one Supabase host. */
export function mediaDirectives(input: CspInput): string[] {
  return [...baseDirectives(input), `media-src 'self' blob: https://${input.supabaseHost}`];
}

export const toCsp = (directives: string[]): string => directives.join("; ");

/** The one remotePattern next/image needs: the configured Supabase host's storage. */
export function supabaseImagePattern(host: string) {
  return {
    protocol: "https" as const,
    hostname: host,
    pathname: "/storage/v1/object/**",
  };
}
