/**
 * #43: one tab-title format, "Page - Remotiv", applied by the root layout's
 * metadata template, and a 404 that names itself.
 *
 *   node --test src/lib/tab-titles.test.ts
 *
 * Reads every metadata title in src/app with the TypeScript AST (the
 * `metadata` export and `generateMetadata` returns of page, layout and
 * not-found files). A title the template will suffix must not carry the brand
 * itself, and no title uses the old separators. `{ absolute }` titles are
 * written out in full on purpose and only checked for separators.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const ROOT = new URL("../../", import.meta.url);
const files = globSync("src/app/**/{page,layout,not-found}.{ts,tsx}", {
  cwd: ROOT.pathname.replace(/%20/g, " "),
}).sort();

/** Each top-level metadata title: its file:line, its text, and whether it is absolute. */
function titles() {
  const out = [];
  for (const rel of files) {
    const text = readFileSync(new URL(rel, ROOT), "utf8");
    const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const at = (n) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n, inMeta) => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === "metadata") inMeta = true;
      if (ts.isFunctionDeclaration(n) && n.name?.getText() === "generateMetadata") inMeta = true;
      if (inMeta && ts.isPropertyAssignment(n) && n.name.getText() === "title") {
        const owner = n.parent.parent;
        const nested =
          ts.isPropertyAssignment(owner) &&
          ["openGraph", "twitter", "absolute", "default"].includes(owner.name.getText());
        if (!nested) {
          const init = n.initializer;
          if (ts.isObjectLiteralExpression(init)) {
            for (const p of init.properties) {
              if (!ts.isPropertyAssignment(p)) continue;
              const key = p.name.getText();
              if (key === "absolute" || key === "default" || key === "template")
                out.push({ at: at(p), key, value: p.initializer.getText() });
            }
          } else {
            out.push({ at: at(n), key: "title", value: init.getText() });
          }
        }
      }
      ts.forEachChild(n, (c) => visit(c, inMeta));
    };
    visit(src, false);
  }
  return out;
}

const all = titles();

test("the root, dashboard and admin layouts each set their template", () => {
  const root = all.filter((t) => t.at.startsWith("src/app/layout.tsx"));
  assert.ok(
    root.some((t) => t.key === "template" && t.value === '"%s - Remotiv"'),
    "root template",
  );
  assert.ok(
    root.some((t) => t.key === "default"),
    "home keeps its own title",
  );
  const tpl = (f) => all.find((t) => t.at.startsWith(f) && t.key === "template")?.value;
  assert.equal(tpl("src/app/ai-dashboard/layout.tsx"), '"%s"');
  assert.equal(tpl("src/app/admin/layout.tsx"), '"%s - Remotiv Admin"');
});

// Negative control: put back any "X · Remotiv", "X | Remotiv" or "Admin — Remotiv".
test("no tab title uses a dot, a pipe, or an en or em dash as its separator", () => {
  const bad = all.filter((t) => /[·|–—]/.test(t.value));
  assert.deepEqual(bad, []);
});

// Negative control: put back "Privacy Policy - Remotiv" and it would read "... - Remotiv - Remotiv".
test("a title the template suffixes does not carry the brand itself", () => {
  // Under /ai-dashboard the template is "%s": its pages name the product
  // themselves ("Jobs - Remotiv AI Interviews"), so they are exempt here.
  const doubled = all.filter(
    (t) =>
      t.key === "title" &&
      !t.at.startsWith("src/app/ai-dashboard/") &&
      /- Remotiv( Admin)?["`]$/.test(t.value),
  );
  assert.deepEqual(doubled, []);
});

// Negative control: put back `default: "Remotiv Admin"` and it renders "Remotiv Admin - Remotiv".
test("below the root, a layout's own title is absolute: Next applies the parent template to a default", () => {
  const nestedDefaults = all.filter(
    (t) =>
      t.key === "default" && t.at.includes("layout.tsx") && !t.at.startsWith("src/app/layout.tsx"),
  );
  assert.deepEqual(nestedDefaults, []);
  const own = (f) => all.find((t) => t.at.startsWith(f) && t.key === "absolute")?.value;
  assert.equal(own("src/app/admin/layout.tsx"), '"Remotiv Admin"');
  assert.equal(own("src/app/ai-dashboard/layout.tsx"), '"Remotiv AI Interviews"');
});

test("the 404s name themselves instead of showing the home title", () => {
  const notFound = all.filter((t) => t.at.includes("not-found.tsx")).map((t) => t.at.split(":")[0]);
  for (const f of [
    "src/app/not-found.tsx",
    "src/app/jobs/not-found.tsx",
    "src/app/careers/[slug]/not-found.tsx",
    "src/app/talent/[id]/not-found.tsx",
  ]) {
    assert.ok(notFound.includes(f), `${f} has a title`);
  }
});
