/**
 * Module-resolution hooks for running node:test directly against source files.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * The repo's source uses the bundler's conventions: `@/…` for src/ and
 * extensionless relative imports. Node's type stripping runs the TypeScript
 * but resolves nothing the bundler would, so until now a module could only be
 * tested under bare Node if it had no value imports at all - which is why
 * every tested module so far is either self-contained or lazy-imports its
 * dependencies. job-patch.ts is the first that genuinely needs its
 * neighbours (the enum lists, the numeric-mode rule), so this is the first
 * test to register hooks.
 *
 * A test opts in with:
 *
 *   import { register } from "node:module";
 *   register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
 *   const mod = await import("./the-module.ts");
 *
 * Test-only. Nothing in the application imports this, and Next never sees it.
 */
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", "/index.ts"];

function withExtension(path) {
  if (existsSync(path) && !existsSync(`${path}.ts`)) return path;
  for (const ext of EXTENSIONS) {
    if (existsSync(path + ext)) return path + ext;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const target = withExtension(resolvePath(SRC, specifier.slice(2)));
    if (target) return next(pathToFileURL(target).href, context);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const target = withExtension(resolvePath(base, specifier));
    if (target) return next(pathToFileURL(target).href, context);
  }
  return next(specifier, context);
}
