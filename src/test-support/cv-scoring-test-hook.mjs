/**
 * Companion to node-resolve.mjs for the CV scorer's allowance tests ONLY.
 *
 * handleAiCvScore builds its own database client and its own Anthropic client,
 * so fakes cannot be passed in. This hook swaps exactly these specifiers and
 * lets everything else - the scorer, the allowance module, the parsers, the
 * queue's error classes - load as is:
 *
 *   server-only                 -> an empty module
 *   @/lib/supabase/server       -> createServiceClient returning the fake the
 *                                  test installed on globalThis.__cvScoringServiceForTests
 *   @/lib/anthropic             -> getAnthropic returning globalThis.__cvScoringAnthropicForTests
 *   @/lib/interviews/shortlist  -> maybeFlagForShortlist recording "shortlist"
 *   @/lib/notifications/company -> notifyCompany recording "notify"
 *
 * Each stub throws when its fake is not installed, so a real client can never
 * be reached by accident. Register this AFTER node-resolve.mjs: Node calls the
 * most recently registered hook first, and this one has to see the bare
 * specifiers.
 *
 * Test-only. Nothing in the application imports this.
 */

const missing = (what) =>
  `throw new Error("test: no fake ${what} installed; the real one must not be reached");`;

const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    "  const make = globalThis.__cvScoringServiceForTests;",
    `  if (!make) ${missing("service")}`,
    "  return make();",
    "}",
  ].join("\n"),
  "@/lib/anthropic": [
    "export function getAnthropic() {",
    "  const client = globalThis.__cvScoringAnthropicForTests;",
    `  if (!client) ${missing("Anthropic client")}`,
    "  return client;",
    "}",
  ].join("\n"),
  "@/lib/interviews/shortlist": [
    "export async function maybeFlagForShortlist() {",
    '  globalThis.__cvScoringEventsForTests?.push("shortlist");',
    "}",
  ].join("\n"),
  "@/lib/notifications/company": [
    "export async function notifyCompany() {",
    '  globalThis.__cvScoringEventsForTests?.push("notify");',
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
