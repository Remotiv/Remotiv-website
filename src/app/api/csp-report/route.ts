import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { MAX_REPORT_BYTES, reportLines } from "@/lib/security/csp-report";

/**
 * Where browsers post Content-Security-Policy-Report-Only violations (#72
 * step 13; the policy is built in lib/security/csp.ts and sent by src/proxy.ts
 * on the dashboard and admin). Nothing is stored: each violation becomes ONE
 * log line, so the reports can be read in the deployment's logs before the
 * policy is enforced.
 *
 *   [csp-report] directive=<script-src-elem|...> blocked=<inline|eval|origin> page=</first-segment>
 *
 * What is never logged: the full page URL (dashboard URLs carry ids, an
 * interview's carries its secret token), the script sample (an inline script
 * can hold the page's data), the blocked URL's path or query, and the IP.
 * `blocked` is "inline", "eval", or the blocked URL's origin only.
 *
 * Accepts both report formats: the legacy report-uri body
 * ({"csp-report": {...}}, application/csp-report) and the Reporting API's
 * array (application/reports+json). Bodies over MAX_REPORT_BYTES and anything that
 * is not a report are ignored. Always 204: a browser does nothing with the
 * answer, and an error would only invite retries. Rate-limited per IP in
 * memory so a flood cannot flood the logs.
 */
export async function POST(request: NextRequest) {
  const limit = rateLimit(request, {
    max: 60,
    windowMs: 60_000,
    bucketKey: "csp-report",
    group: "local",
  });
  if (!limit.ok) return new NextResponse(null, { status: 204 });
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return new NextResponse(null, { status: 204 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  for (const line of reportLines(body)) console.warn(line);
  return new NextResponse(null, { status: 204 });
}
