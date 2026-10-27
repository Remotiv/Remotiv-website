/**
 * How the Next.js app is started so that it sees .env.staging and NOTHING else.
 *
 * Pure: names in, environment out. app.mjs is the thin launcher that reads the
 * files and spawns `next dev` with what this returns.
 *
 * ── The risk this exists for ─────────────────────────────────
 *
 * .env.local carries production credentials and `next dev` loads it on every
 * start. The seed proving ITS process is pointed at staging says nothing about
 * the app's process, and a harness driving a browser around a production app
 * would produce numbers that are true statements about the wrong database,
 * over real candidate data.
 *
 * ── The precedence rule, from the installed @next/env, not the docs ──
 *
 * node_modules/@next/env/dist/index.js (16.2.6), processEnv(): a key is taken
 * from a file only when it is undefined in the process environment that
 * existed BEFORE any file was read (`typeof l[t] === "undefined"`, where `l`
 * is a copy of that initial environment). Two consequences, both verified by
 * running that function on fabricated files (README-steps.md step 7):
 *
 *   1. a value already in the process environment wins over every file,
 *      including .env.local;
 *   2. a key set to the EMPTY STRING in the process environment stays the
 *      empty string (replaceProcessEnv re-applies the initial snapshot) and is
 *      NOT reloaded from any file, because its initial type was "string". An
 *      empty string is therefore a lock: "this name stays empty whatever the
 *      files say". The guard and the identity route both read "" as absent,
 *      and every call site in src tests these keys for truthiness.
 *
 * `next dev` forks its server with `env: {...initialEnv}` (cli/next-dev.js),
 * the same pre-file snapshot, so the locks reach the process that serves
 * requests. The launcher uses (1) to make every .env.staging value win and (2)
 * to lock out every name any other env file could supply, plus every name the
 * guard requires absent. The identity route then reports, from inside the
 * running app, that each locked name is absent; proveAppIdentity refuses the
 * app otherwise. A variable in a file is a claim; a response from the server
 * is evidence.
 */

import { parseEnv } from "node:util";

/** Every file @next/env would read for `next dev`, in its load order, plus the other modes. */
export const NEXT_ENV_FILES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
  ".env.production.local",
  ".env.production",
  ".env.test.local",
  ".env.test",
];

/** Carries the locked names into the app, so its identity route can report on them. */
export const ISOLATION_NAMES_VAR = "STAGING_ISOLATION_NAMES";

/** Variable NAMES in an env file. Values are parsed and discarded here. */
export function envFileNames(contents) {
  return Object.keys(parseEnv(contents));
}

/**
 * Which names to lock out of the app: everything another env file could set
 * that .env.staging does not, plus everything the guard requires absent.
 * `checked` is the full list the app will be asked to confirm absent.
 */
export function isolationPlan({ stagingNames, otherFileNames, mustBeAbsent }) {
  const staging = new Set(stagingNames);
  const blank = new Set();
  for (const n of otherFileNames) if (!staging.has(n)) blank.add(n);
  for (const n of mustBeAbsent) blank.add(n);
  const names = [...blank].sort();
  return { blank: names, checked: names };
}

/**
 * The environment `next dev` is spawned with: the launcher's (which already
 * holds .env.staging), every locked name set to "", the app's own development
 * guard satisfied, and the locked list passed through by name.
 */
export function childEnv({ base, plan }) {
  const env = { ...base };
  for (const n of plan.blank) env[n] = "";
  env.SUPABASE_PROJECT_ENV = "development";
  env[ISOLATION_NAMES_VAR] = plan.checked.join(",");
  return env;
}

/**
 * .env.staging over the shell, explicitly.
 *
 * node's --env-file and process.loadEnvFile both let an existing shell
 * variable win. For this launcher that is backwards: a production URL
 * exported in the shell must not beat the staging file. The file wins; the
 * pure guard checks then run over the result, so a file that is itself wrong
 * is still refused.
 */
export function stagingOverShell(shell, staging) {
  return { ...shell, ...staging };
}

/**
 * Other `next dev` servers running from this checkout, from `ps` output.
 *
 * Next 16 writes development output to <distDir>/dev and takes no lock
 * (node_modules/next/dist/server/config.js:1094; no lock file exists). Two
 * dev servers in one checkout would share .next/dev, and one would serve
 * assets the other compiled, with the other's inlined NEXT_PUBLIC_* values.
 * The launcher refuses to start while one is running. The forked worker
 * shows up as "next-server" with no path, so the CLI line is what is matched.
 */
export function conflictingDevServers(psText, root) {
  const needle = `${root.replace(/\/$/, "")}/node_modules/next/dist/bin/next`;
  return String(psText)
    .split("\n")
    .filter((l) => l.includes(needle) && /\bnext\s+(dev|start)\b/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** The port the app must listen on, from STAGING_BASE_URL. Local hosts only. */
export function localPort(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("STAGING_BASE_URL is not a URL");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "STAGING_BASE_URL is not a local address. The launcher can only isolate an app it " +
        "starts itself; a deployed app's environment is set elsewhere.",
    );
  }
  return url.port || "3000";
}
