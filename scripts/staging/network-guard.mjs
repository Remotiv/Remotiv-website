/**
 * The browser's network, guarded: only the approved staging project, ever.
 *
 * Pure policy and bookkeeping. guarded-test.mjs wires it into Playwright;
 * network-guard.test.mjs drives every decision with fabricated URLs;
 * network-guard.selftest.mjs runs it in a real browser against fabricated
 * hosts that are aborted before any network is touched.
 *
 * ── Why the server-side checks are not enough ────────────────
 *
 * NEXT_PUBLIC_* values are inlined into browser assets at compile time. The
 * sentinel proves the server's service client; the identity route proves the
 * server's environment; neither proves what the compiled bundle actually
 * calls. This guard sits on the browser context, before any page exists,
 * and classifies every HTTP request and WebSocket the browser attempts:
 *
 *   approved   the approved project host (its ref hashes to the pin), or an
 *              exactly-listed custom domain
 *   forbidden  ANY other Supabase-looking destination: another project, the
 *              pooler, a direct db host, an unknown subdomain
 *   other      everything else (the app itself, fonts, calendly)
 *
 * A forbidden destination is aborted before it reaches the network, recorded
 * with its host and path MASKED, and the harness FAILS: a request that was
 * blocked is still a request the app tried to make. At least one successful
 * approved request must be observed, or the run fails too: a guard that saw
 * no traffic has proven nothing.
 *
 * Nothing recorded can identify a project or carry a token: the ref becomes
 * <ref>, a custom domain becomes <custom-domain>, the path becomes <path:N>,
 * and the query string is never kept.
 */

import { assertPinIsReal, sha256 } from "./guard-checks.mjs";

export const CUSTOM_DOMAINS_VAR = "STAGING_SUPABASE_CUSTOM_DOMAINS";

/** Supabase's own hosted domains. Anything under them that is not approved is forbidden. */
const SUPABASE_DOMAIN_RE = /(^|\.)supabase\.(co|in|com|net)$/i;
/** A project host: exactly <ref>.supabase.co or .in, no deeper label. */
const PROJECT_HOST_RE = /^([a-z0-9-]+)\.supabase\.(co|in)$/i;
const BARE_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Exact hostnames only. A wildcard, scheme, port or path is refused. */
export function parseCustomDomains(raw) {
  if (!raw) return [];
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of out) {
    if (!BARE_HOST_RE.test(d) || /[*/:\s]/.test(d)) {
      throw new Error(
        `${CUSTOM_DOMAINS_VAR} holds an entry that is not a bare hostname. Entries must be ` +
          `exact hostnames: no wildcard, no scheme, no port, no path. Arbitrary domains are not allowed.`,
      );
    }
  }
  return out.map((d) => d.toLowerCase());
}

/** The policy: the approved project as a hash, plus exact custom domains. */
export function policyFrom({ pin, customDomains = [] }) {
  return { approvedRefSha256: assertPinIsReal(pin), customDomains: [...customDomains] };
}

function maskHost(host, policy) {
  if (policy.customDomains.includes(host)) return "<custom-domain>";
  const m = host.match(PROJECT_HOST_RE);
  if (m) return `<ref>.supabase.${m[2]}`;
  if (SUPABASE_DOMAIN_RE.test(host)) return `<other>.${host.split(".").slice(-2).join(".")}`;
  return host;
}

/** Classify one URL. `masked` is the only thing ever printed or stored. */
export function classify(url, policy) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { kind: "other", masked: "<unparseable url>" };
  }
  const host = u.hostname.toLowerCase();
  const masked = `${u.protocol}//${maskHost(host, policy)}/<path:${Math.max(0, u.pathname.length - 1)}>`;

  if (policy.customDomains.includes(host))
    return { kind: "approved", masked, via: "custom-domain" };
  const m = host.match(PROJECT_HOST_RE);
  if (m && sha256(m[1].toLowerCase()) === policy.approvedRefSha256) {
    return { kind: "approved", masked, via: "project-host" };
  }
  if (SUPABASE_DOMAIN_RE.test(host) || host.includes("supabase")) {
    return { kind: "forbidden", masked };
  }
  return { kind: "other", masked };
}

/**
 * A guard instance: decisions, the violation list, and the observed counts.
 *
 * Handlers are closures, not methods, so Playwright can be handed them
 * directly. `decide` is the single place a verdict is reached, for both
 * transports, so a reversion that loosens it loosens both.
 */
export function createGuard(policy) {
  const violations = [];
  const observed = { approvedAttempts: 0, approvedOk: 0, other: 0 };

  const decide = (url, transport) => {
    const c = classify(url, policy);
    if (c.kind === "forbidden") {
      violations.push({ transport, masked: c.masked, at: new Date().toISOString() });
      return "abort";
    }
    if (c.kind === "approved") observed.approvedAttempts += 1;
    else observed.other += 1;
    return "continue";
  };

  const handleRoute = async (route) => {
    if (decide(route.request().url(), "http") === "abort") {
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  };

  const handleWebSocket = (ws) => {
    if (decide(ws.url(), "websocket") === "abort") {
      ws.close({ code: 1008, reason: "blocked by the staging network guard" });
    } else {
      ws.connectToServer();
    }
  };

  const onResponse = (res) => {
    const c = classify(res.url(), policy);
    if (c.kind === "approved" && res.status() >= 200 && res.status() < 400)
      observed.approvedOk += 1;
  };

  /** Throws if ANY forbidden destination was attempted. Blocked is still a failure. */
  const assertClean = (label) => {
    if (violations.length === 0) return;
    throw new Error(
      `BROWSER NETWORK VIOLATION during ${label}: the app's browser code attempted ` +
        `${violations.length} request(s) to a Supabase destination that is NOT the approved ` +
        `staging project. Each was aborted before reaching the network, and the run fails ` +
        `anyway: a blocked request is still a request the compiled bundle tried to make.\n  - ` +
        violations.map((v) => `${v.transport} ${v.masked} at ${v.at}`).join("\n  - "),
    );
  };

  /** Throws unless at least one approved request succeeded. Zero observed is not a pass. */
  const assertObserved = () => {
    if (observed.approvedOk > 0) return;
    throw new Error(
      `ZERO successful browser requests to the approved staging project were observed ` +
        `(${observed.approvedAttempts} attempted, ${observed.other} to other hosts). A guard that saw ` +
        `no staging traffic has proven nothing about where the browser talks. If the attempt ` +
        `count is also zero, the page could not even issue one: check the Content-Security-Policy ` +
        `connect-src in next.config.ts, which pins a project host by name.`,
    );
  };

  return {
    policy,
    violations,
    observed,
    decide,
    handleRoute,
    handleWebSocket,
    onResponse,
    assertClean,
    assertObserved,
  };
}
