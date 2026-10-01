/**
 * Companion to node-resolve.mjs: replaces `server-only` with an empty module
 * and resolves everything else normally.
 *
 * `server-only` throws on import outside a React Server Component, which is
 * the point of it in the app and the only obstacle to loading a server module
 * under bare node:test. Nothing else is stubbed, so a test that uses this hook
 * runs the real module and everything it imports.
 *
 * Register this AFTER node-resolve.mjs. Node calls the most recently
 * registered hook first, and this one has to see the bare specifier.
 *
 * Test-only. Nothing in the application imports this.
 */

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export%20%7B%7D%3B", shortCircuit: true };
  }
  return next(specifier, context);
}
