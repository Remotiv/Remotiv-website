/**
 * Rendered em dashes: a ratchet (#49).
 *
 *   node --test src/lib/rendered-em-dashes.test.ts
 *
 * Remotiv copy uses hyphens, never em dashes (#48). This file pins, per source
 * file, how many em dashes sit in user-visible copy today, and fails the moment
 * that number moves in either direction.
 *
 * ── What the number is ───────────────────────────────────────
 *
 * This counts em dashes in AST-classified user-visible copy: string literals,
 * template text, JSX text and JSX attribute strings, after removing console
 * arguments, thrown errors, and the named declarations listed in
 * EXCLUDED_DECLARATIONS (model prompts, an operator CLI, log-only strings).
 * HTML entities count where the literal is user-visible. It is a syntactic
 * classification, not proof that a string is rendered. It cannot see text
 * assembled at runtime, such as String.fromCharCode or strings joined from
 * parts. It cannot see text that comes from the database, such as message
 * templates or job titles.
 *
 * Comments are not AST nodes, so they are excluded by construction. Em dashes
 * in comments are #50, and nothing here counts them.
 *
 * ── The three verdicts, and what a pin means ─────────────────
 *
 *   over       a listed file has more than its pin: a new em dash was added.
 *   unlisted   a file not in RENDERED_EM_DASHES has one or more.
 *   stale      a listed file has fewer than its pin, or is gone: lower the pin
 *              in the same commit, so the number only ever ratchets down.
 *
 * Raising a pin is allowed, but it is a visible decision, not a silent one.
 * The guard converts invisible drift into a reviewable diff line in this file.
 * It does not prevent an accepted increase.
 *
 * ── Exclusions are named, never by path ──────────────────────
 *
 * A literal is excluded only when it sits inside a declaration listed in
 * EXCLUDED_DECLARATIONS, by file AND symbol path, or under one of the three
 * syntactic rules in SYNTACTIC_EXCLUSIONS. No directory is excluded: a
 * user-visible string added to lib/ai/** outside a listed declaration is
 * counted like any other (see the safeguard self-test). Every listed
 * declaration must still exist and must still cover at least one em dash, or
 * the test fails, so the list cannot rot into a silent blanket.
 *
 * ── Out of reach ─────────────────────────────────────────────
 *
 * src/lib/interviews/ and src/app/interview/ are owned by another session and
 * are not read at all. Test files and test-support/ are not read either.
 *
 * ── Vacuity floor ────────────────────────────────────────────
 *
 * The walk must read at least one file AND must reach ANCHOR, the root layout.
 * filesRead > 0 alone would pass a walk rooted at the wrong directory, such as
 * test-support/ or an empty build output, because that directory still has
 * files. The root layout cannot move without breaking the app, so reaching it
 * proves the walk covered the product tree.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** The file the walk must reach. See the vacuity floor in the header. */
export const ANCHOR = "app/layout.tsx";

/** Parse a file only if it could hold an em dash in any spelling, not just the character. */
export const PREFILTER = /\u2014|\\u2014|\\u\{2014\}|&mdash;|&#8212;|&#x2014;/i;
const EM = /\u2014/g;
const ENTITY = /&mdash;|&#8212;|&#x2014;/gi;

/**
 * Declarations whose literals never reach a user. Each is matched by file and
 * symbol path ("outer/inner" for a declaration nested in a function), and
 * optionally by the callee whose argument the literal is. Every entry was
 * traced to its consumer before it was listed; the note says where it goes.
 */
export const EXCLUDED_DECLARATIONS = [
  {
    file: "app/api/chat/route.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the site chat model call (route.ts:108)",
  },
  {
    file: "lib/ai-matching.ts",
    symbol: "candidateSummaryForPrompt",
    reason: "model-prompt",
    note: "candidate blocks joined into the rankWithClaude prompt (ai-matching.ts:313)",
  },
  {
    file: "lib/ai-matching.ts",
    symbol: "rankWithClaude/systemPrompt",
    reason: "model-prompt",
    note: "system argument of the matching model call (ai-matching.ts:332)",
  },
  {
    file: "lib/ai/cv-recompute.ts",
    symbol: "handleCvRecompute",
    callee: "skipJob",
    reason: "log-only",
    note: "skipJob reason, which lib/job-skip.ts only console.logs",
  },
  {
    file: "lib/ai/cv-scoring.ts",
    symbol: "BAND_DEFINITIONS",
    reason: "model-prompt",
    note: "score bands interpolated into SYSTEM_PROMPT",
  },
  {
    file: "lib/ai/cv-scoring.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the CV scoring model call (cv-scoring.ts:1104)",
  },
  {
    file: "lib/ai/cv-scoring.ts",
    symbol: "buildUserMessage",
    reason: "model-prompt",
    note: "user message of the CV scoring call; score-consistency only measures its length",
  },
  {
    file: "lib/ai/cv-scoring.ts",
    symbol: "handleAiCvScore",
    callee: "skip",
    reason: "log-only",
    note: "the local skip() console.warns its reason and nothing else",
  },
  {
    file: "lib/ai/interview-questions.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the interview question model call",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    symbol: "SCORE_BANDS",
    reason: "model-prompt",
    note: "bands interpolated into SYSTEM_PROMPT here and in live-interview-scoring.ts",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    symbol: "SESSION_SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the session rollup model call",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the answer scoring model call",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    symbol: "buildUserMessage",
    reason: "model-prompt",
    note: "user message of the answer scoring model call",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    symbol: "summariseSession/body",
    reason: "model-prompt",
    note: "answer blocks in the user message of the session rollup call",
  },
  {
    file: "lib/ai/jd-generate.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the job description draft model call",
  },
  {
    file: "lib/ai/jd-split.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the job description split model call",
  },
  {
    file: "lib/ai/score-consistency.ts",
    symbol: "USAGE",
    reason: "operator-terminal",
    note: "--help text of a CLI run by an operator; no route, action or page imports it",
  },
  {
    file: "lib/ai/score-consistency.ts",
    symbol: "formatReport",
    reason: "operator-terminal",
    note: "report the same CLI prints to the operator's terminal",
  },
  {
    file: "lib/ai/scoring-criteria.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the scoring criteria model call",
  },
  {
    file: "lib/ai/screening-questions.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the screening question model call",
  },
  {
    file: "lib/calendar/notify.ts",
    symbol: "deliverBooking/problem",
    reason: "log-only",
    note: "NoticeOutcome.problems; every consumer only console.errors them",
  },
  {
    file: "lib/calendar/notify.ts",
    symbol: "sendHostEmail/problem",
    reason: "log-only",
    note: "NoticeOutcome.problems; every consumer only console.errors them",
  },
  {
    file: "lib/cv-extract.ts",
    symbol: "BASIC_SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the basic CV parse model call",
  },
  {
    file: "lib/cv-extract.ts",
    symbol: "SYSTEM_PROMPT",
    reason: "model-prompt",
    note: "system argument of the full CV parse model call",
  },
];

/** Positions excluded by syntax alone, wherever they appear. */
export const SYNTACTIC_EXCLUSIONS = [
  { rule: "console", note: "an argument to console.*: a log line, never rendered" },
  { rule: "thrown", note: "inside throw, or new X where X ends in Error: an exception message" },
  {
    rule: "model-call",
    note: "under the system or messages argument of a .messages.create or .messages.stream call",
  },
];

/** Outermost-first names of the declarations enclosing a node. */
function declarationPath(node, sf) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    if (
      (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) &&
      p.name
    ) {
      names.unshift(p.name.getText(sf));
    } else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      names.unshift(p.name.text);
    }
  }
  return names;
}

/** The callee text of the call this node is an argument of, if any, inside its declaration. */
function argumentOf(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && p.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) {
      return p.expression.getText(sf);
    }
    if (ts.isFunctionLike(p)) return null;
  }
  return null;
}

function syntacticRule(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText(sf);
      if (/^console\./.test(callee)) return "console";
      if (/\.messages\.(create|stream)$/.test(callee)) {
        // Only the system and messages arguments are model input.
        for (let q = node.parent; q && q !== p; q = q.parent) {
          if (ts.isPropertyAssignment(q) && /^(system|messages)$/.test(q.name.getText(sf))) {
            return "model-call";
          }
        }
      }
    }
    if (ts.isThrowStatement(p)) return "thrown";
    if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText(sf))) return "thrown";
  }
  return null;
}

function matchingExclusion(rel, node, sf, exclusions) {
  const path = declarationPath(node, sf);
  for (const e of exclusions) {
    if (e.file !== rel) continue;
    const want = e.symbol.split("/");
    if (want.some((name, i) => path[i] !== name)) continue;
    if (e.callee && argumentOf(node, sf) !== e.callee) continue;
    return e;
  }
  return null;
}

/** Does `symbol` (outer/inner) name a real declaration in this file, with `callee` called inside it? */
function declarationExists(sf, e) {
  const want = e.symbol.split("/");
  let found = false;
  const visit = (n) => {
    const name =
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.name
        ? n.name.getText(sf)
        : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
          ? n.name.text
          : null;
    if (name === want[want.length - 1]) {
      const path = [...declarationPath(n, sf), name];
      if (path.length === want.length && path.every((p, i) => p === want[i])) {
        if (!e.callee) found = true;
        else {
          const call = (m) => {
            if (ts.isCallExpression(m) && m.expression.getText(sf) === e.callee) found = true;
            ts.forEachChild(m, call);
          };
          call(n);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Scan one source text. Pure, so the self-tests below can feed it fixtures.
 * Returns every em dash in a literal position with its class: "user", a
 * syntactic rule, or "excluded" with the matching declaration.
 */
export function scanSource(rel, text, exclusions = EXCLUDED_DECLARATIONS) {
  const own = exclusions.filter((e) => e.file === rel);
  if (!PREFILTER.test(text) && own.length === 0) return { parsed: false, hits: [], missing: [] };
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const visit = (n) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      const chars = (n.text.match(EM) ?? []).length;
      const entities = (n.text.match(ENTITY) ?? []).length;
      if (chars + entities > 0) {
        const rule = syntacticRule(n, sf);
        const exclusion = rule ? null : matchingExclusion(rel, n, sf, own);
        const cls = rule ?? (exclusion ? "excluded" : "user");
        // Entities are decoded only where the literal is user-visible.
        const count = cls === "user" ? chars + entities : chars;
        if (count > 0) {
          hits.push({
            rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            cls,
            count,
            exclusion,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const missing = own.filter((e) => !declarationExists(sf, e));
  return { parsed: true, hits, missing };
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test-support") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx|mjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Owned by another session; never read. */
const OUT_OF_REACH = /^(lib\/interviews|app\/interview)\//;

/** Scan a list of {rel, text}. filesRead and the anchor prove the scan saw the tree. */
export function scanFiles(files, exclusions = EXCLUDED_DECLARATIONS) {
  let filesRead = 0;
  const seen = new Set();
  const hits = [];
  const missing = [];
  for (const { rel, text } of files) {
    if (OUT_OF_REACH.test(rel)) continue;
    filesRead += 1;
    seen.add(rel);
    const r = scanSource(rel, text, exclusions);
    hits.push(...r.hits);
    missing.push(...r.missing);
  }
  // A listed declaration in a file the walk never read cannot be located either.
  for (const e of exclusions) if (!seen.has(e.file)) missing.push(e);
  return { filesRead, seen, hits, missing };
}

export function scanTree(root = SRC, exclusions = EXCLUDED_DECLARATIONS) {
  const files = sourceFiles(root).map((path) => ({
    rel: relative(root, path).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));
  return scanFiles(files, exclusions);
}

/** User-visible count per file. */
export function userCounts(result) {
  const per = new Map();
  for (const h of result.hits) {
    if (h.cls === "user") per.set(h.rel, (per.get(h.rel) ?? 0) + h.count);
  }
  return per;
}

/** The ratchet's verdict over a scan and an inventory. Empty is a pass. */
export function ratchetFailures(result, inventory, { anchor = ANCHOR } = {}) {
  const failures = [];
  if (result.filesRead === 0) failures.push("vacuous: the scan read no source files");
  if (!result.seen.has(anchor)) {
    failures.push(
      `vacuous: the walk never reached ${anchor}, so it did not cover the product tree`,
    );
  }
  const per = userCounts(result);
  const linesOf = (rel) =>
    result.hits
      .filter((h) => h.rel === rel && h.cls === "user")
      .map((h) => h.line)
      .join(",");
  for (const [rel, found] of per) {
    const pin = inventory[rel];
    if (pin === undefined) {
      failures.push(`unlisted: ${rel} has ${found} rendered em dash(es) at lines ${linesOf(rel)}`);
    } else if (found > pin.count) {
      failures.push(
        `over: ${rel} pinned ${pin.count}, found ${found} (+${found - pin.count}) at lines ${linesOf(rel)}`,
      );
    }
  }
  for (const [rel, pin] of Object.entries(inventory)) {
    const found = per.get(rel) ?? 0;
    if (found < pin.count) {
      failures.push(
        `stale: ${rel} pinned ${pin.count}, found ${found}; lower the pin to ${found} in the same commit`,
      );
    }
  }
  return failures;
}

/** Every way the exclusion list disagrees with the tree. Empty is a pass. */
export function exclusionFailures(result, exclusions = EXCLUDED_DECLARATIONS) {
  const failures = result.missing.map(
    (e) => `exclusion not found: ${e.file} ${e.symbol}${e.callee ? ` -> ${e.callee}()` : ""}`,
  );
  for (const e of exclusions) {
    if (result.missing.includes(e)) continue;
    if (!result.hits.some((h) => h.exclusion === e)) {
      failures.push(`exclusion covers no em dash any more, remove it: ${e.file} ${e.symbol}`);
    }
  }
  return failures;
}

/**
 * Today's user-visible em dashes, per file. Every count may only go down; see the
 * header for what over, unlisted and stale mean. Generated from the scan on
 * 2026-11-12: 700 em dashes in 159 files.
 */
export const RENDERED_EM_DASHES = {
  "app/talent/(authed)/dashboard/edit/actions.ts": { count: 39, note: "talent dashboard" },
  "app/ai-dashboard/(gated)/jobs/new/_wizard-client.tsx": { count: 37, note: "AI dashboard copy" },
  "app/privacy/page.tsx": { count: 30, note: "marketing or public page" },
  "app/services/payroll/page.tsx": { count: 28, note: "marketing or public page" },
  "app/talent/(authed)/dashboard/edit/_edit-client.tsx": { count: 28, note: "talent dashboard" },
  "app/admin/analytics/_analytics-client.tsx": { count: 22, note: "admin UI" },
  "app/admin/_components/batch-detail-dashboard.tsx": { count: 21, note: "admin UI" },
  "app/ai-video-interviews/page.tsx": { count: 21, note: "marketing or public page" },
  "app/services/recruitment/page.tsx": { count: 20, note: "marketing or public page" },
  "app/services/staff-augmentation/page.tsx": { count: 17, note: "marketing or public page" },
  "lib/email/candidate/templates.ts": { count: 17, note: "candidate or client email" },
  "app/ai-dashboard/(gated)/analytics/_analytics-client.tsx": {
    count: 16,
    note: "AI dashboard copy",
  },
  "app/admin/_components/applications-dashboard.tsx": { count: 14, note: "admin UI" },
  "app/services/dedicated-team/page.tsx": { count: 14, note: "marketing or public page" },
  "app/admin/_components/contacts-dashboard.tsx": { count: 13, note: "admin UI" },
  "app/ai-dashboard/(gated)/messages/_messages-client.tsx": {
    count: 9,
    note: "AI dashboard copy",
  },
  "app/ai-dashboard/(gated)/settings/_settings-client.tsx": {
    count: 10,
    note: "AI dashboard copy",
  },
  "app/join-as-talent/page.tsx": { count: 10, note: "marketing or public page" },
  "app/ai-dashboard/(gated)/team/_team-client.tsx": { count: 9, note: "AI dashboard copy" },
  "app/client/_components/client-batch-view.tsx": { count: 9, note: "client portal" },
  "app/admin/lib/format.ts": { count: 8, note: "admin UI" },
  "app/ai-dashboard/(gated)/applicants/_interview-panel.tsx": {
    count: 8,
    note: "AI dashboard copy",
  },
  "app/join-as-freelancer/page.tsx": { count: 8, note: "marketing or public page" },
  "lib/calendar/notify.ts": { count: 8, note: "candidate and host email: calendar notices" },
  "app/about/page.tsx": { count: 7, note: "marketing or public page" },
  "app/ai-dashboard/(gated)/_overview-client.tsx": { count: 7, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/settings/_templates-card.tsx": { count: 7, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/weekly-report/_weekly-client.tsx": {
    count: 7,
    note: "AI dashboard copy",
  },
  "app/pricing/page.tsx": { count: 7, note: "marketing or public page" },
  "app/about/layout.tsx": { count: 6, note: "marketing or public page" },
  "app/admin/_components/hire-requests-dashboard.tsx": { count: 6, note: "admin UI" },
  "app/browse-talent/_browse-client.tsx": { count: 6, note: "marketing or public page" },
  "app/careers/[slug]/page.tsx": { count: 6, note: "marketing or public page" },
  "app/admin/_components/add-to-batch-modal.tsx": { count: 5, note: "admin UI" },
  "app/admin/_components/bulk-batch-upload-modal.tsx": { count: 5, note: "admin UI" },
  "app/admin/_components/companies-dashboard.tsx": { count: 5, note: "admin UI" },
  "app/admin/_components/talent-dashboard.tsx": { count: 5, note: "admin UI" },
  "app/ai-dashboard/(gated)/jobs/_jobs-client.tsx": { count: 5, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/messages/_composer.tsx": { count: 5, note: "AI dashboard copy" },
  "app/book/[token]/_booking-client.tsx": { count: 5, note: "candidate booking page" },
  "app/layout.tsx": { count: 5, note: "marketing or public page" },
  "app/admin/_components/screening-question-builder.tsx": { count: 4, note: "admin UI" },
  "app/admin/companies/_queue-panel.tsx": { count: 4, note: "admin UI" },
  "app/ai-dashboard/(gated)/jobs/_deleted-jobs.tsx": { count: 4, note: "AI dashboard copy" },
  "app/account/account-client.tsx": { count: 3, note: "marketing or public page" },
  "app/admin/_components/jobs-dashboard.tsx": { count: 3, note: "admin UI" },
  "app/admin/_components/move-to-talent-modal.tsx": { count: 3, note: "admin UI" },
  "app/admin/_components/overview-dashboard.tsx": { count: 3, note: "admin UI" },
  "app/admin/client-batches/actions.ts": { count: 3, note: "admin UI" },
  "app/admin/search/_search-client.tsx": { count: 3, note: "admin UI" },
  "app/ai-dashboard/(gated)/messages/actions.ts": { count: 2, note: "AI dashboard copy" },
  "app/browse-talent/page.tsx": { count: 3, note: "marketing or public page" },
  "app/client/actions.ts": { count: 3, note: "client portal" },
  "app/contact/page.tsx": { count: 3, note: "marketing or public page" },
  "app/jobs/[slug]/_company-detail.tsx": { count: 3, note: "marketing or public page" },
  "app/jobs/[slug]/page.tsx": { count: 3, note: "marketing or public page" },
  "app/jobs/layout.tsx": { count: 3, note: "marketing or public page" },
  "app/pricing/layout.tsx": { count: 3, note: "marketing or public page" },
  "app/talent/[id]/page.tsx": { count: 3, note: "talent dashboard" },
  "components/home/cta-inquiry.tsx": { count: 3, note: "marketing or public page" },
  "components/home/stats-circles.tsx": { count: 3, note: "marketing or public page" },
  "lib/email/templates/company-invite.ts": { count: 3, note: "candidate or client email" },
  "app/admin/_components/clients-dashboard.tsx": { count: 2, note: "admin UI" },
  "app/admin/analytics/rollup.ts": { count: 2, note: "admin UI" },
  "app/ai-dashboard/(gated)/analytics/actions.ts": { count: 2, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/jobs/_hiring-team.tsx": { count: 2, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/jobs/actions.ts": { count: 2, note: "AI dashboard copy" },
  "app/ai-dashboard/login/login-client.tsx": { count: 2, note: "AI dashboard copy" },
  "app/ai-matching/page.tsx": { count: 2, note: "marketing or public page" },
  "app/book-a-meeting/_booking-form.tsx": { count: 2, note: "marketing or public page" },
  "app/book-a-meeting/page.tsx": { count: 2, note: "marketing or public page" },
  "app/browse-talent/_profile-modal.tsx": { count: 2, note: "marketing or public page" },
  "app/contact/layout.tsx": { count: 2, note: "marketing or public page" },
  "app/find-freelancers/_hire-request-wizard.tsx": { count: 2, note: "marketing or public page" },
  "app/find-freelancers/_marketplace.tsx": { count: 2, note: "marketing or public page" },
  "app/find-freelancers/hire-request-action.ts": { count: 2, note: "marketing or public page" },
  "app/find-freelancers/page.tsx": { count: 2, note: "marketing or public page" },
  "app/jobs/_jobs-client.tsx": { count: 2, note: "marketing or public page" },
  "app/jobs/[slug]/_remotiv-detail.tsx": { count: 2, note: "marketing or public page" },
  "app/services/dedicated-team/layout.tsx": { count: 2, note: "marketing or public page" },
  "components/home/why-remotiv.tsx": { count: 2, note: "marketing or public page" },
  "lib/email/templates/claim-success.ts": { count: 2, note: "candidate or client email" },
  "app/admin/_components/bulk-upload-shared.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/client-batches-dashboard.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/job-order-cell.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/load-failed.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/remote-talent-dashboard.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/screening-answers-view.tsx": { count: 1, note: "admin UI" },
  "app/admin/_components/team-dashboard.tsx": { count: 1, note: "admin UI" },
  "app/admin/analytics/page.tsx": { count: 1, note: "admin UI" },
  "app/admin/companies/actions.ts": { count: 1, note: "admin UI" },
  "app/admin/layout.tsx": { count: 1, note: "admin UI" },
  "app/admin/lib/status-labels.ts": { count: 1, note: "admin UI" },
  "app/admin/talent/actions.ts": { count: 1, note: "admin UI" },
  "app/ai-dashboard/(gated)/applicants/actions.ts": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/applicants/booking-actions.ts": {
    count: 1,
    note: "candidate email: interview booking link",
  },
  "app/ai-dashboard/(gated)/applicants/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/jobs/[id]/edit/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/jobs/new/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/jobs/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/messages/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/overview-actions.ts": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/settings/_calendar-card.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/settings/_hours-card.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/settings/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/settings/template-actions.ts": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/team/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/weekly-report/actions.ts": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/(gated)/weekly-report/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/accept/[token]/accept-client.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/accept/[token]/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/forgot-password/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/login/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-dashboard/reset-password/page.tsx": { count: 1, note: "AI dashboard copy" },
  "app/ai-matching/layout.tsx": { count: 1, note: "marketing or public page" },
  "app/ai-results/layout.tsx": { count: 1, note: "marketing or public page" },
  "app/ai-results/page.tsx": { count: 1, note: "marketing or public page" },
  "app/ai-video-interviews/opengraph-image.tsx": { count: 1, note: "marketing or public page" },
  "app/ai-video-interviews/twitter-image.tsx": { count: 1, note: "marketing or public page" },
  "app/api/apply/route.ts": { count: 1, note: "API response text" },
  "app/api/book/[token]/route.ts": { count: 1, note: "API response text" },
  "app/api/unsubscribe/route.ts": { count: 1, note: "API response text" },
  "app/auth/reset/page.tsx": { count: 1, note: "marketing or public page" },
  "app/book-a-meeting/layout.tsx": { count: 1, note: "marketing or public page" },
  "app/book/[token]/page.tsx": { count: 1, note: "candidate booking page" },
  "app/client/(gated)/dashboard/page.tsx": { count: 1, note: "client portal" },
  "app/client/login/login-client.tsx": { count: 1, note: "client portal" },
  "app/client/login/page.tsx": { count: 1, note: "client portal" },
  "app/contact/actions.ts": { count: 1, note: "marketing or public page" },
  "app/jobs/(list)/page.tsx": { count: 1, note: "marketing or public page" },
  "app/jobs/[slug]/_unavailable.tsx": { count: 1, note: "marketing or public page" },
  "app/jobs/[slug]/layout.tsx": { count: 1, note: "marketing or public page" },
  "app/jobs/not-found.tsx": { count: 1, note: "marketing or public page" },
  "app/join-as-talent/layout.tsx": { count: 1, note: "marketing or public page" },
  "app/login/page.tsx": { count: 1, note: "marketing or public page" },
  "app/not-found.tsx": { count: 1, note: "marketing or public page" },
  "app/opengraph-image.tsx": { count: 1, note: "marketing or public page" },
  "app/talent/(authed)/dashboard/_dashboard-client.tsx": { count: 1, note: "talent dashboard" },
  "app/talent/[id]/not-found.tsx": { count: 1, note: "talent dashboard" },
  "app/talent/login/login-client.tsx": { count: 1, note: "talent dashboard" },
  "app/talent/login/page.tsx": { count: 1, note: "talent dashboard" },
  "app/twitter-image.tsx": { count: 1, note: "marketing or public page" },
  "components/home/ai-recruiter.tsx": { count: 1, note: "marketing or public page" },
  "components/home/hero.tsx": { count: 1, note: "marketing or public page" },
  "components/home/how-it-works/index.tsx": { count: 1, note: "marketing or public page" },
  "components/home/testimonials.tsx": { count: 1, note: "marketing or public page" },
  "components/home/vetting-process.tsx": { count: 1, note: "marketing or public page" },
  "components/home/who-we-help.tsx": { count: 1, note: "marketing or public page" },
  "components/white-label/share.tsx": { count: 1, note: "shared copy" },
  "lib/ai/cv-scoring.ts": { count: 1, note: "recruiter scorecard: unmatched essentials" },
  "lib/calendar/connections.ts": { count: 1, note: "shared copy" },
  "lib/email/candidate/deliver.ts": { count: 1, note: "candidate or client email" },
  "lib/email/templates/claim-verification.ts": { count: 1, note: "candidate or client email" },
  "lib/email/templates/hire-request-client.ts": { count: 1, note: "candidate or client email" },
  "lib/plans.ts": { count: 1, note: "shared copy" },
  "lib/whatsapp/dispatch.ts": { count: 1, note: "WhatsApp copy" },
  "lib/whatsapp/inbound-display.ts": { count: 1, note: "WhatsApp copy" },
  "lib/whatsapp/send.ts": { count: 1, note: "WhatsApp copy" },
};

/* ── self-tests: the scanner ─────────────────────────────────── */

const D = String.fromCharCode(0x2014);
const users = (rel, text, exclusions = []) =>
  scanSource(rel, text, exclusions)
    .hits.filter((h) => h.cls === "user")
    .reduce((s, h) => s + h.count, 0);

test("scanner: a string literal with an em dash counts 1", () => {
  assert.equal(users("app/x.ts", `export const a = "one ${D} two";\n`), 1);
});

test("scanner: the same text in a line, a block and a doc comment counts 0", () => {
  const src = [
    `// one ${D} two`,
    `/* one ${D} two */`,
    `/** one ${D} two */`,
    `export const a = 1;`,
  ].join("\n");
  assert.equal(users("app/x.ts", src), 0);
});

test("scanner: a console.error argument counts 0", () => {
  assert.equal(users("app/x.ts", `console.error("log ${D} line");\n`), 0);
});

test("scanner: a throw counts 0", () => {
  const src = `export function f() { throw new Error("thrown ${D} message"); }\n`;
  assert.equal(users("app/x.ts", src), 0);
});

test("scanner: JSX text counts 1", () => {
  assert.equal(users("app/x.tsx", `export const A = () => <p>one ${D} two</p>;\n`), 1);
});

test("scanner: a \\u2014 escape counts 1, with no em dash character in the source", () => {
  const src = 'export const a = "one \\u2014 two";\n';
  assert.ok(!src.includes(D));
  assert.equal(users("app/x.ts", src), 1);
});

test("scanner: a \\u{2014} escape counts 1, with no em dash character in the source", () => {
  const src = 'export const a = "one \\u{2014} two";\n';
  assert.ok(!src.includes(D));
  assert.equal(users("app/x.ts", src), 1);
});

test("scanner: &mdash; &#8212; &#x2014; and &MDASH; in JSX text each count 1", () => {
  for (const entity of ["&mdash;", "&#8212;", "&#x2014;", "&MDASH;"]) {
    const src = `export const A = () => <p>one ${entity} two</p>;\n`;
    assert.ok(!src.includes(D));
    assert.equal(users("app/x.tsx", src), 1, entity);
  }
});

test("scanner: an entity inside a console argument counts 0", () => {
  assert.equal(users("app/x.ts", `console.warn("log &mdash; line");\n`), 0);
});

test("scanner: a literal under the system argument of a model call counts 0", () => {
  const src = `await client.messages.create({ system: "prompt ${D} text", messages: [] });\n`;
  assert.equal(users("app/x.ts", src), 0);
});

test("SAFEGUARD: a prompt-only module that gains user-visible copy outside the named prompt is counted", () => {
  const rel = "lib/ai/fixture-prompt.ts";
  const exclusions = [
    { file: rel, symbol: "SYSTEM_PROMPT", reason: "model-prompt", note: "fixture" },
  ];
  const before = `export const SYSTEM_PROMPT = \`You score ${D} carefully.\`;\n`;
  assert.equal(users(rel, before, exclusions), 0, "the named prompt is excluded");
  const after = `${before}export const SAVED_TOAST = "Saved ${D} your changes are live";\n`;
  assert.equal(
    users(rel, after, exclusions),
    1,
    "copy beside it in the same lib/ai file is counted",
  );
});

test("exclusions: a listed declaration that is renamed or gone fails, never passes silently", () => {
  const rel = "lib/ai/fixture-prompt.ts";
  const exclusions = [
    { file: rel, symbol: "SYSTEM_PROMPT", reason: "model-prompt", note: "fixture" },
  ];
  const renamed = `export const PROMPT_V2 = \`You score ${D} carefully.\`;\n`;
  const result = scanFiles(
    [
      { rel, text: renamed },
      { rel: ANCHOR, text: "export const ok = 1;\n" },
    ],
    exclusions,
  );
  assert.deepEqual(exclusionFailures(result, exclusions), [
    `exclusion not found: ${rel} SYSTEM_PROMPT`,
  ]);
  assert.equal(userCounts(result).get(rel), 1, "and the renamed prompt is counted as copy");
});

/* ── self-tests: the comparator ──────────────────────────────── */

const anchorFile = { rel: ANCHOR, text: "export const ok = 1;\n" };
const pinned = { "app/pinned.tsx": { count: 1, note: "fixture" } };
const onePinned = `export const A = () => <p>one ${D} two</p>;\n`;

test("comparator: a pinned file over its pin fails, naming pin, found, delta and lines", () => {
  const files = [
    anchorFile,
    { rel: "app/pinned.tsx", text: `${onePinned}export const B = "three ${D} four";\n` },
  ];
  assert.deepEqual(ratchetFailures(scanFiles(files, []), pinned), [
    "over: app/pinned.tsx pinned 1, found 2 (+1) at lines 1,2",
  ]);
});

test("comparator: a file not in the inventory fails as unlisted", () => {
  const files = [
    anchorFile,
    { rel: "app/pinned.tsx", text: onePinned },
    { rel: "app/new.tsx", text: `export const C = "new ${D} copy";\n` },
  ];
  assert.deepEqual(ratchetFailures(scanFiles(files, []), pinned), [
    "unlisted: app/new.tsx has 1 rendered em dash(es) at lines 1",
  ]);
});

test("comparator: a pinned file under its pin, or gone, fails as stale", () => {
  const dropped = [anchorFile, { rel: "app/pinned.tsx", text: onePinned.replace(D, "-") }];
  assert.deepEqual(ratchetFailures(scanFiles(dropped, []), pinned), [
    "stale: app/pinned.tsx pinned 1, found 0; lower the pin to 0 in the same commit",
  ]);
  assert.deepEqual(ratchetFailures(scanFiles([anchorFile], []), pinned), [
    "stale: app/pinned.tsx pinned 1, found 0; lower the pin to 0 in the same commit",
  ]);
});

test("comparator: a scan that read no files fails, and so does one that missed the anchor", () => {
  assert.deepEqual(ratchetFailures(scanFiles([], []), {}), [
    "vacuous: the scan read no source files",
    `vacuous: the walk never reached ${ANCHOR}, so it did not cover the product tree`,
  ]);
  const elsewhere = [{ rel: "test-support/x.ts", text: "export const ok = 1;\n" }];
  assert.deepEqual(ratchetFailures(scanFiles(elsewhere, []), {}), [
    `vacuous: the walk never reached ${ANCHOR}, so it did not cover the product tree`,
  ]);
});

test("comparator: a genuinely clean tree with an empty inventory passes", () => {
  const clean = [anchorFile, { rel: "app/other.ts", text: `// a comment ${D} only\n` }];
  assert.deepEqual(ratchetFailures(scanFiles(clean, []), {}), []);
});

test("comparator: files under the other session's directories are never read", () => {
  const files = [
    anchorFile,
    { rel: "lib/interviews/x.ts", text: `export const a = "one ${D} two";\n` },
    { rel: "app/interview/x.tsx", text: `export const b = "one ${D} two";\n` },
  ];
  const result = scanFiles(files, []);
  assert.equal(result.filesRead, 1);
  assert.deepEqual(ratchetFailures(result, {}), []);
});

/* ── the live tree ───────────────────────────────────────────── */

const live = scanTree();

test("the live scan read the product tree", () => {
  assert.ok(live.filesRead > 100, `only ${live.filesRead} files read`);
  assert.ok(live.seen.has(ANCHOR), `the walk never reached ${ANCHOR}`);
});

test("every excluded declaration still exists and still covers an em dash", () => {
  const failures = exclusionFailures(live);
  assert.deepEqual(failures, [], `\n    ${failures.join("\n    ")}`);
});

test("no file has gained or lost a rendered em dash against its pin", () => {
  const failures = ratchetFailures(live, RENDERED_EM_DASHES);
  assert.deepEqual(failures, [], `\n    ${failures.join("\n    ")}`);
});
