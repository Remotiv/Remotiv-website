/**
 * Who may host or sit on a final interview, against a team that has one of
 * everything: an owner off the team, an admin without a calendar, a recruiter
 * on the team with a calendar, one without, a hiring manager, a recruiter off
 * the team, a removed member, and another company's member.
 *
 *   node --test src/lib/final-interviews/eligibility.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { CO, JOB, finalInterviewWorld, makeDb } = await import(
  "../../test-support/final-interview-world.mjs"
);
const {
  isEligibleHost,
  listEligibleHosts,
  listEligibleInterviewers,
  loadEligibleMembers,
  pickInterviewers,
} = await import("./eligibility.ts");

function world(db = makeDb()) {
  const service = finalInterviewWorld(db);
  // resolveHostEmail builds its own client; it must see the same fake.
  globalThis.__fakeServiceClientForTests = () => service;
  return service;
}

const ids = (members) => members.map((m) => m.memberId).sort();

test("eligible members: on the team or owner/admin, active, this company only", async () => {
  const members = await loadEligibleMembers(world(), CO, JOB);
  assert.deepEqual(ids(members), ["m-admin", "m-hm", "m-host", "m-owner", "m-team"]);
  // Off the team and not owner/admin: out. Removed: out. Another company: out.
  for (const gone of ["m-off", "m-gone", "o-1"]) {
    assert.ok(!members.some((m) => m.memberId === gone), gone);
  }
  const by = Object.fromEntries(members.map((m) => [m.memberId, m]));
  assert.equal(by["m-owner"].onHiringTeam, false);
  assert.equal(by["m-owner"].calendarConnected, true);
  assert.equal(by["m-admin"].calendarConnected, false);
  assert.equal(by["m-host"].calendarConnected, true);
  assert.equal(by["m-team"].calendarConnected, false, "a revoked connection is not connected");
  // The owner's row has no name; it is resolved rather than shown blank.
  assert.equal(by["m-owner"].name, "owner@acme.test");
  assert.equal(by["m-host"].name, "Hana Host");
});

test("hosts need a calendar; interviewers do not", async () => {
  const hosts = await listEligibleHosts(world(), CO, JOB);
  assert.deepEqual(ids(hosts), ["m-host", "m-owner"]);
  const interviewers = await listEligibleInterviewers(world(), CO, JOB);
  assert.deepEqual(ids(interviewers), ["m-admin", "m-hm", "m-host", "m-owner", "m-team"]);
  const members = await loadEligibleMembers(world(), CO, JOB);
  assert.equal(isEligibleHost(members, "m-host"), true);
  assert.equal(isEligibleHost(members, "m-owner"), true, "owner: no team needed, calendar present");
  assert.equal(isEligibleHost(members, "m-team"), false, "on the team, no calendar");
  assert.equal(isEligibleHost(members, "m-admin"), false, "admin without a calendar");
  assert.equal(isEligibleHost(members, "m-off"), false, "calendar, but off the team");
  assert.equal(isEligibleHost(members, "m-gone"), false, "removed");
  assert.equal(isEligibleHost(members, "o-1"), false, "another company");
});

test("every read is scoped to the company and the job", async () => {
  const service = world();
  await loadEligibleMembers(service, CO, JOB);
  const q = (table) =>
    service.queries.find((x) => x.table === table).calls.filter((c) => c[0] === "eq");
  assert.deepEqual(q("company_members"), [
    ["eq", "company_id", CO],
    ["eq", "status", "active"],
  ]);
  assert.deepEqual(q("job_hiring_team"), [
    ["eq", "company_id", CO],
    ["eq", "job_id", JOB],
  ]);
  assert.deepEqual(q("calendar_connections"), [
    ["eq", "company_id", CO],
    ["eq", "status", "active"],
  ]);
});

test("interviewers: the host is dropped, duplicates collapse, six is too many, strangers refused", async () => {
  const members = await loadEligibleMembers(world(), CO, JOB);
  assert.deepEqual(pickInterviewers(members, ["m-team", "m-host", "m-team", "m-admin"], "m-host"), {
    ok: true,
    memberIds: ["m-team", "m-admin"],
  });
  assert.deepEqual(pickInterviewers(members, undefined, "m-host"), { ok: true, memberIds: [] });
  // No calendar needed to sit in.
  assert.equal(pickInterviewers(members, ["m-team", "m-hm"], "m-host").ok, true);
  for (const stranger of ["m-off", "m-gone", "o-1", "nobody"]) {
    const r = pickInterviewers(members, [stranger], "m-host");
    assert.equal(r.ok, false, stranger);
    assert.match(r.error, /active member of this job's hiring team, or an owner or admin/);
  }
  // Five distinct besides the host is the ceiling. Four eligible exist here, so
  // the ceiling is proven with a padded eligible list.
  const many = [...members, ...[1, 2, 3].map((i) => ({ ...members[0], memberId: `x-${i}` }))];
  const six = ["m-team", "m-admin", "m-hm", "m-owner", "x-1", "x-2"];
  const r = pickInterviewers(many, six, "m-host");
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 5 interviewers/);
  assert.equal(pickInterviewers(many, six.slice(0, 5), "m-host").ok, true);
});
