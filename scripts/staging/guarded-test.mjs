/**
 * Playwright's `test`, with the network guard installed on every context
 * BEFORE any page exists in it.
 *
 *   import { guardedTest } from "./guarded-test.mjs";
 *   const test = guardedTest(guard);
 *
 * Playwright's built-in `page` fixture is created FROM the `context` fixture,
 * so overriding `context` here means every page in every test, including
 * pages a test opens itself with context.newPage(), is covered from its
 * first navigation. The override consumes the base context so the config's
 * baseURL and timeouts still apply, and adds:
 *
 *   - serviceWorkers: "block"   via contextOptions, so no worker can issue
 *                               requests outside the interception
 *   - context.route("**")       every HTTP request, decided by the guard
 *   - context.routeWebSocket    every WebSocket, decided by the guard; a
 *                               forbidden one is closed, never connected
 *   - context.on("response")    counts successful approved responses
 *
 * All three registrations happen before `use(context)`, which is before the
 * page fixture runs. harness-wiring.test.mjs pins that order in this text.
 */

import { test as base } from "@playwright/test";

export function guardedTest(guard) {
  return base.extend({
    contextOptions: async ({ contextOptions }, use) => {
      await use({ ...contextOptions, serviceWorkers: "block" });
    },
    context: async ({ context }, use) => {
      await context.route("**/*", guard.handleRoute);
      await context.routeWebSocket(() => true, guard.handleWebSocket);
      context.on("response", guard.onResponse);
      await use(context);
    },
  });
}
