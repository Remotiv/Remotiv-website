/**
 * Resolve `react` to the build Next loads for Server Components.
 *
 * ── Why a test needs this ────────────────────────────────────
 *
 * React ships two `cache` implementations and the package's `exports` map picks
 * between them on the `react-server` condition:
 *
 *   "." : { "react-server": "./react.react-server.js", "default": "./index.js" }
 *
 * The DEFAULT build's cache is an unconditional pass-through — `return function
 * () { return fn.apply(null, arguments); }` and nothing else. Bare Node resolves
 * that one, so under node:test a cache()d function is simply called every time.
 *
 * That is why the existing scope tests are unaffected by wrapping readJobScope,
 * and it is also why they cannot demonstrate that it memoises. A test that wants
 * to see the real behaviour has to load the same module Next does, which this
 * hook does by absolute path — `react.react-server.js` is not an exported
 * subpath, so it cannot be reached by specifier.
 *
 * The server build still needs a dispatcher before it memoises anything; see
 * `withRequestScope` in job-scope-cache.test.ts.
 *
 * Register this LAST, so it sees the bare specifier.
 *
 * Test-only. Nothing in the application imports this.
 */
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_BUILD = resolvePath(ROOT, "node_modules/react/react.react-server.js");

export async function resolve(specifier, context, next) {
  if (specifier === "react") {
    if (!existsSync(SERVER_BUILD)) {
      throw new Error(`test: react server build not found at ${SERVER_BUILD}`);
    }
    return next(pathToFileURL(SERVER_BUILD).href, context);
  }
  return next(specifier, context);
}
