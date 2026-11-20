/**
 * #6: a CV whose file is gone from storage says "CV unavailable", in the admin
 * route, the admin table and the company drawer, and a CV is only ever called
 * lost on storage's own "not found" answer.
 *
 *   node --test src/lib/cv-object.test.ts
 *
 * cv-object.ts, the admin CV route and the admin availability route run as
 * shipped. Storage is a fake answering `info` per path; a missing object gets
 * the exact error storage gave on staging (StorageApiError, 400, "404",
 * "Object not found"). The two UIs fetch from effects, which a server render
 * does not run, so their wiring is pinned in source. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { if (!globalThis.__cvAdmin) throw new Error('no'); return { user: { id: 'admin-1' } }; }",
  "@/lib/admin-scope": "export async function adminApplicationScope() { return 'company_id_snapshot.is.null'; }",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__cvService; }",
  "next/server": [
    "export class NextResponse {",
    "  constructor(body, init) { this.status = init?.status ?? 200; this.body = body ?? ''; this.headers = new Map(Object.entries(init?.headers ?? {})); }",
    "  static redirect(url, status) { const r = new NextResponse('', { status }); r.headers.set('location', String(url)); return r; }",
    "  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }",
    "}",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { cvObjectState, isObjectMissing, availabilityOf, CV_UNAVAILABLE } = await import(
  "./cv-object.ts"
);
const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const { GET: adminOpen } = await import("../app/api/cv/admin-application/[id]/route.ts");
const { POST: availability } = await import(
  "../app/api/cv/admin-application/availability/route.ts"
);

const MISSING = {
  name: "StorageApiError",
  status: 400,
  statusCode: "404",
  message: "Object not found",
};
const OUTAGE = { name: "StorageUnknownError", status: 500, statusCode: "500", message: "upstream" };

/** A bucket where `present` paths exist, `outage` paths error, and the rest are missing. */
function bucket({ present = [], outage = [] } = {}) {
  const calls = { info: [], sign: [] };
  return {
    calls,
    info: async (path) => {
      calls.info.push(path);
      if (outage.includes(path)) return { data: null, error: OUTAGE };
      return present.includes(path)
        ? { data: { size: 1234 }, error: null }
        : { data: null, error: MISSING };
    },
    createSignedUrl: async (path) => {
      calls.sign.push(path);
      return { data: { signedUrl: "https://storage.test/signed" }, error: null };
    },
  };
}

/** Admin-side world: job_applications rows by id, and the bucket. */
function world(rows, storage) {
  const service = fakeService((table, calls) => {
    if (table === "job_applications") {
      const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
      const ids = calls.find((c) => c[0] === "in" && c[1] === "id")?.[2];
      if (id) return { data: rows.find((r) => r.id === id) ?? null, error: null };
      return { data: rows.filter((r) => ids.includes(r.id)), error: null };
    }
    if (table === "signed_url_logs") return { data: null, error: null };
    return { data: null, error: null };
  });
  service.storage = { from: () => storage };
  globalThis.__cvService = service;
  globalThis.__cvAdmin = true;
  return service;
}

const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

// ── The rule ─────────────────────────────────────────────────────

// Negative control: treat every info() error as missing and an outage would
// call a CV lost.
test("only storage's own 'not found' is missing; an outage or a throw is unknown", async () => {
  assert.equal(isObjectMissing(MISSING), true);
  assert.equal(isObjectMissing({ status: 404 }), true);
  assert.equal(isObjectMissing(OUTAGE), false);
  assert.equal(isObjectMissing(null), false);
  const b = bucket({ present: ["a.pdf"], outage: ["b.pdf"] });
  assert.deepEqual(await cvObjectState(b, "a.pdf"), { state: "present", size: 1234 });
  assert.deepEqual(await cvObjectState(b, "b.pdf"), { state: "unknown" });
  assert.deepEqual(await cvObjectState(b, "gone.pdf"), { state: "missing" });
  const throwing = {
    info: async () => {
      throw new Error("socket hang up");
    },
  };
  assert.deepEqual(await cvObjectState(throwing, "x.pdf"), { state: "unknown" });
  assert.equal(availabilityOf({ state: "missing" }), "unavailable");
  assert.doesNotMatch(`${CV_UNAVAILABLE.title} ${CV_UNAVAILABLE.body}`, /[–—]/);
});

// ── The admin route ─────────────────────────────────────────────

// Negative control: remove the 4b check and a missing CV is signed and
// redirected to a link that fails.
test("admin route: a missing CV gets the plain page, and is never signed or logged", async () => {
  const storage = bucket({ present: ["x/here.pdf"] });
  const service = world(
    [
      { id: "app-gone", cv_path: "x/gone.pdf", cv_url: null },
      { id: "app-here", cv_path: "x/here.pdf", cv_url: null },
    ],
    storage,
  );
  const gone = await quiet(() =>
    adminOpen(new Request("https://remotiv.test/api/cv/admin-application/app-gone"), {
      params: Promise.resolve({ id: "app-gone" }),
    }),
  );
  assert.equal(gone.status, 404);
  assert.match(gone.body, /<title>CV unavailable<\/title>/);
  assert.ok(gone.body.includes(CV_UNAVAILABLE.body));
  assert.deepEqual(storage.calls.sign, [], "never signed");
  assert.equal(service.queries.filter((q) => q.table === "signed_url_logs").length, 0);

  const here = await adminOpen(
    new Request("https://remotiv.test/api/cv/admin-application/app-here"),
    { params: Promise.resolve({ id: "app-here" }) },
  );
  assert.equal(here.status, 302, "a present CV still opens");
  assert.deepEqual(storage.calls.sign, ["x/here.pdf"]);
});

test("admin route: a storage outage is not 'unavailable'; it still signs as before", async () => {
  const storage = bucket({ outage: ["x/blip.pdf"] });
  world([{ id: "app-blip", cv_path: "x/blip.pdf", cv_url: null }], storage);
  const r = await adminOpen(new Request("https://remotiv.test/api/cv/admin-application/app-blip"), {
    params: Promise.resolve({ id: "app-blip" }),
  });
  assert.equal(r.status, 302);
});

// ── The availability route ─────────────────────────────────────

const post = (ids) =>
  availability(
    new Request("https://remotiv.test/api/cv/admin-application/availability", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  );

test("availability: one answer per row: available, unavailable, unknown, none; out-of-scope rows absent", async () => {
  const storage = bucket({ present: ["x/a.pdf"], outage: ["x/c.pdf"] });
  world(
    [
      { id: "a", cv_path: "x/a.pdf", cv_url: null },
      { id: "b", cv_path: "x/b.pdf", cv_url: null },
      { id: "c", cv_path: "x/c.pdf", cv_url: null },
      { id: "d", cv_path: null, cv_url: null },
    ],
    storage,
  );
  const r = await post(["a", "b", "c", "d", "not-mine"]);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).results, {
    a: "available",
    b: "unavailable",
    c: "unknown",
    d: "none",
  });
});

test("availability: admin only, and bounded", async () => {
  world([], bucket());
  globalThis.__cvAdmin = false;
  assert.equal((await post(["a"])).status, 403);
  globalThis.__cvAdmin = true;
  assert.equal((await post([])).status, 400);
  assert.equal((await post(Array.from({ length: 51 }, (_, i) => `id-${i}`))).status, 400);
});

// ── The two UIs ─────────────────────────────────────────────────

// Negative control: drop the cvAvailability branch from the admin table and
// the first assertion fails.
test("admin table: one availability request per page, and 'CV unavailable' with no link", () => {
  const src = readFileSync(
    new URL("../app/admin/_components/applications-dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /cvAvailability\[app\.id\] === "unavailable" \? \(\s*<span[^>]*data-cv-unavailable>\s*CV unavailable\s*<\/span>/,
  );
  assert.match(src, /fetch\("\/api\/cv\/admin-application\/availability", \{/);
  assert.match(src, /\}, \[pageIds\]\);/, "re-asked only when the page's rows change");
});

test("company drawer: asks ?check=1 once per row with a CV, and shows 'CV unavailable' with no link", () => {
  const src = readFileSync(
    new URL("../app/ai-dashboard/(gated)/applicants/_drawer-parts.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /fetch\(`\/api\/cv\/company-application\/\$\{applicationId\}\?check=1`\)/);
  assert.match(src, /if \(!hasCv\) return;/, "rows with no CV are not asked");
  assert.match(
    src,
    /\{cvLost \? \(\s*<span[\s\S]{0,300}data-cv-unavailable\s*>\s*<File[^>]*\/>\s*CV unavailable\s*<\/span>\s*\) : \(\s*<a/,
  );
});
