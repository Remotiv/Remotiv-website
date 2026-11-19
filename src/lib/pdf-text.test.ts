/**
 * #24b: server-side CV text extraction on unpdf 2.2.1 (bundles pdfjs 6.5.438,
 * outside GHSA-hq66-cqwq-w95j).
 *
 *   node --test src/lib/pdf-text.test.ts
 *
 * extractPdfTextServer runs as shipped, against the real installed unpdf, on
 * PDFs built here byte for byte. The one change in behaviour this upgrade
 * brings is line breaks: unpdf 1.6.2 flattened a merged document to one line
 * of spaces, unpdf 1.7.0+ keeps each text line. The CV scorer's quote gate
 * (verifyEvidence) is run against both shapes so a quote that spans a line
 * break is proven to verify either way.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/cv-scoring-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { extractPdfTextServer } = await import("./pdf-text.ts");
const { verifyEvidence } = await import("./ai/cv-scoring.ts");
const unpdf = await import("unpdf");
const bundledPdfjs = await import("unpdf/pdfjs");

// extractPdfTextServer logs every failure; the assertions are on its result.
console.error = () => {};

/** A minimal, valid PDF: one page per entry, each line its own text run. */
function makePdf(pages) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids = [];
  for (const lines of pages) {
    const stream = lines
      .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${esc(l)}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ONE_PAGE = [
  "Ayesha Khan",
  "ayesha.khan@example.invalid",
  "+92 300 0000000",
  "Senior Backend Engineer (Go, Postgres)",
  "Led global teams of 25+",
  "across three regions",
];
const THREE_PAGES = [
  ["Page one heading", "Experience at Synthetic Co"],
  ["Page two heading", "Skills: TypeScript, SQL"],
  ["Page three heading", "References on request"],
];

/**
 * pdfjs in the form getDocument sees it. `params` rewrites what unpdf passes,
 * `seen` records it. Installed through unpdf's own definePDFJSModule, so the
 * shipped extractPdfTextServer picks it up with no change to its source.
 */
function wrapPdfjs({ params = (p) => p, seen = [] } = {}) {
  unpdf.definePDFJSModule(() => ({
    ...bundledPdfjs,
    getDocument: (p) => {
      const final = params(p);
      seen.push(final);
      return bundledPdfjs.getDocument(final);
    },
  }));
  return seen;
}

test("unpdf bundles a patched pdfjs (GHSA-hq66-cqwq-w95j fixed in 6.2.108)", () => {
  const [major, minor, patch] = bundledPdfjs.version.split(".").map(Number);
  const atLeast = major > 6 || (major === 6 && (minor > 2 || (minor === 2 && patch >= 108)));
  assert.ok(atLeast, `unpdf bundles pdfjs ${bundledPdfjs.version}`);
});

// Negative control: unpdf 1.6.2 joins the merged document with spaces, one line.
test("a one-page CV: every line, in reading order", async () => {
  const r = await extractPdfTextServer(makePdf([ONE_PAGE]));
  assert.equal(r.status, "completed");
  assert.equal(r.error, null);
  assert.deepEqual(r.text.split("\n"), ONE_PAGE);
});

test("a three-page document: every page is read, in order", async () => {
  const r = await extractPdfTextServer(makePdf(THREE_PAGES));
  assert.equal(r.status, "completed");
  assert.deepEqual(r.text.split("\n").filter(Boolean), THREE_PAGES.flat());
});

test("a file that is not a PDF fails as parse_error, never as empty text", async () => {
  const r = await extractPdfTextServer(Buffer.from("not a pdf"));
  assert.deepEqual(r, { text: null, status: "failed", error: "parse_error" });
});

test("an oversize file is skipped before unpdf is touched", async () => {
  const r = await extractPdfTextServer(makePdf([ONE_PAGE]), { maxBytes: 10 });
  assert.deepEqual(r, { text: null, status: "skipped", error: "oversize" });
});

/**
 * The CV scorer keeps a model's quote only if it is found in cv_text after
 * whitespace is collapsed. Rows extracted on unpdf 1.6.2 are one line; rows
 * extracted from now on keep line breaks. A quote across a break must verify
 * against both, and a fabricated one must fail against both.
 */
test("CV quote gate: a quote across a line break verifies on old (flat) and new text", async () => {
  const r = await extractPdfTextServer(makePdf([ONE_PAGE]));
  const fresh = r.text;
  assert.ok(fresh.includes("teams of 25+\nacross three"), "the new text really has the break");
  // What unpdf 1.6.2 stored for the same PDF (measured before the upgrade).
  const flat = ONE_PAGE.join(" ");

  const across = { claim: "leads large teams", quote: "teams of 25+ across three regions" };
  const asWritten = { claim: "leads large teams", quote: "teams of 25+\nacross three regions" };
  const inLine = { claim: "backend", quote: "Senior Backend Engineer (Go, Postgres)" };
  const fabricated = { claim: "leads large teams", quote: "teams of 250+ across five regions" };

  for (const [label, cvText] of [
    ["flat (1.6.2)", flat],
    ["line breaks (2.2.1)", fresh],
  ]) {
    const out = verifyEvidence([across, asWritten, inLine, fabricated], cvText);
    assert.deepEqual(
      out.verified.map((e) => e.quote),
      [across.quote, asWritten.quote, inLine.quote],
      label,
    );
    assert.deepEqual(
      out.dropped.map((e) => e.quote),
      [fabricated.quote],
      label,
    );
  }
});

/**
 * unpdf 2 points pdfjs at pdfjs-dist's standard_fonts/ and cmaps/ on disk.
 * If a deploy leaves those files out, text must still come back. Both URLs
 * go to an empty directory here; the CV uses Helvetica, a standard font
 * pdfjs would otherwise load from that directory.
 */
test("text still comes back with standard fonts and CMaps unavailable", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pdf-text-nofonts-"));
  try {
    assert.deepEqual(readdirSync(empty), []);
    const emptyUrl = `${pathToFileURL(empty).href}/`;
    const seen = wrapPdfjs({
      params: (p) => ({ ...p, standardFontDataUrl: emptyUrl, cMapUrl: emptyUrl }),
    });
    const r = await extractPdfTextServer(makePdf([ONE_PAGE]));
    assert.equal(seen.length, 1, "the shipped function went through the wrapped pdfjs");
    assert.equal(seen[0].standardFontDataUrl, emptyUrl);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.text.split("\n"), ONE_PAGE);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    wrapPdfjs();
  }
});

/**
 * unpdf 1.6.2 passed isEvalSupported: false to stop pdfjs compiling PDF
 * PostScript functions with `new Function`. pdfjs 6.5 removed that compiler
 * and the option with it, and unpdf 2.2.1 no longer passes it. The guarantee
 * now is that no code-generation path exists in anything unpdf ships, and that
 * nothing here asks for one.
 */
// Negative control: pass isEvalSupported: true from pdf-text.ts and this goes red.
test("no eval: nothing enables it, and unpdf's pdfjs contains no code-generation path", async () => {
  const seen = wrapPdfjs();
  const r = await extractPdfTextServer(makePdf([ONE_PAGE]));
  assert.equal(r.status, "completed");
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0].isEvalSupported, true);

  const dist = createRequire(import.meta.url)
    .resolve("unpdf")
    .replace(/index\.mjs$/, "");
  const files = readdirSync(dist).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.includes("pdfjs.mjs"), `scanned ${files.length} files`);
  for (const f of files) {
    const src = readFileSync(join(dist, f), "utf8");
    assert.doesNotMatch(src, /new Function\(|[^\w.]eval\(|isEvalSupported/, f);
  }
});

test("package.json pins unpdf exactly", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies.unpdf, "2.2.1");
  // unpdf's exports map does not expose package.json, so read it off disk.
  const unpdfDir = createRequire(import.meta.url)
    .resolve("unpdf")
    .replace(/dist\/index\.mjs$/, "");
  const installed = JSON.parse(readFileSync(`${unpdfDir}package.json`, "utf8")).version;
  assert.equal(installed, "2.2.1");
});
