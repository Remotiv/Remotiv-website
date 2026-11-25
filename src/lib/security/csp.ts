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
  /**
   * upgrade-insecure-requests ships in production only (breaks plain-HTTP
   * localhost dev), and 'unsafe-eval' in development only (#72).
   */
  isProduction: boolean;
};

/**
 * script-src. 'unsafe-eval' is development only (#72): Next's dev runtime
 * needs it (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md),
 * and nothing in the production client bundles calls eval. The only
 * Function(...) left in them is the "return this" fallback for finding the
 * global object, behind globalThis, window and self, so never reached in a
 * browser. pdf.js 6 has no eval path at all. 'unsafe-inline' stays until the
 * nonce or hash decision (#72, step 13).
 */
export function scriptSrc(isProduction: boolean): string {
  const evalSource = isProduction ? "" : " 'unsafe-eval'";
  return `script-src 'self' 'unsafe-inline'${evalSource} https://assets.calendly.com`;
}

/**
 * The base CSP directives, as an array. One Supabase host, spliced into
 * img-src and connect-src (https and wss) at a single point each.
 */
export function baseDirectives({ supabaseHost: host, isProduction }: CspInput): string[] {
  const https = `https://${host}`;
  const wss = `wss://${host}`;
  return [
    "default-src 'self'",
    scriptSrc(isProduction),
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

// ── Report-Only: script-src without 'unsafe-inline' (#72 step 13) ──
//
// Sent ALONGSIDE the enforced policy above, which is unchanged: a browser
// enforces the first and only reports against this one, so nothing is blocked.
// Where it is sent (src/proxy.ts): the dashboard and admin, every page of which
// renders per request, so Next stamps the request's nonce on its own inline
// scripts (the streamed page data, self.__next_f.push) and on its script tags.
// The one inline script Next does not stamp, the root layout's scroll script,
// is allowed by its hash (SCROLL_RESTORATION_SHA256 below). Not sent on marketing pages,
// which are static: their inline page-data scripts cannot carry a per-request
// nonce and their bytes are not known when these headers are built, so a
// policy without 'unsafe-inline' would only ever report them.

/**
 * The one executable inline script every page carries (the root layout imports
 * it from here), and its hash for the Report-Only policy. Kept beside the hash
 * so the two cannot drift: csp-report-only.test.ts recomputes the SHA-256 of
 * this exact string and fails if the constant does not match. A pure string,
 * not computed: the proxy imports this module on every request.
 */
export const SCROLL_RESTORATION_SCRIPT = `if("scrollRestoration" in history){history.scrollRestoration="manual";}`;
export const SCROLL_RESTORATION_SHA256 = "'sha256-RYIsiYRCEXlZQQQGMYuOmCpGtjfmUc1k3nbZdEs2bZw='";

/** Where browsers post Report-Only violations: app/api/csp-report/route.ts. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * script-src for the Report-Only policy: this request's nonce and the scroll
 * script's hash instead of 'unsafe-inline'. 'unsafe-eval' in development only,
 * as in the enforced policy.
 */
export function reportOnlyScriptSrc(nonce: string, isProduction: boolean): string {
  const evalSource = isProduction ? "" : " 'unsafe-eval'";
  return `script-src 'self' 'nonce-${nonce}' ${SCROLL_RESTORATION_SHA256}${evalSource} https://assets.calendly.com`;
}

/**
 * The Report-Only policy: the dashboard's enforced directives with script-src
 * swapped for reportOnlyScriptSrc, and a report-uri. Everything else is the
 * same, so the only reports are about scripts.
 */
export function reportOnlyDirectives(input: CspInput & { nonce: string }): string[] {
  return [
    ...mediaDirectives(input).map((d) =>
      d.startsWith("script-src ") ? reportOnlyScriptSrc(input.nonce, input.isProduction) : d,
    ),
    `report-uri ${CSP_REPORT_PATH}`,
  ];
}

/** The one remotePattern next/image needs: the configured Supabase host's storage. */
export function supabaseImagePattern(host: string) {
  return {
    protocol: "https" as const,
    hostname: host,
    pathname: "/storage/v1/object/**",
  };
}
