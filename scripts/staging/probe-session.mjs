/**
 * Turn a Supabase session into the Cookie header the app's server client reads.
 *
 * The staging-probe routes authenticate through getCompanyContext(), the same
 * resolver every dashboard page uses, which reads the session from cookies
 * written by @supabase/ssr. A script that wants to call the route as a real
 * signed-in member therefore has to present that cookie, not a bearer token:
 * adding a second auth path to the route "for scripts" would mean the route's
 * identity check was no longer the application's.
 *
 * The encoding is @supabase/ssr's own, built with its exported helpers so it
 * cannot drift: name `sb-<ref>-auth-token`, value `base64-` + base64url of the
 * session JSON, chunked at the library's size into `.0`, `.1`, ... when long.
 * The ref is used to build the name in memory and is never printed.
 */

import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { projectRef } from "./guard-checks.mjs";

/**
 * @param {{ access_token: string, refresh_token: string }} session
 * @param {string} supabaseUrl the project URL the APP reads, so the name matches
 */
export function sessionCookieHeader(session, supabaseUrl) {
  if (!session || typeof session.access_token !== "string" || session.access_token === "") {
    throw new Error("sessionCookieHeader: no access_token; the sign-in did not produce a session");
  }
  const name = `sb-${projectRef(supabaseUrl, "STAGING_APP_SUPABASE_URL")}-auth-token`;
  const value = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  return createChunks(name, value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
