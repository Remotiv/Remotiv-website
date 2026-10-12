/**
 * Recording step 3, from the source: the route verifies before anything
 * reads the body, the webhook never calls Recall or consults the flag, the
 * alerts go to the host alone through an atomic claim, and nothing logs what
 * it must not. Each pin names the line that carries a rule.
 *
 *   node --test src/lib/final-interviews/webhook-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

const ROUTE = "src/app/api/webhooks/recall/route.ts";
const BOTS = "src/lib/final-interviews/bots.ts";
const ALERTS = "src/lib/final-interviews/alerts.ts";
const VERIFY = "src/lib/recall/verify.ts";

function body(text, signature) {
  const from = text.indexOf(signature);
  assert.ok(from >= 0, `cannot find ${signature}`);
  const rest = text.slice(from + signature.length);
  const next = rest.search(/\n(export )?(async )?function |\nexport const |\nconst [A-Z_]+ =/);
  return text.slice(from, next >= 0 ? from + signature.length + next : undefined);
}

test("the route exports POST and config only, and hands the raw body over unparsed", () => {
  const route = code(read(ROUTE));
  const exported = [...route.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(exported.sort(), ["POST", "dynamic", "runtime"]);
  assert.doesNotMatch(route, /JSON\.parse|request\.json\(\)/, "the route never parses");
  assert.match(route, /secret: process\.env\.RECALL_WEBHOOK_SECRET,/);
  assert.match(route, /const MAX_BODY_BYTES = 256 \* 1024;/);
});

test("proxy.ts puts no login in front of the webhook", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /matcher: \["\/admin\/:path\*", "\/ai-dashboard\/:path\*"\]/);
});

test("the signature is checked before the body is parsed or the database is reached", () => {
  const receive = code(body(code(read(BOTS)), "export async function receiveRecallWebhook("));
  const verifyAt = receive.indexOf("verifyRecallWebhook(");
  const refuseAt = receive.indexOf("if (!verified.ok) {");
  const parseAt = receive.indexOf("JSON.parse(");
  const dbAt = receive.indexOf("createServiceClient()");
  assert.ok(verifyAt >= 0 && refuseAt > verifyAt && parseAt > refuseAt && dbAt > parseAt);
  assert.match(receive, /return \{ status: 503, outcome: "not_configured" \};/);
  assert.match(receive, /return \{ status: 401, outcome: "unauthorized" \};/);
});

test("the webhook path never calls Recall and never consults the recording flag", () => {
  const raw = read(BOTS);
  const start = raw.indexOf("export type WebhookDeps");
  const end = raw.indexOf("/* ── the job handler");
  assert.ok(start > 0 && end > start, "webhook section found");
  const webhook = code(raw.slice(start, end));
  assert.ok(webhook.length > 1000);
  assert.doesNotMatch(
    webhook,
    /recall\.|getRecallClient|workerDeps|isRecallRecordingEnabled|enabled\(\)/,
  );
  assert.doesNotMatch(read(ROUTE), /@\/lib\/recall\/client|isRecallRecordingEnabled/);
});

test("lifecycle writes are one conditional UPDATE guarded by the timestamp and the terminal states", () => {
  const apply = body(code(read(BOTS)), "async function applyLifecycleEvent(");
  assert.match(apply, /\.not\("status", "in", '\("deleted","superseded","fatal"\)'\)/);
  assert.match(apply, /\.or\(`last_event_at\.is\.null,last_event_at\.lt\."\$\{event\.at\}"`\)/);
  assert.match(apply, /\.eq\("provider_bot_id", event\.botId as string\)/);
  assert.doesNotMatch(apply, /provider_recording_id|import_status/);
});

test("the recording stream stores the id once and touches no status, import or media", () => {
  const rec = body(code(read(BOTS)), "async function applyRecordingEvent(");
  assert.match(rec, /\.update\(\{ provider_recording_id: event\.recordingId \}\)/);
  assert.match(rec, /\.is\("provider_recording_id", null\)/);
  assert.equal(rec.split(".update(").length - 1, 1, "one write, the recording id");
  assert.doesNotMatch(
    rec,
    /import_status|import_error|last_event_|deleteRecording|final_recording_import|status: "/,
  );
});

test("the unknown-bot rule deletes only Remotiv's bot whose row is genuinely gone", () => {
  const unknown = body(code(read(BOTS)), "async function handleUnknownBot(");
  const marker = unknown.indexOf("meta?.integration !== RECORDING_BOT_INTEGRATION");
  const ids = unknown.indexOf("!isRecallId(meta.botRowId)");
  const lookup = unknown.indexOf('.eq("id", meta.botRowId)');
  const dbErr = unknown.indexOf('if (error) return { status: 503, outcome: "db_unavailable" };');
  const cleanup = unknown.indexOf('action: "delete"');
  assert.ok(marker >= 0 && ids > marker && lookup > ids && dbErr > lookup && cleanup > dbErr);
  assert.doesNotMatch(unknown, /\.insert\(/, "no row is ever created from a webhook");
});

test("alerts: one atomic claim on the stamp, the host alone, no fan-out, no fallback inbox", () => {
  const alerts = code(read(ALERTS));
  const run = body(alerts, "export async function runFinalBotAlert(");
  assert.match(run, /\.update\(\{ \[stamp\]: claimedAt \}\)[\s\S]{0,200}\.is\(stamp, null\)/);
  assert.match(run, /\.eq\(stamp, claimedAt\)/, "the release only takes back its own claim");
  assert.match(run, /memberId: host\.id,/);
  assert.doesNotMatch(alerts, /notifyCompany\(|resolveHostEmail|contact_email/);
  assert.match(run, /\.eq\("company_id_snapshot", row\.company_id\)/);
  assert.match(
    run,
    /if \(fi\.host_member_id !== booking\.host_member_id\) return "host_mismatch";/,
  );
  // Claim, then send, then bell.
  const claimAt = run.indexOf("is(stamp, null)");
  const sendAt = run.indexOf("deps.sendEmail(");
  const bellAt = run.indexOf("deps.notifyMember(");
  assert.ok(claimAt > 0 && sendAt > claimAt && bellAt > sendAt);
});

test("the two notification types exist and land on the applicant", () => {
  const company = read("src/lib/notifications/company.ts");
  const list = company.slice(
    company.indexOf("COMPANY_NOTIFICATION_TYPES = ["),
    company.indexOf("] as const;"),
  );
  const applicant = company.slice(
    company.indexOf("const APPLICANT_TYPES"),
    company.indexOf("]);", company.indexOf("const APPLICANT_TYPES")),
  );
  for (const t of ["final_recording_lobby", "final_recording_failed"]) {
    assert.ok(list.includes(`"${t}"`), t);
    assert.ok(applicant.includes(`"${t}"`), t);
  }
});

test("no log line in the webhook, alerts or verifier carries a body, secret or personal detail", () => {
  for (const rel of [ROUTE, BOTS, ALERTS, VERIFY]) {
    const lines = code(read(rel))
      .split("\n")
      .filter((l) => /console\.(log|warn|error|info)/.test(l));
    for (const line of lines) {
      // Only interpolated values can leak; fixed words in a sentence cannot.
      for (const [, expr] of line.matchAll(/\$\{([^}]*)\}/g)) {
        // The reconcile report is counts and flags only (ReconcileReport).
        if (expr === "JSON.stringify(report)") continue;
        assert.doesNotMatch(
          expr,
          /rawBody|secret|first_?name|address|email|meeting|metadata|\braw\b|body|payload|JSON\.stringify/i,
          `${rel}: ${line.trim()}`,
        );
      }
      assert.doesNotMatch(
        line,
        /console\.\w+\([^)]*,\s*(event|raw|input|payload|meta|row|host)\)/,
        `${rel}: ${line.trim()}`,
      );
    }
  }
});

test("hyphens, never em dashes, in the alert copy", () => {
  const alerts = read(ALERTS);
  const copy = alerts.slice(
    alerts.indexOf("const FAILURE_REASONS"),
    alerts.indexOf("type Service"),
  );
  const emails = alerts.slice(
    alerts.indexOf("export function lobbyEmail"),
    alerts.indexOf("function defaultDeps"),
  );
  assert.doesNotMatch(copy + emails, /—/);
});
