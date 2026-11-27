/**
 * #20: the edit page's one read of who already holds each interview, run on
 * the shipped page (jobs/[id]/edit/page.tsx) against a filtering fake.
 *
 *   - one interview_sessions read, scoped by job AND company, both kinds, the
 *     three statuses that count, limit 2000; its counts reach the wizard;
 *   - another company's sessions on the same job id are never counted;
 *   - a failed read gives no counts (no line) and the page still renders;
 *   - the save path (actions.ts) never reads sessions: the counts are a page
 *     load fact, never a save-time check.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/edit-invite-counts.test.ts"
 *
 * Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "export {};",
  "next/navigation": "export function redirect(to) { throw new Error('redirect ' + to); }",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__editDb; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__editCtx; }",
  "@/app/ai-dashboard/lib/company-roles": "export function canCreateJobs() { return true; }",
  "@/app/ai-dashboard/lib/job-scope": "export async function roleAllowsJobAction() { return true; }",
  "../../actions": "export async function fetchInterviewQuestions() { return []; }",
  "../../new/_wizard-client": "export function WizardClient(props) { return props; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { default: EditJobPage } = await import("./[id]/edit/page.tsx");

const CO = "c0000000-0000-4000-8000-0000000000f1";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000f2";
const JOB = "j0000000-0000-4000-8000-0000000000f1";
const FUTURE = new Date(Date.now() + 3 * 86400000).toISOString();
const PAST = new Date(Date.now() - 3 * 86400000).toISOString();

/** Applies eq / in / is / limit to the table's rows; records every read. */
function fakeDb(tables, { failSessions = false } = {}) {
  const reads = [];
  const matches = (r, [op, c, v]) => {
    if (op === "eq") return r[c] === v;
    if (op === "in") return v.includes(r[c]);
    return (r[c] ?? null) === v;
  };
  return {
    reads,
    from(table) {
      const read = { table, select: null, filters: [], limit: null, single: false };
      reads.push(read);
      const run = () => {
        if (table === "interview_sessions" && failSessions) {
          return { data: null, error: { code: "57014" } };
        }
        let rows = (tables[table] ?? []).filter((r) => read.filters.every((f) => matches(r, f)));
        if (read.limit !== null) rows = rows.slice(0, read.limit);
        return { data: read.single ? (rows[0] ?? null) : rows, error: null };
      };
      // Awaited like a PostgREST builder: the read runs a microtask later, once
      // every filter call on the chain has been recorded.
      const chain = Object.assign(
        Promise.resolve().then(() => run()),
        {
          select(cols) {
            read.select = cols;
            return chain;
          },
          eq(c, v) {
            read.filters.push(["eq", c, v]);
            return chain;
          },
          in(c, v) {
            read.filters.push(["in", c, v]);
            return chain;
          },
          is(c, v) {
            read.filters.push(["is", c, v]);
            return chain;
          },
          limit(n) {
            read.limit = n;
            return chain;
          },
          maybeSingle() {
            read.single = true;
            return chain;
          },
        },
      );
      return chain;
    },
  };
}

const session = (application_id, status, kind = "async", company_id = CO, expires_at = FUTURE) => ({
  job_id: JOB,
  company_id,
  application_id,
  kind,
  status,
  expires_at,
});

function world(sessions, opts) {
  const db = fakeDb(
    {
      jobs: [{ id: JOB, company_id: CO, title: "Role", screening_questions: [], deleted_at: null }],
      job_applications: [],
      interview_sessions: sessions,
    },
    opts,
  );
  globalThis.__editDb = db;
  globalThis.__editCtx = { companyId: CO, company: { id: CO, name: "Co" }, role: "recruiter" };
  return db;
}

/** The props the page hands the wizard (the page returns <WizardClient ... />). */
async function render() {
  const element = await EditJobPage({ params: Promise.resolve({ id: JOB }) });
  return element.props;
}

test("one sessions read, scoped by job and company, both kinds, counts reach the wizard", async () => {
  const db = world([
    session("app-a", "cancelled"),
    session("app-a", "invited"),
    session("app-b", "started", "async", CO, PAST),
    session("app-c", "invited", "async", CO, PAST),
    session("app-d", "submitted"),
    session("app-e", "abandoned", "live"),
    session("app-e", "started", "live"),
    session("app-f", "submitted", "live"),
    // Another company's rows on the same job id: never counted.
    session("app-x", "invited", "async", OTHER_CO),
    session("app-y", "submitted", "live", OTHER_CO),
  ]);
  const props = await render();
  assert.deepEqual(props.inviteCounts, {
    async: { open: 2, completed: 1 },
    live: { open: 1, completed: 1 },
    atLeast: false,
  });
  const reads = db.reads.filter((r) => r.table === "interview_sessions");
  assert.equal(reads.length, 1, "one read");
  const [r] = reads;
  assert.equal(r.select, "application_id, kind, status, expires_at");
  assert.deepEqual(r.filters, [
    ["eq", "job_id", JOB],
    ["eq", "company_id", CO],
    ["in", "kind", ["async", "live"]],
    ["in", "status", ["invited", "started", "submitted"]],
  ]);
  assert.equal(r.limit, 2000);
});

test("a read that reaches 2000 rows says 'at least'", async () => {
  const many = Array.from({ length: 2001 }, (_, i) => session(`app-${i}`, "invited"));
  world(many);
  const props = await render();
  assert.equal(props.inviteCounts.atLeast, true);
  assert.equal(props.inviteCounts.async.open, 2000);
});

test("a failed read gives no counts and the page still renders", async () => {
  world([session("app-a", "invited")], { failSessions: true });
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const props = await render();
    assert.deepEqual(props.inviteCounts, {
      async: { open: 0, completed: 0 },
      live: { open: 0, completed: 0 },
      atLeast: false,
    });
    assert.equal(props.mode, "edit");
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, ["[jobs] edit: invite counts read failed (57014)"]);
});

test("the counts are a page load fact: no save-time read, no dialog", () => {
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(actions, /inviteCounts|job-invite-counts|inviteCountsOf/);
  const wizard = readFileSync(new URL("./new/_wizard-client.tsx", import.meta.url), "utf8");
  // The wizard only reads the prop; it never fetches sessions itself.
  assert.doesNotMatch(wizard, /interview_sessions|inviteCountsOf/);
});
