/**
 * #68 step 12e: calendar tokens are stored ONLY sealed (token-columns.ts),
 * bound to the row's id, and a row's id never changes. Plaintext is never
 * written and never read; a seal that fails fails the connect or refresh; a
 * sealed copy that does not open is a dead grant (reconnect), never a throw.
 *
 *   node --test src/lib/calendar/token-columns.test.ts
 *
 * storeTokens (the connect callback's write), getAccessToken (the refresh) and
 * disconnect (the revoke) run as shipped against a fake calendar_connections
 * that applies its filters, refuses a second row for (member_id, provider)
 * with 23505 as the unique key does, returns the rows an update matched, and
 * keeps every write. Every sealed column is opened with open(...,
 * tokenAad(storedRow)). Keys and tokens are random per run; nothing real.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { afterEach, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__tc.service; }",
  "./provider": "export function getProvider() { return { refresh: async (token) => { globalThis.__tc.refreshedWith = token; globalThis.__tc.onRefresh?.(); return globalThis.__tc.refreshed; }, revoke: async (token) => { globalThis.__tc.revoked.push(token); return true; } }; }",
  "./google": "export const EXPIRY_SKEW_MS = 60000;",
  "./account-key": "export function accountKeyFor() { return 'acct-key'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS && (specifier.startsWith("./") ? context.parentURL?.includes("/calendar/connections.ts") : true)) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { readTokens, sealedWrite } = await import("./token-columns.ts");
const { open, tokenAad } = await import("./token-crypto.ts");
const { CONNECTION_PROBLEM, disconnect, getAccessToken, storeTokens } = await import(
  "./connections.ts"
);

const KEY_1 = randomBytes(32).toString("base64");
const KEY_2 = randomBytes(32).toString("base64");
const tok = (p) => `${p}.${randomBytes(16).toString("hex")}`;
function setKeys(map, current) {
  process.env.CALENDAR_TOKEN_KEYS = JSON.stringify(map);
  process.env.CALENDAR_TOKEN_KEY_CURRENT = current;
}
setKeys({ k1: KEY_1 }, "k1");
afterEach(() => setKeys({ k1: KEY_1 }, "k1"));

const CO = "c0000000-0000-4000-8000-0000000012e0";
const ACCOUNT = { email: "host@example.test", calendarId: "primary", timezone: "UTC" };
const LATER = () => new Date(Date.now() + 3600_000).toISOString();
const EARLIER = () => new Date(Date.now() - 1000).toISOString();
const aadOf = (r) => tokenAad({ id: r.id, memberId: r.member_id, provider: r.provider });
/** Open both sealed columns of a stored row, for that row. */
const opened = (r) => ({
  access: open(r.access_token_enc, aadOf(r)),
  refresh: r.refresh_token_enc ? open(r.refresh_token_enc, aadOf(r)) : null,
  keyOfAccess: r.access_token_enc.split(".")[1],
  keyOfRefresh: r.refresh_token_enc?.split(".")[1] ?? null,
});

/** A sealed value with one ciphertext byte flipped: well formed, never opens. */
function tamper(sealed) {
  const parts = sealed.split(".");
  const ct = Buffer.from(parts[4], "base64url");
  ct[0] ^= 1;
  parts[4] = ct.toString("base64url");
  return parts.join(".");
}

/** A calendar_connections table: unique (member_id, provider), filters applied, writes kept. */
function world(rows = []) {
  const t = { rows: rows.map((r) => ({ ...r })), logs: [], writes: [], revoked: [] };
  const matches = (row, calls) =>
    calls.filter((c) => c[0] === "eq").every(([, k, v]) => row[k] === v);
  t.service = fakeService((table, calls) => {
    assert.equal(table, "calendar_connections");
    const insert = calls.find((c) => c[0] === "insert");
    if (insert) {
      t.beforeInsert?.();
      const row = insert[1];
      t.writes.push(["insert", { ...row }]);
      const clash = t.rows.some(
        (r) => r.id === row.id || (r.member_id === row.member_id && r.provider === row.provider),
      );
      if (clash) return { data: null, error: { code: "23505", message: "duplicate key" } };
      t.rows.push({ refresh_token_enc: null, ...row });
      return { data: null, error: null };
    }
    const upsert = calls.find((c) => c[0] === "upsert");
    if (upsert) {
      // As Postgres applies ON CONFLICT (member_id, provider) DO UPDATE SET
      // <every column sent>: an id sent replaces the existing row's.
      t.writes.push(["upsert", { ...upsert[1] }]);
      const hit = t.rows.find(
        (r) => r.member_id === upsert[1].member_id && r.provider === upsert[1].provider,
      );
      if (hit) Object.assign(hit, upsert[1]);
      else t.rows.push({ refresh_token_enc: null, ...upsert[1] });
      return { data: null, error: null };
    }
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      t.writes.push(["update", { ...update[1] }]);
      const matched = t.rows.filter((r) => matches(r, calls));
      for (const r of matched) Object.assign(r, update[1]);
      const returning = calls.some((c) => c[0] === "select");
      return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (calls.some((c) => c[0] === "delete")) {
      t.rows = t.rows.filter((r) => !matches(r, calls));
      return { data: null, error: null };
    }
    const hit = t.rows.filter((r) => matches(r, calls)).map((r) => ({ ...r }));
    t.onRead?.();
    return {
      data: calls.some((c) => c[0] === "maybeSingle") ? (hit[0] ?? null) : hit,
      error: null,
    };
  });
  globalThis.__tc = t;
  return t;
}

async function capture(fn) {
  const t = globalThis.__tc;
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(saved)) console[k] = (...a) => t.logs.push(a.map(String).join(" "));
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const connect = (memberId, tokens) =>
  capture(() =>
    storeTokens({
      companyId: CO,
      memberId,
      provider: "google",
      tokens: { expiresAt: LATER(), scope: "s", ...tokens },
      account: ACCOUNT,
    }),
  );

/** A stored, sealed row (as 12b-12d left it, with plaintext decoys that must never be used). */
function storedRow(memberId, { access, refresh, expiresAt = LATER() }) {
  const id = randomUUID();
  const sealed = sealedWrite(
    { id, memberId, provider: "google" },
    { accessToken: access, refreshToken: refresh },
  );
  return {
    id,
    company_id: CO,
    member_id: memberId,
    provider: "google",
    provider_account: ACCOUNT.email,
    status: "active",
    expires_at: expiresAt,
    updated_at: "2026-11-24T09:00:00.000Z",
    ...sealed.columns,
    access_token: "plaintext-decoy-access",
    refresh_token: "plaintext-decoy-refresh",
  };
}

/** Every token column any write sent: the plaintext ones must all be null. */
const plaintextWritten = (w) =>
  w.writes.flatMap(([, patch]) =>
    ["access_token", "refresh_token"]
      .filter((c) => c in patch && patch[c] !== null)
      .map((c) => `${c}=${patch[c]}`),
  );

/* ── writes ──────────────────────────────────────────────────── */

test("the helper: both tokens sealed for the row under the current key, plaintext null; no refresh token and none stored, no refresh column", () => {
  const row = { id: randomUUID(), memberId: "m-1", provider: "google" };
  const access = tok("access");
  const refresh = tok("refresh");
  const out = sealedWrite(row, { accessToken: access, refreshToken: refresh });
  assert.equal(out.ok, true);
  assert.equal(out.columns.access_token, null);
  assert.equal(out.columns.refresh_token, null);
  assert.equal(out.columns.token_key_id, "k1");
  assert.equal(open(out.columns.access_token_enc, tokenAad(row)), access);
  assert.equal(open(out.columns.refresh_token_enc, tokenAad(row)), refresh);

  const none = sealedWrite(row, { accessToken: access, refreshToken: null });
  assert.ok(!("refresh_token_enc" in none.columns), "the stored copy is left as it is");
  const kept = sealedWrite(row, {
    accessToken: access,
    refreshToken: null,
    storedRefreshToken: refresh,
  });
  assert.equal(
    open(kept.columns.refresh_token_enc, tokenAad(row)),
    refresh,
    "re-sealed, not cleared",
  );
});

// Negative control: write the access token in plaintext again (sealedWrite's
// `access_token: null` back to the token) and this test fails.
test("first connect: INSERTED with an app-generated id, sealed for that id, no plaintext anywhere", async () => {
  const w = world();
  const access = tok("access");
  const refresh = tok("refresh");
  assert.deepEqual(await connect("m-new", { accessToken: access, refreshToken: refresh }), {
    ok: true,
  });
  assert.equal(w.rows.length, 1);
  const stored = w.rows[0];
  const insert = w.writes.find(([op]) => op === "insert")[1];
  assert.equal(insert.id, stored.id, "the id it was sealed for is the id it has");
  assert.ok(!w.writes.some(([op]) => op === "upsert"), "never an upsert");
  assert.deepEqual(opened(stored), { access, refresh, keyOfAccess: "k1", keyOfRefresh: "k1" });
  assert.equal(stored.token_key_id, "k1");
  assert.deepEqual(plaintextWritten(w), [], "plaintext is never written");
  assert.equal(stored.access_token, null);
  assert.equal(stored.refresh_token, null);
});

// Negative control: make a reconnect clear refresh_token_enc (seal it as null
// when the grant brings none) and this test fails.
test("reconnect without a refresh token, after a key rotation: same row and id, the refresh token KEPT and re-sealed under the new key", async () => {
  const w = world();
  const refresh = tok("refresh");
  await connect("m-re", { accessToken: tok("access"), refreshToken: refresh });
  const id = w.rows[0].id;
  assert.equal(opened(w.rows[0]).keyOfRefresh, "k1", "sealed under k1 to start with");

  setKeys({ k1: KEY_1, k2: KEY_2 }, "k2");
  const access = tok("access");
  assert.deepEqual(await connect("m-re", { accessToken: access, refreshToken: null }), {
    ok: true,
  });
  assert.equal(w.rows.length, 1);
  const stored = w.rows[0];
  assert.equal(stored.id, id, "an existing row keeps its id");
  assert.equal(
    w.writes.filter(([op]) => op === "insert").length,
    1,
    "only the first connect inserted",
  );
  assert.deepEqual(opened(stored), { access, refresh, keyOfAccess: "k2", keyOfRefresh: "k2" });
  assert.equal(stored.token_key_id, "k2");
  const reconnectWrite = w.writes.filter(([op]) => op === "update").at(-2)[1];
  assert.ok(reconnectWrite.refresh_token_enc, "the reconnect re-sealed it, it did not drop it");
  // k1 retired: the refresh token still opens, so it really is under k2 now.
  setKeys({ k2: KEY_2 }, "k2");
  assert.equal(opened(stored).refresh, refresh);
  assert.deepEqual(plaintextWritten(w), []);
});

test("reconnect without a refresh token when the stored copy does not open: it is left exactly as stored, never cleared", async () => {
  const w = world();
  await connect("m-keep", { accessToken: tok("access"), refreshToken: tok("refresh") });
  w.rows[0].refresh_token_enc = tamper(w.rows[0].refresh_token_enc);
  const before = w.rows[0].refresh_token_enc;
  await connect("m-keep", { accessToken: tok("access"), refreshToken: null });
  assert.equal(w.rows[0].refresh_token_enc, before);
  assert.ok(!("refresh_token_enc" in w.writes.at(-2)[1]), "the update did not touch it");
});

// Negative control: make storeTokens upsert where it inserts (onConflict
// member_id,provider) and this test fails: the winner's id is replaced.
test("two first connects race: the loser's insert hits the unique key, reads the winner's row and updates it; the id never changes", async () => {
  const w = world();
  const winnerId = randomUUID();
  const winnerRefresh = tok("refresh");
  // Another connect inserts first, between this one's read and its insert.
  w.beforeInsert = () => {
    w.beforeInsert = undefined;
    const sealed = sealedWrite(
      { id: winnerId, memberId: "m-race", provider: "google" },
      { accessToken: tok("access"), refreshToken: winnerRefresh },
    );
    w.rows.push({
      id: winnerId,
      company_id: CO,
      member_id: "m-race",
      provider: "google",
      status: "active",
      updated_at: "2026-11-24T09:00:00.000Z",
      ...sealed.columns,
    });
  };
  const access = tok("access");
  assert.deepEqual(await connect("m-race", { accessToken: access, refreshToken: null }), {
    ok: true,
  });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].id, winnerId, "the winner's id stands");
  assert.deepEqual(opened(w.rows[0]), {
    access,
    refresh: winnerRefresh,
    keyOfAccess: "k1",
    keyOfRefresh: "k1",
  });
});

// Negative control: drop the updated_at guard from storeTokens' update and
// this test fails.
test("the row changes between the read and the write: the guarded update matches nothing, the loop reads again; all attempts moved, the connect fails", async () => {
  const w = world();
  await connect("m-moved", { accessToken: tok("access"), refreshToken: tok("refresh") });
  let moves = 1;
  w.onRead = () => {
    if (moves-- > 0) w.rows[0].updated_at = new Date(Date.now() + 5000).toISOString();
  };
  const access = tok("access");
  assert.deepEqual(await connect("m-moved", { accessToken: access, refreshToken: null }), {
    ok: true,
  });
  const guarded = w.writes.filter(([op]) => op === "update").length;
  assert.ok(guarded >= 3, "a first update that matched nothing, then the one that landed");
  assert.equal(opened(w.rows[0]).access, access);

  // Every read is followed by another write to the row.
  let tick = 0;
  w.onRead = () => {
    tick += 1;
    w.rows[0].updated_at = `2026-11-24T10:00:${String(tick).padStart(2, "0")}.000Z`;
  };
  assert.deepEqual(await connect("m-moved", { accessToken: tok("access"), refreshToken: null }), {
    ok: false,
    error: "conflict",
  });
  assert.ok(w.logs.includes("[calendar] storeTokens failed: conflict"));
});

test("keys missing or invalid: the connect FAILS, nothing is written, a reason code is logged", async () => {
  const w = world();
  delete process.env.CALENDAR_TOKEN_KEYS;
  const access = tok("access");
  assert.deepEqual(
    await connect("m-nokey", { accessToken: access, refreshToken: tok("refresh") }),
    {
      ok: false,
      error: "seal_failed",
    },
  );
  assert.deepEqual(w.rows, []);
  assert.deepEqual(w.writes, [], "nothing to fall back to: no write at all");
  assert.deepEqual(w.logs, [
    "[calendar-token-crypto] seal_failed reason=keys_missing",
    "[calendar] storeTokens failed: seal_keys_missing",
  ]);
});

/* ── the refresh ─────────────────────────────────────────────── */

test("a token refresh writes the new access token sealed only, by the row's id, and KEEPS the refresh token Google did not resend", async () => {
  const refresh = tok("refresh");
  const w = world([storedRow("m-ref", { access: tok("old"), refresh, expiresAt: EARLIER() })]);
  setKeys({ k1: KEY_1, k2: KEY_2 }, "k2");
  const fresh = tok("access");
  w.refreshed = { accessToken: fresh, refreshToken: null, expiresAt: LATER() };
  assert.equal(await capture(() => getAccessToken("m-ref", "google")), fresh);
  assert.equal(w.refreshedWith, refresh, "the sealed refresh token was used, not the decoy");
  const stored = w.rows[0];
  assert.deepEqual(opened(stored), {
    access: fresh,
    refresh,
    keyOfAccess: "k2",
    keyOfRefresh: "k2",
  });
  assert.equal(stored.token_key_id, "k2");
  assert.deepEqual(plaintextWritten(w), []);
  assert.equal(stored.access_token, null, "the plaintext decoy is cleared by the write");
});

test("the refresh cannot be sealed (keys invalid): it fails, the card says refresh failed, no token is written", async () => {
  const w = world([
    storedRow("m-rfail", { access: tok("old"), refresh: tok("refresh"), expiresAt: EARLIER() }),
  ]);
  w.refreshed = { accessToken: tok("access"), refreshToken: null, expiresAt: LATER() };
  // The keys break while Google is refreshing: the read opened, the seal cannot.
  w.onRefresh = () => {
    process.env.CALENDAR_TOKEN_KEYS = "not json";
  };
  assert.equal(await capture(() => getAccessToken("m-rfail", "google")), null);
  assert.equal(w.rows[0].status, "error");
  assert.equal(w.rows[0].last_error, CONNECTION_PROBLEM.refreshFailed);
  assert.ok(!w.writes.some(([, p]) => "access_token_enc" in p), "no token written");
  assert.ok(w.logs.includes("[calendar] token refresh not stored: seal_keys_invalid"));
});

/* ── reads ───────────────────────────────────────────────────── */

// Negative control: put a plaintext fallback back into readTokens and this
// test fails.
test("reads use the sealed copies only: a row's plaintext is never used, even when no sealed copy is there", async () => {
  const access = tok("access");
  const row = storedRow("m-read", { access, refresh: tok("refresh") });
  const w = world([row]);
  assert.equal(await capture(() => getAccessToken("m-read", "google")), access);

  const bare = { ...row, access_token_enc: null, refresh_token_enc: null };
  assert.deepEqual(readTokens(bare), { accessToken: null, refreshToken: null, openFailed: false });
  w.rows = [{ ...bare, expires_at: EARLIER() }];
  assert.equal(await capture(() => getAccessToken("m-read", "google")), null);
  assert.equal(
    w.rows[0].last_error,
    CONNECTION_PROBLEM.noRefreshToken,
    "a reconnect, not the plaintext",
  );
});

test("a sealed copy that does not open: the reconnect-needed state, a reason code, no throw, nothing re-sealed", async () => {
  const row = storedRow("m-dead", {
    access: tok("access"),
    refresh: tok("refresh"),
    expiresAt: EARLIER(),
  });
  setKeys({ k2: KEY_2 }, "k2");
  const w = world([row]);
  assert.equal(await capture(() => getAccessToken("m-dead", "google")), null);
  assert.equal(w.rows[0].status, "error");
  assert.equal(w.rows[0].last_error, CONNECTION_PROBLEM.noRefreshToken);
  assert.deepEqual(w.logs, [
    "[calendar-token] open_failed reason=unknown_key",
    "[calendar-token] open_failed reason=unknown_key",
  ]);
  assert.equal(w.rows[0].access_token_enc, row.access_token_enc, "left for the right key");
});

test("disconnect revokes with the copy that opens; with none, it revokes nothing and still deletes", async () => {
  const refresh = tok("refresh");
  const w = world([storedRow("m-rev", { access: tok("access"), refresh })]);
  assert.deepEqual(await capture(() => disconnect("m-rev", "google")), {
    deleted: true,
    revokedAtProvider: true,
  });
  assert.deepEqual(w.revoked, [refresh]);

  const dead = storedRow("m-rev2", { access: tok("access"), refresh: tok("refresh") });
  dead.access_token_enc = tamper(dead.access_token_enc);
  dead.refresh_token_enc = tamper(dead.refresh_token_enc);
  const w2 = world([dead]);
  assert.deepEqual(await capture(() => disconnect("m-rev2", "google")), {
    deleted: true,
    revokedAtProvider: false,
  });
  assert.deepEqual(w2.revoked, [], "the plaintext decoys are never revoked");
  assert.deepEqual(w2.rows, []);
});

test("no token, key or sealed value in any log line of any path", async () => {
  const secrets = [];
  const t = (p) => {
    const v = tok(p);
    secrets.push(v);
    return v;
  };
  const w = world();
  await connect("m-l1", { accessToken: t("a"), refreshToken: t("r") });
  await connect("m-l1", { accessToken: t("a"), refreshToken: null });
  w.rows[0].expires_at = EARLIER();
  w.refreshed = { accessToken: t("a"), refreshToken: null, expiresAt: LATER() };
  await capture(() => getAccessToken("m-l1", "google"));
  w.rows.push(storedRow("m-l2", { access: t("a"), refresh: t("r") }));
  w.rows[1].access_token_enc = tamper(w.rows[1].access_token_enc);
  await capture(() => getAccessToken("m-l2", "google"));
  delete process.env.CALENDAR_TOKEN_KEYS;
  await connect("m-l3", { accessToken: t("a"), refreshToken: t("r") });
  setKeys({ k1: KEY_1 }, "k1");
  await capture(() => disconnect("m-l1", "google"));
  const all = w.logs.join("\n");
  assert.ok(w.logs.length > 0);
  const sealedValues = w.writes
    .flatMap(([, p]) => [p.access_token_enc, p.refresh_token_enc])
    .filter(Boolean);
  for (const secret of [...secrets, KEY_1, ...sealedValues]) {
    assert.ok(!all.includes(secret), "a token, key or sealed value reached a log");
  }
});
