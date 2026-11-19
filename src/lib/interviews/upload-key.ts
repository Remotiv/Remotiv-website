import { randomBytes } from "node:crypto";

/**
 * One storage key per async answer upload (#50, QA-SAFETY-40 C-1).
 *
 * A signed upload link lives 2 hours and cannot be revoked. When every
 * recording of a question went to the same key with upsert, a saved link
 * could replace an answer after it was confirmed or submitted. Now each link
 * is for a fresh key, signed upsert:false: once that key holds a file, no
 * link can write it again, and a re-record is a new key the confirm step
 * points the answer at.
 */
export function newUploadKey(): string {
  return randomBytes(16).toString("hex");
}

/** 32 lowercase hex characters, exactly what newUploadKey makes; nothing else reaches a path. */
export function isUploadKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** Said when a page from before #50 tries to record an answer again. */
export const RELOAD_TO_RERECORD = "Please reload this page to record this answer again.";
