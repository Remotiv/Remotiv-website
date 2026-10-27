/**
 * The isolation plan and the environment it produces, with fabricated names.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * No real file is read. The names below are made up; the property under test
 * is that every name another env file could supply, and every name the guard
 * requires absent, is locked to "" in the child environment, and that the
 * .env.staging values are passed through untouched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  childEnv,
  conflictingDevServers,
  envFileNames,
  ISOLATION_NAMES_VAR,
  isolationPlan,
  localPort,
  stagingOverShell,
} from "./app-isolation.mjs";

const MUST = ["PAID_KEY", "OUTBOUND_TOKEN"];

test("envFileNames returns names only, never values", () => {
  const names = envFileNames('A=1\nB="two words"\n# comment\nC=\n');
  assert.deepEqual(names, ["A", "B", "C"]);
  assert.ok(!JSON.stringify(names).includes("two words"));
});

test("every name another env file could set, and .env.staging does not, is locked", () => {
  const plan = isolationPlan({
    stagingNames: ["NEXT_PUBLIC_SUPABASE_URL", "SHARED"],
    otherFileNames: ["NEXT_PUBLIC_SUPABASE_URL", "SHARED", "REDIS_URL", "OTHER_SECRET"],
    mustBeAbsent: MUST,
  });
  assert.deepEqual(plan.blank, ["OTHER_SECRET", "OUTBOUND_TOKEN", "PAID_KEY", "REDIS_URL"]);
  assert.ok(!plan.blank.includes("SHARED"), ".env.staging's own names are not locked");
  assert.deepEqual(plan.checked, plan.blank, "the app is asked to confirm every locked name");
});

test("a guard-required-absent name is locked even when no file mentions it", () => {
  const plan = isolationPlan({ stagingNames: ["X"], otherFileNames: [], mustBeAbsent: MUST });
  assert.deepEqual(plan.blank, ["OUTBOUND_TOKEN", "PAID_KEY"]);
});

test("childEnv locks each name to the empty string and passes the staging values through", () => {
  const plan = isolationPlan({
    stagingNames: ["NEXT_PUBLIC_SUPABASE_URL"],
    otherFileNames: ["REDIS_URL"],
    mustBeAbsent: MUST,
  });
  const env = childEnv({
    base: { NEXT_PUBLIC_SUPABASE_URL: "https://x.example", PATH: "/bin" },
    plan,
  });
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "https://x.example");
  assert.equal(env.PATH, "/bin");
  for (const n of ["REDIS_URL", "PAID_KEY", "OUTBOUND_TOKEN"]) {
    assert.equal(env[n], "", `${n} must be locked to the empty string, the @next/env lock value`);
    assert.ok(n in env, `${n} must be PRESENT as "", not merely missing: missing is loadable`);
  }
  assert.equal(env.SUPABASE_PROJECT_ENV, "development");
  assert.equal(env[ISOLATION_NAMES_VAR], "OUTBOUND_TOKEN,PAID_KEY,REDIS_URL");
});

test("childEnv does not mutate the base environment", () => {
  const base = { A: "1" };
  childEnv({ base, plan: { blank: ["B"], checked: ["B"] } });
  assert.deepEqual(base, { A: "1" });
});

test("stagingOverShell: the file wins over a conflicting shell variable", () => {
  const out = stagingOverShell(
    { NEXT_PUBLIC_SUPABASE_URL: "https://shell.example", PATH: "/bin" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://staging.example" },
  );
  assert.equal(out.NEXT_PUBLIC_SUPABASE_URL, "https://staging.example");
  assert.equal(out.PATH, "/bin");
});

test("conflictingDevServers finds a next dev from THIS checkout and ignores others", () => {
  const root = "/Users/x/Remotiv-website";
  const ps = [
    "  PID COMMAND",
    `  101 node ${root}/node_modules/next/dist/bin/next dev --port 3000`,
    `  102 next-server (v16.2.6)`,
    `  103 node /Users/x/other-app/node_modules/next/dist/bin/next dev`,
    `  104 node ${root}/node_modules/next/dist/bin/next build`,
    `  105 node ${root}/node_modules/next/dist/bin/next start -p 4000`,
  ].join("\n");
  assert.deepEqual(conflictingDevServers(ps, root), ["101", "105"]);
  assert.deepEqual(conflictingDevServers("  PID COMMAND\n", root), []);
});

/**
 * The precedence rule, proven against the INSTALLED @next/env with fabricated
 * files in a temp directory, not asserted from its source. What app.mjs
 * relies on: a pre-set process value beats .env.local; a value locked to ""
 * is not reloaded from .env.local; .env.local beats .env.development and
 * .env; .env.staging is not read at all.
 */
test("@next/env: process env beats .env.local, a locked empty value stays empty, .env.staging is never read", () => {
  const dir = mkdtempSync(join(tmpdir(), "remotiv-envproof-"));
  writeFileSync(
    join(dir, ".env.local"),
    "PROOF_URL=from_env_local\nPROOF_SECRET=from_env_local\nPROOF_ONLY_LOCAL=from_env_local\n",
  );
  writeFileSync(
    join(dir, ".env.development"),
    "PROOF_URL=from_env_development\nPROOF_DEV=from_env_development\n",
  );
  writeFileSync(join(dir, ".env"), "PROOF_URL=from_dot_env\nPROOF_DOT=from_dot_env\n");
  writeFileSync(join(dir, ".env.staging"), "PROOF_STAGING_ONLY=from_env_staging\n");
  const { loadEnvConfig } = createRequire(import.meta.url)("@next/env");
  process.env.PROOF_URL = "from_process";
  process.env.PROOF_SECRET = "";
  try {
    const r = loadEnvConfig(dir, true, { info() {}, error() {} }, true);
    assert.deepEqual(
      r.loadedEnvFiles.map((f) => f.path),
      [".env.local", ".env.development", ".env"],
      ".env.staging must not be among the files Next reads",
    );
    assert.equal(
      process.env.PROOF_URL,
      "from_process",
      "a pre-set process value must beat every file",
    );
    assert.equal(
      process.env.PROOF_SECRET,
      "",
      "a value locked to '' must not be reloaded from .env.local",
    );
    assert.equal(
      process.env.PROOF_ONLY_LOCAL,
      "from_env_local",
      "an unlocked name IS loaded: the lock is what stops it",
    );
    assert.equal(process.env.PROOF_DEV, "from_env_development");
    assert.equal(process.env.PROOF_DOT, "from_dot_env");
    assert.equal(process.env.PROOF_STAGING_ONLY, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("PROOF_")) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localPort accepts only a local STAGING_BASE_URL", () => {
  assert.equal(localPort("http://localhost:3100"), "3100");
  assert.equal(localPort("http://127.0.0.1"), "3000");
  assert.throws(() => localPort("https://staging.example.com"), /not a local address/);
  assert.throws(() => localPort("not a url"), /not a URL/);
});
