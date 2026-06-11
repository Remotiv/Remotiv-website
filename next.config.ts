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
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          // LOW RISK — enforced immediately
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
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
