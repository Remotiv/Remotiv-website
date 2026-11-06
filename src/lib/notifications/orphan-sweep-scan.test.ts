/**
 * The orphan sweep's safety premise, proved from source (#72, migration 056).
 *
 *   node --test src/lib/notifications/orphan-sweep-scan.test.ts
 *
 * The sweep clears a row because application_id IS NULL. That is only safe
 * where NULL can mean one thing: the FK nulled it when the applicant was
 * deleted. This file proves, from the writers, that every swept table and
 * every swept bell type is written against a live application, and shows the
 * scan refusing the one table where NULL means something else:
 * whatsapp_inbound, whose application_id is nullable by design.
 *
 * Pure functions over the TypeScript AST, with snippet controls, in the
 * style of communication-log-writes.test.ts.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { COMPANY_NOTIFICATION_TYPES, SWEEPABLE_NOTIFICATION_TYPES } = await import("./company.ts");

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Every production source file under src: no tests, no test support. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "test-support") walk(path);
        continue;
      }
      if (
        !/\.tsx?$/.test(entry.name) ||
        /\.test\.tsx?$/.test(entry.name) ||
        entry.name.endsWith(".d.ts")
      )
        continue;
      out.push({
        rel: relative(SRC, path).split("\\").join("/"),
        text: readFileSync(path, "utf8"),
      });
    }
  };
  walk(SRC);
  return out;
}

const parse = (name, text) =>
  ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const line = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** A property's initializer in an object literal: "absent", "null", "shorthand:<name>", or its text. */
function propValue(obj, name) {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return `shorthand:${name}`;
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name
    ) {
      const init = p.initializer;
      if (init.kind === ts.SyntaxKind.NullKeyword) return "null";
      if (ts.isIdentifier(init) && init.text === "undefined") return "null";
      return init.getText();
    }
  }
  return "absent";
}

function propNode(obj, name) {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name
    )
      return p.initializer;
  }
  return null;
}

/**
 * Whether an initializer is PROVABLY a non-null string, by one syntactic
 * rule: it is a parameter of the enclosing function typed exactly `string`,
 * or a property of such a parameter whose inline type literal types that
 * property exactly `string` and not optional. Anything else, a local, a
 * call, a nullable type, a field read through a const, is "not proven" and
 * reads as unsafe. The rule is narrow on purpose: it has to say no to
 * whatsapp_inbound.
 */
export function provablyString(init) {
  let fnNode = init.parent;
  while (fnNode && !ts.isFunctionLike(fnNode)) fnNode = fnNode.parent;
  if (!fnNode?.parameters) return false;
  const param = (name) =>
    fnNode.parameters.find(
      (p) => ts.isIdentifier(p.name) && p.name.text === name && !p.questionToken,
    );
  if (ts.isIdentifier(init)) {
    const p = param(init.text);
    return Boolean(p?.type && p.type.kind === ts.SyntaxKind.StringKeyword);
  }
  if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
    const p = param(init.expression.text);
    if (!p?.type || !ts.isTypeLiteralNode(p.type)) return false;
    const member = p.type.members.find(
      (m) => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === init.name.text,
    );
    return Boolean(
      member &&
        !member.questionToken &&
        member.type &&
        member.type.kind === ts.SyntaxKind.StringKeyword,
    );
  }
  return false;
}

/** Every notifyCompany / notifyCompanyMember call: its literal type and how it passes applicationId. */
export function bellWrites(sf) {
  const out = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === "notifyCompany" || n.expression.text === "notifyCompanyMember") &&
      n.arguments[0] &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      const obj = n.arguments[0];
      const typeNode = propNode(obj, "type");
      out.push({
        fn: n.expression.text,
        type: typeNode && ts.isStringLiteral(typeNode) ? typeNode.text : null,
        applicationId: propValue(obj, "applicationId"),
        line: line(sf, n),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether a call chain contains `.from("<table>")`. */
function chainHasFrom(node, table) {
  let e = node;
  while (e) {
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "from"
    ) {
      const arg = e.arguments[0];
      if (arg && ts.isStringLiteral(arg) && arg.text === table) return true;
    }
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
    else return false;
  }
  return false;
}

/** Every raw `.from("<table>").insert|upsert({...})`: how it writes application_id, and whether that is proven. */
export function rawInserts(sf, table) {
  const out = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === "insert" || n.expression.name.text === "upsert") &&
      chainHasFrom(n.expression.expression, table)
    ) {
      const obj = n.arguments[0];
      const row = obj && ts.isObjectLiteralExpression(obj) ? obj : null;
      const init = row ? propNode(row, "application_id") : null;
      out.push({
        line: line(sf, n),
        applicationId: row ? propValue(row, "application_id") : "opaque",
        provable: Boolean(init && provablyString(init)),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The bell-side problems for a candidate type list: every listed type must
 * be written only through notifyCompany, always with an applicationId that
 * is present and not the null literal.
 */
export function bellProblems(types, writesByFile) {
  const out = [];
  for (const type of types) {
    const sites = [];
    for (const [rel, writes] of writesByFile)
      for (const w of writes) if (w.type === type) sites.push({ rel, ...w });
    if (sites.length === 0) out.push(`${type}: no writer found; a stale list entry`);
    for (const s of sites) {
      if (s.fn !== "notifyCompany")
        out.push(
          `${type}: ${s.rel}:${s.line} writes it through ${s.fn}, which nulls application_id`,
        );
      if (s.applicationId === "absent" || s.applicationId === "null")
        out.push(
          `${type}: ${s.rel}:${s.line} passes no application id, so the bell is orphaned from birth`,
        );
    }
  }
  return out;
}

const files = sourceFiles();
const parsed = files.map((f) => ({ rel: f.rel, text: f.text, sf: parse(f.rel, f.text) }));
const writesByFile = new Map(parsed.map((f) => [f.rel, bellWrites(f.sf)]));

/* ── the list itself ─────────────────────────────────────────── */

test("the sweepable list is exactly the six name-bearing applicant types", () => {
  assert.deepEqual(
    [...SWEEPABLE_NOTIFICATION_TYPES],
    [
      "score_ready",
      "stage_change",
      "interview_booked",
      "interview_rescheduled",
      "interview_cancelled",
      "interview_expired",
    ],
  );
  for (const t of SWEEPABLE_NOTIFICATION_TYPES)
    assert.ok(COMPANY_NOTIFICATION_TYPES.includes(t), `${t} is not a bell type`);
  for (const t of [
    "applicant_deleted",
    "final_recording_lobby",
    "final_recording_failed",
    "final_recording_ready",
    "message_failed",
  ]) {
    assert.ok(!SWEEPABLE_NOTIFICATION_TYPES.includes(t), `${t} must not be swept`);
  }
});

/* ── the premise, from the writers ───────────────────────────── */

test("every sweepable type is written only through notifyCompany with an application id from a live row", () => {
  assert.deepEqual(bellProblems(SWEEPABLE_NOTIFICATION_TYPES, writesByFile), []);
});

test("no sweepable type is written by a raw insert; the only raw bell inserts are the two known modules", () => {
  const rawFiles = parsed
    .filter((f) => rawInserts(f.sf, "notifications_company").length > 0)
    .map((f) => f.rel)
    .sort();
  assert.deepEqual(rawFiles, ["lib/final-interviews/alerts.ts", "lib/notifications/company.ts"]);
  const alerts = parsed.find((f) => f.rel === "lib/final-interviews/alerts.ts").text;
  for (const t of SWEEPABLE_NOTIFICATION_TYPES)
    assert.ok(!alerts.includes(`"${t}"`), `alerts.ts writes ${t}`);
});

test("every raw insert into communication_logs carries an application id the scan can prove is a string", () => {
  const sites = parsed.flatMap((f) =>
    rawInserts(f.sf, "communication_logs").map((s) => ({ rel: f.rel, ...s })),
  );
  assert.ok(sites.length >= 4, `expected the four known writers, found ${sites.length}`);
  const unproven = sites
    .filter((s) => !s.provable)
    .map((s) => `${s.rel}:${s.line} application_id = ${s.applicationId}`);
  assert.deepEqual(unproven, []);
});

/* ── the controls ────────────────────────────────────────────── */

test("control: the scan refuses whatsapp_inbound, whose application_id is nullable by design", () => {
  const route = parsed.find((f) => f.rel === "app/api/webhooks/whatsapp/route.ts");
  const sites = rawInserts(route.sf, "whatsapp_inbound");
  assert.ok(sites.length >= 1, "the inbound insert was not found");
  assert.ok(
    sites.some((s) => !s.provable),
    "whatsapp_inbound passed the scan; a NULL there means unmatched, not deleted",
  );
});

test("control: adding applicant_deleted to the list is caught, because its writer passes no application id", () => {
  const problems = bellProblems(
    [...SWEEPABLE_NOTIFICATION_TYPES, "applicant_deleted"],
    writesByFile,
  );
  assert.ok(
    problems.some((p) => p.startsWith("applicant_deleted:") && p.includes("orphaned from birth")),
    problems.join("\n"),
  );
});

test("control: the provability rule says no to a nullable parameter, a local, and an optional property", () => {
  const cases = [
    [
      "param string",
      "function f(service, applicationId: string) { return service.from('t').insert({ application_id: applicationId }); }",
      true,
    ],
    [
      "param nullable",
      "function f(service, applicationId: string | null) { return service.from('t').insert({ application_id: applicationId }); }",
      false,
    ],
    [
      "literal property",
      "function f(service, row: { applicationId: string }) { return service.from('t').insert({ application_id: row.applicationId }); }",
      true,
    ],
    [
      "optional property",
      "function f(service, row: { applicationId?: string }) { return service.from('t').insert({ application_id: row.applicationId }); }",
      false,
    ],
    [
      "nullable property",
      "function f(service, row: { applicationId: string | null }) { return service.from('t').insert({ application_id: row.applicationId }); }",
      false,
    ],
    [
      "local const",
      "async function f(service) { const resolved = await find(); return service.from('t').insert({ application_id: resolved.applicationId }); }",
      false,
    ],
    [
      "null literal",
      "function f(service) { return service.from('t').insert({ application_id: null }); }",
      false,
    ],
  ];
  for (const [name, src, expected] of cases) {
    const sites = rawInserts(parse("x.ts", src), "t");
    assert.equal(sites.length, 1, `${name}: one site`);
    assert.equal(sites[0].provable, expected, `${name}: expected ${expected}`);
  }
});

test("control: a bell written through notifyCompanyMember, or with applicationId null, is a problem", () => {
  const sf = parse(
    "x.ts",
    [
      'await notifyCompanyMember({ companyId, memberId, type: "score_ready", title: "x", body: "y" });',
      'await notifyCompany({ companyId, type: "stage_change", title: "x", body: "y", applicationId: null });',
      'await notifyCompany({ companyId, type: "interview_expired", title: "x", body: "y", applicationId: session.application_id });',
    ].join("\n"),
  );
  const problems = bellProblems(
    ["score_ready", "stage_change", "interview_expired"],
    new Map([["x.ts", bellWrites(sf)]]),
  );
  // The Member write is reported twice: the wrong function, and the id it therefore lacks.
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.ok(problems[0].startsWith("score_ready:") && problems[0].includes("notifyCompanyMember"));
  assert.ok(problems[1].startsWith("score_ready:") && problems[1].includes("orphaned from birth"));
  assert.ok(problems[2].startsWith("stage_change:") && problems[2].includes("orphaned from birth"));
  assert.ok(
    !problems.some((x) => x.startsWith("interview_expired:")),
    "a live id is not a problem",
  );
});
