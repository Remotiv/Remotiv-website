/**
 * Lets a test drive the admin erasure actions (app/admin/erasure/actions.ts)
 * under bare node:test. Register AFTER node-resolve.mjs and
 * fake-service-client-hook.mjs, so this one sees the bare specifier first.
 *
 *   @/app/admin/lib/role-guards -> requireSuperAdmin returning
 *                                  globalThis.__adminCtxForTests, or throwing
 *                                  when none is installed, so the real guard
 *                                  (and its cookie-bound client) is never
 *                                  reached
 *
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "@/app/admin/lib/role-guards": [
    "export async function requireSuperAdmin() {",
    "  const ctx = globalThis.__adminCtxForTests;",
    '  if (!ctx) throw new Error("Forbidden: super_admin role required");',
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
