/**
 * #74 part 2: a single-row action on the Admin Talent page no longer
 * re-renders the page, which re-read every profile. The dashboard keeps its
 * own list instead. /browse-talent and /admin/applications are still
 * revalidated where they were.
 *
 *   node --test src/app/admin/talent/talent-refresh.test.ts
 *
 * The four server actions run as shipped against a fake database, with every
 * revalidatePath call recorded (admin-actions-test-hook). The dashboard's
 * side is pinned from source: no full refresh anywhere, and each handler still
 * updates and rolls back its own list. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fakeService } from "../../../test-support/fake-postgrest.mjs";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../../test-support/admin-actions-test-hook.mjs", import.meta.url));

const A = await import("./actions.ts");

const ID = "t0000000-0000-0000-0000-00000000a001";
globalThis.__adminCtxForTests = { userId: "admin-1", role: "super_admin" };

/** writes: "ok" | "fail". Reads answer a claimed, never-approved profile. */
function world(writes) {
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (op === "select") {
      return {
        data: { approved_at: null, user_id: "u0000000-0000-0000-0000-000000000001" },
        error: null,
      };
    }
    if (table === "notifications") return { data: null, error: null };
    return writes === "fail"
      ? { data: null, error: { message: "Synthetic write failure." } }
      : { data: null, error: null };
  });
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__revalidatedPaths = [];
  return service;
}

const ACTIONS = {
  "status: approve": {
    run: () => A.updateTalentStatus(ID, "approved"),
    revalidates: ["/browse-talent"],
    notifies: true,
  },
  "flag: shortlist": {
    run: () => A.setTalentFlag(ID, "shortlisted", true),
    revalidates: ["/browse-talent"],
    notifies: true,
  },
  "flag: archive": {
    run: () => A.setTalentFlag(ID, "archived", true),
    revalidates: ["/browse-talent", "/admin/applications"],
    notifies: false,
  },
  delete: {
    run: () => A.deleteTalentProfile(ID),
    revalidates: ["/admin/applications"],
    notifies: false,
  },
  note: {
    run: () => A.saveTalentNote(ID, "  A new note.  "),
    revalidates: [],
    notifies: false,
  },
};

test("R1. no single-row action revalidates /admin/talent; the other surfaces are revalidated exactly as before", async () => {
  for (const [name, a] of Object.entries(ACTIONS)) {
    const service = world("ok");
    const out = await a.run();
    assert.equal(out.success, true, name);
    assert.ok(
      !globalThis.__revalidatedPaths.includes("/admin/talent"),
      `${name}: re-renders the Talent page`,
    );
    assert.deepEqual(globalThis.__revalidatedPaths, a.revalidates, name);
    // Notifications unchanged: the candidate is still told where they were.
    const notified = service.queries.some((q) => q.table === "notifications");
    assert.equal(notified, a.notifies, `${name}: notification`);
  }
});

test("R2. a failed write still returns the same error and revalidates nothing", async () => {
  for (const [name, a] of Object.entries(ACTIONS)) {
    world("fail");
    const out = await a.run();
    assert.deepEqual(out, { success: false, error: "Synthetic write failure." }, name);
    assert.deepEqual(globalThis.__revalidatedPaths, [], name);
  }
});

test("R3. the note is stored by trimToNull, the rule the dashboard mirrors", async () => {
  const service = world("ok");
  await A.saveTalentNote(ID, "  A new note.  ");
  const update = service.queries.find((q) => q.calls[0][0] === "update");
  assert.deepEqual(update.calls[0][1], { notes: "A new note." });
  const blank = world("ok");
  await A.saveTalentNote(ID, "   ");
  assert.deepEqual(blank.queries.find((q) => q.calls[0][0] === "update").calls[0][1], {
    notes: null,
  });
});

/* ── the dashboard, from source ─────────────────────────────────── */

const dashboard = readFileSync(
  new URL("../_components/talent-dashboard.tsx", import.meta.url),
  "utf8",
);
/** Code only: comments may name what the code must not do. */
const code = dashboard.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const fn = (name) => {
  const start = code.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return code.slice(start, code.indexOf("\n  }\n", start));
};

test("D1. the Talent page has no full refresh left: no router, no router.refresh()", () => {
  assert.doesNotMatch(code, /router\.refresh\(/);
  assert.doesNotMatch(code, /useRouter/);
});

test("D2. status, flag and delete still update the list themselves, and status and flag still roll back on failure", () => {
  const status = fn("handleSetStatus");
  assert.match(
    status,
    /setProfiles\(\(prev\) =>\s*prev\.map\(\(p\) => \(p\.id === profile\.id \? \{ \.\.\.p, \.\.\.optimisticPatch \} : p\)\)/,
  );
  assert.match(
    status,
    /\} else \{\s*setProfiles\(\(prev\) => prev\.map\(\(p\) => \(p\.id === profile\.id \? profile : p\)\)\);/,
  );
  const flag = fn("handleSetFlag");
  assert.match(flag, /\{ \.\.\.p, \.\.\.optimistic \}/);
  assert.match(
    flag,
    /\} else \{\s*setProfiles\(\(prev\) => prev\.map\(\(p\) => \(p\.id === profile\.id \? profile : p\)\)\);/,
  );
  const del = fn("handleDelete");
  assert.match(
    del,
    /if \(result\.success\) \{\s*setProfiles\(\(prev\) => prev\.filter\(\(p\) => p\.id !== profile\.id\)\);/,
  );
});

test("D3. the note goes into the list only after a successful save, through withSavedNote", () => {
  const save = fn("handleSaveNote");
  const success = save.slice(save.indexOf("if (result.success) {"), save.indexOf("} else {"));
  const failure = save.slice(save.indexOf("} else {"));
  assert.match(success, /onNoteSaved\(note\);/);
  assert.doesNotMatch(failure, /onNoteSaved/);
  assert.match(
    code,
    /onNoteSaved=\{\(note\) =>\s*setProfiles\(\(prev\) => withSavedNote\(prev, openProfile\.id, note\)\)\s*\}/,
  );
});
