import { NextResponse } from "next/server";
import { getJobScope, scopedApplicationIds } from "@/app/ai-dashboard/lib/job-scope";
import { notFound, openProbe } from "../_lib/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The application's REAL allow-list, for the signed-in member's OWN scope.
 *
 * scopedApplicationIds (job-scope.ts:200) is a filter: a missing id removes a
 * row from Messages rather than showing one, so its omissions are invisible on
 * any page. The seed's self-check and the harness call it here, in the app's
 * runtime, exactly as the Messages page does, and compare the result against
 * the ids the seed independently wrote.
 *
 * Authorization is the dashboard's own: getCompanyContext resolves the session
 * to a member, getJobScope resolves that member's hiring-team assignments, and
 * the ids returned are the ones that member can already see in the product. An
 * owner or admin is unscoped and gets `ids: null`, which is the function's own
 * answer for "unrestricted" and not an error.
 *
 * In production the sentinel schema does not exist and this is a bare 404
 * before any id is computed (see ../_lib/gate.ts).
 */
export async function GET() {
  const result = await openProbe();
  if (!result.ok) return notFound(result.code);
  const { ctx } = result.probe;

  const scope = await getJobScope(ctx);
  if (!scope.scoped) return NextResponse.json({ scoped: false, jobCount: null, ids: null });

  const read = await scopedApplicationIds(ctx, scope);
  if (!read.ok) {
    return NextResponse.json({ error: "The allow-list could not be read." }, { status: 503 });
  }
  return NextResponse.json({ scoped: true, jobCount: scope.jobIds.length, ids: read.value ?? [] });
}
