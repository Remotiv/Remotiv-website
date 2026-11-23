/**
 * Lets a test drive admin server actions that only need an admin to be
 * signed in (requireAdmin / requireSuperAdmin) under bare node:test.
 * Register AFTER node-resolve.mjs and fake-service-client-hook.mjs.
 *
 *   @/app/admin/lib/role-guards -> both guards resolve to
 *                                  globalThis.__adminCtxForTests, or throw
 *                                  when none is installed, so the real guard
 *                                  (and its cookie-bound client) is never
 *                                  reached
 *   next/cache                  -> revalidatePath records each path on
 *                                  globalThis.__revalidatedPaths when a test
 *                                  installed that array, else does nothing
 *   next/headers                -> cookies() throws: nothing under test may
 *                                  read a real request
 *
 * Test-only. Nothing in the application imports this.
 */

const guard = (name) =>
  [
    `export async function ${name}() {`,
    "  const ctx = globalThis.__adminCtxForTests;",
    '  if (!ctx) throw new Error("Forbidden: admin role required");',
    "  return ctx;",
    "}",
  ].join("\n");

const STUBS = {
  "@/app/admin/lib/role-guards": [guard("requireAdmin"), guard("requireSuperAdmin")].join("\n"),
  "next/cache":
    "export function revalidatePath(path) { globalThis.__revalidatedPaths?.push(path); }",
  "next/headers": [
    "export async function cookies() {",
    '  throw new Error("test: no request cookies here");',
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
