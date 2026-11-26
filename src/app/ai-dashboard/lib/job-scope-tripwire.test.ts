/**
 * #98: a tripwire for job scope. Every company-dashboard server action and
 * company API route that reads job_applications, jobs, interview_sessions or
 * one of their child tables by an id the caller supplies must reach a job-scope
 * helper (roleAllowsJobAction, getJobScope, readJobScope, scopeJobIds,
 * scopedApplicationIds, isEmptyScope) somewhere in its call tree. A recruiter
 * or hiring manager is limited to the jobs they are on; a read by id that never
 * asks is a read of any job in the company.
 *
 *   node --test "src/app/ai-dashboard/lib/job-scope-tripwire.test.ts"
 *
 * ── How it decides ───────────────────────────────────────────
 *
 * A static sweep with the TypeScript compiler, no imports of the code under
 * test. It builds a call graph over src/ (function declarations and functions
 * assigned to a const, resolved through "@/" and relative imports, including a
 * function passed by name rather than called), then walks each entry point's
 * tree:
 *
 *   reads by id   a `.from("<table>")` chain on a target table with an
 *                 .eq / .in / .match on an id column (id, application_id,
 *                 session_id, job_id, booking_id, final_interview_id) whose
 *                 value is not a literal and does not name companyId
 *   scope         any node in the tree is a scope helper in job-scope.ts
 *   exempt        computed: the entry itself calls requireCompanyRole with
 *                 only "owner" and/or "admin" (both see every job); or listed
 *                 in EXEMPT below, each with a reason
 *
 * An entry with no parameters takes no client-supplied id and is reported as
 * not applicable. Out of scope BY CATEGORY, stated here and in OUT_OF_SCOPE:
 * admin routes and actions (src/app/admin, src/app/api/admin: Remotiv staff),
 * candidate token routes (src/app/api/interview, src/app/api/book,
 * src/app/api/claim, src/app/interview, src/app/book: the token is the key),
 * public and webhook routes (apply, jobs, chat, webhooks, track ...), the
 * other portals (client, talent, browse-talent), sign-in and invite pages,
 * and staging probes.
 *
 * ── What it cannot prove ─────────────────────────────────────
 *
 *   - That the scope check is about the SAME record that is read. A tree that
 *     checks job A and reads application B passes.
 *   - That the check runs BEFORE the read or before any side effect. Presence
 *     in the tree is all it sees; order is not modelled.
 *   - That an EMPTY scope short-circuits (a recruiter on no jobs). That is
 *     isEmptyScope's callers' job, and the scope tests'.
 *   - A query built in pieces (`let q = ...from(); q = q.eq("id", x)`) or a
 *     filter passed in a variable is not seen as a read by id. Neither is a
 *     call through an object method or a dynamic import.
 *   - Whether an id is really client-supplied. Any non-literal id filter in
 *     an entry that takes parameters counts, so this errs towards flagging.
 *
 * A flag is a real finding to look at, not a test to quieten: fix the action
 * or add an EXEMPT entry with the reason the read is safe without job scope.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = process.env.TRIPWIRE_SRC ?? fileURLToPath(new URL("../../../", import.meta.url));

/** Tables keyed by a job, an application or a session, and their children. */
export const TARGET_TABLES = new Set([
  "job_applications",
  "jobs",
  "interview_sessions",
  "interview_answers",
  "interview_turns",
  "interview_notes",
  "interview_session_scores",
  "interview_answer_scores",
  "interview_questions",
  "interview_bookings",
  "application_scores",
  "application_team_comments",
  "application_stage_history",
  "communication_logs",
  "final_interviews",
  "final_interview_bots",
  "final_interview_recordings",
  "final_interview_evaluations",
  "final_interview_interviewers",
  "live_video_pieces",
  "live_interview_actions",
  "live_interview_scores",
  "live_session_events",
  "live_restart_link_events",
  "job_hiring_team",
  "job_question_scoring_guides",
]);

const ID_COLUMNS = new Set([
  "id",
  "application_id",
  "session_id",
  "job_id",
  "booking_id",
  "final_interview_id",
]);

const SCOPE_MODULE = "app/ai-dashboard/lib/job-scope.ts";
const SCOPE_HELPERS = new Set([
  "roleAllowsJobAction",
  "getJobScope",
  "readJobScope",
  "scopeJobIds",
  "scopedApplicationIds",
  "isEmptyScope",
]);

/** Entry points: company server actions and company API routes. */
const ENTRY_FILES = (rel: string, text: string) =>
  (rel.startsWith("app/ai-dashboard/(gated)/") && /^\s*["']use server["']/.test(text)) ||
  (rel.startsWith("app/api/ai-dashboard/") && rel.endsWith("/route.ts")) ||
  (rel.startsWith("app/api/cv/company-application/") && rel.endsWith("/route.ts"));

/** Out of scope by category. Pinned so the categories cannot drift silently. */
export const OUT_OF_SCOPE = [
  "app/admin/ (Remotiv staff)",
  "app/api/admin/ (Remotiv staff)",
  "app/api/interview/, app/interview/ (candidate interview token)",
  "app/api/book/, app/book/ (candidate booking token)",
  "app/api/claim/ (talent claim token)",
  "app/api/apply, jobs, chat, ai-matching, talent, track, webhooks, health (public)",
  "app/client/, app/talent/, app/browse-talent/ (other portals)",
  "app/ai-dashboard/accept, login, change-password (no job data)",
  "app/api/staging-probe/ (staging only)",
];

/**
 * Entries that read by id without a job-scope helper. Only two kinds are
 * allowed, and each entry names its kind:
 *
 *   "owner-admin-only"   the action is open to owner and admin only by role,
 *                        and both see every job, so there is no scope to ask.
 *                        (The usual case is computed from the tree, when the
 *                        entry calls requireCompanyRole("owner", "admin"); list
 *                        one here only when the role check is written another
 *                        way.)
 *   "self-generated-id"  the id it reads by is generated by this action itself
 *                        (a row it has just inserted), never supplied by the
 *                        caller.
 *
 * A kind and a reason are required; an entry that no longer exists, or that
 * the sweep would not flag anyway, fails the test (stale).
 */
export const EXEMPT_KINDS = ["owner-admin-only", "self-generated-id"] as const;

export const EXEMPT: {
  entry: string;
  kind: (typeof EXEMPT_KINDS)[number];
  reason: string;
}[] = [
  // Empty since #58 commit 5: createCompanyJob's one read by job id (the
  // interview_questions sync, on the row it had just inserted) became a call
  // to replace_interview_questions, which locks the job by company itself.
];

/* ── the analyser ─────────────────────────────────────────── */

type Fn = { key: string; file: string; name: string; node: ts.Node; params: number };

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "node_modules" || name === "test-support") continue;
        walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** "@/x" or "./x" from `fromRel`, to a src-relative file that exists in `files`. */
function resolveModule(spec: string, fromRel: string, files: Map<string, string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(dirname(fromRel), spec).split(sep).join("/");
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(c)) return c;
  }
  return null;
}

function functionLike(n: ts.Node | undefined): ts.Node | null {
  if (!n) return null;
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return n;
  // export const x = cache(async (...) => ...)
  if (ts.isCallExpression(n)) {
    for (const a of n.arguments) {
      const f = functionLike(a);
      if (f) return f;
    }
  }
  return null;
}

/**
 * The whole analysis over a set of files (src-relative path -> text). Pure, so
 * the self-tests below can feed it fixtures.
 */
export function analyse(files: Map<string, string>, isEntryFile = ENTRY_FILES) {
  const fns = new Map<string, Fn>();
  const imports = new Map<string, Map<string, string>>(); // file -> local name -> key
  const exported = new Map<string, Set<string>>();
  const parsed = new Map<string, ts.SourceFile>();

  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(
      rel,
      text,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(rel, sf);
    const ex = new Set<string>();
    for (const st of sf.statements) {
      const isExported = (st as { modifiers?: ts.NodeArray<ts.Modifier> }).modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (ts.isFunctionDeclaration(st) && st.name) {
        fns.set(`${rel}#${st.name.text}`, {
          key: `${rel}#${st.name.text}`,
          file: rel,
          name: st.name.text,
          node: st,
          params: st.parameters.length,
        });
        if (isExported) ex.add(st.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const f = functionLike(d.initializer);
          const name = d.name.text;
          if (f) {
            fns.set(`${rel}#${name}`, {
              key: `${rel}#${name}`,
              file: rel,
              name,
              node: f,
              params: (f as ts.FunctionLikeDeclaration).parameters.length,
            });
          } else if (d.initializer && ts.isIdentifier(d.initializer)) {
            // export const alias = otherFunction;
            fns.set(`${rel}#${name}`, {
              key: `${rel}#${name}`,
              file: rel,
              name,
              node: d.initializer,
              params: 0,
            });
          }
          if (isExported) ex.add(name);
        }
      }
    }
    exported.set(rel, ex);
  }

  for (const [rel, sf] of parsed) {
    const local = new Map<string, string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
      const target = resolveModule((st.moduleSpecifier as ts.StringLiteral).text, rel, files);
      if (!target) continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          local.set(el.name.text, `${target}#${(el.propertyName ?? el.name).text}`);
        }
      }
    }
    imports.set(rel, local);
  }

  /** Each function's edges, reads by id, and whether it calls requireCompanyRole owner/admin only. */
  const facts = new Map<string, { edges: Set<string>; reads: string[]; ownerAdminOnly: boolean }>();
  for (const fn of fns.values()) {
    const sf = parsed.get(fn.file);
    const local = imports.get(fn.file);
    const edges = new Set<string>();
    const reads: string[] = [];
    let ownerAdminOnly = false;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n !== (fn.node as { name?: ts.Node }).name) {
        const viaImport = local?.get(n.text);
        if (viaImport) edges.add(viaImport);
        else if (fns.has(`${fn.file}#${n.text}`) && `${fn.file}#${n.text}` !== fn.key) {
          edges.add(`${fn.file}#${n.text}`);
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "from" &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0]) &&
        TARGET_TABLES.has(n.arguments[0].text)
      ) {
        // Walk up the chain: .from(t).select(...).eq(col, value) ...
        let cur: ts.Node = n;
        while (
          ts.isPropertyAccessExpression(cur.parent) &&
          ts.isCallExpression(cur.parent.parent)
        ) {
          const call = cur.parent.parent;
          const method = cur.parent.name.text;
          const [col, value] = call.arguments;
          if (
            (method === "eq" || method === "in" || method === "match") &&
            col &&
            ts.isStringLiteral(col) &&
            ID_COLUMNS.has(col.text) &&
            value &&
            !ts.isStringLiteralLike(value) &&
            !/companyId/.test(value.getText(sf))
          ) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            reads.push(`${fn.file}:${line} ${n.arguments[0].text}.${col.text}`);
            break;
          }
          cur = call;
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "requireCompanyRole" &&
        n.arguments.length > 0 &&
        n.arguments.every(
          (a) => ts.isStringLiteral(a) && (a.text === "owner" || a.text === "admin"),
        )
      ) {
        ownerAdminOnly = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.node);
    facts.set(fn.key, { edges, reads, ownerAdminOnly });
  }

  const entries = [];
  for (const [rel, text] of files) {
    if (!isEntryFile(rel, text)) continue;
    for (const name of exported.get(rel) ?? []) {
      const key = `${rel}#${name}`;
      const fn = fns.get(key);
      if (!fn) continue;
      const seen = new Set<string>();
      const stack = [key];
      const reads: string[] = [];
      let scoped = false;
      while (stack.length > 0) {
        const k = stack.pop() as string;
        if (seen.has(k)) continue;
        seen.add(k);
        const [file, fname] = k.split("#");
        if (file === SCOPE_MODULE && SCOPE_HELPERS.has(fname)) scoped = true;
        const f = facts.get(k);
        if (!f) continue;
        reads.push(...f.reads);
        for (const e of f.edges) stack.push(e);
      }
      const ownerAdminOnly = facts.get(key)?.ownerAdminOnly ?? false;
      const takesInput = fn.params > 0;
      entries.push({
        entry: key,
        takesInput,
        reads: [...new Set(reads)].sort(),
        scoped,
        ownerAdminOnly,
      });
    }
  }
  entries.sort((a, b) => a.entry.localeCompare(b.entry));
  return entries;
}

/** The flagged entries: client input, a read by id, no scope, not exempt. */
export function flagged(entries: ReturnType<typeof analyse>, exempt = EXEMPT) {
  const listed = new Set(exempt.map((e) => e.entry));
  return entries
    .filter((e) => e.takesInput && e.reads.length > 0 && !e.scoped && !e.ownerAdminOnly)
    .filter((e) => !listed.has(e.entry));
}

/** Problems with the exempt list itself: a missing reason, or an entry that is stale. */
export function exemptProblems(entries: ReturnType<typeof analyse>, exempt = EXEMPT) {
  const byKey = new Map(entries.map((e) => [e.entry, e]));
  const out: string[] = [];
  for (const x of exempt) {
    if (!EXEMPT_KINDS.includes(x.kind)) out.push(`no kind: ${x.entry}`);
    if (!x.reason || x.reason.trim().length < 10) out.push(`no reason: ${x.entry}`);
    const e = byKey.get(x.entry);
    if (!e) out.push(`stale, no such entry: ${x.entry}`);
    else if (!(e.takesInput && e.reads.length > 0 && !e.scoped && !e.ownerAdminOnly)) {
      out.push(`stale, not flagged without the exemption: ${x.entry}`);
    }
  }
  return out;
}

function realFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const p of sourceFiles(SRC)) {
    files.set(relative(SRC, p).split(sep).join("/"), readFileSync(p, "utf8"));
  }
  return files;
}

/* ── the real tree ────────────────────────────────────────── */

const real = analyse(realFiles());

test("the sweep reaches the company dashboard: entries found, the scope module read", () => {
  assert.ok(existsSync(join(SRC, SCOPE_MODULE)), "job-scope.ts is where the helpers live");
  assert.ok(real.length >= 50, `only ${real.length} entries: the walk is rooted wrong`);
  assert.ok(
    real.some((e) => e.entry.endsWith("applicants/actions.ts#deleteApplication") && e.scoped),
    "a known scoped action is seen as scoped",
  );
  const withReads = real.filter((e) => e.takesInput && e.reads.length > 0);
  assert.ok(withReads.length >= 20, `only ${withReads.length} entries read by id`);
});

test("every company action or route that reads by a client-supplied id reaches a job-scope helper", (t) => {
  const covered = real.filter((e) => e.takesInput && e.reads.length > 0);
  t.diagnostic(
    `covered ${covered.length}: ${covered.filter((e) => e.scoped).length} scoped, ` +
      `${covered.filter((e) => !e.scoped && e.ownerAdminOnly).length} owner/admin only, ` +
      `${EXEMPT.length} exempt by list`,
  );
  const flags = flagged(real);
  assert.deepEqual(
    flags.map((e) => `${e.entry} reads ${e.reads.slice(0, 3).join(", ")}`),
    [],
    "an entry reads by id with no job-scope helper in its tree: scope it, or exempt it with a reason",
  );
});

test("the exempt list: every entry has an allowed kind and a reason, still exists, and would be flagged without it", () => {
  assert.deepEqual(exemptProblems(real), []);
});

test("the out-of-scope categories are the stated ones", () => {
  assert.equal(OUT_OF_SCOPE.length, 9);
  const entryFiles = new Set(real.map((e) => e.entry.split("#")[0]));
  for (const f of entryFiles) {
    assert.ok(
      f.startsWith("app/ai-dashboard/(gated)/") ||
        f.startsWith("app/api/ai-dashboard/") ||
        f.startsWith("app/api/cv/company-application/"),
      `an entry outside the company dashboard: ${f}`,
    );
  }
});

/* ── self-tests: the sweep catches what it says it catches ── */

const fixture = (files: Record<string, string>) => new Map(Object.entries(files));
const JOB_SCOPE = [
  "export async function roleAllowsJobAction(ctx, jobId) { return true; }",
  "export async function getJobScope(ctx) { return { scoped: false }; }",
].join("\n");

test("self-test: a new action reading job_applications by id with no scope helper is flagged", () => {
  const entries = analyse(
    fixture({
      "app/ai-dashboard/lib/job-scope.ts": JOB_SCOPE,
      "app/ai-dashboard/(gated)/fake/actions.ts": [
        '"use server";',
        "export async function peek(applicationId: string) {",
        '  return service.from("job_applications").select("*").eq("id", applicationId).maybeSingle();',
        "}",
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    flagged(entries, []).map((e) => e.entry),
    ["app/ai-dashboard/(gated)/fake/actions.ts#peek"],
  );
});

test("self-test: the same action through a helper that asks roleAllowsJobAction is not flagged", () => {
  const entries = analyse(
    fixture({
      "app/ai-dashboard/lib/job-scope.ts": JOB_SCOPE,
      "app/ai-dashboard/lib/gate.ts": [
        'import { roleAllowsJobAction } from "@/app/ai-dashboard/lib/job-scope";',
        "export async function gate(ctx, jobId) { return roleAllowsJobAction(ctx, jobId); }",
      ].join("\n"),
      "app/ai-dashboard/(gated)/fake/actions.ts": [
        '"use server";',
        'import { gate } from "@/app/ai-dashboard/lib/gate";',
        "export async function peek(applicationId: string) {",
        '  const row = await service.from("job_applications").select("*").eq("id", applicationId).maybeSingle();',
        "  await gate(ctx, row.job_id);",
        "}",
      ].join("\n"),
    }),
  );
  assert.deepEqual(flagged(entries, []), []);
});

test("self-test: owner/admin-only is computed from the tree; a companyId filter is not a read by id", () => {
  const entries = analyse(
    fixture({
      "app/ai-dashboard/lib/job-scope.ts": JOB_SCOPE,
      "app/ai-dashboard/(gated)/fake/actions.ts": [
        '"use server";',
        "export async function wipe(jobId: string) {",
        '  const ctx = await requireCompanyRole("owner", "admin");',
        '  await service.from("jobs").delete().eq("id", jobId);',
        "}",
        "export async function count(x: string) {",
        '  return service.from("jobs").select("id").eq("company_id", ctx.companyId);',
        "}",
        "export async function list() {",
        '  return service.from("jobs").select("*").eq("id", someId);',
        "}",
      ].join("\n"),
    }),
  );
  const byName = Object.fromEntries(entries.map((e) => [e.entry.split("#")[1], e]));
  assert.equal(byName.wipe.ownerAdminOnly, true);
  assert.deepEqual(byName.count.reads, [], "a company filter is not a read by id");
  assert.equal(byName.list.takesInput, false, "no parameter, no client-supplied id");
  assert.deepEqual(flagged(entries, []), []);
});

test("self-test: an exempt entry with no kind, an unknown kind, no reason, or a stale one, is a problem", () => {
  const entries = analyse(
    fixture({
      "app/ai-dashboard/lib/job-scope.ts": JOB_SCOPE,
      "app/ai-dashboard/(gated)/fake/actions.ts": [
        '"use server";',
        "export async function peek(id: string) {",
        '  return service.from("interview_sessions").select("*").eq("id", id);',
        "}",
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    exemptProblems(entries, [
      {
        entry: "app/ai-dashboard/(gated)/fake/actions.ts#peek",
        kind: "self-generated-id",
        reason: "",
      },
    ]),
    ["no reason: app/ai-dashboard/(gated)/fake/actions.ts#peek"],
  );
  assert.deepEqual(
    exemptProblems(entries, [
      { entry: "app/ai-dashboard/(gated)/fake/actions.ts#peek", reason: "a reason long enough" },
    ]),
    ["no kind: app/ai-dashboard/(gated)/fake/actions.ts#peek"],
  );
  assert.deepEqual(
    exemptProblems(entries, [
      {
        entry: "app/ai-dashboard/(gated)/fake/actions.ts#peek",
        kind: "trusted",
        reason: "a reason long enough",
      },
    ]),
    ["no kind: app/ai-dashboard/(gated)/fake/actions.ts#peek"],
  );
  assert.deepEqual(
    exemptProblems(entries, [
      {
        entry: "app/ai-dashboard/(gated)/fake/actions.ts#gone",
        kind: "self-generated-id",
        reason: "an old reason here",
      },
    ]),
    ["stale, no such entry: app/ai-dashboard/(gated)/fake/actions.ts#gone"],
  );
});
