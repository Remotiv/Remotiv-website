/**
 * The two paged reads whose ESTABLISHED verdicts rest on a total order, pinned
 * to the shipped source.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * This is one of the few places a source assertion is the RIGHT instrument
 * and not a weak substitute for running the code: determinism is a property
 * of the query's shape, and no run can show it (assertions.mjs,
 * assertTotalOrder, says why at length). negative-controls.mjs removes each
 * .order("id") and requires the named test here to go red.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertTotalOrder } from "./assertions.mjs";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const read = (rel) => readFileSync(`${SRC}${rel}`, "utf8");

/** The same two sites the harness reads at run time (harness.spec.mjs, QUERY_ORDER_SITES). */
export const SITES = {
  scoped: { file: "app/ai-dashboard/lib/job-scope.ts", from: '.in("job_id", chunk)' },
  messages: { file: "app/ai-dashboard/(gated)/messages/actions.ts", from: "build(false)" },
};

test("#25: scopedApplicationIds pages under a total order (job-scope.ts)", () => {
  const r = assertTotalOrder(read(SITES.scoped.file), SITES.scoped);
  assert.deepEqual(r.keys, ["id"], "the allow-list read orders by id and nothing else");
});

test("#23: the messages list pages under a total order (messages/actions.ts)", () => {
  const r = assertTotalOrder(read(SITES.messages.file), SITES.messages);
  assert.deepEqual(r.keys, ["created_at", "id"], "newest first, then id to break the tie");
});
