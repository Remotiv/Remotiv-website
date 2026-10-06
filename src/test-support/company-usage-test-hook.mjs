/**
 * Companion to node-resolve.mjs for the client usage loader tests ONLY.
 *
 * The loaders resolve the viewer's company from the session and build their own
 * database client, so neither can be passed in. This hook swaps exactly:
 *
 *   server-only                           -> an empty module
 *   @/lib/supabase/server                 -> createServiceClient returning
 *                                            globalThis.__usageServiceForTests()
 *   @/app/ai-dashboard/lib/company-guards -> getCompanyContext returning
 *                                            globalThis.__usageCtxForTests
 *
 * Everything else - the loaders, the reader, the role rules, the Karachi
 * helpers - loads as shipped. Each stub throws when its fake is not installed.
 * Register this AFTER node-resolve.mjs: Node calls the most recently registered
 * hook first, and this one has to see the bare specifiers.
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    "  const make = globalThis.__usageServiceForTests;",
    '  if (!make) throw new Error("test: no fake service installed");',
    "  return make();",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function getCompanyContext() {",
    "  const ctx = globalThis.__usageCtxForTests;",
    '  if (!ctx) throw new Error("test: no company context installed");',
    "  return ctx;",
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
