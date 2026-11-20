/**
 * #44: the "Remotiv." logo on the three sign-in pages links home without
 * prefetching it. With prefetch on, opening a sign-in page fetched the home
 * page's route data and its 10 eager images (hero portraits, How it works
 * avatars), about 54 KB, 12.5% of the page, measured on production.
 *
 *   node --test src/app/login-logo-prefetch.test.ts
 *
 * Each file is parsed with TypeScript and every <Link href="/"> in it is
 * checked, so a comment or a string cannot satisfy the test.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const FILES = {
  "ai-dashboard/login/login-client.tsx": 2,
  "talent/login/login-client.tsx": 2,
  "client/login/login-client.tsx": 2,
};

/** Every <Link href="/"> in the file, with its prefetch attribute's source text. */
function homeLinks(rel) {
  const text = readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (n) => {
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      n.tagName.getText(sf) === "Link"
    ) {
      const attrs = Object.fromEntries(
        n.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((a) => [a.name.getText(sf), a.initializer ? a.initializer.getText(sf) : "true"]),
      );
      if (attrs.href === '"/"') {
        found.push({
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          prefetch: attrs.prefetch ?? null,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// Negative control: remove prefetch={false} from any one of the six and this fails.
test("every logo link home on the sign-in pages has prefetch={false}, and still goes to /", () => {
  let total = 0;
  for (const [rel, expected] of Object.entries(FILES)) {
    const links = homeLinks(rel);
    assert.equal(links.length, expected, `${rel}: ${expected} links home`);
    for (const l of links) {
      assert.equal(l.prefetch, "{false}", `${rel}:${l.line}`);
    }
    total += links.length;
  }
  assert.equal(total, 6);
});
