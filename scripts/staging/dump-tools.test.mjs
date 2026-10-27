/**
 * Negative controls for the dump review and strip.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Every fabricated dump below contains the thing the function must find, and
 * the test requires it to be found; then the strip is handed a dump with a
 * blocking finding and must refuse to produce output. The false green these
 * guard against: a review that reports "clean" over a dump it did not parse,
 * and a strip that quietly writes a restorable file carrying a webhook.
 *
 * Masking is tested with a fabricated project host and a fabricated token in a
 * webhook path. Neither string may appear in any output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mask, reviewDump, statements, stripDump } from "./dump-tools.mjs";

const HEADER = `--
-- PostgreSQL database dump
--
\\restrict ABCDEFTOKEN
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
`;

const SCHEMA_PUBLIC = `--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';
`;

const CLEAN_BODY = `CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL
);
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.jobs FOR SELECT TO authenticated USING ((auth.uid() IS NOT NULL));
CREATE INDEX idx_bio ON public.talent_profiles USING gin (bio public.gin_trgm_ops);
CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now(); -- a ; inside the body must not split the statement
  return new;
end;
$$;
CREATE TRIGGER t BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE TABLE public.application_scores (
    overall_score integer,
    effective_score integer GENERATED ALWAYS AS (COALESCE(human_adjusted_score, overall_score)) STORED
);
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
GRANT ALL ON TABLE public.jobs TO anon;
REVOKE ALL ON TABLE public.jobs FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch() TO service_role;
\\unrestrict ABCDEFTOKEN
`;

const WEBHOOK = `CREATE TRIGGER on_apply AFTER INSERT ON public.job_applications
  FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://hooks.example.com/services/SECRETTOKEN123', 'POST');
`;
const PROD_HOST = `COMMENT ON TABLE public.jobs IS 'synced from https://abcdefghijklmnopqrst.supabase.co/rest/v1/jobs';
`;

/**
 * The constraint that stopped the first restore, verbatim from the production
 * dump (line 2444 of that file). host_member_id is a uuid; gist has no
 * operator class for uuid without btree_gist, and a --schema=public dump
 * never emits the CREATE EXTENSION.
 */
const BOOKINGS = `CREATE TABLE public.interview_bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    host_member_id uuid NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    scheduled_start timestamp with time zone,
    scheduled_end timestamp with time zone,
    CONSTRAINT interview_bookings_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'booked'::text])))
);
ALTER TABLE ONLY public.interview_bookings
    ADD CONSTRAINT interview_bookings_no_host_overlap EXCLUDE USING gist (host_member_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)'::text) WITH &&) WHERE ((status = 'booked'::text));
`;

/** A gist index core handles alone: a range-typed column, no btree type in sight. */
const RANGE_ONLY = `CREATE TABLE public.shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period tstzrange NOT NULL
);
CREATE INDEX shifts_period_idx ON public.shifts USING gist (period);
`;

const clean = HEADER + SCHEMA_PUBLIC + CLEAN_BODY;
/** Statements appended after \unrestrict would be outside the restricted span; insert before it. */
const withBody = (extra) =>
  clean.replace("\\unrestrict ABCDEFTOKEN\n", `${extra}\\unrestrict ABCDEFTOKEN\n`);

/* ───────────────────────────── parsing ───────────────────────────── */

test("statements splits on line-ending semicolons outside dollar quotes", () => {
  const s = statements(CLEAN_BODY);
  const fn = s.find((x) => x.text.startsWith("CREATE FUNCTION"));
  assert.ok(fn, "the function statement was not found");
  assert.match(fn.text, /return new;\nend;\n\$\$;$/, "the body's ; split the function");
  assert.equal(s.filter((x) => x.text.startsWith("CREATE TABLE")).length, 2);
});

test("statements records the line each statement starts on", () => {
  const s = statements("-- c\n\nCREATE TABLE a (\n x int\n);\nGRANT ALL ON a TO b;\n");
  assert.deepEqual(
    s.map((x) => x.line),
    [3, 6],
  );
});

/* ───────────────────────────── masking ───────────────────────────── */

test("mask hides a Supabase project host and every URL path", () => {
  const out = mask(
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1/x and https://hooks.example.com/services/SECRETTOKEN123 and db.abcdefghijklmnopqrst.supabase.co",
  );
  assert.doesNotMatch(out, /abcdefghijklmnopqrst/, "the project ref leaked");
  assert.doesNotMatch(out, /SECRETTOKEN/, "a webhook token leaked");
  assert.match(out, /<ref>\.supabase\.co/);
  assert.match(out, /hooks\.example\.com\/<path:\d+>/, "the host stays, the path is redacted");
});

/* ───────────────────────────── review ────────────────────────────── */

test("reviewDump counts the object classes of a clean dump", () => {
  const r = reviewDump(clean);
  assert.equal(r.counts.tables, 2);
  assert.equal(r.counts.rlsEnabled, 1);
  assert.equal(r.counts.policies, 1);
  assert.equal(r.counts.indexes, 1);
  assert.equal(r.counts.triggers, 1);
  assert.equal(r.counts.functions, 1);
  assert.equal(r.counts.generatedColumns, 1);
  assert.equal(r.counts.grants, 3);
  assert.equal(r.counts.defaultPrivileges, 2);
  assert.deepEqual(r.grantees, ["anon", "authenticated", "service_role"]);
  assert.equal(r.needs.pg_trgm, true);
  assert.equal(r.needs.uuid_ossp, false);
  assert.equal(r.effectiveScore.length, 1, "effective_score must be found as a generated column");
  assert.equal(r.blockingTotal, 0);
});

test("reviewDump finds the mechanical strip targets with their lines", () => {
  const r = reviewDump(clean);
  assert.equal(r.mechanical.createSchemaPublic.hits.length, 1);
  assert.equal(r.mechanical.commentSchemaPublic.hits.length, 1);
  assert.equal(r.mechanical.defaultPrivilegesSupabaseAdmin.hits.length, 1);
  assert.match(r.mechanical.createSchemaPublic.hits[0].preview, /^CREATE SCHEMA public;/);
});

test("reviewDump flags a database webhook as blocking, and as a trigger outside public", () => {
  const r = reviewDump(clean + WEBHOOK);
  assert.equal(r.blocking.outbound.length, 1, "supabase_functions.http_request must be found");
  assert.equal(r.blocking.url.length, 1);
  assert.equal(r.triggersOutsidePublic.length, 1);
  assert.ok(r.blockingTotal >= 2);
  const everything = JSON.stringify(r);
  assert.doesNotMatch(everything, /SECRETTOKEN/, "the webhook token must be masked everywhere");
});

test("reviewDump flags a production host in a comment as blocking and masks it", () => {
  const r = reviewDump(clean + PROD_HOST);
  assert.equal(r.blocking.url.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /abcdefghijklmnopqrst/, "the project ref leaked");
  assert.match(r.blocking.url[0].preview, /<ref>\.supabase\.co/);
});

test("reviewDump flags cron, owner, foreign and drop statements", () => {
  const r = reviewDump(
    `${clean}SELECT cron.schedule('x', '* * * * *', 'select 1');\nALTER TABLE public.jobs OWNER TO someone;\nCREATE PUBLICATION p FOR TABLE public.jobs;\nDROP TABLE public.jobs;\n`,
  );
  assert.equal(r.blocking.cron.length, 1);
  assert.equal(r.blocking.owner.length, 1);
  assert.equal(r.blocking.foreign.length, 1);
  assert.equal(r.blocking.drop.length, 1);
});

test("reviewDump over an empty or trivial text reports zero of everything, not a crash", () => {
  const r = reviewDump("");
  assert.equal(r.counts.statements, 0);
  assert.equal(r.blockingTotal, 0);
  assert.equal(
    r.effectiveScore.length,
    0,
    "an empty dump has no generated column; the CLI says NOT FOUND",
  );
});

/* ────────────────────────────── strip ────────────────────────────── */

test("stripDump removes the three mechanical classes and prepends pg_trgm", () => {
  const s = stripDump(clean);
  assert.equal(s.ok, true, JSON.stringify(s.blockers));
  assert.deepEqual(
    s.removed.map((r) => r.rule),
    ["createSchemaPublic", "commentSchemaPublic", "defaultPrivilegesSupabaseAdmin"],
  );
  assert.doesNotMatch(s.text, /^CREATE SCHEMA public;/m);
  assert.doesNotMatch(s.text, /^COMMENT ON SCHEMA public/m);
  assert.doesNotMatch(s.text, /FOR ROLE supabase_admin/);
  assert.match(s.text, /FOR ROLE postgres/, "postgres default privileges must survive");
  assert.match(s.text, /^CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;$/m);
  assert.deepEqual(s.prepended, ["CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;"]);
});

test("stripDump keeps the restrict line first and the unrestrict line last", () => {
  const s = stripDump(clean);
  const lines = s.text.trimEnd().split("\n");
  assert.equal(lines[0], "\\restrict ABCDEFTOKEN");
  assert.equal(lines.at(-1), "\\unrestrict ABCDEFTOKEN");
});

test("stripDump emits EXACTLY ONE restrict and EXACTLY ONE unrestrict line", () => {
  // The test above checked POSITION, and a duplicated line satisfies it: the
  // first restore's output had \restrict at lines 1 and 5, because the header
  // re-emitted the line and the body still carried it. psql stops at the
  // second one. Position is not count; this asserts the count.
  const s = stripDump(clean);
  const lines = s.text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("\\restrict")).length, 1, "restrict count");
  assert.equal(lines.filter((l) => l.startsWith("\\unrestrict")).length, 1, "unrestrict count");
  assert.equal(lines.filter((l) => l.startsWith("\\")).length, 2, "no other meta-command");
});

test("stripDump preserves every non-stripped statement, grants included", () => {
  const s = stripDump(clean);
  for (const must of [
    "CREATE TABLE public.jobs (",
    "ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY p",
    "GRANT ALL ON TABLE public.jobs TO anon;",
    "REVOKE ALL ON TABLE public.jobs FROM anon, authenticated;",
    "GENERATED ALWAYS AS",
    "EXECUTE FUNCTION public.touch();",
  ]) {
    assert.ok(s.text.includes(must), `stripped output lost: ${must}`);
  }
});

test("stripDump REFUSES while a webhook trigger is in the dump", () => {
  // The dangerous case. A strip that wrote this file would restore a trigger
  // that fires at a real endpoint on the seed's first insert.
  const s = stripDump(clean + WEBHOOK);
  assert.equal(s.ok, false);
  assert.equal(s.text, undefined, "no output may exist");
  assert.ok(
    s.blockers.some((b) => b.startsWith("outbound:")),
    JSON.stringify(s.blockers),
  );
  assert.doesNotMatch(JSON.stringify(s), /SECRETTOKEN/);
});

test("stripDump REFUSES a dump naming a production host", () => {
  const s = stripDump(clean + PROD_HOST);
  assert.equal(s.ok, false);
  assert.ok(s.blockers.some((b) => b.startsWith("url:")));
});

test("stripDump REFUSES a dump carrying any DROP", () => {
  const s = stripDump(`${clean}DROP TABLE public.jobs;\n`);
  assert.equal(s.ok, false);
  assert.ok(s.blockers.some((b) => b.startsWith("drop:")));
});

test("stripDump REFUSES a dump with no effective_score generated column: the restore gate", () => {
  // Not a note, a gate. The stale schema.sql is exactly this dump, and a strip
  // that wrote it would restore a database where Best Match cannot work.
  const without = clean.replace(
    "    effective_score integer GENERATED ALWAYS AS (COALESCE(human_adjusted_score, overall_score)) STORED\n",
    "",
  );
  assert.equal(reviewDump(without).effectiveScore.length, 0, "the premise: the column is gone");
  const s = stripDump(without);
  assert.equal(s.ok, false);
  assert.equal(s.text, undefined, "no output may exist");
  assert.ok(
    s.blockers.some((b) => b.includes("RESTORE GATE")),
    `the gate must be named: ${JSON.stringify(s.blockers)}`,
  );
});

/* ─────────────────────────── extensions ──────────────────────────── */

test("reviewDump resolves the real uuid EXCLUDE USING gist to btree_gist, and the range half to core", () => {
  const r = reviewDump(withBody(BOOKINGS));
  assert.equal(r.indexing.gist.length, 1, "the EXCLUDE constraint must be found as gist usage");
  const [g] = r.indexing.gist;
  assert.equal(g.elements.length, 2, JSON.stringify(g.elements));
  assert.deepEqual(
    g.elements.map((e) => [e.expr, e.source]),
    [
      ["host_member_id", "btree_gist"],
      ["tstzrange(scheduled_start, scheduled_end, '[)'::text)", "core"],
    ],
  );
  assert.equal(r.needs.btree_gist, true);
  assert.equal(r.blocking.extension.length, 0, "nothing unknown: both halves resolved");
});

test("stripDump prepends btree_gist for that constraint, in public, next to pg_trgm", () => {
  const s = stripDump(withBody(BOOKINGS));
  assert.equal(s.ok, true, JSON.stringify(s.blockers));
  assert.deepEqual(s.prepended, [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;",
  ]);
  const lines = s.text.split("\n");
  const ext = lines.findIndex((l) => l.includes("btree_gist"));
  const excl = lines.findIndex((l) => l.includes("EXCLUDE USING gist"));
  assert.ok(ext > 0 && ext < excl, "the extension must come before the constraint that needs it");
});

test("a gist index over a range column alone does NOT need btree_gist", () => {
  const r = reviewDump(withBody(RANGE_ONLY));
  assert.equal(r.indexing.gist.length, 1);
  assert.deepEqual(
    r.indexing.gist[0].elements.map((e) => e.source),
    ["core"],
  );
  assert.equal(r.needs.btree_gist, false);
  assert.deepEqual(stripDump(withBody(RANGE_ONLY)).prepended, [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
  ]);
});

test("reviewDump enumerates every access method and operator class with its source", () => {
  const r = reviewDump(withBody(BOOKINGS));
  assert.deepEqual(Object.keys(r.indexing.accessMethods).sort(), ["gin", "gist"]);
  assert.equal(r.indexing.accessMethods.gin.count, 1);
  assert.equal(r.indexing.accessMethods.gin.source, "core");
  assert.match(r.indexing.accessMethods.gist.source, /^core/);
  assert.deepEqual(r.indexing.operatorClasses, { gin_trgm_ops: { count: 1, source: "pg_trgm" } });
});

test("an operator class from no known extension is BLOCKING and the strip refuses", () => {
  const mystery = "CREATE INDEX idx_m ON public.jobs USING gin (status public.mystery_ops);\n";
  const r = reviewDump(withBody(mystery));
  assert.equal(r.indexing.operatorClasses.mystery_ops.source, "UNKNOWN: decide by hand");
  assert.equal(r.blocking.extension.length, 1);
  const s = stripDump(withBody(mystery));
  assert.equal(s.ok, false);
  assert.ok(
    s.blockers.some((b) => b.startsWith("extension:") && b.includes("mystery_ops")),
    JSON.stringify(s.blockers),
  );
});

test("a gist element whose column type cannot be resolved is BLOCKING, not silently core", () => {
  const orphan = "CREATE INDEX idx_o ON public.nowhere USING gist (thing);\n";
  const r = reviewDump(withBody(orphan));
  assert.equal(r.indexing.gist[0].elements[0].source, "unknown");
  assert.equal(r.needs.btree_gist, true, "unresolved is prepended AND blocked");
  assert.equal(stripDump(withBody(orphan)).ok, false);
});

test("stripDump REFUSES an unexpected psql meta-command, naming its line and text", () => {
  // The previous version skipped EVERY backslash line. A \connect or \i in a
  // hand-edited dump would have vanished without a word, and the output would
  // have looked complete. Only \restrict and \unrestrict are expected.
  for (const cmd of ["\\connect postgres", "\\i /somewhere/else.sql", "\\set ON_ERROR_STOP off"]) {
    const s = stripDump(withBody(`${cmd}\n`));
    assert.equal(s.ok, false, `${cmd} was not refused`);
    assert.equal(s.text, undefined, "no output may exist");
    const b = s.blockers.find((x) => x.startsWith("meta-command:"));
    assert.ok(b, JSON.stringify(s.blockers));
    assert.match(b, /line \d+/, "the line must be named");
    assert.ok(b.includes(cmd.split(" ")[0]), `the command text must be named: ${b}`);
  }
});

test("stripDump does not prepend pg_trgm when nothing references it", () => {
  const s = stripDump(clean.replace("public.gin_trgm_ops", "text_pattern_ops"));
  assert.equal(s.ok, true);
  assert.deepEqual(s.prepended, []);
});
