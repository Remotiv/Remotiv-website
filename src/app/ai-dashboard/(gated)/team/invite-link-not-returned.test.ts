/**
 * The raw invitation link goes in the email and nowhere else (#48, QA-SAFETY-40
 * T-2).
 *
 *   node --test "src/app/ai-dashboard/(gated)/team/invite-link-not-returned.test.ts"
 *
 * inviteMember and resendInvite used to return { acceptUrl } to the inviting
 * admin. The team page never read it, but it put a redeemable token in the
 * admin's browser, which is what made re-inviting an existing user a way to
 * guess their password. Source pins over the TypeScript AST, because the
 * actions need a session, a database and a mailer to run.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const SRC = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const sf = ts.createSourceFile("actions.ts", SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function fn(name) {
  let found = null;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
  });
  assert.ok(found, `${name} not found`);
  return found;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

for (const name of ["inviteMember", "resendInvite"]) {
  test(`${name}: neither its type nor any return carries the accept link`, () => {
    const f = fn(name);
    assert.doesNotMatch(f.type.getText(sf), /acceptUrl|token/i, "return type");
    let returns = 0;
    walk(f.body, (n) => {
      if (ts.isReturnStatement(n)) {
        returns++;
        assert.doesNotMatch(n.getText(sf), /acceptUrl|rawToken/, n.getText(sf));
      }
    });
    assert.ok(returns > 2, "the success and failure returns were all inspected");
  });

  test(`${name}: the link is built once and used only inside the invite email`, () => {
    const f = fn(name);
    const uses = [];
    walk(f.body, (n) => {
      if (ts.isIdentifier(n) && n.text === "acceptUrl" && !ts.isVariableDeclaration(n.parent))
        uses.push(n);
    });
    assert.equal(uses.length, 1, "one use");
    let p = uses[0].parent;
    while (p && !ts.isCallExpression(p)) p = p.parent;
    assert.equal(p.expression.getText(sf), "renderCompanyInviteEmail");
  });
}
