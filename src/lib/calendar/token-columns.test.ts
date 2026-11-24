/**
 * #68 step 12b: every write of a calendar token also writes it sealed
 * (token-columns.ts), bound to the row as stored, under one key per row.
 * Reads stay on the plaintext; a seal that fails never blocks a connect or a
 * refresh.
 *
 *   node --test src/lib/calendar/token-columns.test.ts
 *
 * storeTokens (the connect callback's write) and getAccessToken (the refresh)
 * run as shipped against a fake calendar_connections that applies upsert on
 * (member_id, provider), fills a default id, and keeps what was written. Every
 * sealed column is then opened with open(..., tokenAad(storedRow)). Keys and
 * tokens are random per run; nothing real.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__tc.service; }",
  "./provider": "export function getProvider() { return { refresh: async (token) => { globalThis.__tc.refreshedWith = token; await globalThis.__tc.refreshGate; return globalThis.__tc.refreshed; }, revoke: async (token) => { globalThis.__tc.revoked.push(token); return true; } }; }",
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
const { readTokens, tokenColumns } = await import("./token-columns.ts");
const { open, tokenAad } = await import("./token-crypto.ts");
const { disconnect, storeTokens, getAccessToken } = await import("./connections.ts");

const KEY_1 = randomBytes(32).toString("base64");
const KEY_2 = randomBytes(32).toString("base64");
const tok = (p) => `${p}.${randomBytes(16).toString("hex")}`;
function setKeys(map, current) {
  process.env.CALENDAR_TOKEN_KEYS = JSON.stringify(map);
  process.env.CALENDAR_TOKEN_KEY_CURRENT = current;
}
function noKeys() {
  delete process.env.CALENDAR_TOKEN_KEYS;
  delete process.env.CALENDAR_TOKEN_KEY_CURRENT;
}

const CO = "c0000000-0000-4000-8000-0000000012b0";
const ACCOUNT = { email: "host@example.test", calendarId: "primary", timezone: "UTC" };
const aadOf = (r) => tokenAad({ id: r.id, memberId: r.member_id, provider: r.provider });
/** Open both sealed columns of a stored row, for that row. */
const opened = (r) => ({
  access: open(r.access_token_enc, aadOf(r)),
  refresh: r.refresh_token_enc === null ? null : open(r.refresh_token_enc, aadOf(r)),
  keyOfAccess: r.access_token_enc.split(".")[1],
  keyOfRefresh: r.refresh_token_enc?.split(".")[1] ?? null,
});

/** A calendar_connections table with upsert on (member_id, provider) and a default id. */
function world(rows = []) {
  const t = {
    rows: rows.map((r) => ({ ...r })),
    logs: [],
    failSealWrite: false,
    writes: [],
    revoked: [],
  };
  const matches = (row, calls) =>
    calls.filter((c) => c[0] === "eq").every(([, k, v]) => row[k] === v);
  t.service = fakeService((table, calls) => {
    assert.equal(table, "calendar_connections");
    const upsert = calls.find((c) => c[0] === "upsert");
    if (upsert) {
      const patch = upsert[1];
      t.writes.push(["upsert", { ...patch }]);
      // ON CONFLICT (member_id, provider) DO UPDATE SET <the columns sent>.
      let hit = t.rows.find(
        (r) => r.member_id === patch.member_id && r.provider === patch.provider,
      );
      if (hit) Object.assign(hit, patch);
      else {
        hit = { id: randomUUID(), refresh_token: null, ...patch };
        t.rows.push(hit);
      }
      t.onUpsert?.(hit);
      return { data: { ...hit }, error: null };
    }
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      t.writes.push(["update", { ...update[1] }]);
      if (t.failSealWrite && "access_token_enc" in update[1] && !("access_token" in update[1])) {
        return { data: null, error: { code: "57014", message: "timeout" } };
      }
      const matched = t.rows.filter((r) => matches(r, calls));
      for (const r of matched) Object.assign(r, update[1]);
      const returning = calls.some((c) => c[0] === "select");
      return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (calls.some((c) => c[0] === "delete")) {
      t.rows = t.rows.filter((r) => !matches(r, calls));
      return { data: null, error: null };
    }
    // Reads return copies, as the network does; onRead runs after the copy.
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
      tokens: { expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope: "s", ...tokens },
      account: ACCOUNT,
    }),
  );

// Negative control: make tokenColumns return null sealed columns from its try
// block (sealing skipped) and this test fails.
test("the helper: both tokens sealed for the row, under the current key; no refresh token, no refresh column", () => {
  setKeys({ k1: KEY_1 }, "k1");
  const row = { id: randomUUID(), memberId: "m-1", provider: "google" };
  const access = tok("access");
  const refresh = tok("refresh");
  const out = tokenColumns(row, { accessToken: access, refreshToken: refresh });
  assert.equal(out.access_token, access);
  assert.equal(out.refresh_token, refresh);
  assert.equal(out.token_key_id, "k1");
  assert.equal(open(out.access_token_enc, tokenAad(row)), access);
  assert.equal(open(out.refresh_token_enc, tokenAad(row)), refresh);

  const noRefresh = tokenColumns(row, { accessToken: access, refreshToken: null });
  assert.ok(
    !("refresh_token" in noRefresh),
    "an absent refresh token never overwrites the stored one",
  );
  assert.equal(noRefresh.refresh_token_enc, null);

  const kept = tokenColumns(row, {
    accessToken: access,
    refreshToken: null,
    storedRefreshToken: refresh,
  });
  assert.ok(!("refresh_token" in kept));
  assert.equal(open(kept.refresh_token_enc, tokenAad(row)), refresh, "the stored one, re-sealed");
});

// Negative control: seal storeTokens' tokens for an id other than the stored
// row's and this test fails.
test("first connect: no id is sent; the sealed copies are written for the id the database gave the row, and open for it", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  const access = tok("access");
  const refresh = tok("refresh");
  assert.deepEqual(await connect("m-new", { accessToken: access, refreshToken: refresh }), {
    ok: true,
  });
  assert.equal(w.rows.length, 1);
  const stored = w.rows[0];
  assert.ok(!("id" in w.writes[0][1]), "the upsert never sends an id");
  assert.deepEqual(
    [w.writes[0][1].access_token_enc, w.writes[0][1].token_key_id],
    [null, null],
    "the plaintext goes first with the sealed columns cleared",
  );
  assert.deepEqual(opened(stored), { access, refresh, keyOfAccess: "k1", keyOfRefresh: "k1" });
  assert.equal(stored.token_key_id, "k1");
  assert.equal(stored.access_token, access, "the plaintext is still written (reads stay on it)");
  assert.equal(stored.refresh_token, refresh);
});

test("reconnect without a refresh token, after a key rotation: the row keeps its id and its refresh token; both columns sealed under the new key", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  const firstRefresh = tok("refresh");
  await connect("m-re", { accessToken: tok("access"), refreshToken: firstRefresh });
  const id = w.rows[0].id;

  setKeys({ k1: KEY_1, k2: KEY_2 }, "k2");
  const access = tok("access");
  await connect("m-re", { accessToken: access, refreshToken: null });
  const stored = w.rows[0];
  assert.equal(w.rows.length, 1);
  assert.equal(stored.id, id, "an existing row keeps its own id");
  assert.equal(stored.refresh_token, firstRefresh, "the working refresh token is not destroyed");
  const upsert = w.writes.filter(([op]) => op === "upsert").at(-1)[1];
  assert.ok(!("refresh_token" in upsert), "the upsert did not send refresh_token");
  assert.ok(!("id" in upsert));
  assert.deepEqual(opened(stored), {
    access,
    refresh: firstRefresh,
    keyOfAccess: "k2",
    keyOfRefresh: "k2",
  });
  assert.equal(stored.token_key_id, "k2", "one key per row, and token_key_id names it");
});

// Negative control: seal the refresh write for an id other than row.id and
// this test fails.
test("a token refresh re-seals the new access token (and the refresh token) for the stored row, key id consistent", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  const refresh = tok("refresh");
  await connect("m-ref", { accessToken: tok("old"), refreshToken: refresh });
  w.rows[0].expires_at = new Date(Date.now() - 1000).toISOString();

  setKeys({ k1: KEY_1, k2: KEY_2 }, "k2");
  const fresh = tok("access");
  w.refreshed = {
    accessToken: fresh,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  assert.equal(await capture(() => getAccessToken("m-ref", "google")), fresh);
  const stored = w.rows[0];
  assert.equal(stored.access_token, fresh);
  assert.equal(stored.refresh_token, refresh, "kept");
  assert.ok(!("refresh_token" in w.writes.at(-1)[1]));
  assert.deepEqual(opened(stored), {
    access: fresh,
    refresh,
    keyOfAccess: "k2",
    keyOfRefresh: "k2",
  });
  assert.equal(stored.token_key_id, "k2");

  // Google sends a new refresh token: both plaintext and sealed follow it.
  stored.expires_at = new Date(Date.now() - 1000).toISOString();
  const rotated = tok("refresh");
  w.refreshed = {
    accessToken: tok("access"),
    refreshToken: rotated,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  await capture(() => getAccessToken("m-ref", "google"));
  assert.equal(stored.refresh_token, rotated);
  assert.equal(opened(stored).refresh, rotated);
});

test("keys missing or invalid: the connect and the refresh still work, plaintext written, sealed columns cleared, reason codes only", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  const refresh = tok("refresh");
  await connect("m-nokey", { accessToken: tok("access"), refreshToken: refresh });
  assert.ok(w.rows[0].access_token_enc, "sealed while the keys were there");

  noKeys();
  w.logs.length = 0;
  const access = tok("access");
  assert.deepEqual(await connect("m-nokey", { accessToken: access, refreshToken: null }), {
    ok: true,
  });
  const stored = w.rows[0];
  assert.equal(stored.access_token, access);
  assert.equal(stored.refresh_token, refresh);
  assert.deepEqual(
    [stored.access_token_enc, stored.refresh_token_enc, stored.token_key_id],
    [null, null, null],
    "never left holding a sealed copy of an older token",
  );
  assert.deepEqual(w.logs, ["[calendar-token-crypto] seal_failed reason=keys_missing"]);

  process.env.CALENDAR_TOKEN_KEYS = "not json";
  process.env.CALENDAR_TOKEN_KEY_CURRENT = "k1";
  stored.expires_at = new Date(Date.now() - 1000).toISOString();
  const fresh = tok("access");
  w.refreshed = {
    accessToken: fresh,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  w.logs.length = 0;
  assert.equal(
    await capture(() => getAccessToken("m-nokey", "google")),
    fresh,
    "the refresh is not blocked",
  );
  assert.equal(stored.access_token, fresh);
  assert.equal(stored.access_token_enc, null);
  assert.deepEqual(w.logs, [
    // 12d: the read found no sealed copy and tried to seal it (no keys), then
    // the refresh's own write.
    "[calendar-token-crypto] seal_failed reason=keys_invalid",
    "[calendar-token] read=plaintext sealed_now=false",
    "[calendar-token-crypto] seal_failed reason=keys_invalid",
  ]);
  for (const l of w.logs)
    assert.ok(!l.includes(fresh) && !l.includes(refresh) && !l.includes(KEY_1));
  setKeys({ k1: KEY_1 }, "k1");
});

test("the sealed write fails: the connect still succeeds, the row is plaintext-only with the sealed columns cleared, one reason-code line", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  w.failSealWrite = true;
  const access = tok("access");
  assert.deepEqual(
    await connect("m-sealfail", { accessToken: access, refreshToken: tok("refresh") }),
    { ok: true },
  );
  const stored = w.rows[0];
  assert.equal(stored.access_token, access);
  assert.deepEqual(
    [stored.access_token_enc, stored.refresh_token_enc, stored.token_key_id],
    [null, null, null],
  );
  assert.deepEqual(w.logs, ["[calendar-token-crypto] seal_failed reason=write_57014"]);
});

// Negative control: put an id back into storeTokens' upsert (a generated
// one, as the first 12b draft did) and this test fails: the second connect
// changes the row's id under the refresh, whose sealed copy then never opens.
test("a reconnect racing a token refresh: the row's id never changes, so every sealed copy opens for the stored row", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  await connect("m-race", { accessToken: tok("access"), refreshToken: tok("refresh") });
  const idBefore = w.rows[0].id;
  w.rows[0].expires_at = new Date(Date.now() - 1000).toISOString();

  // 1. A refresh reads the row and waits on Google.
  let release: () => void = () => {};
  w.refreshGate = new Promise((r) => {
    release = r;
  });
  const fresh = tok("access");
  w.refreshed = {
    accessToken: fresh,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const refreshing = capture(() => getAccessToken("m-race", "google"));
  await new Promise((r) => setTimeout(r, 5));

  // 2. Meanwhile the host reconnects.
  await connect("m-race", { accessToken: tok("access"), refreshToken: null });

  // 3. The refresh lands last.
  release();
  assert.equal(await refreshing, fresh);
  w.refreshGate = undefined;

  const stored = w.rows[0];
  assert.equal(w.rows.length, 1);
  assert.equal(stored.id, idBefore, "the id the refresh read is still the row's id");
  assert.equal(stored.access_token, fresh, "last writer wins, as before 12b");
  assert.equal(opened(stored).access, fresh, "and its sealed copy opens for the stored row");
  assert.equal(opened(stored).refresh, stored.refresh_token);
});

// Negative control: drop `.eq("updated_at", now)` from storeTokens' sealed
// write and this test fails: the connect's older token would be sealed over
// the refresh's newer one.
test("a refresh lands between the upsert and its sealed write: the sealed write stands down, the refresh's copy stays", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const w = world();
  const newer = tok("access");
  w.onUpsert = (row) => {
    w.onUpsert = undefined;
    // What getAccessToken's write does, for this row, a moment later.
    Object.assign(row, {
      ...tokenColumns(
        { id: row.id, memberId: row.member_id, provider: row.provider },
        { accessToken: newer, refreshToken: null, storedRefreshToken: row.refresh_token },
      ),
      updated_at: new Date(Date.now() + 1000).toISOString(),
    });
  };
  await connect("m-between", { accessToken: tok("access"), refreshToken: tok("refresh") });
  const stored = w.rows[0];
  assert.equal(stored.access_token, newer);
  assert.equal(opened(stored).access, newer, "the sealed copy matches the plaintext the row holds");
});

/* ── 12c + 12d: every read goes through readTokens ─────────── */

const LATER = () => new Date(Date.now() + 3600_000).toISOString();
const EARLIER = () => new Date(Date.now() - 1000).toISOString();

/** A sealed value with one ciphertext byte flipped: well-formed, but it does not open. */
function tamper(sealed) {
  const [v, id, iv, tag, ct] = sealed.split(".");
  const b = Buffer.from(ct, "base64url");
  b[0] ^= 1;
  return [v, id, iv, tag, b.toString("base64url")].join(".");
}

/** A stored row whose sealed copies hold `sealed` and whose plaintext holds `plain`. */
function storedRow(memberId, { sealed, plain, expiresAt = LATER() }) {
  const id = randomUUID();
  const cols = sealed
    ? tokenColumns(
        { id, memberId, provider: "google" },
        { accessToken: sealed.access, refreshToken: sealed.refresh },
      )
    : { access_token_enc: null, refresh_token_enc: null, token_key_id: null };
  return {
    id,
    company_id: CO,
    member_id: memberId,
    provider: "google",
    provider_account: ACCOUNT.email,
    status: "active",
    expires_at: expiresAt,
    updated_at: "2026-11-24T09:00:00.000Z",
    ...cols,
    access_token: plain.access,
    refresh_token: plain.refresh,
  };
}

// Negative control: make readTokens ignore the sealed copies (read the
// plaintext always) and this test fails.
test("12d: a sealed row is read from its sealed copies, not the plaintext", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const access = tok("access");
  const refresh = tok("refresh");
  const row = storedRow("m-sealed", {
    sealed: { access, refresh },
    plain: { access: "plaintext-decoy-access", refresh: "plaintext-decoy-refresh" },
  });
  const w = world([row]);
  assert.deepEqual(readTokens(row), {
    accessToken: access,
    refreshToken: refresh,
    source: "sealed",
    missingSealed: false,
    openFailed: false,
  });
  assert.equal(await capture(() => getAccessToken("m-sealed", "google")), access);
  assert.deepEqual(w.logs, [], "a sealed read says nothing");
  assert.deepEqual(w.writes, [], "and writes nothing");

  w.rows[0].expires_at = EARLIER();
  w.refreshed = { accessToken: tok("access"), refreshToken: null, expiresAt: LATER() };
  await capture(() => getAccessToken("m-sealed", "google"));
  assert.equal(w.refreshedWith, refresh, "the refresh used the sealed refresh token");
});

test("12c: a row with no sealed copy is read from plaintext and sealed now, for that row", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const access = tok("access");
  const refresh = tok("refresh");
  const w = world([storedRow("m-lazy", { plain: { access, refresh } })]);
  assert.equal(await capture(() => getAccessToken("m-lazy", "google")), access);
  const stored = w.rows[0];
  assert.deepEqual(opened(stored), { access, refresh, keyOfAccess: "k1", keyOfRefresh: "k1" });
  assert.equal(stored.token_key_id, "k1");
  assert.deepEqual(w.logs, ["[calendar-token] read=plaintext sealed_now=true"]);
  const seal = w.writes.at(-1)[1];
  assert.ok(
    !("access_token" in seal) && !("refresh_token" in seal),
    "the plaintext is not rewritten",
  );
});

// Negative control: drop `.eq("updated_at", row.updated_at)` from
// sealIfMissing and this test fails.
test("12c: the lazy seal stands down when the row changed after it was read", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const access = tok("access");
  const w = world([storedRow("m-moved", { plain: { access, refresh: tok("refresh") } })]);
  // A write lands between the read and the lazy seal (a refresh elsewhere).
  w.onRead = () => {
    w.onRead = undefined;
    w.rows[0].updated_at = "2026-11-24T09:00:05.000Z";
  };
  assert.equal(await capture(() => getAccessToken("m-moved", "google")), access);
  assert.equal(w.rows[0].access_token_enc, null, "nothing sealed over a row that moved");
  assert.deepEqual(w.logs, ["[calendar-token] read=plaintext sealed_now=false"]);
});

test("12d: a sealed copy that does not open (tampered, or its key gone) falls back to plaintext, is logged, and is NOT re-sealed", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const access = tok("access");
  const refresh = tok("refresh");
  const row = storedRow("m-bad", { sealed: { access, refresh }, plain: { access, refresh } });
  row.access_token_enc = tamper(row.access_token_enc);
  const w = world([row]);
  assert.equal(await capture(() => getAccessToken("m-bad", "google")), access);
  assert.deepEqual(w.logs, ["[calendar-token] open_failed reason=auth_failed"]);
  assert.equal(w.rows[0].access_token_enc, row.access_token_enc, "left for the right key");
  assert.deepEqual(w.writes, []);

  // The key that sealed it is no longer configured.
  const oldKeyRow = storedRow("m-oldkey", {
    sealed: { access, refresh },
    plain: { access, refresh },
  });
  setKeys({ k2: KEY_2 }, "k2");
  const w2 = world([oldKeyRow]);
  assert.equal(await capture(() => getAccessToken("m-oldkey", "google")), access);
  assert.deepEqual(w2.logs, [
    "[calendar-token] open_failed reason=unknown_key",
    "[calendar-token] open_failed reason=unknown_key",
  ]);
  assert.deepEqual(w2.writes, [], "a copy under a key we lack is never overwritten");
  setKeys({ k1: KEY_1 }, "k1");

  // One copy does not open and the other is missing: still nothing re-sealed,
  // the lazy path stands down for the whole row.
  // Negative control: drop the openFailed check in sealIfMissing and this fails.
  const mixed = storedRow("m-mixed", { sealed: { access, refresh }, plain: { access, refresh } });
  mixed.access_token_enc = tamper(mixed.access_token_enc);
  mixed.refresh_token_enc = null;
  const w3 = world([mixed]);
  assert.equal(await capture(() => getAccessToken("m-mixed", "google")), access);
  assert.deepEqual(w3.writes, [], "the failing copy is not overwritten by a lazy seal");
  assert.deepEqual(w3.logs, [
    "[calendar-token] open_failed reason=auth_failed",
    "[calendar-token] read=plaintext sealed_now=false",
  ]);
});

test("12d: nothing usable (sealed copies that do not open, no plaintext): the reconnect-needed state, no throw", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const row = storedRow("m-dead", {
    sealed: { access: tok("access"), refresh: tok("refresh") },
    plain: { access: null, refresh: null },
    expiresAt: EARLIER(),
  });
  setKeys({ k2: KEY_2 }, "k2");
  const w = world([row]);
  assert.equal(await capture(() => getAccessToken("m-dead", "google")), null);
  assert.equal(w.rows[0].status, "error", "marked for the recruiter to reconnect");
  assert.ok(w.rows[0].last_error, "with the existing message");
  assert.deepEqual(w.logs, [
    "[calendar-token] open_failed reason=unknown_key",
    "[calendar-token] open_failed reason=unknown_key",
  ]);
  setKeys({ k1: KEY_1 }, "k1");
});

test("12d: disconnect revokes with whichever copy opens: the sealed one, else the plaintext", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const refresh = tok("refresh");
  const w = world([
    storedRow("m-rev", {
      sealed: { access: tok("access"), refresh },
      plain: { access: "plaintext-decoy-access", refresh: "plaintext-decoy-refresh" },
    }),
  ]);
  assert.deepEqual(await capture(() => disconnect("m-rev", "google")), {
    deleted: true,
    revokedAtProvider: true,
  });
  assert.deepEqual(w.revoked, [refresh], "the sealed refresh token was revoked");
  assert.deepEqual(w.rows, []);

  const plainRefresh = tok("refresh");
  const row = storedRow("m-rev2", {
    sealed: { access: tok("access"), refresh: tok("refresh") },
    plain: { access: tok("access"), refresh: plainRefresh },
  });
  row.refresh_token_enc = tamper(row.refresh_token_enc);
  const w2 = world([row]);
  await capture(() => disconnect("m-rev2", "google"));
  assert.deepEqual(
    w2.revoked,
    [plainRefresh],
    "a copy that does not open: the plaintext is revoked",
  );
});

test("12d: no token or key in any log line of any read path", async () => {
  setKeys({ k1: KEY_1 }, "k1");
  const secrets = [];
  const t = (p) => {
    const v = tok(p);
    secrets.push(v);
    return v;
  };
  const rows = [
    storedRow("m-l1", {
      sealed: { access: t("a"), refresh: t("r") },
      plain: { access: t("a"), refresh: t("r") },
    }),
    storedRow("m-l2", { plain: { access: t("a"), refresh: t("r") } }),
  ];
  const bad = storedRow("m-l3", {
    sealed: { access: t("a"), refresh: t("r") },
    plain: { access: t("a"), refresh: t("r") },
  });
  bad.access_token_enc = tamper(bad.access_token_enc);
  rows.push(bad);
  const w = world(rows);
  for (const m of ["m-l1", "m-l2", "m-l3"]) await capture(() => getAccessToken(m, "google"));
  await capture(() => disconnect("m-l1", "google"));
  const all = w.logs.join("\n");
  for (const secret of [
    ...secrets,
    KEY_1,
    ...rows.flatMap((r) => [r.access_token_enc, r.refresh_token_enc]).filter(Boolean),
  ]) {
    assert.ok(!all.includes(secret), "a token, key or sealed value reached a log");
  }
});
