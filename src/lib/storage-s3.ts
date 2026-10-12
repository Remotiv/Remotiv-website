import "server-only";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

/**
 * Supabase Storage through its S3 endpoint, for copies too large for a single
 * request: the recording import (recording step 4) uploads in parts and finds
 * its place again by asking which parts are already there.
 *
 * ── Configuration ────────────────────────────────────────────
 *
 * SUPABASE_S3_ENDPOINT (https), SUPABASE_S3_REGION, SUPABASE_S3_ACCESS_KEY_ID
 * and SUPABASE_S3_SECRET_ACCESS_KEY, read when a store is built. Any missing
 * gives no store at all, and the caller refuses with a configuration error.
 * The keys bypass row-level security, so this module is server-only.
 *
 * ── Supabase compatibility ───────────────────────────────────
 *
 * Path-style addressing, and checksums only where an operation requires one:
 * the SDK's default CRC32 headers are not something Supabase documents, and it
 * does not support Content-MD5 on uploads.
 *
 * ── What is never logged or thrown ───────────────────────────
 *
 * The keys and the object key (it carries company and interview ids). Errors
 * carry the operation, the HTTP status and S3's error code only.
 */

export type StoredPart = { partNumber: number; size: number; etag: string };

/** What the import needs from object storage. One bucket per store. */
export interface RecordingStore {
  /** The object's size, or null when there is none. */
  headObject(key: string, signal?: AbortSignal): Promise<{ size: number } | null>;
  /** The first `length` bytes of the object. */
  readHead(key: string, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Unfinished multipart uploads for exactly this key, oldest first. */
  findUploads(key: string, signal?: AbortSignal): Promise<string[]>;
  createUpload(key: string, contentType: string, signal?: AbortSignal): Promise<string>;
  /** The parts stored so far, or null when the upload no longer exists. */
  listParts(key: string, uploadId: string, signal?: AbortSignal): Promise<StoredPart[] | null>;
  /** The part's ETag. Uploading a part number again replaces it. */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<string>;
  /** "missing" when the upload no longer exists (completed already, or aborted). */
  completeUpload(
    key: string,
    uploadId: string,
    parts: StoredPart[],
    signal?: AbortSignal,
  ): Promise<"completed" | "missing">;
  abortUpload(key: string, uploadId: string, signal?: AbortSignal): Promise<void>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
}

/** S3 error codes that mean the store itself is set up wrong, not that this request failed. */
const CONFIG_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "NoSuchBucket",
  "InvalidBucketName",
]);
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A refused or failed storage call. `status` is what lib/queue/failure-class.ts reads. */
export class RecordingStoreError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  /** The bucket or the keys are wrong: no retry will help until someone fixes them. */
  readonly configuration: boolean;

  constructor(operation: string, status: number | null, code: string | null) {
    const what = status === null ? "network error" : `HTTP ${status}`;
    super(`storage ${operation} failed: ${what}${code ? ` (${code})` : ""}`);
    this.name = "RecordingStoreError";
    this.status = status;
    this.code = code;
    this.configuration = code !== null && CONFIG_CODES.has(code);
  }
}

function details(err: unknown): { status: number | null; code: string | null } {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const status = e?.$metadata?.httpStatusCode;
  const code = typeof e?.name === "string" && SAFE_CODE_RE.test(e.name) ? e.name : null;
  return { status: typeof status === "number" ? status : null, code };
}

export type RecordingStoreConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export function createRecordingStore(config: RecordingStoreConfig): RecordingStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // The queue is the one retry controller.
    maxAttempts: 1,
  });
  const Bucket = config.bucket;

  async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const { status, code } = details(err);
      throw new RecordingStoreError(operation, status, code);
    }
  }

  return {
    async headObject(key, signal) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }), {
          abortSignal: signal,
        });
        return { size: Number(res.ContentLength ?? 0) };
      } catch (err) {
        const { status, code } = details(err);
        if (status === 404 || code === "NotFound" || code === "NoSuchKey") return null;
        throw new RecordingStoreError("head object", status, code);
      }
    },

    async readHead(key, length, signal) {
      return call("read object", async () => {
        const res = await client.send(
          new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${length - 1}` }),
          { abortSignal: signal },
        );
        const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
        return bytes.subarray(0, length);
      });
    },

    async findUploads(key, signal) {
      return call("list uploads", async () => {
        const res = await client.send(new ListMultipartUploadsCommand({ Bucket, Prefix: key }), {
          abortSignal: signal,
        });
        return (res.Uploads ?? [])
          .filter((u) => u.Key === key && u.UploadId)
          .sort((a, b) => (a.Initiated?.getTime() ?? 0) - (b.Initiated?.getTime() ?? 0))
          .map((u) => u.UploadId as string);
      });
    },

    async createUpload(key, contentType, signal) {
      return call("create upload", async () => {
        const res = await client.send(
          new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }),
          { abortSignal: signal },
        );
        if (!res.UploadId) throw new Error("no upload id");
        return res.UploadId;
      });
    },

    async listParts(key, uploadId, signal) {
      const parts: StoredPart[] = [];
      let marker: string | undefined;
      try {
        for (;;) {
          const res = await client.send(
            new ListPartsCommand({
              Bucket,
              Key: key,
              UploadId: uploadId,
              PartNumberMarker: marker,
            }),
            { abortSignal: signal },
          );
          for (const p of res.Parts ?? []) {
            if (p.PartNumber && p.ETag) {
              parts.push({ partNumber: p.PartNumber, size: Number(p.Size ?? 0), etag: p.ETag });
            }
          }
          if (!res.IsTruncated || !res.NextPartNumberMarker) break;
          marker = res.NextPartNumberMarker;
        }
      } catch (err) {
        const { status, code } = details(err);
        if (code === "NoSuchUpload" || status === 404) return null;
        throw new RecordingStoreError("list parts", status, code);
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async uploadPart(key, uploadId, partNumber, body, signal) {
      return call("upload part", async () => {
        const res = await client.send(
          new UploadPartCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
            ContentLength: body.byteLength,
          }),
          { abortSignal: signal },
        );
        if (!res.ETag) throw new Error("no etag");
        return res.ETag;
      });
    },

    async completeUpload(key, uploadId, parts, signal) {
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          }),
          { abortSignal: signal },
        );
        return "completed";
      } catch (err) {
        const { status, code } = details(err);
        if (code === "NoSuchUpload" || status === 404) return "missing";
        throw new RecordingStoreError("complete upload", status, code);
      }
    },

    async abortUpload(key, uploadId, signal) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }),
          {
            abortSignal: signal,
          },
        );
      } catch (err) {
        const { status, code } = details(err);
        if (code === "NoSuchUpload" || status === 404) return;
        throw new RecordingStoreError("abort upload", status, code);
      }
    },

    async deleteObject(key, signal) {
      await call("delete object", () =>
        client.send(new DeleteObjectCommand({ Bucket, Key: key }), { abortSignal: signal }),
      );
    },
  };
}

/** The store for this deployment, or null when any SUPABASE_S3_* value is missing. */
export function getRecordingStore(
  bucket: string,
  env: Record<string, string | undefined> = process.env,
): RecordingStore | null {
  const endpoint = env.SUPABASE_S3_ENDPOINT?.trim() ?? "";
  const region = env.SUPABASE_S3_REGION?.trim() ?? "";
  const accessKeyId = env.SUPABASE_S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!endpoint.startsWith("https://") || !region || !accessKeyId || !secretAccessKey) return null;
  return createRecordingStore({ endpoint, region, accessKeyId, secretAccessKey, bucket });
}
