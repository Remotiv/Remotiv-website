/**
 * Lets a test drive the WhatsApp webhook route
 * (src/app/api/webhooks/whatsapp/route.ts) under bare node:test. Register
 * AFTER node-resolve.mjs and fake-service-client-hook.mjs, so this one sees
 * the bare specifier first.
 *
 *   next/server -> a NextResponse with the constructor and the static json()
 *                  the route uses (the real module does not resolve under
 *                  Node's ESM loader)
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "next/server": [
    "export class NextResponse {",
    "  constructor(body, init) { this.body = body; this.status = init?.status ?? 200; }",
    "  static json(body, init) { return { status: init?.status ?? 200, body }; }",
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
