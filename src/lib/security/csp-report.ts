/**
 * Turning a browser's CSP violation report into one safe log line (#72 step
 * 13). Pure, so it is tested directly (csp-report.test.ts); the route,
 * app/api/csp-report/route.ts, only reads the body and logs these lines.
 * What a line may never contain is set out in the route's comment.
 */
/** Bodies over this are ignored. */
export const MAX_REPORT_BYTES = 16_384;
const MAX_REPORTS = 10;

type Report = {
  "effective-directive"?: string;
  "violated-directive"?: string;
  effectiveDirective?: string;
  "blocked-uri"?: string;
  blockedURL?: string;
  "document-uri"?: string;
  documentURL?: string;
};

/** The first path segment of a URL ("/ai-dashboard"), or "?" when it is not one. */
export function pageOf(url: string | undefined): string {
  if (!url) return "?";
  try {
    const first = new URL(url).pathname.split("/")[1] ?? "";
    return /^[a-z0-9-]{1,40}$/i.test(first) ? `/${first}` : first === "" ? "/" : "?";
  } catch {
    return "?";
  }
}

/** "inline", "eval", the blocked URL's origin, or "?". Never a path or query. */
export function blockedOf(uri: string | undefined): string {
  if (!uri) return "?";
  if (uri === "inline" || uri === "eval" || uri === "wasm-eval") return uri;
  try {
    return new URL(uri).origin;
  } catch {
    return "?";
  }
}

/** The directive name alone (a violated-directive may carry its sources). */
export function directiveOf(r: Report): string {
  const d = r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? "";
  const name = d.split(" ")[0];
  return /^[a-z-]{1,40}$/.test(name) ? name : "?";
}

/** One sanitized line per report in a body, at most MAX_REPORTS. */
export function reportLines(body: unknown): string[] {
  const reports: Report[] = [];
  if (Array.isArray(body)) {
    for (const item of body) {
      const r = (item as { type?: string; body?: Report } | null) ?? null;
      if (r?.type === "csp-violation" && r.body && typeof r.body === "object") reports.push(r.body);
    }
  } else if (body && typeof body === "object" && "csp-report" in body) {
    const r = (body as { "csp-report": unknown })["csp-report"];
    if (r && typeof r === "object") reports.push(r as Report);
  }
  return reports
    .slice(0, MAX_REPORTS)
    .map(
      (r) =>
        `[csp-report] directive=${directiveOf(r)} blocked=${blockedOf(r["blocked-uri"] ?? r.blockedURL)} page=${pageOf(r["document-uri"] ?? r.documentURL)}`,
    );
}
