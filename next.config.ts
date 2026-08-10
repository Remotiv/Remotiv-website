import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "jlezhdhzuyubhqvxdwvg.supabase.co",
        pathname: "/storage/v1/object/**",
      },
    ],
  },
  async redirects() {
    // 308 permanent redirects for renamed public routes. Preserves query
    // strings and transfers SEO ranking. Old URL stays reachable for
    // bookmarks, external links, and search-engine crawls.
    return [
      {
        source: "/become-a-talent",
        destination: "/join-as-talent",
        permanent: true,
      },
      {
        source: "/hire-remote",
        destination: "/find-freelancers",
        permanent: true,
      },
      {
        source: "/remote-ready",
        destination: "/join-as-freelancer",
        permanent: true,
      },
    ];
  },
  async headers() {
    // Dev gate: HSTS pins for 2 years with preload — once a browser sees it
    // on localhost (via tunnel, prod-pointing config, etc.) Safari will
    // force-upgrade http://localhost to https forever. Similarly,
    // upgrade-insecure-requests rewrites every http:// to https:// before
    // sending, which breaks plain-HTTP localhost dev. Both ship only in
    // production builds where they belong.
    const isProduction = process.env.NODE_ENV === "production";

    // Single source of truth for CSP directives.
    const baseDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://assets.calendly.com",
      "style-src 'self' 'unsafe-inline' https://assets.calendly.com",
      "img-src 'self' data: blob: https://jlezhdhzuyubhqvxdwvg.supabase.co https://*.calendly.com",
      "font-src 'self' data:",
      "connect-src 'self' https://jlezhdhzuyubhqvxdwvg.supabase.co wss://jlezhdhzuyubhqvxdwvg.supabase.co https://calendly.com https://*.calendly.com",
      "frame-src 'self' https://calendly.com https://*.calendly.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      ...(isProduction ? ["upgrade-insecure-requests"] : []),
    ];
    const cspDirectives = baseDirectives.join("; ");

    /*
     * ── The two exceptions /interview/** needs ────────────────
     *
     * This is the only route on the origin that records video, and the only
     * one that plays a recording back. Both were blocked by headers written
     * for a site that did neither, and both failed in Chrome while working in
     * Safari — Safari enforces neither Permissions-Policy nor, historically,
     * media-src as strictly.
     *
     * 1. camera=() / microphone=() forbids getUserMedia in EVERY document on
     *    the origin. Chrome refuses before showing a prompt, so the candidate
     *    saw a tech check that never asked for anything:
     *      [Violation] Permissions policy violation: camera is not allowed…
     *
     * 2. There is no media-src above, so <video src="https://…supabase.co/…">
     *    falls back to default-src 'self' and the signed playback URL is
     *    blocked. img-src and connect-src were both extended for Supabase
     *    when they were needed; media is simply the case nobody had yet.
     *
     * `self` rather than `*`: the interview page embeds no third-party frame,
     * so nothing but this origin ever needs the camera. blob: covers a
     * locally recorded chunk played back before upload, which is same-origin
     * by construction.
     *
     * Scoped to this prefix so the rest of the site keeps camera=() and
     * microphone=() and its media fallback to default-src. Later entries win
     * per key, so every other directive is inherited from the block above
     * untouched — geolocation and interest-cohort are restated here only
     * because a Permissions-Policy header replaces the whole value.
     */
    const INTERVIEW_PREFIX = "/interview/:path*";
    const DASHBOARD_PREFIX = "/ai-dashboard/:path*";
    const SUPABASE_ORIGIN = "https://jlezhdhzuyubhqvxdwvg.supabase.co";

    /*
     * media-src is needed on BOTH ends of an interview, and only the
     * candidate's end had it.
     *
     * The reviewer's page plays the same objects back from the same private
     * bucket over the same kind of signed URL, so it failed in exactly the way
     * the candidate page did — a <video> pointed at *.supabase.co falling back
     * to default-src 'self'. The dashboard gets the media directive and
     * NOTHING else: no camera, no microphone, because nobody records here.
     */
    const mediaCsp = [
      ...baseDirectives,
      `media-src 'self' blob: ${SUPABASE_ORIGIN}`,
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          // LOW RISK — enforced immediately
          ...(isProduction
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Enforced (was report-only until pre-launch audit)
          {
            key: "Content-Security-Policy",
            value: cspDirectives,
          },
        ],
      },
      {
        // The dashboard plays recordings back but never captures — media only,
        // and camera/microphone stay denied by the block above.
        source: DASHBOARD_PREFIX,
        headers: [{ key: "Content-Security-Policy", value: mediaCsp }],
      },
      {
        source: INTERVIEW_PREFIX,
        headers: [
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(), interest-cohort=()",
          },
          {
            key: "Content-Security-Policy",
            value: mediaCsp,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
