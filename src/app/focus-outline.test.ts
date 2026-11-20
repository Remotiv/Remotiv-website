/**
 * #46: the global keyboard focus outline lives in Tailwind's base layer, so a
 * rounded button keeps its corners on focus and a component's own focus
 * utilities win over it. Every field that removes the outline still shows a
 * focus style of its own.
 *
 *   node --test src/app/focus-outline.test.ts
 *
 * The outline rule is read from globals.css. Every `outline-none` in a .tsx
 * file under src/ is found by parsing with TypeScript (comments are not AST
 * nodes) and must carry one of:
 *   - its own focus style on the same element (ring, border, outline, shadow
 *     under a focus: or focus-visible: variant; an always-on ring is not one);
 *   - a parent with a focus-within: style (a search box that lights up);
 *   - focus that only code gives (tabIndex={-1}, a dialog), where no ring is meant.
 * No exceptions: the two Applicants gaps were closed in f42a9a0.
 *
 * The rendered behaviour (the radius kept, the ring shown) was checked once in
 * headless Chrome against the compiled globals.css; this pins the source.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("..", import.meta.url));
/**
 * A focus style: a variant that changes on focus. A ring that is always shown
 * does not count (#46): it looks the same focused or not, so a keyboard user
 * cannot tell where focus is.
 */
const OWN_FOCUS =
  /(^|\s)(focus|focus-visible):(ring|border|shadow|outline-(?!none)|-?outline-offset)/;
const BG_ONLY = /(^|\s)(focus|focus-visible):bg-/;
const CODE_FOCUS = /tabIndex=\{-1\}|role="dialog"|aria-modal/;

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

function classify() {
  const out = [];
  for (const p of walk(SRC).filter((f) => f.endsWith(".tsx"))) {
    const text = readFileSync(p, "utf8");
    if (!text.includes("outline-none")) continue;
    const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n) => {
      const literal =
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n);
      if (literal && /(^|\s)outline-none(\s|$)/.test(n.text)) {
        let el = n;
        while (el && !ts.isJsxOpeningElement(el) && !ts.isJsxSelfClosingElement(el)) el = el.parent;
        const elText = el ? el.getText(sf) : n.text;
        const kind =
          OWN_FOCUS.test(n.text) || OWN_FOCUS.test(elText)
            ? "own"
            : el && CODE_FOCUS.test(elText)
              ? "code-focus"
              : el && withinFocusBox(el, sf)
                ? "focus-within"
                : BG_ONLY.test(n.text)
                  ? "bg-only"
                  : "none";
        out.push({
          file: relative(SRC, p),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          kind,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** A JSX ancestor whose className carries a focus-within: style. */
function withinFocusBox(el, sf) {
  for (let p = el.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) {
      const cls = p.openingElement.attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "className",
      );
      if (cls?.initializer && /focus-within:/.test(cls.initializer.getText(sf))) return true;
    }
  }
  return false;
}

test("the global focus outline is in the base layer and sets no corner radius", () => {
  const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  const layer = css.match(
    /@layer base \{\s*\*:focus-visible \{([^}]*)\}\s*\*:focus:not\(:focus-visible\) \{[^}]*\}\s*\}/,
  );
  assert.ok(layer, "*:focus-visible inside @layer base");
  assert.match(layer[1], /outline: 2px solid var\(--color-remotiv-purple\);/);
  assert.doesNotMatch(
    layer[1],
    /border-radius/,
    "no radius: the outline follows the element's corners",
  );
  const unlayered = css.replace(/@layer base \{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(unlayered, /\*:focus-visible\s*\{/, "no unlayered copy left behind");
});

// Negative control: put `outline-none` back on any of the 30 fields #46 fixed
// (admin search, the services forms, ...) and this names it.
test("every field that removes the outline has a focus style of its own", () => {
  const rows = classify();
  assert.ok(rows.length > 100, `scanned ${rows.length} outline-none uses`);
  const bad = rows.filter((r) => r.kind === "none" || r.kind === "bg-only");
  assert.deepEqual(
    bad.map((r) => `${r.file}:${r.line} (${r.kind})`),
    [],
    "outline-none with no focus style: the base-layer rule no longer shows a ring there",
  );
});
