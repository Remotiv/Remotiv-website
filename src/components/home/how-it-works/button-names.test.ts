/**
 * #38: the "How Remotiv works" section has no fake buttons. The candidate
 * mock-up's action icons do nothing, so they are decoration: not buttons, not
 * focusable, hidden from assistive technology. Anything interactive that is
 * left (links) has a name.
 *
 *   node --test src/components/home/how-it-works/button-names.test.ts
 *
 * The section renders as shipped (renderToStaticMarkup).
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
// The icons barrel is a directory import, which Node's resolver refuses;
// next/image and next/link are CommonJS defaults it cannot hand React, so
// they render as a plain <img> and <a>.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "@/components/icons") return next("@/components/icons/index.ts", context);
  if (specifier === "next/link") {
    const link = "export default function Link({ href, prefetch, ...p }) { return globalThis.__h('a', { href, ...p }); }";
    return { url: "data:text/javascript," + encodeURIComponent(link), shortCircuit: true };
  }
  if (specifier === "next/image") {
    const img = "export default function Image({ fill, priority, ...p }) { return globalThis.__h('img', p); }";
    return { url: "data:text/javascript," + encodeURIComponent(img), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
globalThis.__h = createElement;
const { renderToStaticMarkup } = await import("react-dom/server");
const { HowItWorks } = await import("./index.tsx");

const html = renderToStaticMarkup(createElement(HowItWorks));
const decode = (v) =>
  v
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const nameOf = (attrs, inner) =>
  decode(/aria-label="([^"]*)"/.exec(attrs)?.[1] ?? "").trim() ||
  inner
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

// Negative control: put one icon back as a <button> and this fails.
test("no fake buttons: nothing in the section is a button or pretends to be one", () => {
  assert.equal((html.match(/<button\b/g) ?? []).length, 0, "<button> elements");
  assert.doesNotMatch(html, /role="button"/);
  assert.doesNotMatch(html, /tabindex=/i, "nothing made focusable by hand");
});

// Negative control: drop aria-hidden from a candidate's icon pair and this fails.
test("the six candidate icons are hidden decoration, with no labels", () => {
  const hidden = [
    ...html.matchAll(/<div aria-hidden="true" class="flex gap-1\.5">([\s\S]*?)<\/div>/g),
  ];
  assert.equal(hidden.length, 3, "one hidden pair per candidate");
  const icons = hidden.flatMap((m) => [...m[1].matchAll(/<span class="flex size-11[^"]*">/g)]);
  assert.equal(icons.length, 6);
  assert.doesNotMatch(html, /aria-label="(View|Message) /, "the old labels are gone");
});

test("every link left in the section has a name", () => {
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
  const unnamed = links.filter((m) => !nameOf(m[1], m[2]));
  assert.deepEqual(
    unnamed.map((m) => m[0].slice(0, 80)),
    [],
  );
});
