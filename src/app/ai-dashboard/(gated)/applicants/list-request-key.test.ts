/**
 * Selecting or opening an applicant never re-reads the list (Applicants Split,
 * commit 5d).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-request-key.test.ts"
 *
 * The list effect re-reads whenever `request` changes identity. `request` came
 * straight from decoding the whole query string, which also carries the
 * panel's ?applicant= and ?tab=, so every applicant opened, stepped to or
 * selected in the Split panel rebuilt it with the same values and fetched the
 * page again. The client now memoises `request` on listKey. These tests pin
 * the two halves that fix rests on: the panel params never change the key,
 * and every field that reaches the server does.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { decodeListUrl, listKey } = await import("./list-state.ts");

const keyOf = (qs) => listKey(decodeListUrl(new URLSearchParams(qs)).request);
const BASE =
  "stage=applied&job=3f1c2a4e-1111-4222-8333-944445555666&q=ana&flagged=1&sort=newest&page=3";

test("?applicant= and ?tab= never change the request key", () => {
  const k = keyOf(BASE);
  assert.equal(keyOf(`${BASE}&applicant=app-aaaaaa`), k);
  assert.equal(keyOf(`${BASE}&applicant=app-bbbbbb&tab=review`), k);
  assert.equal(keyOf(`applicant=app-aaaaaa&${BASE}&tab=comments`), k, "param order is irrelevant");
  assert.equal(keyOf("applicant=app-aaaaaa"), keyOf(""), "the default page too");
});

test("every field that reaches the server changes it", () => {
  const k = keyOf(BASE);
  for (const [field, qs] of [
    ["stage", BASE.replace("stage=applied", "stage=screening")],
    ["job", BASE.replace("944445555666", "944445555667")],
    ["search", BASE.replace("q=ana", "q=bob")],
    ["flagged", BASE.replace("flagged=1", "flagged=0")],
    ["sort", BASE.replace("sort=newest", "sort=best")],
    ["page", BASE.replace("page=3", "page=4")],
  ]) {
    assert.notEqual(keyOf(qs), k, field);
  }
});

test("the client memoises the request on that key, and the list effect depends on it", () => {
  const src = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
  assert.match(src, /const requestKey = listKey\(urlState\.request\);/);
  assert.match(src, /const request = useMemo\(\(\) => urlState\.request, \[requestKey\]\);/);
  assert.equal(
    (src.match(/= urlState\.request\b/g) ?? []).length,
    0,
    "no bare `= urlState.request` left",
  );
  assert.match(src, /refreshList\(request\);\s*\}, \[request, refreshList\]\);/);
});
