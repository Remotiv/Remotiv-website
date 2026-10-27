/**
 * Start the Next.js app in an isolated staging environment.
 *
 *   npm run staging:app
 *
 * The app sees .env.staging and nothing else. See app-isolation.mjs for the
 * mechanism and the @next/env source it rests on. In order:
 *
 *   1. .env.staging must exist; its values are loaded OVER the shell's, so a
 *      production variable exported in the shell cannot win.
 *   2. the same five pure guard checks the seed runs (opt-in phrase, paid and
 *      outbound keys absent, service key not public, ref equals the pin in
 *      git, app URL parity) run here, against the launcher's environment.
 *      Nothing starts if any fails.
 *   3. every variable name any other env file could supply, and every name
 *      the guard requires absent, is locked to "" in the child environment.
 *      Names are read from those files; values are never read.
 *   4. `next dev` is spawned on the port STAGING_BASE_URL names, local only.
 *
 * The identity route then reports from inside the app that every locked name
 * is absent, and the seed and harness refuse the app unless it does.
 *
 * Nothing here prints a value: file names, variable names and a port only.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  childEnv,
  conflictingDevServers,
  envFileNames,
  isolationPlan,
  localPort,
  NEXT_ENV_FILES,
  stagingOverShell,
} from "./app-isolation.mjs";
import { loadPin } from "./guard.mjs";
import { MUST_BE_ABSENT, runPureChecks } from "./guard-checks.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STAGING_FILE = `${ROOT}.env.staging`;

if (!existsSync(STAGING_FILE)) {
  console.error("no .env.staging at the repo root. Write it first: README-steps.md step 7.");
  process.exit(1);
}

const stagingContents = readFileSync(STAGING_FILE, "utf8");
Object.assign(process.env, stagingOverShell(process.env, parseEnv(stagingContents)));
const stagingNames = envFileNames(stagingContents);

// Next 16 has no dev lock and one shared .next/dev per checkout. Another dev
// server here (Commit 10's, for instance) would share compiled assets with
// this one. Refuse rather than race.
const running = conflictingDevServers(
  execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" }),
  ROOT,
);
if (running.length > 0) {
  console.error(
    `another next dev/start is running from this checkout (pid ${running.join(", ")}). Next 16 ` +
      `writes both to .next/dev with no lock, so the two would share compiled assets. Stop it, ` +
      `or run the staging app from a separate checkout. Refusing to start.`,
  );
  process.exit(1);
}

try {
  runPureChecks(process.env, loadPin());
} catch (e) {
  console.error(`staging guard refused the launch: ${e.message}`);
  process.exit(1);
}

const otherFiles = NEXT_ENV_FILES.filter((f) => existsSync(`${ROOT}${f}`));
const otherFileNames = otherFiles.flatMap((f) => envFileNames(readFileSync(`${ROOT}${f}`, "utf8")));
const plan = isolationPlan({
  stagingNames,
  otherFileNames,
  mustBeAbsent: Object.values(MUST_BE_ABSENT).flat(),
});

let port;
try {
  port = localPort(process.env.STAGING_BASE_URL);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

console.log("isolated launch");
console.log(`  .env.staging: ${stagingNames.length} variable(s) loaded, guard checks 1-5 passed`);
console.log(`  other env files present: ${otherFiles.join(", ") || "(none)"}`);
console.log(`  locked to absent in the app (${plan.blank.length}): ${plan.blank.join(", ")}`);
console.log(`  next dev on port ${port}\n`);

const child = spawn(
  process.execPath,
  [`${ROOT}node_modules/next/dist/bin/next`, "dev", "-p", port],
  { cwd: ROOT, env: childEnv({ base: process.env, plan }), stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
