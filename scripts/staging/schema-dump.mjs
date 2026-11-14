/**
 * Where the production schema dump lives, and whether it is fit to read.
 *
 * The one place every reader resolves it: seed.mjs, constraints.test.mjs,
 * seed-plan.test.mjs and negative-controls.mjs. It used to default to /tmp,
 * which macOS clears, and a cleared /tmp turned two baseline suites red and so
 * blocked every negative control (#62). It now defaults to a git-ignored folder
 * beside this file, and REMOTIV_SCHEMA_DUMP still overrides it.
 *
 * A dump that is missing, outdated, carries data, or carries a credential is a
 * REFUSAL with one message, never a skip: a reader that silently stops reading
 * its source agrees with anything.
 *
 * ── What "outdated" means here, and what it cannot mean ───────
 *
 * The dump must contain every object in REQUIRED_OBJECTS: the one the newest
 * applied migration creates, plus the structures the baseline suites read. A
 * dump that passes is NOT proven to match production. It was taken at some
 * moment, and anything applied by hand since (several tables were) is invisible
 * offline. Only a fresh dump proves parity; this check only refuses a dump that
 * is provably older than the repo.
 *
 * Nothing here prints dump content. Findings name a class and line numbers.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: this checkout's path contains spaces.
export const DEFAULT_SCHEMA_DUMP_PATH = fileURLToPath(
  new URL(".schema/prod-schema.sql", import.meta.url),
);
export const SCHEMA_DUMP_PATH = process.env.REMOTIV_SCHEMA_DUMP ?? DEFAULT_SCHEMA_DUMP_PATH;

/** README-steps.md step 1. The service name carries no credential; ~/.pg_service.conf and ~/.pgpass do. */
export const REGENERATE_COMMAND = [
  "mkdir -p scripts/staging/.schema",
  "PGSERVICE=remotiv-prod pg_dump \\",
  "  --schema-only \\",
  "  --no-owner \\",
  "  --no-publications \\",
  "  --no-subscriptions \\",
  "  --schema=public \\",
  "  --file=scripts/staging/.schema/prod-schema.sql",
].join("\n");

const communicationLogsColumns = (text) =>
  text.match(/CREATE TABLE public\.communication_logs \(\n([\s\S]*?)\n\);/)?.[1] ?? "";

/*
 * Deliberately NOT parseCheckEnums from constraints.mjs: that parser is a
 * negative-control target, and a preflight that depended on it would refuse the
 * dump whenever a control reverted it, so the control would go red for the
 * preflight's reason instead of its own test's.
 */
const hasCommunicationLogsCheck = (text, column) => {
  const check = `CONSTRAINT \\S+ CHECK \\(\\(${column} = ANY`;
  return (
    new RegExp(check).test(communicationLogsColumns(text)) ||
    new RegExp(`ALTER TABLE ONLY public\\.communication_logs\\s+ADD ${check}`).test(text)
  );
};

/** Each `found(text)` is true when the dump carries the object. */
export const REQUIRED_OBJECTS = [
  {
    what: "communication_logs.attempt_started_at timestamp with time zone",
    why: "migration 058 creates it, and 058 is the newest applied migration (14 Nov 2026)",
    found: (text) =>
      /^\s+attempt_started_at timestamp with time zone\b/m.test(communicationLogsColumns(text)),
  },
  {
    what: "the communication_logs event and status CHECK constraints",
    why: "read by constraints.test.mjs and the seed's enum preflight",
    found: (text) =>
      hasCommunicationLogsCheck(text, "event") && hasCommunicationLogsCheck(text, "status"),
  },
  {
    what: "effective_score as a GENERATED ALWAYS AS column",
    why: "the restore gate in README-steps.md step 2",
    found: (text) => /effective_score\b[^\n]*GENERATED ALWAYS AS/.test(text),
  },
];

/** Blanks every dollar-quoted body, keeping its newlines so line numbers survive. */
const blankFunctionBodies = (text) =>
  text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, (m) => m.replace(/[^\n]/g, " "));

/** Statements only a data dump writes. Matched at line start, outside function bodies. */
const DATA_PATTERNS = [
  /^COPY\s+\S+[^\n]*FROM stdin;/,
  /^INSERT INTO\s/,
  /^SELECT pg_catalog\.setval\(/,
  /^-- Data for Name: /,
];

/** Credential shapes. A hit refuses the dump; only the line number is ever reported. */
const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"]+@/i,
  /\b(sk_live|sk_test|rk_live|sb_secret)_[A-Za-z0-9]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\b(password|passwd|secret|api_key|apikey|token)\s*:?=\s*'[^']{8,}'/i,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const linesMatching = (lines, patterns) =>
  lines.flatMap((line, i) => (patterns.some((re) => re.test(line)) ? [i + 1] : []));

const lineList = (nums) =>
  `line${nums.length === 1 ? "" : "s"} ${nums.slice(0, 10).join(", ")}${nums.length > 10 ? `, and ${nums.length - 10} more` : ""}`;

/**
 * Pure: the problems (refusals) and warnings for one dump's text.
 * Messages carry classes and line numbers, never matched content.
 */
export function inspectSchemaDump(text) {
  const problems = [];
  const warnings = [];

  const missing = REQUIRED_OBJECTS.filter((o) => !o.found(text));
  for (const o of missing) problems.push(`OUTDATED: missing ${o.what}; ${o.why}.`);

  const structural = blankFunctionBodies(text).split("\n");
  const dataLines = linesMatching(structural, DATA_PATTERNS);
  if (dataLines.length > 0) {
    problems.push(
      `DATA: ${dataLines.length} data statement(s) at ${lineList(dataLines)}. The dump must be ` +
        "structure only: --schema-only, never --data-only, --inserts or a full dump. Delete it and take it again.",
    );
  }

  const lines = text.split("\n");
  const credentialLines = linesMatching(lines, CREDENTIAL_PATTERNS);
  if (credentialLines.length > 0) {
    problems.push(
      `CREDENTIAL: credential-shaped text at ${lineList(credentialLines)}. Not printed. Inspect those ` +
        "lines locally; do not paste them anywhere, and do not use this dump until they are understood.",
    );
  }

  const emailLines = linesMatching(lines, [EMAIL]);
  if (emailLines.length > 0) {
    warnings.push(
      `email-shaped text at ${lineList(emailLines)} (not printed). A schema can legitimately name an ` +
        "address in a policy or function; confirm it is not personal data before sharing anything from this file.",
    );
  }

  return { problems, warnings };
}

function refusalMessage(path, problems) {
  return [
    `REFUSED: the production schema dump at ${path} cannot be used.`,
    "",
    ...problems.map((p) => `  - ${p}`),
    "",
    "Passing this check does not prove the dump matches production: only a fresh dump does.",
    "",
    "Take a fresh structure-only dump as scripts/staging/README-steps.md step 1 describes, from",
    "the repository root. The connection comes from ~/.pg_service.conf and the password from",
    "~/.pgpass, so nothing secret is on the command line:",
    "",
    REGENERATE_COMMAND.replace(/^/gm, "  "),
    "",
    `It must land at ${DEFAULT_SCHEMA_DUMP_PATH}, which is git-ignored and never committed,`,
    "or set REMOTIV_SCHEMA_DUMP to wherever it is.",
  ].join("\n");
}

/** Reads and inspects the dump. `refusal` is null when it is fit to read. */
export function checkSchemaDump(path = SCHEMA_DUMP_PATH) {
  if (!existsSync(path)) {
    return {
      refusal: refusalMessage(path, ["MISSING: no file is there."]),
      warnings: [],
      text: null,
    };
  }
  const text = readFileSync(path, "utf8");
  const { problems, warnings } = inspectSchemaDump(text);
  return { refusal: problems.length > 0 ? refusalMessage(path, problems) : null, warnings, text };
}

let warned = false;

/** The dump's text, or a throw carrying the full refusal. Warnings print once per process. */
export function loadSchemaDump(path = SCHEMA_DUMP_PATH) {
  const { refusal, warnings, text } = checkSchemaDump(path);
  if (refusal) throw new Error(refusal);
  if (!warned) {
    for (const w of warnings) console.warn(`schema dump warning: ${w}`);
    warned = true;
  }
  return text;
}
