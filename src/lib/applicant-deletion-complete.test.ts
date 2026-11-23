/**
 * #69 step 3: the company's applicant delete and "Delete anyway" run
 * completeDeletion from lib/applicant-deletion-complete.ts, the one shared
 * copy, and that module can never be called from a browser.
 *
 *   node --test src/lib/applicant-deletion-complete.test.ts
 *
 * L1 runs the shipped deleteApplication and deleteApplicationAnyway with the
 * lib module swapped for a recorder: what they return IS the lib's answer,
 * with the arguments they passed. The behaviour of completeDeletion itself is
 * pinned, unchanged, by delete-bells.test.ts (D1 to D10) and the source pins
 * that read it through test-support/company-delete-source.mjs. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/applicants-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/lib/applicant-deletion-complete": "export const ANYWAY_NEEDS_ACK = 'needs ack'; export const ANYWAY_NOT_AVAILABLE = 'not available'; export async function completeDeletion(ctx, service, input) { globalThis.__completeCalls.push({ companyId: ctx.companyId, input }); return { success: true, data: { from: 'lib' } }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const { deleteApplication, deleteApplicationAnyway } = await import(
  "../app/ai-dashboard/(gated)/applicants/actions.ts"
);

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-0000000aaaaa";
const JOB = "j0000000-0000-0000-0000-000000000001";
const SESSION = "s0000000-0000-0000-0000-0000000sssss";

function world() {
  globalThis.__completeCalls = [];
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-actor",
    memberName: "Team Member",
    role: "owner",
    company: { id: CO, name: "Acme" },
  };
  globalThis.__applicantsServiceForTests = () =>
    fakeService((table) => {
      if (table === "rpc:close_application_for_deletion") {
        return {
          data: { outcome: "closed", first: true, session_ids: [SESSION], final_booking_ids: [] },
          error: null,
        };
      }
      if (table === "job_applications") {
        return {
          data: {
            id: APP,
            company_id_snapshot: CO,
            cv_path: "cvs/a.pdf",
            job_id: JOB,
            first_name: "Candidatea",
            last_name: "Testperson",
            deletion_started_at: "2026-11-23T10:00:00.000Z",
            deletion_calendar_failed_at: "2026-11-23T10:01:00.000Z",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
}

test("L1. both delete actions return exactly what the lib's completeDeletion returns, called once with their inputs", async () => {
  world();
  assert.deepEqual(await deleteApplication(APP), { success: true, data: { from: "lib" } });
  world();
  assert.deepEqual(await deleteApplicationAnyway(APP, { acknowledgeCalendarEvent: true }), {
    success: true,
    data: { from: "lib" },
  });
  const calls = globalThis.__completeCalls;
  assert.equal(calls.length, 1, "Delete anyway: one call");
  assert.equal(calls[0].companyId, CO);
  assert.equal(calls[0].input.anyway, true);
  world();
  await deleteApplication(APP);
  assert.deepEqual(globalThis.__completeCalls, [
    {
      companyId: CO,
      input: {
        applicationId: APP,
        cvPath: "cvs/a.pdf",
        jobId: JOB,
        closed: { outcome: "closed", first: true, sessionIds: [SESSION], finalBookingIds: [] },
        anyway: false,
      },
    },
  ]);
});

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ACTIONS = read("../app/ai-dashboard/(gated)/applicants/actions.ts");
const LIB = read("./applicant-deletion-complete.ts");

test("L2. the actions keep no copy: one import, no local completeDeletion, and they never export it", () => {
  assert.match(
    ACTIONS,
    /^import \{\n {2}ANYWAY_NEEDS_ACK,\n {2}ANYWAY_NOT_AVAILABLE,\n {2}completeDeletion,\n\} from "@\/lib\/applicant-deletion-complete";$/m,
  );
  assert.doesNotMatch(ACTIONS, /function completeDeletion\(/);
  // A "use server" file turns every export into a browser-callable action:
  // completeDeletion must not be one of them, re-exported or otherwise.
  assert.doesNotMatch(ACTIONS, /export\s*\{[^}]*\bcompleteDeletion\b/);
  assert.doesNotMatch(ACTIONS, /export \* from "@\/lib\/applicant-deletion-complete"/);
  assert.equal((ACTIONS.match(/\bcompleteDeletion\(ctx, service, \{/g) ?? []).length, 2);
});

test("L3. the lib module is never a server action: no 'use server', and server-only first", () => {
  // The directive is a statement on its own line; the header may mention it.
  assert.doesNotMatch(LIB, /^\s*["']use server["'];?\s*$/m);
  assert.match(ACTIONS, /^"use server";$/m, "the same check finds the directive where it is");
  assert.ok(LIB.startsWith('import "server-only";\n'), "server-only is the first import");
  assert.match(LIB, /^export async function completeDeletion\(/m);
});
