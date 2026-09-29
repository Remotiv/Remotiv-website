/**
 * Where a redirect may send the browser when the target came from a query
 * string. Deliberately dependency-free: it is imported by Route Handlers, a
 * plain server module, and two client components alike.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 * Only a same-origin path survives: it must start with `/`, must not start
 * with `//`, and must carry no backslash or line break. Everything else
 * collapses to the caller's fallback rather than being followed.
 *
 * The concrete attacks this closes, given a sink like
 * `redirect(\`${origin}${next}\`)`:
 *
 *   next=@evil.com        → https://remotiv.work@evil.com      host evil.com
 *   next=:443@evil.com    → https://remotiv.work:443@evil.com  host evil.com
 *   next=.evil.com        → https://remotiv.work.evil.com      attacker's subdomain
 *   next=-evil.com        → https://remotiv.work-evil.com      attacker's domain
 *   next=https://evil.com → router.push follows it as an external navigation
 *
 * `//host` and `\` are rejected too. Prepending an origin neutralises them,
 * but a caller that redirects to the path RELATIVELY (a bare Location header,
 * router.push) would follow `//evil.com` to evil.com, so the rule does not
 * depend on how the caller assembles the URL.
 */
export function safeRelativePath(raw: string | null | undefined, fallback: string): string {
  if (!raw?.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.includes("\\") || /[\r\n]/.test(raw)) return fallback;
  return raw;
}

/**
 * Where the dashboard's recover handler may send the browser afterwards.
 *
 * The same rule, narrowed: only a dashboard path survives, and never the
 * recover URL itself (a loop) or the login page (the handler's own failure
 * destination). Everything else collapses to the dashboard root.
 */
export function safeNext(raw: string | null | undefined): string {
  const path = safeRelativePath(raw, "/ai-dashboard");
  if (!path.startsWith("/ai-dashboard")) return "/ai-dashboard";
  if (path.startsWith("/ai-dashboard/api/") || path.startsWith("/ai-dashboard/login")) {
    return "/ai-dashboard";
  }
  return path;
}
