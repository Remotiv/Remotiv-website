/**
 * Apply the approved mechanical edits to a schema dump and write a sibling file.
 *
 *   node scripts/staging/strip-dump.mjs /tmp/remotiv-prod-schema.sql
 *   → /tmp/remotiv-prod-schema.restorable.sql
 *
 * Refuses, writing nothing, while review-dump.mjs still reports a blocking
 * finding. Prints what it removed and what it prepended, masked. The output
 * file is what README-steps.md step 4 restores.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stripDump } from "./dump-tools.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/staging/strip-dump.mjs <dump.sql>");
  process.exit(2);
}

const result = stripDump(readFileSync(path, "utf8"));
if (!result.ok) {
  console.error("refusing to strip: the review still has findings a human must decide:");
  for (const b of result.blockers) console.error(`  ${b}`);
  console.error("run review-dump.mjs, decide each, edit the dump by hand, then re-run.");
  process.exit(1);
}

const out = `${path.replace(/\.sql$/, "")}.restorable.sql`;
writeFileSync(out, result.text, "utf8");

console.log(`removed ${result.removed.length} statement(s):`);
for (const r of result.removed) console.log(`  line ${r.line} [${r.rule}] ${r.preview}`);
console.log(`prepended ${result.prepended.length} statement(s):`);
for (const p of result.prepended) console.log(`  ${p}`);
console.log(`\nwrote ${out}`);
console.log(
  "restore with: PGSERVICE=remotiv-staging psql --single-transaction --set ON_ERROR_STOP=on -f <that file>",
);
