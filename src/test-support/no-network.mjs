/**
 * Block every network path for the rest of this test process (#48).
 *
 * The limiter and diagnostics tests must never reach a real Redis: a fake URL
 * on *.upstash.io resolves, and a test that slipped into the real client would
 * send a token to real infrastructure. So this replaces
 *
 *   globalThis.fetch                       (what @upstash/redis calls)
 *   node:http / node:https request + get    (anything older)
 *   node:net connect / createConnection     (undici and raw sockets)
 *   node:tls connect
 *
 * with functions that RECORD the attempt and THROW. A throw alone could be
 * swallowed by code under test (the limiter fails closed on any error), so the
 * record is the real check: every file that installs this ends with
 * `guard.assertNoNetwork()` in a test of its own, which fails the suite if
 * anything tried. no-network.test.ts proves the guard catches a real Upstash
 * client.
 *
 * Test-only. Nothing in the application imports this.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);

export class NetworkBlockedError extends Error {
  name = "NetworkBlockedError";
}

export function blockNetwork() {
  const attempts = [];
  const block = (what) =>
    function blocked() {
      attempts.push(what);
      throw new NetworkBlockedError(`network blocked in unit tests: ${what}`);
    };
  globalThis.fetch = async () => block("fetch")();
  for (const [mod, fns] of [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
  ]) {
    const m = require(mod);
    for (const fn of fns) m[fn] = block(`${mod.slice(5)}.${fn}`);
  }
  syncBuiltinESMExports();
  return {
    attempts,
    assertNoNetwork() {
      if (attempts.length > 0) {
        throw new Error(`a unit test tried the network: ${attempts.join(", ")}`);
      }
    },
  };
}
