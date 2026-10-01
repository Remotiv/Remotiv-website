/**
 * Every write to communication_logs.body goes through redactCandidateLinks.
 *
 *   node --test src/lib/communication-log-writes.test.ts
 *
 * Two halves, because each catches what the other cannot.
 *
 * The SCAN parses every source file with the TypeScript compiler, finds every
 * `.from("communication_logs").insert|update|upsert(...)`, and requires each
 * `body` it writes to be `redactCandidateLinks(...)`, an empty string, or null.
 * A shorthand `body`, a body hidden in a spread, a payload built elsewhere and
 * passed by name, or the table name held in a variable all fail. This is the
 * test that fails when a NEW write path skips the redactor.
 *
 * The RUN drives the real deliverEmail with a fake database and checks what
 * was actually inserted. It is what proves the redactor is applied to the
 * value, not merely named near it, on the path every invite takes.
 *
 * Why both exist: the first S2 fix redacted the daily-cap insert and stored the
 * normal send raw, and its tests only exercised the redactor itself. Run
 * against that code, both halves below fail.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TABLE = "communication_logs";
const WRITES = new Set(["insert", "update", "upsert"]);
const REDACTOR = "redactCandidateLinks";
const SRC = fileURLToPath(new URL("../", import.meta.url));

/* ── the scan ─────────────────────────────────────────────────── */

function isTableLiteral(node) {
  return ts.isStringLiteralLike(node) && node.text === TABLE;
}

/** `x.from("communication_logs")`, the call itself. */
function isFromTable(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "from" &&
    node.arguments.length > 0 &&
    isTableLiteral(node.arguments[0])
  );
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

/** "" , null, or exactly one call to the redactor. Nothing else is safe. */
function isSafeBody(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isStringLiteralLike(e) && e.text === "") return true;
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === REDACTOR;
}

/** Any `body` key anywhere under a node, for spreads whose contents vary. */
function mentionsBodyKey(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      propName(n.name) === "body"
    ) {
      found = true;
      return;
    }
    if (ts.isSpreadAssignment(n) && !ts.isObjectLiteralExpression(n.expression)) {
      // A spread of something built elsewhere could carry anything.
      const inner = n.expression;
      if (!ts.isConditionalExpression(inner) && !ts.isParenthesizedExpression(inner)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Problems with one object literal written to the table. */
function checkObject(obj, where) {
  const problems = [];
  let bodies = 0;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (mentionsBodyKey(p)) problems.push(`${where}: a spread that may carry body`);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === "body") {
      problems.push(`${where}: shorthand \`body\` is not redacted at the write`);
      bodies += 1;
      continue;
    }
    if (ts.isPropertyAssignment(p) && propName(p.name) === "body") {
      bodies += 1;
      if (!isSafeBody(p.initializer)) {
        problems.push(`${where}: body is \`${p.initializer.getText()}\`, not ${REDACTOR}(...)`);
      }
    }
  }
  return { problems, bodies };
}

/**
 * The object a write is given. A literal is read directly. A name is followed
 * to its declaration in the same file, and any later `name.body = ...` or
 * `name["body"] = ...` is refused. Anything else cannot be checked, so it fails.
 */
function resolvePayload(arg, sf, where) {
  if (ts.isObjectLiteralExpression(arg)) return { obj: arg };
  if (ts.isIdentifier(arg)) {
    let decl = null;
    let assignsBody = false;
    const visit = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === arg.text &&
        n.initializer
      ) {
        decl = n.initializer;
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ((ts.isPropertyAccessExpression(n.left) &&
          ts.isIdentifier(n.left.expression) &&
          n.left.expression.text === arg.text &&
          n.left.name.text === "body") ||
          (ts.isElementAccessExpression(n.left) &&
            ts.isIdentifier(n.left.expression) &&
            n.left.expression.text === arg.text &&
            ts.isStringLiteralLike(n.left.argumentExpression) &&
            n.left.argumentExpression.text === "body"))
      ) {
        assignsBody = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (assignsBody)
      return { problem: `${where}: \`${arg.text}.body\` is assigned outside the write` };
    if (decl && ts.isObjectLiteralExpression(decl)) return { obj: decl };
    return {
      problem: `${where}: payload \`${arg.text}\` is not a literal in this file, cannot verify`,
    };
  }
  return { problem: `${where}: payload \`${arg.getText()}\` cannot be verified` };
}

/** Scan one source text. Pure, so the self-tests below can feed it snippets. */
export function scanSource(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems = [];
  const writes = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n) => {
    // The table name anywhere but `.from("...")` is a write we cannot follow.
    if (isTableLiteral(n)) {
      const parent = n.parent;
      if (
        !(parent && ts.isCallExpression(parent) && isFromTable(parent) && parent.arguments[0] === n)
      ) {
        problems.push(`${fileName}:${line(n)}: "${TABLE}" used outside .from(), cannot follow it`);
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITES.has(n.expression.name.text) &&
      isFromTable(n.expression.expression)
    ) {
      const where = `${fileName}:${line(n)} .${n.expression.name.text}`;
      const arg = n.arguments[0];
      if (!arg) {
        problems.push(`${where}: no payload`);
      } else {
        const payload = resolvePayload(arg, sf, where);
        if (payload.problem) {
          problems.push(payload.problem);
          writes.push({ where, bodies: 0 });
        } else {
          const r = checkObject(payload.obj, where);
          problems.push(...r.problems);
          writes.push({ where, bodies: r.bodies });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { problems, writes };
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/* ── the scanner discriminates ────────────────────────────────── */

const wrap = (payload) =>
  `async function f(s) { await s.from("communication_logs").insert(${payload}); }`;

test("the scanner refuses every unsafe shape and accepts the safe ones", () => {
  const refused = {
    raw: wrap("{ body: html }"),
    "a property read": wrap("{ body: row.body }"),
    shorthand: wrap("{ status, body }"),
    "a fallback": wrap('{ body: row.body ?? "" }'),
    "redactor on one branch only": wrap("{ body: ok ? redactCandidateLinks(a) : a }"),
    "a spread of a variable": wrap("{ status, ...extra }"),
    "a spread literal carrying body": wrap("{ ...{ body: html } }"),
    "a payload assigned later": `async function f(s) { const p = { status: "x" }; p.body = html; await s.from("communication_logs").update(p); }`,
    "a payload from elsewhere": `async function f(s, p) { await s.from("communication_logs").update(p); }`,
    "an array": wrap("[{ body: html }]"),
    "the table in a variable": `const T = "communication_logs"; async function f(s) { await s.from(T).insert({ body: html }); }`,
  };
  for (const [name, src] of Object.entries(refused)) {
    assert.ok(scanSource("x.ts", src).problems.length > 0, `not refused: ${name}`);
  }
  const accepted = {
    redacted: wrap("{ body: redactCandidateLinks(html) }"),
    "empty string": wrap('{ body: "" }'),
    null: wrap("{ body: null }"),
    "no body at all": wrap('{ status: "sent" }'),
    "a conditional spread without body": wrap("{ status, ...(sent ? { sent_at: now } : {}) }"),
    "a named payload with no body": `async function f(s) { const p = { status: "x" }; p.error = "e"; await s.from("communication_logs").update(p); }`,
    "a read": `async function f(s) { await s.from("communication_logs").select("body"); }`,
  };
  for (const [name, src] of Object.entries(accepted)) {
    assert.deepEqual(scanSource("x.ts", src).problems, [], `refused: ${name}`);
  }
});

/* ── the real tree ────────────────────────────────────────────── */

test("every write to communication_logs in src stores a redacted body, or none", () => {
  const problems = [];
  const writes = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    const r = scanSource(rel, readFileSync(file, "utf8"));
    problems.push(...r.problems);
    writes.push(...r.writes);
  }
  assert.deepEqual(problems, []);

  // Not vacuous: the scan has to have found the writes that exist today. If a
  // refactor moves them somewhere the scan cannot see, this fails rather than
  // passing over nothing.
  const bodyWrites = writes.filter((w) => w.bodies > 0).map((w) => w.where.split(":")[0]);
  assert.ok(writes.length >= 10, `only ${writes.length} writes found`);
  for (const file of [
    "lib/email/candidate/deliver.ts",
    "lib/whatsapp/dispatch.ts",
    "lib/interviews/reminder.ts",
    "lib/email/candidate/triggers.ts",
  ]) {
    assert.ok(bodyWrites.includes(file), `no body write found in ${file}`);
  }
});

/* ── the real send path ───────────────────────────────────────── */

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

/** A PostgREST builder impersonator that records inserts and answers counts. */
function fakeService({ sentToday }) {
  const inserted = [];
  return {
    inserted,
    from(table) {
      const calls = [];
      const q = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve, reject) => {
                const isInsert = calls.some((c) => c[0] === "insert");
                const out = isInsert
                  ? { data: { id: `log-${inserted.length}` }, error: null }
                  : { data: null, count: sentToday, error: null };
                return Promise.resolve(out).then(resolve, reject);
              };
            }
            return (...args) => {
              calls.push([prop, ...args]);
              if (prop === "insert") inserted.push({ table, row: args[0] });
              return q;
            };
          },
        },
      );
      return q;
    },
  };
}

async function sendInvite(sentToday) {
  const { interviewUrl, bookingUrl, REDACTED_LINK } = await import("./candidate-links.ts");
  const { deliverEmail } = await import("./email/candidate/deliver.ts");
  const interviewToken = randomBytes(32).toString("base64url");
  const bookingToken = randomBytes(32).toString("base64url");
  const html = `<p><a href="${interviewUrl(interviewToken)}">Start your interview</a></p><p><a href="${bookingUrl(bookingToken)}">Book</a></p>`;
  const service = fakeService({ sentToday });

  // No provider key, so the send stops after the log row is written; the row
  // is what is under test, and nothing leaves the machine.
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const errors = console.error;
  console.error = () => {};
  try {
    await deliverEmail(service, {
      companyId: "c",
      applicationId: "a",
      event: "interview",
      to: "candidate@example.test",
      subject: "Your interview",
      html,
      companyName: "Acme",
      replyTo: null,
    });
  } finally {
    console.error = errors;
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
  }
  return { service, html, interviewToken, bookingToken, REDACTED_LINK };
}

test("the normal send stores the invite with both tokens removed", async () => {
  const { service, interviewToken, bookingToken, REDACTED_LINK } = await sendInvite(0);
  const rows = service.inserted.filter((i) => i.table === TABLE);
  assert.equal(rows.length, 1, "exactly one log row");
  assert.equal(rows[0].row.status, "queued", "this is the normal path, not the cap");
  const body = rows[0].row.body;
  assert.ok(!body.includes(interviewToken), "interview token stored raw");
  assert.ok(!body.includes(bookingToken), "booking token stored raw");
  assert.ok(
    body.includes(`/interview/${REDACTED_LINK}`) && body.includes(`/book/${REDACTED_LINK}`),
  );
  assert.ok(body.includes("Start your interview"), "the rest of the email is kept");
});

test("the daily-cap path stores it redacted too", async () => {
  const { service, interviewToken } = await sendInvite(1_000_000);
  const rows = service.inserted.filter((i) => i.table === TABLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row.status, "skipped");
  assert.ok(!rows[0].row.body.includes(interviewToken));
});

test("the redactor passes a missing body through as null", async () => {
  const { redactCandidateLinks } = await import("./candidate-links.ts");
  assert.equal(redactCandidateLinks(null), null);
  assert.equal(redactCandidateLinks(undefined), null);
  assert.equal(redactCandidateLinks(""), "");
});
