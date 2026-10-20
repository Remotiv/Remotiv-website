/**
 * A load hook that lets node:test import `.tsx` components, for render tests
 * with react-dom/server.
 *
 * Node strips TypeScript types but does not compile JSX, so a `.tsx` file is
 * transpiled here with the repo's own TypeScript (react-jsx, ES modules) and
 * nothing else: no bundling, no type check. A syntax error is thrown, not
 * transpiled into stray text. Register it after
 * node-resolve.mjs, which already resolves `@/…` and extensionless `.tsx`.
 *
 *   register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
 *
 * Test-only. Nothing in the application imports this, and Next never sees it.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function load(url, context, next) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
  const source = await readFile(fileURLToPath(url), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  // Transpiling alone would render broken JSX as text; a syntax error fails the test instead.
  if (diagnostics?.length) {
    const first = diagnostics[0];
    throw new Error(
      `tsx-load: ${fileURLToPath(url)}: ${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`,
    );
  }
  return { format: "module", source: outputText, shortCircuit: true };
}
