/**
 * The real store (src/lib/storage-s3.ts) against a local HTTP server that
 * answers ListParts the way Supabase Storage does: PartNumber, LastModified
 * and ETag, no Size. Nothing leaves the machine; the keys are fake.
 *
 *   node --test src/lib/storage-s3.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
// storage-s3.ts imports "server-only", which only resolves inside Next.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createRecordingStore } = await import("./storage-s3.ts");

/** ListPartsResult with these parts; a part's Size element only when it has one. */
function listPartsXml(parts) {
  const body = parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.n}</PartNumber><LastModified>2026-10-15T11:07:10.000Z</LastModified><ETag>"${p.etag}"</ETag>${
          p.size === undefined ? "" : `<Size>${p.size}</Size>`
        }</Part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>final-interview-recordings</Bucket><Key>co/fi/rec.mp4</Key><UploadId>up-1</UploadId><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${body}</ListPartsResult>`;
}

/** The store, pointed at a local server that answers every request with `xml`. */
async function storeAnswering(xml) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(xml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = createRecordingStore({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    region: "ap-northeast-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    bucket: "final-interview-recordings",
  });
  return { store, requests, close: () => new Promise((r) => server.close(r)) };
}

test("Supabase-style ListParts (no Size): each part parses with size null, never 0", async () => {
  const s = await storeAnswering(
    listPartsXml([
      { n: 1, etag: "aaa" },
      { n: 2, etag: "bbb" },
    ]),
  );
  try {
    const parts = await s.store.listParts("co/fi/rec.mp4", "up-1");
    assert.deepEqual(parts, [
      { partNumber: 1, size: null, etag: '"aaa"' },
      { partNumber: 2, size: null, etag: '"bbb"' },
    ]);
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].method, "GET");
    assert.match(s.requests[0].url, /uploadId=up-1/);
  } finally {
    await s.close();
  }
});

test("ListParts with Size (AWS-style): the size is kept as a number", async () => {
  const s = await storeAnswering(listPartsXml([{ n: 1, etag: "aaa", size: 1500758 }]));
  try {
    assert.deepEqual(await s.store.listParts("co/fi/rec.mp4", "up-1"), [
      { partNumber: 1, size: 1500758, etag: '"aaa"' },
    ]);
  } finally {
    await s.close();
  }
});
