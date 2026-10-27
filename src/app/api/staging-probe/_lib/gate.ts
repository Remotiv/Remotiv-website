import { NextResponse } from "next/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The gate every staging-probe route passes through, in this order:
 *
 *   1. the database says it is a staging database   (staging_guard.sentinel)
 *   2. the request carries a signed-in dashboard session (getCompanyContext)
 *
 * and only then does a route compute anything.
 *
 * ── What happens in production ───────────────────────────────
 *
 * Production has no `staging_guard` schema. The sentinel read fails, the route
 * returns a bare 404 with no body, and nothing below it runs: no session is
 * read, no company is resolved, no applicant id is computed. The schema cannot
 * be acquired by accident; it is created by hand, in staging, by the person
 * holding the key (scripts/staging/README-steps.md step 3). No environment
 * variable is consulted, because a variable is a claim the environment makes
 * about itself and this gate wants evidence from the database.
 *
 * ── Why the sentinel is read through PostgREST ───────────────
 *
 * The same way the seed and harness read it: `.schema("staging_guard")`. This
 * requires the schema on the project's exposed-schemas list, a human step. If
 * it is missing the read errors and the gate fails closed, which means the
 * route 404s rather than running unguarded.
 *
 * ── Why the session is the application's own ─────────────────
 *
 * getCompanyContext() is the resolver every dashboard page uses. No bearer
 * token, no second path "for scripts": a route whose identity check is not
 * the application's is not measuring the application. The seed presents the
 * same cookie the browser would (scripts/staging/probe-session.mjs).
 */

export const SENTINEL_SCHEMA = "staging_guard";
export const SENTINEL_TABLE = "sentinel";
const HASH = /^[0-9a-f]{64}$/;

export type Sentinel = { projectRefSha256: string; purpose: string };
export type Probe = { sentinel: Sentinel; ctx: CompanyContext };

/**
 * Why a probe refused, as a FIXED enum — never a message.
 *
 * A bare 404 with four possible causes is not debuggable, and a guard that
 * cannot say why it refused is one the next person disables. So the refusal
 * carries one of these codes, and only these: each is a constant that names a
 * CATEGORY, never a value. None can carry a project ref, a URL, a key, or any
 * row content. The header this travels in (REFUSAL_HEADER) is therefore safe
 * to return even in production, where it reveals only that the sentinel is
 * absent, which production's 404 already implies.
 *
 *   sentinel-unreadable  the service client could not read staging_guard.sentinel
 *                        (schema not on the Data API, grant missing, or offline).
 *                        In production this is the normal 404: no such schema.
 *   sentinel-count       the sentinel table does not hold exactly one row.
 *   sentinel-hash        the one row's hash is not 64 lowercase hex characters.
 *   unauthenticated      the request carried no session the app's cookie-based
 *                        server client would accept (getUser returned no user).
 *   no-company           authenticated, but the user resolves to no active
 *                        company membership (or the company is not active).
 *   profile-error        access was granted, then the company row failed to load.
 *   unknown              any other throw; should never be seen.
 */
export type RefusalCode =
  | "sentinel-unreadable"
  | "sentinel-count"
  | "sentinel-hash"
  | "unauthenticated"
  | "no-company"
  | "profile-error"
  | "unknown";

export const REFUSAL_HEADER = "x-staging-probe-refused";

export type SentinelResult = { ok: true; sentinel: Sentinel } | { ok: false; code: RefusalCode };
export type ProbeResult = { ok: true; probe: Probe } | { ok: false; code: RefusalCode };

/**
 * Exactly one well-formed sentinel row, or a refusal code.
 *
 * `.limit(2)` because "exactly one" is part of the claim: zero rows means this
 * is not a staging database, two means someone has been editing it. An error
 * is a refusal too, and its text is never read: a PostgREST error can carry the
 * request URL, which names the project. The CODE it maps to carries nothing.
 */
export async function readSentinel(
  service: ReturnType<typeof createServiceClient>,
): Promise<SentinelResult> {
  const { data, error } = await service
    .schema(SENTINEL_SCHEMA)
    .from(SENTINEL_TABLE)
    .select("project_ref_sha256, purpose")
    .limit(2);
  if (error || !Array.isArray(data)) return { ok: false, code: "sentinel-unreadable" };
  if (data.length !== 1) return { ok: false, code: "sentinel-count" };
  const row = data[0] as { project_ref_sha256?: unknown; purpose?: unknown };
  if (typeof row.project_ref_sha256 !== "string" || !HASH.test(row.project_ref_sha256)) {
    return { ok: false, code: "sentinel-hash" };
  }
  return {
    ok: true,
    sentinel: {
      projectRefSha256: row.project_ref_sha256,
      purpose: typeof row.purpose === "string" ? row.purpose : "",
    },
  };
}

/**
 * Map a thrown context verdict to a code, by its reason only — never its text.
 *
 * Duck-typed rather than `instanceof` on purpose: importing the error classes
 * would pull the whole company-access graph into this module (and into the
 * route tests). CompanyAccessDenied carries `.access.reason`; CompanyProfileError
 * carries `.name`. Nothing read here is ever a value — only the reason category.
 */
export function codeForContextError(err: unknown): RefusalCode {
  const e = err as { name?: string; access?: { reason?: string } } | null;
  if (e && typeof e.access?.reason === "string") {
    return e.access.reason === "unauthenticated" ? "unauthenticated" : "no-company";
  }
  if (e?.name === "CompanyProfileError") return "profile-error";
  return "unknown";
}

/**
 * A bare 404. With a code, it carries that code in REFUSAL_HEADER so a caller
 * (the seed, the harness) can report WHICH check refused. The body stays null:
 * no hint of what the route is, only — to someone already holding the cookie —
 * why it said no.
 */
export function notFound(code?: RefusalCode): NextResponse {
  const res = new NextResponse(null, { status: 404 });
  if (code) res.headers.set(REFUSAL_HEADER, code);
  return res;
}

/** Sentinel first, then session. A refusal names which step said no. */
export async function openProbe(): Promise<ProbeResult> {
  const sentinel = await readSentinel(createServiceClient());
  if (!sentinel.ok) return sentinel;
  try {
    return { ok: true, probe: { sentinel: sentinel.sentinel, ctx: await getCompanyContext() } };
  } catch (err) {
    return { ok: false, code: codeForContextError(err) };
  }
}
