/**
 * Print the review of a schema dump, with every host and path masked.
 *
 *   node scripts/staging/review-dump.mjs /tmp/remotiv-prod-schema.sql
 *
 * Read-only. Exits 1 when any blocking class has a hit, so a shell step that
 * chains into the strip stops here. See dump-tools.mjs for what each class is.
 */
import { readFileSync } from "node:fs";
import { EFFECTIVE_SCORE_GATE, reviewDump } from "./dump-tools.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/staging/review-dump.mjs <dump.sql>");
  process.exit(2);
}

const r = reviewDump(readFileSync(path, "utf8"));

console.log("── counts ──");
for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k.padEnd(18)} ${v}`);
console.log(`  grantees           ${r.grantees.join(", ") || "(none)"}`);
console.log(`  needs pg_trgm      ${r.needs.pg_trgm}`);
console.log(`  needs uuid-ossp    ${r.needs.uuid_ossp}`);
console.log(
  `  effective_score    ${r.effectiveScore.length > 0 ? `GENERATED column present (line ${r.effectiveScore[0].line})` : "NOT FOUND as a generated column"}`,
);

console.log("\n── indexing: what each access method and operator class comes from ──");
for (const [k, v] of Object.entries(r.indexing.accessMethods)) {
  console.log(`  USING ${k.padEnd(12)} ${String(v.count).padStart(4)}  ${v.source}`);
}
for (const [k, v] of Object.entries(r.indexing.operatorClasses)) {
  console.log(`  ${k.padEnd(18)} ${String(v.count).padStart(4)}  ${v.source}`);
}
if (r.indexing.gist.length === 0) console.log("  gist: none");
for (const g of r.indexing.gist) {
  console.log(`  gist at line ${g.line}: ${g.preview}`);
  for (const e of g.elements) console.log(`    ${e.expr.padEnd(52)} ${e.source}  (${e.reason})`);
}
console.log(
  `  extensions to prepend: ${
    Object.entries(r.needs)
      .filter(([, v]) => v)
      .map(([k]) => k.replace("uuid_ossp", "uuid-ossp"))
      .join(", ") || "(none)"
  }`,
);

console.log("\n── mechanical (strip-dump.mjs removes these) ──");
for (const [k, { reason, hits }] of Object.entries(r.mechanical)) {
  console.log(`  ${k}: ${hits.length}  (${reason})`);
  for (const h of hits) console.log(`    line ${h.line}: ${h.preview}`);
}

console.log("\n── triggers whose function is outside public ──");
if (r.triggersOutsidePublic.length === 0) console.log("  none");
for (const h of r.triggersOutsidePublic) console.log(`  line ${h.line}: ${h.preview}`);

console.log("\n── BLOCKING (a human decides each one; the strip refuses until they are gone) ──");
for (const [k, hits] of Object.entries(r.blocking)) {
  console.log(`  ${k}: ${hits.length}`);
  for (const h of hits) console.log(`    line ${h.line}: ${h.preview}`);
}

const gateOpen = r.effectiveScore.length > 0;
if (!gateOpen) console.log(`\n${EFFECTIVE_SCORE_GATE}`);
console.log(
  r.blockingTotal === 0 && gateOpen
    ? "\nno blocking findings and the effective_score gate is open; strip-dump.mjs may run"
    : `\n${r.blockingTotal} blocking finding(s)${gateOpen ? "" : " plus the effective_score gate"}; ` +
        "decide each, edit the dump by hand, re-run",
);
process.exit(r.blockingTotal === 0 && gateOpen ? 0 : 1);
