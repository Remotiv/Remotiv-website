/**
 * #24: CV text extraction still works on pdfjs-dist 6.x.
 *
 *   node --test src/app/admin/_components/pdf-text-extract.test.ts
 *
 * extractPdfText (bulk-upload-shared.tsx) runs as shipped, against the real
 * installed pdfjs-dist, on two PDFs built here byte for byte: a one-page CV
 * and a three-page document. The admin bulk upload calls this function; the
 * join-as-talent page carries a private copy of the same loop (plus a 10-page
 * cap) that cannot be imported, so it is covered by this one.
 *
 * What runs in Node and what does not: the browser loads the worker from a
 * bundler URL (`new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs",
 * import.meta.url)`). Node has no bundler, so a resolve hook points that one
 * URL at the real worker file in node_modules, which pdfjs then runs in-process
 * (its "fake worker"). Parsing and text extraction are the same code either
 * way; the Web Worker transport is not exercised here.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pdfjsPkg = require.resolve("pdfjs-dist/package.json");
const WORKER = pathToFileURL(
  pdfjsPkg.replace(/package\.json$/, "legacy/build/pdf.worker.min.mjs"),
).href;
const VERSION = JSON.parse(readFileSync(pdfjsPkg, "utf8")).version;

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith("/pdfjs-dist/legacy/build/pdf.worker.min.mjs")) {
    return { url: ${JSON.stringify(WORKER)}, shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { extractPdfText } = await import("./bulk-upload-shared.tsx");

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
  return new File([Buffer.from(out, "latin1")], "cv.pdf", { type: "application/pdf" });
}

test("the installed pdfjs-dist is the patched 6.x (GHSA-hq66-cqwq-w95j fixed in 6.2.108)", () => {
  const [major, minor] = VERSION.split(".").map(Number);
  assert.ok(major > 6 || (major === 6 && minor >= 2), `pdfjs-dist ${VERSION}`);
});

// Negative control: break the extraction loop (e.g. skip pushing a line) and the lines differ.
test("a one-page CV: every line, in reading order", async () => {
  const text = await extractPdfText(
    makePdf([
      [
        "Ayesha Khan",
        "ayesha.khan@example.invalid",
        "+92 300 0000000",
        "linkedin.com/in/synthetic-ayesha",
        "Senior Backend Engineer (Go, Postgres)",
      ],
    ]),
  );
  assert.deepEqual(text.split("\n"), [
    "Ayesha Khan",
    "ayesha.khan@example.invalid",
    "+92 300 0000000",
    "linkedin.com/in/synthetic-ayesha",
    "Senior Backend Engineer (Go, Postgres)",
  ]);
});

test("a three-page document: every page is read, in order", async () => {
  const text = await extractPdfText(
    makePdf([
      ["Page one heading", "Experience at Synthetic Co"],
      ["Page two heading", "Skills: TypeScript, SQL"],
      ["Page three heading", "References on request"],
    ]),
  );
  assert.deepEqual(text.split("\n"), [
    "Page one heading",
    "Experience at Synthetic Co",
    "Page two heading",
    "Skills: TypeScript, SQL",
    "Page three heading",
    "References on request",
  ]);
});

// Negative control: point either call site back at "pdfjs-dist" (the default build).
test("both call sites load the legacy build, library and worker alike", () => {
  for (const rel of ["./bulk-upload-shared.tsx", "../../join-as-talent/page.tsx"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/, rel);
    assert.match(src, /"pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs"/, rel);
    assert.doesNotMatch(src, /import\("pdfjs-dist"\)|"pdfjs-dist\/build\//, rel);
  }
});

// Negative control: put back `doc.destroy()` (removed in pdfjs 6; tsc fails too).
test("join-as-talent frees the document the pdfjs 6 way", () => {
  const src = readFileSync(new URL("../../join-as-talent/page.tsx", import.meta.url), "utf8");
  assert.match(src, /await doc\.loadingTask\.destroy\(\);/);
  assert.doesNotMatch(src, /await doc\.destroy\(\);/);
});

test("a file that is not a PDF is rejected, not read as empty text", async () => {
  await assert.rejects(
    extractPdfText(new File([Buffer.from("not a pdf")], "cv.pdf", { type: "application/pdf" })),
  );
});
