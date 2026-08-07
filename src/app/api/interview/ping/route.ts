import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connection check for the tech screen.
 *
 * A real round trip to OUR origin rather than navigator.connection's claimed
 * downlink: what matters is whether an upload will reach this server from
 * where the candidate is sitting, and a phone reporting "4g" behind a captive
 * portal is not a working connection.
 *
 * Carries no session and reveals nothing — it is reachable without a token on
 * purpose, because the check runs before anything is at stake.
 */
export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
