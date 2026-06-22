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
  async headers() {
    // Dev gate: HSTS pins for 2 years with preload — once a browser sees it
    // on localhost (via tunnel, prod-pointing config, etc.) Safari will
    // force-upgrade http://localhost to https forever. Similarly,
    // upgrade-insecure-requests rewrites every http:// to https:// before
    // sending, which breaks plain-HTTP localhost dev. Both ship only in
    // production builds where they belong.
    const isProduction = process.env.NODE_ENV === "production";

    // Single source of truth for CSP directives.
    const cspDirectives = [
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
    ];
  },
};

export default nextConfig;
