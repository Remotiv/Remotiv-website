/**
 * Companion to node-resolve.mjs for the Messages actions ONLY.
 *
 * fetchRecipients resolves the viewer from the session and builds its own
 * database client, so neither can be passed in. This hook swaps exactly:
 *
 *   server-only                           -> an empty module
 *   next/cache                            -> revalidatePath as a no-op
 *   @/lib/supabase/server                 -> createServiceClient returning
 *                                            globalThis.__messagesServiceForTests()
 *   @/app/ai-dashboard/lib/company-guards -> getCompanyContext returning
 *                                            globalThis.__messagesCtxForTests
 *
 * Everything else loads as shipped — including job-scope, which means
 * getJobScope resolves the hiring team against the fake database for real
 * rather than being mocked. That is the point: the test exercises the actual
 * role -> scope -> filter chain, not a restatement of it.
 *
 * Register this AFTER node-resolve.mjs. Node calls the most recently
 * registered hook first, and this one has to see the bare specifiers.
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "server-only": "export {};",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    "  const make = globalThis.__messagesServiceForTests;",
    '  if (!make) throw new Error("test: no fake service installed; the real client must not be reached");',
    "  return make();",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function getCompanyContext() {",
    "  const ctx = globalThis.__messagesCtxForTests;",
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
