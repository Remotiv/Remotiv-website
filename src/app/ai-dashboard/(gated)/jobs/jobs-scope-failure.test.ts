/**
 * #24, the Jobs page: a FAILED job-scope read is reported as a failed read,
 * where a genuinely empty scope is an empty list. Both the live list and the
 * Deleted view.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/jobs-scope-failure.test.ts"
 *
 * fetchCompanyJobs used getJobScope, which turns a failed hiring-team read
 * into "assigned to no jobs". It then returned a successful empty list, so the
 * page's loadFailed stayed false and a hiring manager was told "You haven't
 * been assigned to any roles yet. Ask an owner or admin..." about roles they
 * were already on.
 *
 * fetchCompanyJobs is the shipped code. The company context and the job-scope
 * module are stubbed: readJobScope answers whatever the test sets, and
 * getJobScope is stubbed exactly as shipped (the read, or the empty scope on
 * failure), so reverting fetchCompanyJobs to getJobScope fails the first test.
 * The service client throws if touched: neither path may query jobs.
 *
 * fetchDeletedCompanyJobs had the same collapse, and the page then hid even a
 * reported failure: it passed `deletedJobs.ok ? deletedJobs.value : []`, so
 * the Deleted view said "Nothing deleted" either way. The panel is rendered
 * for real below through react-dom/server, failed against genuinely empty.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return new Proxy({}, { get() { throw new Error('no query expected'); } }); } export async function createClient() { throw new Error('no auth expected'); }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__jobsCtx; } export async function requireCompanyRole() { return globalThis.__jobsCtx; }",
  "@/app/ai-dashboard/lib/job-scope": "export async function readJobScope() { return globalThis.__scopeRead; } export async function getJobScope() { const r = globalThis.__scopeRead; return r.ok ? r.value : { scoped: true, jobIds: [] }; } export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; } export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; } export async function roleAllowsJobAction() { return false; } export const canAccessJob = roleAllowsJobAction; export async function scopedApplicationIds() { return { ok: true, value: [] }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fetchCompanyJobs, fetchDeletedCompanyJobs } = await import("./actions.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DeletedJobsPanel } = await import("./_deleted-jobs.tsx");

globalThis.__jobsCtx = {
  companyId: "c0000000-0000-4000-8000-000000000024",
  role: "hiring_manager",
  memberId: "e0000000-0000-4000-8000-000000000024",
};

test("#24 FAILED scope read is a failed read; a genuinely empty scope is an empty list", async () => {
  globalThis.__scopeRead = { ok: false };
  const failed = await fetchCompanyJobs();

  globalThis.__scopeRead = { ok: true, value: { scoped: true, jobIds: [] } };
  const empty = await fetchCompanyJobs();

  assert.deepEqual(failed, { ok: false }, "a failed scope read is reported as one");
  assert.deepEqual(empty, { ok: true, value: [] }, "assigned to no roles is still an answer");
});

test("#24 the page turns a failed read into its load-failed state, ahead of the scoped copy", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./_jobs-client.tsx", import.meta.url), "utf8");
  assert.ok(/loadFailed=\{!jobs\.ok\}/.test(page), "the page derives loadFailed from the read");
  const failedAt = client.indexOf("We couldn't load your roles");
  const unassignedAt = client.indexOf("You haven't been assigned to any roles yet");
  assert.ok(failedAt !== -1 && unassignedAt !== -1, "both states still exist");
  assert.ok(failedAt < unassignedAt, "the load-failed state is chosen before the unassigned copy");
});

test("#24 Deleted view: FAILED scope read is a failed read; a genuinely empty scope is an empty list", async () => {
  globalThis.__scopeRead = { ok: false };
  const failed = await fetchDeletedCompanyJobs();

  globalThis.__scopeRead = { ok: true, value: { scoped: true, jobIds: [] } };
  const empty = await fetchDeletedCompanyJobs();

  assert.deepEqual(failed, { ok: false }, "a failed scope read is reported as one");
  assert.deepEqual(empty, { ok: true, value: [] }, "assigned to no roles is still an answer");
});

test("#24 Deleted view renders a failed read as unavailable, never as Nothing deleted", async () => {
  // The page's own wiring, as source: the failure reaches the panel as a flag
  // rather than being flattened into an empty list.
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./_jobs-client.tsx", import.meta.url), "utf8");
  assert.ok(/deletedLoadFailed=\{!deletedJobs\.ok\}/.test(page), "the page reports the failure");
  assert.ok(/loadFailed=\{deletedLoadFailed\}/.test(client), "the client hands it to the panel");

  // Exactly what the page passes for each read, rendered for real.
  const render = async (read) => {
    globalThis.__scopeRead = read;
    const deletedJobs = await fetchDeletedCompanyJobs();
    return renderToStaticMarkup(
      createElement(DeletedJobsPanel, {
        jobs: deletedJobs.ok ? deletedJobs.value : [],
        loadFailed: !deletedJobs.ok,
        canRestore: true,
        busyId: null,
        onRestore() {},
        onBack() {},
      }),
    );
  };
  const failed = await render({ ok: false });
  const empty = await render({ ok: true, value: { scoped: true, jobIds: [] } });

  assert.ok(
    failed.includes("We couldn&#x27;t load your deleted jobs"),
    "failed: unavailable state",
  );
  assert.ok(!failed.includes("Nothing deleted"), "failed: never the empty state");
  assert.ok(empty.includes("Nothing deleted"), "empty: the empty state, unchanged");
  assert.ok(!empty.includes("couldn&#x27;t load"), "empty: no failure claimed");
  assert.notEqual(failed, empty);
});
