import "server-only";

// pdf-parse v2 (installed: ^2.4.5) exposes a class-based API at the package
// root. The v1 footgun (root import ran a self-test fs.readFileSync) no
// longer applies — v2 is a properly bundled module.
import { PDFParse } from "pdf-parse";

/**
 * Extract plain text from a PDF buffer, server-side. NEVER throws — returns
 * null on any failure (timeout, parse error, encrypted PDF, scanned image-only,
 * oversize). Mirrors the soft-fail contract of `src/lib/cv-extract.ts`.
 *
 * The 3 MB default size guard skips very large PDFs — those are usually
 * image-heavy and rarely yield useful text, and they're the most likely to
 * spike past the function's CPU budget.
 *
 * The 6 s default timeout exists because pdf-parse can hang on pathological
 * PDFs. The route caller still inserts the application row with cv_text=null
 * on timeout — extraction is best-effort.
 */
export async function extractPdfTextServer(
  buffer: Buffer,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<string | null> {
  const maxBytes = opts?.maxBytes ?? 3_000_000;
  if (buffer.length > maxBytes) return null;

  const timeoutMs = opts?.timeoutMs ?? 6000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: buffer });
    const parsePromise = parser.getText();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("pdf_extract_timeout")),
        timeoutMs,
      );
    });

    const result = await Promise.race([parsePromise, timeoutPromise]);
    const text = (result?.text ?? "").trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error("[pdf-text] extraction failed:", err);
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (parser !== null) {
      try {
        await parser.destroy();
      } catch {
        // best-effort cleanup; the worker handle is reaped eventually
      }
    }
  }
}
