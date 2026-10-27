/**
 * Playwright, scoped to this directory only.
 *
 *   npx playwright test --config scripts/staging/playwright.config.mjs
 *
 * Deliberately NOT at the repo root. A root config would make `npx playwright
 * test` discover these specs by default, and they are destructive-adjacent
 * (they log in, page through 10,000 rows, and take minutes). They run when
 * someone names this config and not otherwise.
 *
 * ── Why this file loads .env.staging ─────────────────────────
 *
 * The seed runs under `node --env-file=.env.staging`; `playwright test` takes
 * no such flag, so without this the harness process has none of the staging
 * variables and beforeAll throws "STAGING_BASE_URL is not set" before any
 * assertion — which is exactly how the first harness run failed. The config
 * is read in the parent process before workers fork, and workers inherit the
 * environment, so loading here reaches every test. Semantics match
 * `--env-file`: a value already in the shell WINS; the file only fills gaps,
 * so an operator can still override STAGING_BASE_URL for one run. The guard
 * (openStaging, in beforeAll) re-checks identity regardless, so a wrong file
 * cannot smuggle the harness onto the wrong project.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "@playwright/test";

const STAGING_ENV = fileURLToPath(new URL("../../.env.staging", import.meta.url));
if (existsSync(STAGING_ENV)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(STAGING_ENV, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,

  // One worker. Parallel workers would interleave logins and paging against a
  // free-tier instance, and the resulting numbers would describe the contention
  // rather than the queries. Correctness assertions would survive it; the
  // latency column would become actively misleading.
  workers: 1,
  fullyParallel: false,

  // No retries. A pagination defect that appears on one run in three is a
  // finding, and a retry would hide exactly the intermittency that matters —
  // the production measurement behind #23 failed at one boundary in five.
  retries: 0,

  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },

  // Traces and video off by default: these pages render lists of people, and on
  // any run against data that is not synthetic a trace is a recording of it.
  // Turn on only against the seeded staging company.
  use: {
    baseURL: process.env.STAGING_BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
  },

  reporter: [["list"], ["json", { outputFile: "/tmp/remotiv-staging-harness.json" }]],
});
