/**
 * Lets a test drive the job worker route (src/app/api/jobs/worker/route.ts)
 * under bare node:test. Register AFTER node-resolve.mjs and
 * fake-service-client-hook.mjs, so this one sees the bare specifiers first.
 *
 *   next/server         -> NextResponse.json returning { status, body }, all
 *                          the route needs (the real module does not resolve
 *                          under Node's ESM loader)
 *   @/lib/notifications -> notifyAllAdmins recording each call on
 *                          globalThis.__adminNotificationsForTests, so a test
 *                          sees exactly which alerts a tick raised
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "next/server": [
    "export const NextResponse = {",
    "  json(body, init) { return { status: init?.status ?? 200, body }; },",
    "};",
  ].join("\n"),
  "@/lib/notifications": [
    "export async function notifyAllAdmins(input) {",
    "  (globalThis.__adminNotificationsForTests ??= []).push(input);",
    "}",
  ].join("\n"),
};

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return {
      url: `data:text/javascript,${encodeURIComponent(stub)}`,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
