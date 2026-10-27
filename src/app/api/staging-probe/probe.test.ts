/**
 * The staging-probe gate and both routes, with every dependency faked.
 *
 *   node --test src/app/api/staging-probe/probe.test.ts
 *
 * The property under test is ORDER: the sentinel is read before the session,
 * and the session before any applicant id, so that in production, where the
 * sentinel schema does not exist, the routes are a bare 404 that computed
 * nothing. Each fake records whether it was called, and the tests assert the
 * later steps were NOT reached, not merely that the status was 404.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "next/server": `export class NextResponse {
  constructor(body, init) { this.status = init?.status ?? 200; this.body = body; this.headers = new Map(); }
  static json(body, init) { return { status: init?.status ?? 200, body, headers: new Map() }; }
};`,
  "@/lib/supabase/server": `export function createServiceClient() {
  globalThis.__probe.serviceBuilt += 1;
  return globalThis.__probe.service;
}`,
  "@/app/ai-dashboard/lib/company-guards": `export async function getCompanyContext() {
  globalThis.__probe.contextCalls += 1;
  const r = globalThis.__probe.context;
  if (r instanceof Error) throw r;
  return r;
}`,
  "@/app/ai-dashboard/lib/job-scope": `export async function getJobScope(ctx) {
  globalThis.__probe.scopeCalls += 1;
  return globalThis.__probe.scope;
}
export async function scopedApplicationIds(ctx, scope) {
  globalThis.__probe.idsCalls += 1;
  globalThis.__probe.idsArgs = { ctx, scope };
  return globalThis.__probe.ids;
}`,
};
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const identity = await import("./identity/route.ts");
const scoped = await import("./scoped-application-ids/route.ts");

const HASH = "c".repeat(64);
const CTX = { companyId: "co", role: "recruiter", memberId: "m1", user: { id: "u" } };

/** A service client that records the schema and table of each read. */
function service(result) {
  const reads = [];
  return {
    reads,
    schema(name) {
      return {
        from(table) {
          reads.push({ schema: name, table });
          return { select: () => ({ limit: async () => result }) };
        },
      };
    },
    // A bare .from() is the PUBLIC schema. The gate must never use it.
    from(table) {
      reads.push({ schema: "public", table });
      return { select: () => ({ limit: async () => result }) };
    },
  };
}

function world({
  sentinel = { data: [{ project_ref_sha256: HASH, purpose: "load test" }], error: null },
  context = CTX,
  scope = { scoped: true, jobIds: ["j1", "j2"] },
  ids = { ok: true, value: ["a", "b", "c"] },
} = {}) {
  globalThis.__probe = {
    service: service(sentinel),
    serviceBuilt: 0,
    context,
    contextCalls: 0,
    scope,
    scopeCalls: 0,
    ids,
    idsCalls: 0,
    idsArgs: null,
  };
  return globalThis.__probe;
}

const gate = await import("./_lib/gate.ts");

const bare404 = (res, code) => {
  assert.equal(res.status, 404);
  assert.equal(res.body ?? null, null, "a 404 carries no body");
  if (code !== undefined) {
    assert.equal(
      res.headers.get(gate.REFUSAL_HEADER),
      code,
      `the 404 must carry the refusal code ${code}`,
    );
  }
};

/* ──────────────────────────── the gate ───────────────────────────── */

test("a failed sentinel read is a bare 404, code sentinel-unreadable, before the session is read", async () => {
  for (const route of [identity, scoped]) {
    const w = world({ sentinel: { data: null, error: { message: "schema does not exist" } } });
    bare404(await route.GET(), "sentinel-unreadable");
    assert.equal(w.contextCalls, 0, "the session was read after the sentinel refused");
    assert.equal(w.idsCalls, 0, "ids were computed after the sentinel refused");
  }
});

test("an EMPTY sentinel table is a bare 404, code sentinel-count, not agreement", async () => {
  const w = world({ sentinel: { data: [], error: null } });
  bare404(await identity.GET(), "sentinel-count");
  assert.equal(w.contextCalls, 0);
});

test("a two-row sentinel is refused with code sentinel-count", async () => {
  const two = [
    { project_ref_sha256: HASH, purpose: "a" },
    { project_ref_sha256: HASH, purpose: "b" },
  ];
  world({ sentinel: { data: two, error: null } });
  bare404(await identity.GET(), "sentinel-count");
});

test("a sentinel whose hash is not 64 hex characters is refused with code sentinel-hash", async () => {
  for (const bad of ["todo", "", "G".repeat(64), null, 64]) {
    world({ sentinel: { data: [{ project_ref_sha256: bad, purpose: "x" }], error: null } });
    bare404(await identity.GET(), "sentinel-hash");
  }
});

/* ── the refusal codes: WHICH check said no ── */

test("an unauthenticated session is a 404 with code unauthenticated", async () => {
  const denied = Object.assign(new Error("denied"), { access: { reason: "unauthenticated" } });
  const w = world({ context: denied });
  bare404(await identity.GET(), "unauthenticated");
  assert.equal(w.contextCalls, 1, "the session WAS read, after the sentinel passed");
});

test("an authenticated user with no company is a 404 with code no-company — the pre-seed case", async () => {
  // This is the condition the 50-seed hit: the owner is signed in but FREE,
  // so resolveCompanyAccess refuses with not_company and the gate 404s. The
  // code makes that legible instead of a bare, four-cause 404.
  for (const reason of ["not_company", "inactive", "unavailable"]) {
    world({ context: Object.assign(new Error("denied"), { access: { reason } }) });
    bare404(await identity.GET(), "no-company");
  }
});

test("a company-profile error after access is a 404 with code profile-error", async () => {
  const profile = Object.assign(new Error("vanished"), { name: "CompanyProfileError" });
  world({ context: profile });
  bare404(await identity.GET(), "profile-error");
});

test("any other throw is a 404 with code unknown", async () => {
  world({ context: new Error("something else entirely") });
  bare404(await identity.GET(), "unknown");
});

test("codeForContextError maps by reason and name only", () => {
  assert.equal(
    gate.codeForContextError({ access: { reason: "unauthenticated" } }),
    "unauthenticated",
  );
  assert.equal(gate.codeForContextError({ access: { reason: "not_company" } }), "no-company");
  assert.equal(gate.codeForContextError({ name: "CompanyProfileError" }), "profile-error");
  assert.equal(gate.codeForContextError(new Error("x")), "unknown");
  assert.equal(gate.codeForContextError(null), "unknown");
});

test("the sentinel is read from the staging_guard schema, never public", async () => {
  const w = world();
  await identity.GET();
  assert.deepEqual(w.service.reads, [{ schema: "staging_guard", table: "sentinel" }]);
});

test("no signed-in session is a bare 404, and no id is computed", async () => {
  const w = world({ context: new Error("unauthenticated") });
  bare404(await scoped.GET());
  assert.equal(w.contextCalls, 1, "the session WAS asked for, after the sentinel passed");
  assert.equal(w.scopeCalls, 0);
  assert.equal(w.idsCalls, 0);
});

/* ─────────────────────────── identity ────────────────────────────── */

test("identity returns the sentinel's hash and purpose, and no isolation when not launched in isolation", async () => {
  world();
  delete process.env.STAGING_ISOLATION_NAMES;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const res = await identity.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    projectRefSha256: HASH,
    sentinelPurpose: "load test",
    isolation: null,
    connections: { publicRefSha256: null, anonKeyRefSha256: null, anonKeyValid: null },
  });
});

/* ───────────────────── the browser's connection ───────────────────── */

const fakeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

test("identity reports the browser's URL and anon key as HASHES, and whether the project accepts the key", async () => {
  const { sha256 } = await import("./_lib/connections.ts");
  const REF = "probefakeref00000000";
  world();
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${REF}.supabase.co`;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = fakeJwt({ ref: REF, role: "anon" });
  const realFetch = globalThis.fetch;
  const calls: { url: string; apikey: string | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, apikey: (init?.headers as Record<string, string>)?.apikey });
    return { status: 401 } as Response;
  }) as typeof fetch;
  try {
    const res = await identity.GET();
    assert.deepEqual(res.body.connections, {
      publicRefSha256: sha256(REF),
      anonKeyRefSha256: sha256(REF),
      anonKeyValid: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://${REF}.supabase.co/auth/v1/settings`);
    assert.equal(calls[0].apikey, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(REF), "the ref must not appear in the response");
    assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"), "the key must not appear in the response");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
});

test("connections: a 200 from the settings endpoint means the key is valid; a non-Supabase URL has no ref", async () => {
  const { anonKeyRef, publicConnection, refOf } = await import("./_lib/connections.ts");
  assert.equal(refOf("https://abcdefghijklmnopqrst.supabase.co"), "abcdefghijklmnopqrst");
  assert.equal(refOf("https://example.com"), null);
  assert.equal(refOf(undefined), null);
  assert.equal(anonKeyRef(fakeJwt({ ref: "r" })), "r");
  assert.equal(anonKeyRef("sb_publishable_notajwt"), null);
  assert.equal(anonKeyRef(undefined), null);
  const c = await publicConnection({
    url: "https://abcdefghijklmnopqrst.supabase.co",
    anonKey: "sb_publishable_notajwt",
    fetchImpl: (async () => ({ status: 200 }) as Response) as typeof fetch,
  });
  assert.equal(c.anonKeyValid, true);
  assert.equal(c.anonKeyRefSha256, null, "a publishable key carries no ref claim");
  const unreachable = await publicConnection({
    url: "https://abcdefghijklmnopqrst.supabase.co",
    anonKey: "k",
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  assert.equal(unreachable.anonKeyValid, null, "unverifiable is null, never true");
});

test("identity reports which locked variable NAMES are present, never a value", async () => {
  world();
  process.env.STAGING_ISOLATION_NAMES = "PROBE_LOCKED_A,PROBE_LOCKED_B,PROBE_LOCKED_C";
  process.env.PROBE_LOCKED_A = "";
  process.env.PROBE_LOCKED_B = "a-value-that-must-not-appear";
  delete process.env.PROBE_LOCKED_C;
  try {
    const res = await identity.GET();
    assert.deepEqual(res.body.isolation, {
      checked: ["PROBE_LOCKED_A", "PROBE_LOCKED_B", "PROBE_LOCKED_C"],
      present: ["PROBE_LOCKED_B"],
    });
    assert.ok(!JSON.stringify(res.body).includes("a-value-that-must-not-appear"));
  } finally {
    delete process.env.STAGING_ISOLATION_NAMES;
    delete process.env.PROBE_LOCKED_A;
    delete process.env.PROBE_LOCKED_B;
  }
});

test("isolationReport is pure over the env it is given", async () => {
  const { isolationReport } = await import("./_lib/isolation.ts");
  assert.equal(isolationReport({}), null);
  assert.deepEqual(isolationReport({ STAGING_ISOLATION_NAMES: "X,Y", X: "1" }), {
    checked: ["X", "Y"],
    present: ["X"],
  });
});

/* ───────────────────────── scoped-application-ids ────────────────── */

test("an unscoped member gets ids: null, the function's own answer for unrestricted", async () => {
  const w = world({ scope: { scoped: false } });
  const res = await scoped.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scoped: false, jobCount: null, ids: null });
  assert.equal(w.idsCalls, 0, "no allow-list is computed for an unscoped member");
});

test("a scoped member gets the REAL function's ids for their OWN context and scope", async () => {
  const w = world();
  const res = await scoped.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { scoped: true, jobCount: 2, ids: ["a", "b", "c"] });
  assert.equal(w.idsCalls, 1);
  assert.equal(w.idsArgs.ctx, CTX, "the context passed is the session's, not a constructed one");
  assert.deepEqual(w.idsArgs.scope, { scoped: true, jobIds: ["j1", "j2"] });
});

test("an unavailable allow-list is a 503, never an empty list that would read as complete", async () => {
  world({ ids: { ok: false } });
  const res = await scoped.GET();
  assert.equal(res.status, 503);
  assert.equal(res.body.ids, undefined);
});
