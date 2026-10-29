import { createHash } from "node:crypto";

/**
 * A UUID derived from a name: the same name always gives the same id. Used as
 * an explicit primary key, it lets the database refuse a second row (23505)
 * where no unique index does it.
 */
export function deterministicUuid(name: string): string {
  const b = createHash("sha256").update(`remotiv:${name}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 layout
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
