/**
 * Companion to node-resolve.mjs: lets a test run a module that builds its own
 * database client with createServiceClient().
 *
 *   server-only            -> an empty module (it throws outside RSC on import)
 *   @/lib/supabase/server  -> createServiceClient returning whatever the test
 *                             installed on globalThis.__fakeServiceClientForTests,
 *                             and throwing if nothing was installed, so the real
 *                             client can never be reached by accident
 *
 * Register this AFTER node-resolve.mjs. Node calls the most recently
 * registered hook first, and this one has to see the bare specifiers.
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    "  const make = globalThis.__fakeServiceClientForTests;",
    '  if (!make) throw new Error("test: no fake service installed; the real client must not be reached");',
    "  return make();",
    "}",
    "export async function createClient() {",
    '  throw new Error("test: the cookie-bound client is not available here");',
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
