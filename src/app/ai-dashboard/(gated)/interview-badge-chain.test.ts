/**
 * The sidebar's Interviews badge counts a restart once (F10): attempt 1
 * ('abandoned') and its restart (attempt 2) are one interview, as the
 * interview list shows them (F10 C6d). Everything else it counted, it still
 * counts, scoped by the hiring team as before, as a head count.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interview-badge-chain.test.ts"
 *
 * A Next layout may export only its own names, so the badge's query cannot be
 * imported. This test takes the Interviews badge's query expression out of
 * layout.tsx as written and runs it, through the shipped scopeBadges and
 * badgeCount, against a small store that applies eq / neq / in as PostgREST
 * would and answers a head count. The other three badges are not run here
 * (layout-badge-scope.test.ts pins Messages). Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { badgeCount, scopeBadges } = await import("./scope-badges.ts");

const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

/** The Interviews badge's query expression, `(() => { ... })()`, exactly as layout.tsx has it. */
function interviewQuerySource(): string {
  const from = layout.indexOf('.from("interview_sessions")');
  assert.ok(from !== -1, "the Interviews badge still reads interview_sessions");
  const start = layout.lastIndexOf("(() => {", from);
  const end = layout.indexOf("})()", from);
  assert.ok(start !== -1 && end > from, "the badge is still one immediately-run function");
  const source = layout.slice(start, end + "})()".length);
  assert.ok(!/:\s*[A-Z]\w*[<\s,)]/.test(source), "plain JavaScript, so it can run as written");
  return source;
}

type Row = {
  id: string;
  company_id: string;
  job_id: string | null;
  kind: "async" | "live";
  status: string;
  attempt: number;
  previous_attempt_id: string | null;
};
type Call = [string, ...unknown[]];
type Scope = { scoped: false } | { scoped: true; jobIds: string[] };

/** A head count over `rows`, honouring the filters the query applied. */
function store(rows: Row[], fail = false) {
  const reads: Call[][] = [];
  const service = {
    from(table: string) {
      assert.equal(table, "interview_sessions");
      const calls: Call[] = [];
      reads.push(calls);
      const record =
        (op: string) =>
        (...a: unknown[]) => {
          calls.push([op, ...a]);
          return q;
        };
      const q = {
        select: record("select"),
        eq: record("eq"),
        neq: record("neq"),
        in: record("in"),
        // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited directly.
        then(resolve: (v: unknown) => void) {
          if (fail) return resolve({ count: null, error: { code: "57014", message: "timeout" } });
          const hit = rows.filter((r) =>
            calls.every(([op, col, v]) => {
              const value = r[col as keyof Row];
              if (op === "eq") return value === v;
              if (op === "neq") return value !== v;
              if (op === "in") return (v as unknown[]).includes(value);
              return true;
            }),
          );
          resolve({ count: hit.length, error: null, data: null });
        },
      };
      return q;
    },
  };
  return { service, reads };
}

const CO = "c0000000-0000-4000-8000-0000000000b1";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000b2";
const JOB_A = "b0000000-0000-4000-8000-0000000000a1";
const JOB_B = "b0000000-0000-4000-8000-0000000000a2";
const ctx = { companyId: CO };

let n = 0;
const row = (over: Partial<Row>): Row => ({
  id: `5e550000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  company_id: CO,
  job_id: JOB_A,
  kind: "live",
  status: "invited",
  attempt: 1,
  previous_attempt_id: null,
  ...over,
});
/** A restart: attempt 1 abandoned (053), attempt 2 on the same job in `status`. */
function restart(status: string, job = JOB_A, company = CO): Row[] {
  const first = row({ status: "abandoned", job_id: job, company_id: company });
  return [
    first,
    row({ status, attempt: 2, previous_attempt_id: first.id, job_id: job, company_id: company }),
  ];
}

/** Every status an interview row can hold, without restarts. */
function ordinary(job = JOB_A, company = CO): Row[] {
  return [
    ...["invited", "started", "submitted", "expired", "cancelled"].map((status) =>
      row({ kind: "async", status, job_id: job, company_id: company }),
    ),
    ...["invited", "started", "submitted", "expired"].map((status) =>
      row({ status, job_id: job, company_id: company }),
    ),
    // An ordinary re-send: the replaced invite and the new one, two first attempts.
    row({ status: "cancelled", job_id: job, company_id: company }),
    row({ status: "invited", job_id: job, company_id: company }),
  ];
}
const RESTART_STATES = ["invited", "started", "submitted", "expired"];

/** The badge as the layout renders it: scopeBadges, the shipped query, badgeCount. */
async function badge(
  rows: Row[],
  scopeRead: unknown,
  source = interviewQuerySource(),
  fail = false,
) {
  const { service, reads } = store(rows, fail);
  const run = new Function("service", "ctx", "scope", `return ${source};`);
  const results = await scopeBadges(scopeRead as never, async (scope: Scope) => {
    const empty = { count: 0, error: null };
    return [empty, empty, empty, await run(service, ctx, scope)];
  });
  return { count: badgeCount(results[3]), reads };
}
const everyone = { ok: true, value: { scoped: false } };
const team = (jobIds: string[]) => ({ ok: true, value: { scoped: true, jobIds } });

test("a restart counts once, whatever state its restart is in", async () => {
  for (const status of RESTART_STATES) {
    assert.equal((await badge(restart(status), everyone)).count, 1, `restart ${status}`);
  }
  const all = RESTART_STATES.flatMap((s) => restart(s));
  assert.equal((await badge(all, everyone)).count, RESTART_STATES.length, "one per restart");
});

test("ordinary interviews, async and live, re-sends included, count as before", async () => {
  const rows = ordinary();
  assert.equal((await badge(rows, everyone)).count, rows.length, "every ordinary row, as today");
  const mixed = [...rows, ...RESTART_STATES.flatMap((s) => restart(s))];
  assert.equal(
    (await badge(mixed, everyone)).count,
    rows.length + RESTART_STATES.length,
    "the ordinary rows plus one per restart",
  );
});

test("still a head count, company-bounded, scoped by the hiring team exactly as before", async () => {
  const rows = [
    ...ordinary(JOB_A),
    ...restart("started", JOB_A),
    ...ordinary(JOB_B),
    ...restart("invited", JOB_B),
    ...restart("submitted", JOB_B),
    ...ordinary(JOB_A, OTHER_CO),
    ...restart("invited", JOB_A, OTHER_CO),
  ];
  const ord = ordinary().length;
  const { count, reads } = await badge(rows, everyone);
  assert.equal(count, 2 * ord + 3, "the company's own rows, each restart once");
  assert.deepEqual(reads[0][0], ["select", "id", { count: "exact", head: true }], "a head count");
  assert.ok(reads[0].some(([op, col, v]) => op === "eq" && col === "company_id" && v === CO));
  assert.ok(!reads[0].some(([op]) => op === "in"), "an owner is not narrowed");

  const recruiter = await badge(rows, team([JOB_A]));
  assert.equal(recruiter.count, ord + 1, "job A only: its rows and its one restart");
  assert.ok(
    recruiter.reads[0].some(
      ([op, col, v]) => op === "in" && col === "job_id" && (v as string[]).join() === JOB_A,
    ),
    "narrowed by job_id, as before",
  );
  assert.equal((await badge(rows, team([JOB_B]))).count, ord + 2);
  assert.equal((await badge(rows, team([JOB_A, JOB_B]))).count, 2 * ord + 3);
});

test("#24 unchanged: a failed scope read shows no badge, an empty team a real 0, a failed count no badge", async () => {
  const rows = [...ordinary(), ...restart("invited")];
  const unread = await badge(rows, { ok: false, error: "scope read failed" });
  assert.equal(unread.count, undefined, "no badge");
  assert.equal(unread.reads.length, 0, "and no count was run");
  const none = await badge(rows, team([]));
  assert.equal(none.count, 0, "an empty hiring team is a real zero");
  assert.equal(none.reads.length, 0);
  assert.equal((await badge(rows, everyone, undefined, true)).count, undefined, "a failed count");
});

test("the query this replaces counted a restart twice", async () => {
  const before = interviewQuerySource().replace(/\s*\.neq\("status", "abandoned"\)/, "");
  assert.notEqual(before, interviewQuerySource(), "the shipped query has the filter");
  assert.equal((await badge(restart("invited"), everyone, before)).count, 2);
  assert.equal((await badge(restart("invited"), everyone)).count, 1);
});
