import "server-only";

/**
 * The checks every CV upload must make, in one place.
 *
 * They were inline in /api/apply, which was the only path that accepted a file
 * from outside. The applicant panel's attach action is the second, and the two
 * must not drift: a panel that quietly accepted 20 MB, or a renamed .exe, would
 * look like it worked right up until the bucket or the extractor refused it —
 * after the row already claimed a CV.
 */

/** Matches the Supabase bucket's own upload limit; a larger file fails there anyway. */
export const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;

/** More than any real CV. Bounds what reaches Postgres and the scorer's context. */
export const MAX_CV_TEXT_LENGTH = 100_000;

export type CvFileCheck =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "too_large" | "not_pdf"; message: string };

/**
 * Size, then magic bytes. THE CONTENT TYPE IS NEVER CONSULTED: `file.type` is
 * whatever the client claimed, and a renamed .html or .exe arrives as
 * application/pdf for the asking. A real PDF opens "%PDF" (25 50 44 46), so
 * the first four bytes are the only claim worth believing.
 *
 * Size is checked BEFORE the body is read, so an oversized upload is refused
 * without being buffered into memory first.
 *
 * `reason` exists because the callers disagree on how to report a refusal: the
 * route needs 413 vs 400, the server action needs neither. Both use `message`.
 */
export async function checkCvFile(file: File): Promise<CvFileCheck> {
  if (file.size > MAX_CV_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: "CV file is too large (max 5 MB)." };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const isPdf =
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46;

  if (!isPdf) {
    return {
      ok: false,
      reason: "not_pdf",
      message: "Please upload a valid PDF file. Other file types are not accepted.",
    };
  }

  return { ok: true, bytes };
}

/** Clamp extracted text before it reaches Postgres or a search blob. */
export function capCvText(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_CV_TEXT_LENGTH ? text.slice(0, MAX_CV_TEXT_LENGTH) : text;
}

/** How long a company may hold an applicant's CV. */
export const CV_RETENTION_MONTHS = 24;

/**
 * The retention date to stamp on a NEW company application.
 *
 * Here rather than at each call site because there are now two paths that
 * create company-owned applications — /api/apply and the applicants panel's
 * add action — and a second literal is how the promise made to a candidate
 * starts depending on which door they came through.
 *
 * Only ever called for company-owned rows. A null cv_delete_after means keep
 * forever, which is correct for Remotiv-owned rows and is the first half of
 * cv-purge's scope guard; callers decide, this only computes. Nothing reads
 * this to derive a date later — the purge reads the stored column — so
 * changing the constant affects future applications and nothing already
 * written.
 */
export function cvRetentionDate(from: Date = new Date()): string {
  const due = new Date(from);
  due.setMonth(due.getMonth() + CV_RETENTION_MONTHS);
  return due.toISOString();
}
