/**
 * The company-side CV open, run as shipped against a fake database (#97, #99).
 *
 *   node --test "src/app/api/cv/company-application/????/route.test.ts"
 *
 * (The directory is [id]; written literally it reads as a glob class and
 * matches no file, which is a run of 0 tests that exits 0. Four ?s match the
 * four characters of [id], and a star here would close this comment.)
 *
 * ── What is tested ───────────────────────────────────────────
 *
 * Two checks, in order, before anything is logged or served: the application
 * belongs to the viewer's company, and the viewer may see its job (#97). Then
 * the document is served through this origin (#99): the access log is awaited
 * and fails closed, the bytes are streamed with the headers a PDF viewer needs,
 * and no signed storage URL is ever minted, on any path.
 *
 * The context and the database are fakes (applicants-test-hook.mjs); job-scope
 * is NOT faked, so roleAllowsJobAction resolves the hiring team against the fake rows
 * for real, and what is tested is the actual role -> team -> refusal chain. The
 * storage client is a fake that records every call in order, which is how the
 * "log before bytes" and "never signed" assertions are made.
 *
 * ── Fixtures ─────────────────────────────────────────────────
 *
 *   A1  on Job A, company CO     the recruiter's own job
 *   B1  on Job B, company CO     a colleague's job in the same company
 *   C1  on Job C, company CO2    another company
 *   N1  no job, company CO       job deleted (job_id is ON DELETE SET NULL on
 *                                production) or added by hand
 *
 * The recruiter and the hiring manager are on Job A's team only. Synthetic
 * data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../../test-support/applicants-test-hook.mjs", import.meta.url));
// The route builds NextResponse objects for its error pages; the real module
// needs a Next runtime. This stand-in keeps status, body and headers, which is
// all the assertions read. The 200 is a plain Response and needs no stub.
// rate-limit is stubbed as chat/route.test.ts does: its cleanup setInterval
// would keep a bare Node process alive after the last test, and the limit is
// not what this file tests.
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "next/server": [
    "export class NextResponse {",
    "  constructor(body, init) {",
    "    this.status = init?.status ?? 200;",
    "    this.body = body ?? '';",
    "    this.headers = new Map(Object.entries(init?.headers ?? {}));",
    "  }",
    "  static redirect(url, status) {",
    "    const r = new NextResponse('', { status: status ?? 307 });",
    "    r.headers.set('location', String(url));",
    "    return r;",
    "  }",
    "  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }",
    "}",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../../test-support/fake-postgrest.mjs");
const { GET } = await import("./route.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_C = "c0000000-0000-0000-0000-00000000000c";
const MEMBER = "m-1";

const APPS = {
  A1: {
    id: "app-a1",
    company_id_snapshot: CO,
    job_id: JOB_A,
    cv_path: "x/a1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  B1: {
    id: "app-b1",
    company_id_snapshot: CO,
    job_id: JOB_B,
    cv_path: "x/b1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  C1: {
    id: "app-c1",
    company_id_snapshot: CO2,
    job_id: JOB_C,
    cv_path: "x/c1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  N1: {
    id: "app-n1",
    company_id_snapshot: CO,
    job_id: null,
    cv_path: "x/n1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
};

/** The bytes the fake bucket serves: a PDF header, then filler, as two chunks. */
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake cv for the route test\n%%EOF\n");

/** Strings that must never appear in an error body, a header or a log line. */
const SECRET_URL = "https://storage.example.test/object/sign/cvs/x/a1.pdf?token=SECRET-TOKEN";

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: MEMBER,
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
  mustChangePassword: false,
});

const eqMap = (calls) =>
  Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));

/**
 * One request as `role`, whose hiring team is `teamJobs`. The responder applies
 * the filters the route and roleAllowsJobAction actually send, so dropping either check
 * from the route changes an answer here. `events` records, in order, every
 * storage call and the moment the access-log insert resolved: that order is the
 * proof that the log is awaited before a byte is asked for.
 */
async function open(
  role,
  who,
  {
    teamJobs = [JOB_A],
    query = "",
    logFails = false,
    storageFails = false,
    infoFails = false,
    infoThrows = false,
    streamThrows = false,
    size = PDF_BYTES.length,
  } = {},
) {
  const events = [];
  const signed = [];
  const service = fakeService((table, calls) => {
    const eqs = eqMap(calls);
    if (table === "job_applications") {
      const row = Object.values(APPS).find((a) => a.id === eqs.id) ?? null;
      return { data: row, error: null };
    }
    if (table === "job_hiring_team") {
      const onTeam =
        eqs.company_id === CO && eqs.member_id === MEMBER && teamJobs.includes(eqs.job_id);
      return { data: onTeam ? { id: "team-row" } : null, error: null };
    }
    if (table === "signed_url_logs") {
      events.push("log");
      return logFails
        ? { data: null, error: { message: "boom", code: "57014" } }
        : { data: null, error: null };
    }
    throw new Error(`unexpected table ${table}`);
  });
  service.storage = {
    from(bucket) {
      return {
        async info(path) {
          events.push("info");
          // A network failure THROWS rather than resolving; the message carries
          // the secret so a leak would be caught.
          if (infoThrows) throw new Error(`info failed ${SECRET_URL}`);
          if (infoFails) {
            return { data: null, error: { message: `info failed ${SECRET_URL}`, status: 500 } };
          }
          // "absent" models storage answering with no size field at all.
          const data = { name: path.split("/").pop() };
          if (size !== "absent") data.size = size;
          return { data, error: null };
        },
        download(path) {
          return {
            async asStream() {
              events.push("stream");
              if (streamThrows) throw new Error(`stream failed ${SECRET_URL}`);
              if (storageFails) {
                return { data: null, error: { message: `read failed ${SECRET_URL}`, status: 500 } };
              }
              const half = Math.floor(PDF_BYTES.length / 2);
              const stream = new ReadableStream({
                start(controller) {
                  controller.enqueue(PDF_BYTES.slice(0, half));
                  controller.enqueue(PDF_BYTES.slice(half));
                  controller.close();
                },
              });
              return { data: stream, error: null, bucket, path };
            },
          };
        },
        async createSignedUrl(path, ttl, opts) {
          signed.push({ bucket, path, ttl, opts });
          return { data: { signedUrl: SECRET_URL }, error: null };
        },
      };
    },
  };
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor(role);

  const id = APPS[who].id;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  const res = await (async () => {
    try {
      return await GET(
        new Request(`https://remotiv.test/api/cv/company-application/${id}${query}`),
        { params: Promise.resolve({ id }) },
      );
    } finally {
      console.error = realError;
    }
  })();
  const logs = service.queries.filter((q) => q.table === "signed_url_logs");
  return { res, signed, logs, events, logged };
}

/** Headers come back as a real Headers on the 200 and as a Map on the stub. */
const header = (res, name) => res.headers.get(name) ?? null;

/** The body as text: a real Response streams it, the stub holds a string. */
async function bodyText(res) {
  return typeof res.body === "string" ? res.body : await new Response(res.body).text();
}

async function assertOpened(r, who, { disposition = "inline" } = {}) {
  const { res, signed, logs, events } = r;
  assert.equal(res.status, 200);
  assert.equal(header(res, "content-type"), "application/pdf");
  assert.equal(header(res, "content-disposition"), `${disposition}; filename="cv.pdf"`);
  assert.equal(header(res, "cache-control"), "private, no-store");
  assert.equal(header(res, "content-length"), String(PDF_BYTES.length));
  assert.equal(header(res, "accept-ranges"), null, "byte ranges are not advertised");
  assert.equal(header(res, "location"), null, "no redirect, ever");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF_BYTES, "the exact bytes");
  assert.equal(signed.length, 0, "no signed URL is minted on an allowed request");
  assert.equal(logs.length, 1, "exactly one access log row");
  const insert = logs[0].calls.find((c) => c[0] === "insert");
  assert.deepEqual(insert?.[1], {
    user_id: "u-1",
    candidate_id: APPS[who].id,
    source_table: "job_applications",
    was_admin: false,
  });
  assert.ok(
    events.indexOf("log") >= 0 && events.indexOf("log") < events.indexOf("stream"),
    `the log resolves before the stream is asked for (saw ${events.join(" > ")})`,
  );
}

function assertRefused({ res, signed, logs, events }) {
  assert.equal(res.status, 404);
  assert.match(res.body, /CV not found/);
  assert.match(res.body, /isn't in your workspace, or it no longer exists/);
  assert.equal(signed.length, 0, "a refused request mints no signed URL");
  assert.equal(logs.length, 0, "a refused request writes no signed_url_logs row");
  assert.equal(events.length, 0, "a refused request touches storage not at all");
}

/* ── #97: the authorisation cases, unchanged in meaning ─────────────────── */

test("1. a recruiter on Job A opens A1: 200, the bytes, one log row", async () => {
  await assertOpened(await open("recruiter", "A1"), "A1");
});

test("2. a recruiter on Job A is refused B1 (same company, another job): 404, nothing signed, nothing logged", async () => {
  assertRefused(await open("recruiter", "B1"));
});

test("3. a hiring manager on Job A is refused B1 the same way", async () => {
  assertRefused(await open("hiring_manager", "B1"));
});

test("4. an owner opens both A1 and B1", async () => {
  await assertOpened(await open("owner", "A1"), "A1");
  await assertOpened(await open("owner", "B1"), "B1");
});

test("5. every role is refused C1 (another company), nothing signed, nothing logged", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    assertRefused(await open(role, "C1"));
  }
});

test("6. an application with no job (job deleted, SET NULL): owner opens it, recruiter is refused", async () => {
  await assertOpened(await open("owner", "N1"), "N1");
  assertRefused(await open("recruiter", "N1"));
});

test("7. the wrong-job and wrong-company refusals are byte-identical: the response is not an oracle", async () => {
  const wrongJob = await open("recruiter", "B1");
  const wrongCompany = await open("recruiter", "C1");
  assert.equal(wrongJob.res.status, wrongCompany.res.status);
  assert.equal(wrongJob.res.body, wrongCompany.res.body);
  assert.deepEqual([...wrongJob.res.headers], [...wrongCompany.res.headers]);
});

test("control: the gate is the hiring-team row, not the id - put the recruiter on Job B and B1 opens", async () => {
  await assertOpened(await open("recruiter", "B1", { teamJobs: [JOB_A, JOB_B] }), "B1");
});

test("control: the checks run in order - a wrong-company row never reaches the hiring-team read", async () => {
  const reads = [];
  const service = fakeService((table) => {
    reads.push(table);
    if (table === "job_applications") return { data: APPS.C1, error: null };
    return { data: null, error: null };
  });
  service.storage = {
    from: () => ({
      info: async () => {
        throw new Error("must not read storage");
      },
      download: () => {
        throw new Error("must not read storage");
      },
      createSignedUrl: async () => {
        throw new Error("must not sign");
      },
    }),
  };
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor("recruiter");
  const res = await GET(new Request("https://remotiv.test/api/cv/company-application/app-c1"), {
    params: Promise.resolve({ id: APPS.C1.id }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(reads, ["job_applications"]);
});

/* ── #99: served through the dashboard ──────────────────────────────────── */

test("8. ?download=1 flips Content-Disposition to attachment and changes nothing else", async () => {
  const r = await open("recruiter", "A1", { query: "?download=1" });
  await assertOpened(r, "A1", { disposition: "attachment" });
});

test("9. the access log is awaited before any byte: when the insert fails, an error page and no bytes", async () => {
  const r = await open("recruiter", "A1", { logFails: true });
  assert.equal(r.res.status, 500);
  assert.match(r.res.body, /Could not open CV/);
  const text = await bodyText(r.res);
  assert.ok(!text.includes("%PDF"), "no file bytes in a failed-log response");
  assert.equal(r.events.includes("stream"), false, "the stream is never opened");
  assert.equal(r.signed.length, 0, "and nothing is signed");
  assert.equal(header(r.res, "location"), null);
});

test("10. a storage failure returns the error page and leaks no path, URL or token anywhere", async () => {
  const r = await open("recruiter", "A1", { storageFails: true });
  assert.equal(r.res.status, 502);
  assert.match(r.res.body, /Could not open CV/);
  const everything = [r.res.body, ...[...r.res.headers].flat(), ...r.logged].join("\n");
  for (const needle of [SECRET_URL, "SECRET-TOKEN", "x/a1.pdf", "cvs/"]) {
    assert.ok(!everything.includes(needle), `leaked ${needle}`);
  }
  assert.equal(r.signed.length, 0);
  assert.equal(r.logs.length, 1, "the view was logged before storage was asked");
});

test("11. no Content-Length is sent when storage reports no usable size; nothing else changes", async () => {
  for (const size of ["absent", 0, -1, 1.5, Number.NaN, "12"]) {
    const r = await open("recruiter", "A1", { size });
    assert.equal(r.res.status, 200);
    assert.equal(
      header(r.res, "content-length"),
      null,
      `size ${String(size)} must not become a header`,
    );
    assert.equal(header(r.res, "content-type"), "application/pdf");
    assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), PDF_BYTES);
  }
});

test("12. createSignedUrl is never called, on any path: allowed, refused, failed log, failed storage", async () => {
  const runs = [
    await open("recruiter", "A1"),
    await open("recruiter", "B1"),
    await open("owner", "C1"),
    await open("recruiter", "A1", { logFails: true }),
    await open("recruiter", "A1", { storageFails: true }),
  ];
  for (const r of runs) assert.equal(r.signed.length, 0);
});

/* ── #99 follow-up: the storage calls survive a throw, not just an error field ── */

/** Nothing of a storage failure may reach the body, a header or the console. */
function assertNoLeak(r) {
  const everything = [
    typeof r.res.body === "string" ? r.res.body : "",
    ...[...r.res.headers].flat(),
    ...r.logged,
  ].join("\n");
  for (const needle of [
    SECRET_URL,
    "SECRET-TOKEN",
    "x/a1.pdf",
    "cvs/",
    "info failed",
    "stream failed",
  ]) {
    assert.ok(!everything.includes(needle), `leaked ${needle}`);
  }
}

test("13. info() THROWS: 200, the exact bytes, no Content-Length, no error page, nothing leaked", async () => {
  const r = await open("recruiter", "A1", { infoThrows: true });
  assert.equal(r.res.status, 200);
  assert.equal(header(r.res, "content-length"), null, "a thrown size read is a missing size");
  assert.equal(header(r.res, "content-type"), "application/pdf");
  assert.equal(header(r.res, "content-disposition"), 'inline; filename="cv.pdf"');
  assert.equal(header(r.res, "cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), PDF_BYTES, "the exact bytes");
  assertNoLeak(r);
  assert.equal(r.logs.length, 1, "the access log row is still written exactly once");
  assert.ok(
    r.events.indexOf("log") >= 0 && r.events.indexOf("log") < r.events.indexOf("stream"),
    `the log still resolves before the stream is requested (saw ${r.events.join(" > ")})`,
  );
  assert.equal(r.signed.length, 0);
});

test("14. info() returns { error }: same as a throw - 200, the bytes, no Content-Length, nothing leaked", async () => {
  const r = await open("recruiter", "A1", { infoFails: true });
  assert.equal(r.res.status, 200);
  assert.equal(header(r.res, "content-length"), null, "an error return is a missing size");
  assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), PDF_BYTES);
  assertNoLeak(r);
  assert.equal(r.logs.length, 1);
  assert.ok(r.events.indexOf("log") < r.events.indexOf("stream"));
});

test("15. asStream() THROWS: the 502 page, no bytes, nothing leaked - one path with the error return", async () => {
  const thrown = await open("recruiter", "A1", { streamThrows: true });
  const returned = await open("recruiter", "A1", { storageFails: true });
  assert.equal(thrown.res.status, 502);
  assert.match(thrown.res.body, /Could not open CV/);
  assert.ok(!(await bodyText(thrown.res)).includes("%PDF"), "no file bytes");
  assert.equal(header(thrown.res, "location"), null);
  assertNoLeak(thrown);
  assert.equal(
    thrown.res.status,
    returned.res.status,
    "a throw and an error return share one page",
  );
  assert.equal(thrown.res.body, returned.res.body);
  assert.deepEqual(thrown.logged, returned.logged, "and one log line, with no error detail");
  assert.equal(thrown.signed.length, 0);
});

test("16. neither catch logs the thrown object: the console lines are fixed strings", async () => {
  const infoCase = await open("recruiter", "A1", { infoThrows: true });
  const streamCase = await open("recruiter", "A1", { streamThrows: true });
  assert.deepEqual(infoCase.logged, [
    "[cv-company-application] size read threw; serving without Content-Length",
  ]);
  assert.deepEqual(streamCase.logged, ["[cv-company-application] storage read failed"]);
});
