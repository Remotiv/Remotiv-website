import { NextResponse } from "next/server";
import { publicConnection } from "../_lib/connections";
import { notFound, openProbe } from "../_lib/gate";
import { isolationReport } from "../_lib/isolation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The running app states which project it reads, as a hash, and whether it
 * was launched in isolation.
 *
 * The harness compares the hash to the pin committed in
 * scripts/staging/approved-identity.json. Nothing identifying crosses the
 * wire: no ref, no URL, no key. In production the sentinel schema does not
 * exist and this is a bare 404 (see ../_lib/gate.ts).
 */
export async function GET() {
  const result = await openProbe();
  if (!result.ok) return notFound(result.code);
  return NextResponse.json({
    projectRefSha256: result.probe.sentinel.projectRefSha256,
    sentinelPurpose: result.probe.sentinel.purpose,
    isolation: isolationReport(),
    connections: await publicConnection({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    }),
  });
}
