import "server-only";

/**
 * Extract plain text from a PDF buffer, server-side, using `unpdf` — a
 * serverless-safe pdfjs distribution with no worker file (unlike pdf-parse,
 * whose worker resolution broke on Vercel). NEVER throws — every failure path
 * resolves to a `PdfTextResult` so the caller can persist a `cv_text_status`
 * row without risking a 500.
 *
 * Mirrors the soft-fail style of `src/lib/cv-extract.ts`. The 3 MB default
 * size guard skips very large PDFs (image-heavy CVs that yield little useful
 * text and are most likely to spike past the function CPU budget). The 6 s
 * default timeout exists because pathological PDFs can hang inside pdfjs.
 *
 * unpdf is imported dynamically INSIDE the try so even a module-load failure
 * is caught and surfaced as `{ status: "failed", error: "parse_error" }`
 * rather than poisoning the route at import time — the exact failure mode
 * that broke the prior pdf-parse attempt on Vercel.
 */
export type PdfTextResult = {
  text: string | null;
  status: "completed" | "failed" | "skipped";
  error: string | null;
};

/**
 * Strip characters Postgres refuses in text/jsonb. U+0000 (NUL) is the
 * primary offender — it survives PDF extraction and causes SQLSTATE 22P05
 * "unsupported Unicode escape sequence" on INSERT. C0 controls other than
 * TAB (U+0009), LF (U+000A) and CR (U+000D) go too; they are never
 * meaningful in extracted CV text and only cause parser/log noise
 * downstream.
 *
 * Length-changing on purpose — apply AFTER any length validation so a
 * shorter sanitized value doesn't sneak past a rejection threshold.
 *
 * Built with RegExp+string escapes rather than a regex literal so no literal
 * control character ever appears in this source file.
 */
const NUL_RE = new RegExp("\\u0000", "g");
const C0_RE = new RegExp(
  "[\\u0001-\\u0008\\u000B\\u000C\\u000E-\\u001F]",
  "g",
);

export function stripInvalidPgChars(s: string): string {
  return s.replace(NUL_RE, "").replace(C0_RE, "");
}

export async function extractPdfTextServer(
  buffer: Buffer,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<PdfTextResult> {
  const maxBytes = opts?.maxBytes ?? 3_000_000;
  if (buffer.length > maxBytes) {
    return { text: null, status: "skipped", error: "oversize" };
  }

  const timeoutMs = opts?.timeoutMs ?? 6000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Dynamic import: a module-load failure here is caught by this same
    // try/catch instead of crashing the route at module-evaluation time.
    const { extractText, getDocumentProxy } = await import("unpdf");

    const data = new Uint8Array(buffer);

    const extractPromise = (async () => {
      const doc = await getDocumentProxy(data);
      return extractText(doc, { mergePages: true });
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("pdf_extract_timeout")),
        timeoutMs,
      );
    });

    const result = await Promise.race([extractPromise, timeoutPromise]);
    // unpdf with mergePages:true returns text as a string. Handle the array
    // shape defensively in case a future version flips the default or the
    // option is ignored.
    const rawText = Array.isArray(result?.text)
      ? result.text.join("\n")
      : (result?.text ?? "");
    // Sanitize at the extraction boundary so every consumer of this text is
    // Postgres-safe. Trim after strip: a text of nothing but NUL bytes should
    // report `empty`, not `completed` with an empty string.
    const clean = stripInvalidPgChars(rawText).trim();
    if (clean.length === 0) {
      return { text: null, status: "failed", error: "empty" };
    }
    return { text: clean, status: "completed", error: null };
  } catch (err) {
    console.error("[pdf-text] extraction failed:", err);
    const message = err instanceof Error ? err.message : "";
    const tag = message === "pdf_extract_timeout" ? "timeout" : "parse_error";
    return { text: null, status: "failed", error: tag };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
