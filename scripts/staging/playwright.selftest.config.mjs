/**
 * Playwright config for the network guard's offline self-test ONLY.
 *
 *   npx playwright test --config scripts/staging/playwright.selftest.config.mjs
 *
 * Separate from playwright.config.mjs on purpose: the self-test triggers
 * violations deliberately and must never run under the harness, whose
 * afterEach fails on any violation.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /network-guard\.selftest\.mjs$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: "off", video: "off", screenshot: "off", actionTimeout: 15_000 },
  reporter: [["list"]],
});
