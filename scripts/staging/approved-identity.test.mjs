/**
 * The committed pin is a real hash: BOTH halves, on the file as committed.
 *
 *   node --test scripts/staging/approved-identity.test.mjs
 *
 * ── The test's NAME says why it is red ───────────────────────
 *
 * approved-identity.json ships with a placeholder, and until step 3 of
 * README-steps.md replaces it this test is red. "138 pass, 1 expected failure"
 * is a suite nobody can read at a glance, so the name is computed from the
 * file: while the placeholder is there the name reads IDENTITY NOT CONFIGURED
 * YET and says what to paste where; once a real hash is in, the name reads as
 * the ordinary pin it then is. Fail-closed is right. Do not delete this to make
 * the suite green; do not fill the file with anything but the output of step 3.
 *
 * ── Why both halves, in one assertion ─────────────────────────
 *
 * The test this replaces asserted the pin was STILL the placeholder. Pasting
 * the real hash turned it red, and the tempting fix was to delete it, which
 * would have removed the only static check that a pin exists at all: the
 * eighth false green in this project, and the first walked into knowingly.
 *
 * So the replacement needs two conditions and needs both:
 *
 *   format           ^[0-9a-f]{64}$   the word "todo" FAILS this; a plausible
 *                                      64-hex fake PASSES it
 *   not placeholder                    the shipped file FAILS this; "todo"
 *                                      PASSES it
 *
 * The placeholder is deliberately hex-shaped ("deadbeef" x 8) so that each
 * half is defeated by exactly the input the other half catches, and each can
 * be shown to fire on its own. assertPinIsReal holds both in one function so
 * neither can be removed alone; guard-checks.test.mjs proves each half on
 * fabricated pins; this file applies the pair to the committed file. Nothing
 * here prints the value: a hash is not a secret, but the habit is.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertPinIsReal, PIN_PLACEHOLDER } from "./guard-checks.mjs";

const PIN_PATH = fileURLToPath(new URL("./approved-identity.json", import.meta.url));
const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));

const stillPlaceholder = String(pin.projectRefSha256).toLowerCase() === PIN_PLACEHOLDER;

const NAME = stillPlaceholder
  ? "IDENTITY NOT CONFIGURED YET: approved-identity.json still holds the placeholder. " +
    "Paste the staging project ref's SHA-256 (README-steps.md step 3). RED UNTIL THEN."
  : "approved-identity.json carries a real SHA-256 pin, not the placeholder";

test(NAME, () => {
  assert.equal(
    stillPlaceholder,
    false,
    "the pin is the hex-shaped placeholder: step 3 of README-steps.md has not been done",
  );
  assert.match(
    String(pin.projectRefSha256),
    /^[0-9a-f]{64}$/,
    "the pin is not a lowercase 64-character hex SHA-256",
  );
  // Both halves again, through the one function the guard itself uses, so the
  // file and the runtime cannot disagree about what "usable" means.
  assert.doesNotThrow(() => assertPinIsReal(pin));
  assert.equal(pin.label, "remotiv-staging");
});
