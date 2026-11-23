/**
 * #68 step 12a: Google Calendar tokens sealed at rest (token-crypto.ts).
 * AES-256-GCM with a random IV, bound to the row it belongs to, keys from the
 * environment, every failure a typed reason code that carries no secret.
 *
 *   node --test src/lib/calendar/token-crypto.test.ts
 *
 * Keys and tokens here are generated per run; nothing real.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { seal, open, tokenAad, sealedKeyId, TokenCryptoError } = await import("./token-crypto.ts");

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const TOKEN = `ya29.${randomBytes(24).toString("hex")}`;
const ROW = { id: "6f1c0000-0000-4000-8000-000000000001", memberId: "m-host", provider: "google" };
const AAD = tokenAad(ROW);

function setKeys(map, current) {
  process.env.CALENDAR_TOKEN_KEYS = JSON.stringify(map);
  process.env.CALENDAR_TOKEN_KEY_CURRENT = current;
}
setKeys({ k1: KEY_A }, "k1");

/** Run fn expecting a TokenCryptoError with this reason; returns the error. */
function refuses(fn, reason) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TokenCryptoError, `expected TokenCryptoError, got ${caught}`);
  assert.equal(caught.reason, reason);
  return caught;
}

test("round trip: what is sealed for a row opens for that row; the sealed text carries version, key id, iv, tag, ciphertext", () => {
  setKeys({ k1: KEY_A }, "k1");
  const sealed = seal(TOKEN, AAD);
  const parts = sealed.split(".");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "v1");
  assert.equal(parts[1], "k1");
  assert.equal(Buffer.from(parts[2], "base64url").length, 12, "a 12-byte IV");
  assert.equal(Buffer.from(parts[3], "base64url").length, 16, "a 16-byte tag");
  assert.ok(!sealed.includes(TOKEN), "the token is not in the sealed text");
  assert.equal(sealedKeyId(sealed), "k1");
  assert.equal(open(sealed, AAD), TOKEN);
});

// Negative control: seal with a fixed IV (Buffer.alloc(12) for randomBytes)
// and this test fails.
test("every seal has its own IV: the same token sealed twice never repeats", () => {
  setKeys({ k1: KEY_A }, "k1");
  const ivs = new Set();
  const sealedAll = new Set();
  for (let i = 0; i < 50; i++) {
    const s = seal(TOKEN, AAD);
    ivs.add(s.split(".")[2]);
    sealedAll.add(s);
  }
  assert.equal(ivs.size, 50, "50 seals, 50 different IVs");
  assert.equal(sealedAll.size, 50);
});

// Negative control: leave the row out of the AAD (aadBytes ignoring `aad`)
// and this test fails.
test("bound to its row: moved to another connection, member or provider, it does not open", () => {
  setKeys({ k1: KEY_A }, "k1");
  const sealed = seal(TOKEN, AAD);
  for (const other of [
    { ...ROW, id: "6f1c0000-0000-4000-8000-000000000002" },
    { ...ROW, memberId: "m-other" },
    { ...ROW, provider: "outlook" },
  ]) {
    refuses(() => open(sealed, tokenAad(other)), "auth_failed");
  }
});

test("the wrong key does not open it, even under the same key id", () => {
  setKeys({ k1: KEY_A }, "k1");
  const sealed = seal(TOKEN, AAD);
  setKeys({ k1: KEY_B }, "k1");
  refuses(() => open(sealed, AAD), "auth_failed");
  setKeys({ k1: KEY_A }, "k1");
});

test("tampered: a changed ciphertext, tag, iv or key id does not open; a truncated tag is malformed", () => {
  setKeys({ k1: KEY_A, k2: KEY_B }, "k1");
  const sealed = seal(TOKEN, AAD);
  const [v, id, iv, tag, ct] = sealed.split(".");
  const flip = (part) => {
    const b = Buffer.from(part, "base64url");
    b[0] ^= 0x01;
    return b.toString("base64url");
  };
  refuses(() => open([v, id, iv, tag, flip(ct)].join("."), AAD), "auth_failed");
  refuses(() => open([v, id, iv, flip(tag)].concat(ct).join("."), AAD), "auth_failed");
  refuses(() => open([v, id, flip(iv), tag, ct].join("."), AAD), "auth_failed");
  refuses(() => open([v, "k2", iv, tag, ct].join("."), AAD), "auth_failed");
  const shortTag = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");
  refuses(() => open([v, id, iv, shortTag, ct].join("."), AAD), "malformed");
  refuses(() => open(`v2.${id}.${iv}.${tag}.${ct}`, AAD), "malformed");
  refuses(() => open(TOKEN, AAD), "malformed");
  refuses(() => open([v, "gone", iv, tag, ct].join("."), AAD), "unknown_key");
});

test("missing or bad keys fail closed: nothing is sealed or opened", () => {
  setKeys({ k1: KEY_A }, "k1");
  const sealed = seal(TOKEN, AAD);
  const cases = [
    [() => delete process.env.CALENDAR_TOKEN_KEYS, "keys_missing"],
    [() => (process.env.CALENDAR_TOKEN_KEYS = "{}"), "keys_missing"],
    [() => (process.env.CALENDAR_TOKEN_KEYS = "not json"), "keys_invalid"],
    [() => (process.env.CALENDAR_TOKEN_KEYS = JSON.stringify([KEY_A])), "keys_invalid"],
    [() => setKeys({ k1: randomBytes(16).toString("base64") }, "k1"), "keys_invalid"],
    [() => setKeys({ k1: `${KEY_A.slice(0, 20)}!!${KEY_A.slice(22)}` }, "k1"), "keys_invalid"],
    [() => setKeys({ "bad.id": KEY_A }, "bad.id"), "keys_invalid"],
    [() => setKeys({ k1: KEY_A }, "k9"), "current_key_missing"],
    [() => setKeys({ k1: KEY_A }, ""), "current_key_missing"],
  ];
  for (const [setUp, reason] of cases) {
    setUp();
    refuses(() => seal(TOKEN, AAD), reason);
    refuses(() => open(sealed, AAD), reason);
  }
  setKeys({ k1: KEY_A }, "k1");
  refuses(() => seal("", AAD), "plaintext_invalid");
  refuses(() => seal(TOKEN, ""), "aad_invalid");
  refuses(() => open(sealed, ""), "aad_invalid");
  refuses(() => tokenAad({ ...ROW, memberId: "" }), "aad_invalid");
  refuses(() => tokenAad({ ...ROW, provider: "google|x" }), "aad_invalid");
});

test("rotation: an old key still opens what it sealed; new seals use the current key", () => {
  setKeys({ k1: KEY_A }, "k1");
  const old = seal(TOKEN, AAD);
  setKeys({ k1: KEY_A, k2: KEY_B }, "k2");
  assert.equal(open(old, AAD), TOKEN, "k1 still opens");
  const fresh = seal(TOKEN, AAD);
  assert.equal(sealedKeyId(fresh), "k2");
  assert.equal(open(fresh, AAD), TOKEN);
  setKeys({ k2: KEY_B }, "k2");
  refuses(() => open(old, AAD), "unknown_key");
  setKeys({ k1: KEY_A }, "k1");
});

test("nothing it says, logs or throws contains a key, the token or the sealed value", () => {
  const said = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => said.push(a.map(String).join(" "));
  try {
    setKeys({ k1: KEY_A, k2: KEY_B }, "k1");
    const sealed = seal(TOKEN, AAD);
    open(sealed, AAD);
    const failures = [];
    const tryIt = (fn) => {
      try {
        fn();
      } catch (err) {
        failures.push(err);
      }
    };
    tryIt(() => open(sealed, tokenAad({ ...ROW, memberId: "m-other" })));
    tryIt(() =>
      open(
        sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        AAD,
      ),
    );
    setKeys({ k1: KEY_B }, "k1");
    tryIt(() => open(sealed, AAD));
    setKeys({ k1: `${KEY_A}x` }, "k1");
    tryIt(() => seal(TOKEN, AAD));
    setKeys({ k1: KEY_A }, "k1");
    assert.equal(failures.length, 4);
    const text = [
      ...said,
      ...failures.flatMap((e) => [String(e), e.message, e.stack ?? "", JSON.stringify(e)]),
    ].join("\n");
    for (const secret of [KEY_A, KEY_B, TOKEN, sealed, sealed.split(".")[4]]) {
      assert.ok(!text.includes(secret), "a secret reached a message, a log or an error");
    }
    assert.deepEqual(said, [], "the module logs nothing");
  } finally {
    Object.assign(console, saved);
  }
});
