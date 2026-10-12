/**
 * An in-memory S3 bucket for the recording-import tests, with the same
 * interface as src/lib/storage-s3.ts's RecordingStore and the multipart rules
 * the import depends on:
 *
 *   uploadPart       replaces a part uploaded again under the same number;
 *                    NoSuchUpload (404) once the upload is gone
 *   listParts        null once the upload is gone
 *   completeUpload   every part but the last at least 5 MiB (EntityTooSmall
 *                    otherwise), ETags must match; the parts are assembled in
 *                    order and the upload ends. 'missing' when it is gone
 *   abortUpload      ends the upload; a repeat is a no-op
 *
 * Every call is logged on `calls` as [method, ...args] (bodies by length).
 * Scripting:
 *   failNext(method, error, { after })  the next call throws `error`; with
 *                    after: true it does its work first, as a lost response
 *   before(method, fn)  runs `fn()` once, at the start of the next call
 *   expireUploads()  every unfinished upload disappears, as Supabase drops
 *                    them after a day
 *
 * Test-only. Nothing in the application imports this.
 */
import { createHash } from "node:crypto";

const MIN_PART = 5 * 1024 * 1024;

export function fakeS3() {
  const objects = new Map();
  const uploads = new Map();
  const calls = [];
  const failures = [];
  const hooks = new Map();
  let seq = 0;

  async function enter(method, args) {
    calls.push([method, ...args]);
    const hook = hooks.get(method);
    if (hook) {
      hooks.delete(method);
      await hook();
    }
    const i = failures.findIndex((f) => f.method === method);
    if (i < 0) return null;
    const [f] = failures.splice(i, 1);
    if (!f.after) throw f.error;
    return f.error;
  }
  const finish = (lost, value) => {
    if (lost) throw lost;
    return value;
  };
  const noSuchUpload = () =>
    Object.assign(new Error("NoSuchUpload"), { status: 404, code: "NoSuchUpload" });

  return {
    objects,
    uploads,
    calls,
    count: (method) => calls.filter((c) => c[0] === method).length,
    /** The largest part body ever sent: the import's memory bound. */
    maxPartBytes: () => Math.max(0, ...calls.filter((c) => c[0] === "uploadPart").map((c) => c[3])),
    failNext(method, error, { after = false } = {}) {
      failures.push({ method, error, after });
    },
    before(method, fn) {
      hooks.set(method, fn);
    },
    expireUploads() {
      uploads.clear();
    },

    async headObject(key) {
      const lost = await enter("headObject", [key]);
      const o = objects.get(key);
      return finish(lost, o ? { size: o.length } : null);
    },
    async readHead(key, length) {
      const lost = await enter("readHead", [key, length]);
      const o = objects.get(key);
      if (!o) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
      return finish(lost, o.slice(0, length));
    },
    async findUploads(key) {
      const lost = await enter("findUploads", [key]);
      const ids = [...uploads.entries()]
        .filter(([, u]) => u.key === key)
        .sort((a, b) => a[1].initiated - b[1].initiated)
        .map(([id]) => id);
      return finish(lost, ids);
    },
    async createUpload(key, contentType) {
      const lost = await enter("createUpload", [key, contentType]);
      const id = `upload-${++seq}`;
      uploads.set(id, { key, contentType, parts: new Map(), initiated: seq });
      return finish(lost, id);
    },
    async listParts(key, uploadId) {
      const lost = await enter("listParts", [key, uploadId]);
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) return finish(lost, null);
      const parts = [...u.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, p]) => ({ partNumber, size: p.bytes.length, etag: p.etag }));
      return finish(lost, parts);
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const lost = await enter("uploadPart", [key, uploadId, body.byteLength, partNumber]);
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw noSuchUpload();
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      u.parts.set(partNumber, { bytes: Uint8Array.from(body), etag });
      return finish(lost, etag);
    },
    async completeUpload(key, uploadId, parts) {
      const lost = await enter("completeUpload", [key, uploadId, parts.length]);
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) return finish(lost, "missing");
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const chunks = sorted.map((p, i) => {
        const stored = u.parts.get(p.partNumber);
        if (!stored || stored.etag !== p.etag) throw new Error("InvalidPart");
        if (i < sorted.length - 1 && stored.bytes.length < MIN_PART)
          throw new Error("EntityTooSmall");
        return stored.bytes;
      });
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      objects.set(key, out);
      uploads.delete(uploadId);
      return finish(lost, "completed");
    },
    async abortUpload(key, uploadId) {
      const lost = await enter("abortUpload", [key, uploadId]);
      if (uploads.get(uploadId)?.key === key) uploads.delete(uploadId);
      return finish(lost, undefined);
    },
    async deleteObject(key) {
      const lost = await enter("deleteObject", [key]);
      objects.delete(key);
      return finish(lost, undefined);
    },
  };
}
