/**
 * The cross-table duplicate check behind the admin bulk CV upload: quoting,
 * priority, and a failed read that is never "no duplicate".
 *
 *   node --test src/lib/contact-duplicates.test.ts
 *
 * findContactDuplicate runs as shipped against fake-postgrest.mjs, whose
 * `.or()` is answered by fake-or-filter.mjs: PostgREST's own grammar, so an
 * unquoted comma really becomes a second term and an unquoted parenthesis
 * really fails to parse. Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOrFilters } from "../test-support/fake-or-filter.mjs";
import { fakeService } from "../test-support/fake-postgrest.mjs";

const { contactOrFilter, findContactDuplicate, postgrestOrValue } = await import(
  "./contact-duplicates.ts"
);

const REMOTIV_ONLY = "company_id_snapshot.is.null";
const ADVERSARIAL = [",", "(", ")", "*", "%", '"', "\\"];

const person = (id, email, phone, extra = {}) => ({
  id,
  first_name: "Synthetic",
  last_name: id,
  email,
  phone,
  ...extra,
});

/** A database of the three tables; `fail` names tables whose read errors. */
function world(tables, { fail = [] } = {}) {
  return fakeService((table, calls) => {
    if (fail.includes(table)) return { data: null, error: { code: "57014", message: "timeout" } };
    const answer = applyOrFilters(tables[table] ?? [], calls);
    if (answer.error) return { data: null, error: answer.error };
    return { data: answer.rows[0] ?? null, error: null };
  });
}

const empty = { client_batch_candidates: [], job_applications: [], talent_profiles: [] };

/* ── the quoting ──────────────────────────────────────────────── */

test('a value is double-quoted, with \\ and " escaped inside the quotes', () => {
  assert.equal(postgrestOrValue("a@x.com"), '"a@x.com"');
  assert.equal(postgrestOrValue('a"b'), '"a\\"b"');
  assert.equal(postgrestOrValue("a\\b"), '"a\\\\b"');
  assert.equal(
    postgrestOrValue("a,b(c)*%"),
    '"a,b(c)*%"',
    "commas, parentheses, * and % stay data",
  );
  assert.equal(
    contactOrFilter({ email: "a@x.com", phone: "+92 300 1234567" }),
    'email.eq."a@x.com",phone.eq."+92 300 1234567"',
  );
  assert.equal(contactOrFilter({ email: "", phone: "" }), null);
});

/* ── positive cases ───────────────────────────────────────────── */

for (const [label, email, phone, row] of [
  ["a normal email", "ada@example.test", "", person("t1", "ada@example.test", null)],
  [
    "a plus-addressed email",
    "ada+jobs@example.test",
    "",
    person("t1", "ada+jobs@example.test", null),
  ],
  ["a phone with spaces and +", "", "+92 300 1234567", person("t1", null, "+92 300 1234567")],
]) {
  test(`${label} is found exactly`, async () => {
    const svc = world({ ...empty, talent_profiles: [row] });
    const r = await findContactDuplicate(svc, { email, phone });
    assert.deepEqual(r, {
      ok: true,
      match: { source: "talent", id: "t1", first_name: "Synthetic", last_name: "t1" },
    });
  });
}

test("a near match is not a match", async () => {
  const svc = world({
    ...empty,
    talent_profiles: [person("t1", "ada@example.test", "+923001234567")],
  });
  for (const contact of [
    { email: "ada@example.tes", phone: "" },
    { email: "ada@example.test.pk", phone: "" },
    { email: "", phone: "+92300123456" },
  ]) {
    assert.deepEqual(await findContactDuplicate(svc, contact), { ok: true, match: null });
  }
});

test("no email and no phone asks nothing and finds nothing", async () => {
  const svc = world(empty);
  assert.deepEqual(await findContactDuplicate(svc, { email: "", phone: "" }), {
    ok: true,
    match: null,
  });
  assert.equal(svc.queries.length, 0);
});

/* ── adversarial values ───────────────────────────────────────── */

// Negative control: unquote the value in contactOrFilter and the injection matches every row.
test("a value smuggling a second term matches nothing, not every row", async () => {
  const svc = world({
    ...empty,
    talent_profiles: [
      person("t1", "someone@else.test", "+1"),
      person("t2", "other@else.test", "+2"),
    ],
  });
  for (const email of ["a@x.com,id.not.is.null", "a@x.com),or(id.not.is.null"]) {
    assert.deepEqual(await findContactDuplicate(svc, { email, phone: "" }), {
      ok: true,
      match: null,
    });
  }
});

// Negative control: unquote the value and each of these either fails to parse (ok: false) or over-matches.
for (const ch of ADVERSARIAL) {
  test(`a value containing ${JSON.stringify(ch)} is data: it finds its own row and no other`, async () => {
    const email = `a${ch}b@example.test`;
    const svc = world({
      ...empty,
      talent_profiles: [person("other", "ab@example.test", null), person("own", email, null)],
    });
    const r = await findContactDuplicate(svc, { email, phone: "" });
    assert.equal(r.ok, true, "the filter parsed");
    assert.equal(r.match?.id, "own");
    const sent = svc.queries
      .find((q) => q.table === "talent_profiles")
      .calls.find((c) => c[0] === "or")[1];
    assert.equal(sent, `email.eq.${postgrestOrValue(email)}`);
  });
}

/* ── priority ─────────────────────────────────────────────────── */

test("a batch candidate outranks an application, which outranks a talent profile", async () => {
  const c = { email: "dup@example.test", phone: "" };
  const all = {
    client_batch_candidates: [person("b1", c.email, null)],
    job_applications: [person("a1", c.email, null, { company_id_snapshot: null })],
    talent_profiles: [person("t1", c.email, null)],
  };
  assert.equal((await findContactDuplicate(world(all), c)).match.source, "batch");
  assert.equal(
    (await findContactDuplicate(world({ ...all, client_batch_candidates: [] }), c)).match.source,
    "application",
  );
  assert.equal(
    (await findContactDuplicate(world({ ...empty, talent_profiles: all.talent_profiles }), c)).match
      .source,
    "talent",
  );
});

/* ── a failed read is never "no duplicate" ────────────────────── */

// Negative control: skip the `if (error)` in findContactDuplicate and these read as no match.
test("a failed read on a table that could hold the winning match makes the answer unknown", async () => {
  const c = { email: "dup@example.test", phone: "" };
  const talentOnly = { ...empty, talent_profiles: [person("t1", c.email, null)] };
  for (const fail of ["client_batch_candidates", "job_applications", "talent_profiles"]) {
    assert.deepEqual(
      await findContactDuplicate(world(empty, { fail: [fail] }), c),
      { ok: false },
      fail,
    );
  }
  assert.deepEqual(
    await findContactDuplicate(world(talentOnly, { fail: ["job_applications"] }), c),
    { ok: false },
    "a talent match cannot be trusted while the applications read failed",
  );
});

test("a batch match still stands when a later table's read fails", async () => {
  const c = { email: "dup@example.test", phone: "" };
  const svc = world(
    { ...empty, client_batch_candidates: [person("b1", c.email, null)] },
    { fail: ["job_applications", "talent_profiles"] },
  );
  assert.equal((await findContactDuplicate(svc, c)).match.source, "batch");
});

/* ── the application scope ────────────────────────────────────── */

// Negative control: drop `applications.or(options.applicationScope)` and the customer's applicant is found.
test("an application scope is ANDed onto the applications read only", async () => {
  const c = { email: "dup@example.test", phone: "" };
  const svc = world({
    ...empty,
    job_applications: [person("cust", c.email, null, { company_id_snapshot: "c-customer" })],
  });
  assert.deepEqual(await findContactDuplicate(svc, c, { applicationScope: REMOTIV_ONLY }), {
    ok: true,
    match: null,
  });
  const appRead = svc.queries.find((q) => q.table === "job_applications");
  assert.deepEqual(
    appRead.calls.filter((x) => x[0] === "or").map((x) => x[1]),
    ['email.eq."dup@example.test"', REMOTIV_ONLY],
  );
  for (const t of ["client_batch_candidates", "talent_profiles"]) {
    const read = svc.queries.find((q) => q.table === t);
    assert.equal(read.calls.filter((x) => x[0] === "or").length, 1, `${t} carries no scope`);
  }
  // Without a scope the same row IS found: the per-row submit's behaviour, unchanged.
  assert.equal((await findContactDuplicate(svc, c)).match.id, "cust");
});
