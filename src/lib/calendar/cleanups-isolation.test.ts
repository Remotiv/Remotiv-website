/**
 * #56: every read and write of calendar_cleanups (migration 070) is on one
 * company. The scanner tenant-isolation.test.ts runs checks job_applications
 * only; this checks this table, the same way, from the source.
 *
 *   node --test src/lib/calendar/cleanups-isolation.test.ts
 *
 * Every `.from("calendar_cleanups")` chain in src (outside tests) must carry
 * `.eq("company_id", V)`, or, for an insert or upsert, a `company_id: V` in
 * its payload, where V is one of the traced shapes below, each pinned to where
 * it comes from. No chain is excused: the worker's sweep reads one company at
 * a time, and its only cross-company step is the database function
 * calendar_cleanup_companies, which returns company ids and nothing else.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const SRC = new URL("../../", import.meta.url);
const TABLE = "calendar_cleanups";

/**
 * The company values a chain may filter on, and where each comes from (each
 * pinned by a test below):
 *   ctx.companyId   the signed-in member's company (getCompanyContext);
 *   args.companyId  resolveCleanupsOnReconnect: the Google callback's ctx;
 *   companyId       a parameter: recordPendingCleanup / activateCalendarCleanups
 *                   (callers pass ctx.companyId), sweepCompany (the database
 *                   function's company ids), and the delete step's own
 *                   companyId (the applicant delete's ctx.companyId);
 *   r.company_id    a calendar_cleanups row this module read with a company
 *                   filter (deleteForHost: rows from those reads).
 */
const TRUSTED = new Set(["ctx.companyId", "args.companyId", "companyId", "r.company_id"]);

function files(dir, out = []) {
  for (const e of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) files(`${rel}/`, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every chain on calendar_cleanups: its file, function, methods (name + arg texts) and payload. */
export function chainsIn(rel, text) {
  if (!text.includes(TABLE)) return [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const enclosingFn = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if (
        (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
        ts.isVariableDeclaration(p.parent)
      )
        return p.parent.name.getText(sf);
      if (ts.isMethodDeclaration(p)) return p.name.getText(sf);
    }
    return "(module)";
  };
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "from" &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === TABLE
    ) {
      const methods = [];
      let cur = n;
      while (
        cur.parent &&
        ts.isPropertyAccessExpression(cur.parent) &&
        cur.parent.parent &&
        ts.isCallExpression(cur.parent.parent)
      ) {
        const call = cur.parent.parent;
        methods.push({
          name: cur.parent.name.text,
          args: call.arguments.map((a) => a.getText(sf)),
          node: call,
        });
        cur = call;
      }
      out.push({
        file: rel,
        fn: enclosingFn(n),
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        methods,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The company value a chain is on, or null: a filter, or an insert/upsert payload. */
export function companyOf(chain) {
  const eq = chain.methods.find((m) => m.name === "eq" && m.args[0] === '"company_id"');
  if (eq) return eq.args[1];
  const write = chain.methods.find((m) => m.name === "upsert" || m.name === "insert");
  if (write) {
    const payload = write.node.arguments[0];
    if (payload && ts.isObjectLiteralExpression(payload)) {
      for (const p of payload.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === "company_id")
          return p.initializer.getText();
      }
    }
  }
  return null;
}

const ALL = files("").flatMap((rel) => chainsIn(rel, readFileSync(new URL(rel, SRC), "utf8")));

test("I1. the scan found the table's reads and writes (vacuity floor)", () => {
  assert.ok(ALL.length >= 9, `only ${ALL.length} chains found`);
  const fns = new Set(ALL.map((c) => c.fn));
  for (const fn of [
    "recordPendingCleanup",
    "activateCalendarCleanups",
    "listOpenCleanups",
    "markCleanupRemoved",
    "resolveCleanupsOnReconnect",
    "deleteForHost",
    "sweepCompany",
  ]) {
    assert.ok(fns.has(fn), `${fn} not seen`);
  }
});

test("I2. every calendar_cleanups read and write is on one company, with a traced value", () => {
  const bad = ALL.filter((c) => !TRUSTED.has(companyOf(c) ?? "")).map(
    (c) => `${c.file}:${c.line} ${c.fn}() company=${companyOf(c)}`,
  );
  assert.deepEqual(bad, []);
});

test("I3. only the calendar modules touch the table", () => {
  const where = [...new Set(ALL.map((c) => c.file))].sort();
  assert.deepEqual(where, ["lib/calendar/bookings.ts", "lib/calendar/cleanups.ts"]);
});

const CLEANUPS = readFileSync(new URL("lib/calendar/cleanups.ts", SRC), "utf8");
const BOOKINGS = readFileSync(new URL("lib/calendar/bookings.ts", SRC), "utf8");

test("I4. where each traced value comes from", () => {
  // `companyId` parameters: the delete action passes its ctx; the sweep the function's ids.
  const actions = readFileSync(
    new URL("app/ai-dashboard/(gated)/applicants/actions.ts", SRC),
    "utf8",
  );
  // #16: the delete activates nothing itself (071's Finish does, in SQL, on its
  // own p_company_id); the booking step still gets the action's ctx.
  assert.doesNotMatch(actions, /activateCalendarCleanups\(/);
  assert.match(actions, /cancelScreeningBookingsForDeletion\(ctx\.companyId, applicationId, \{/);
  assert.match(BOOKINGS, /await recordPendingCleanup\(service, companyId, applicationId, \{/);
  assert.match(
    CLEANUPS,
    /for \(const companyId of companies\) \{[^}]*step = await sweepCompany\(service, companyId, now, budget, deadlineAt\);/,
  );
  assert.match(CLEANUPS, /service\.rpc\("calendar_cleanup_companies"/);
  // args.companyId: the Google callback passes its own ctx.
  const callback = readFileSync(new URL("app/api/calendar/google/callback/route.ts", SRC), "utf8");
  assert.match(callback, /resolveCleanupsOnReconnect\(\{\s*companyId: ctx\.companyId,/);
  // r.company_id: deleteForHost only ever gets rows read with a company filter.
  assert.equal(
    (CLEANUPS.match(/await deleteForHost\(\s*service,/g) ?? []).length,
    2,
    "two callers: the reconnect read and the sweep's per-company read",
  );
  // ctx.companyId: the bell's read and clear take the server's context.
  const bellActions = readFileSync(
    new URL("app/ai-dashboard/(gated)/notification-actions.ts", SRC),
    "utf8",
  );
  assert.match(
    bellActions,
    /const ctx = await getCompanyContext\(\);\s*return await markCleanupRemoved\(ctx, id\);/,
  );
});

test("I5. the scanner catches what it must (each shape fails, the safe ones pass)", () => {
  const scan = (body) => chainsIn("x.ts", `async function f(service, ctx, other) { ${body} }`);
  const verdict = (body) => scan(body).map((c) => TRUSTED.has(companyOf(c) ?? ""));
  assert.deepEqual(
    verdict('await service.from("calendar_cleanups").select("id");'),
    [false],
    "no filter",
  );
  assert.deepEqual(
    verdict('await service.from("calendar_cleanups").select("id").eq("company_id", other);'),
    [false],
    "an untraced value",
  );
  assert.deepEqual(
    verdict(
      'await service.from("calendar_cleanups").select("id").eq("host_member_id", ctx.companyId);',
    ),
    [false],
    "the right value on the wrong column",
  );
  assert.deepEqual(
    verdict('await service.from("calendar_cleanups").upsert({ id: 1 });'),
    [false],
    "a write without a company",
  );
  assert.deepEqual(
    verdict(
      'await service.from("calendar_cleanups").select("id").eq("company_id", ctx.companyId);',
    ),
    [true],
  );
  assert.deepEqual(
    verdict('await service.from("calendar_cleanups").upsert({ company_id: ctx.companyId, x: 1 });'),
    [true],
  );
});
