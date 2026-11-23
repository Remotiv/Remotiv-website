/**
 * The company's applicant delete, as one source text, for the tests that pin
 * its code by reading it (#69 step 3).
 *
 * completeDeletion moved, unchanged, from the applicants actions into
 * lib/applicant-deletion-complete.ts. The source pins written before that
 * read actions.ts and slice from "export async function deleteApplication("
 * to "// ── Team comments", where completeDeletion and its constants used to
 * sit. This returns actions.ts with the moved module inlined at that spot, so
 * every pin reads the same code path it read before, with no assertion
 * changed. The two files are read as they are on disk, nothing else.
 *
 * Test-only. Nothing in the application imports this.
 */
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MARKER = "// ── Team comments";

export function companyDeleteSource() {
  const actions = read("../app/ai-dashboard/(gated)/applicants/actions.ts");
  const moved = read("../lib/applicant-deletion-complete.ts");
  if (actions.split(MARKER).length !== 2) {
    throw new Error(
      "companyDeleteSource: the Team comments marker is not in actions.ts exactly once",
    );
  }
  return actions.replace(MARKER, `${moved}\n${MARKER}`);
}
