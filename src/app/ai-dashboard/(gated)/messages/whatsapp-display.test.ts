/**
 * #62: a WhatsApp interview invite on the Messages page reads as what was
 * sent, with a subject, and one sender answer in the list and the detail.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/whatsapp-display.test.ts"
 *
 * The stored row is built the way dispatch.ts builds it
 * (`${template}: ${JSON.stringify(vars)}`, subject null) and read through the
 * real fetchApplicationMessages, which shares its row mapping with the
 * Messages list (hydrate). Display only: nothing is written. Synthetic data.
 */
// @ts-nocheck - same reason as stop-and-pending.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchApplicationMessages } = await import("./actions.ts");
const { displayMessage, senderLine, sentAutomatically, typeLabel, WHATSAPP_TEMPLATE_TITLES } =
  await import("./message-display.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-0000000000a1";
const VARS = {
  candidateName: "Ada",
  companyName: "Acme",
  jobTitle: "Support Engineer",
  minutes: "12",
  deadline: "Friday 27 November",
};
/** Exactly what dispatch.ts messageFor() stores. */
const stored = (template, vars = VARS) => `${template}: ${JSON.stringify(vars)}`;
const plain = (html) => `PLAIN(${html})`;

function world(rows) {
  const service = fakeService((table, calls) => {
    if (table === "job_applications") {
      const a = {
        id: APP,
        job_id: "j-1",
        company_id_snapshot: CO,
        first_name: "Ada",
        last_name: "One",
        email: "ada@example.test",
        job_title_snapshot: "Support Engineer",
        jobs: { title: "Support Engineer" },
      };
      return call(calls, "maybeSingle") ? { data: a, error: null } : { data: [a], error: null };
    }
    if (table !== "communication_logs") throw new Error(`test: unexpected table ${table}`);
    if (call(calls, "update") || call(calls, "insert") || call(calls, "delete")) {
      throw new Error("test: the Messages read must not write");
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    role: "owner",
    memberId: "m-1",
    memberName: "Rae Recruiter",
    user: { id: "u-1", email: "rae@acme.test" },
    company: { id: CO, name: "Acme" },
  };
  return service;
}
const logRow = (over) => ({
  id: "l-1",
  company_id: CO,
  application_id: APP,
  event: "interview",
  status: "sent",
  to_address: "923001234567",
  subject: null,
  body: stored("interview_invitation"),
  scheduled_for: null,
  sent_at: "2026-11-18T10:00:00.000Z",
  sent_by_name: "Rae Recruiter",
  created_at: "2026-11-18T10:00:00.000Z",
  ...over,
});

test("W1. an invitation's stored template and values read as text, under 'Interview invitation'", () => {
  const out = displayMessage({ subject: null, body: stored("interview_invitation") }, plain);
  assert.equal(out.subject, "Interview invitation");
  assert.equal(
    out.body,
    [
      "Interview invitation sent on WhatsApp to Ada.",
      "",
      "Role: Support Engineer at Acme",
      "Takes about: 12 minutes",
      "Complete by: Friday 27 November",
      "",
      "This is a summary of the WhatsApp template message. The exact wording is managed by Meta.",
    ].join("\n"),
  );
  assert.doesNotMatch(out.body, /[{}"]|candidateName|interview_invitation/);
  assert.equal(out.bodySummary, true, "labelled as a summary, not Meta's words");
});

test("W2. the reminder template; a missing first name (dispatch's 'there') is not printed as a name", () => {
  const out = displayMessage(
    { subject: "", body: stored("interview_reminder", { ...VARS, candidateName: "there" }) },
    plain,
  );
  assert.equal(out.subject, "Interview reminder");
  assert.match(out.body, /^Interview reminder sent on WhatsApp\.\n/);
});

test("W3. anything not exactly that shape is shown as stored, never half-read", () => {
  for (const body of [
    stored("some_other_template"),
    "interview_invitation: {not json}",
    stored("interview_invitation", { ...VARS, minutes: 12 }),
    stored("interview_invitation", { candidateName: "Ada" }),
    "<html><p>Hello</p></html>",
    "",
  ]) {
    assert.deepEqual(displayMessage({ subject: null, body }, plain), {
      subject: "",
      body: plain(body),
    });
  }
  // A stored subject is kept even on a template row.
  assert.equal(
    displayMessage({ subject: "Kept", body: stored("interview_invitation") }, plain).subject,
    "Kept",
  );
});

test("W4. one sender answer: the list's Type pill and the detail's line agree for every kind", () => {
  const cases = [
    // [kind, event, sentByName] -> [Type pill, detail line]
    [
      ["automatic", "interview", "Rae Recruiter"],
      ["Template", "Sent by Rae Recruiter"],
    ],
    [
      ["written", "manual", "Rae Recruiter"],
      ["Written", "Written by Rae Recruiter"],
    ],
    [
      ["automatic", "interview", null],
      ["Automatic", "Sent automatically"],
    ],
    [
      ["automatic", null, null],
      ["Automatic", "Sent automatically"],
    ],
    [
      ["written", "manual", null],
      ["Written", "Written by your team"],
    ],
    [
      ["scheduled", "interview", "Rae Recruiter"],
      ["Pending", "Sent by Rae Recruiter"],
    ],
    [
      ["failed", "interview", "Rae Recruiter"],
      ["Failed", "Sent by Rae Recruiter"],
    ],
    [
      ["failed", "manual", "Rae Recruiter"],
      ["Failed", "Written by Rae Recruiter"],
    ],
  ];
  for (const [[kind, event, sentByName], [pill, line]] of cases) {
    const row = { kind, event, sentByName };
    assert.equal(typeLabel(row), pill, `${kind}/${event}/${sentByName} pill`);
    assert.equal(senderLine(row), line, `${kind}/${event}/${sentByName} line`);
    // Never both "Automatic" and a person.
    assert.ok(!(pill === "Automatic" && sentByName), "a person's send is never Automatic");
  }
});

test("W5. an EXISTING stored row, through the real read: subject, readable body, Sent by the recruiter", async () => {
  const service = world([logRow({})]);
  const read = await fetchApplicationMessages(APP);
  assert.equal(read.ok, true);
  const [row] = read.rows;
  assert.equal(row.subject, "Interview invitation");
  assert.match(row.body, /^Interview invitation sent on WhatsApp to Ada\./);
  assert.doesNotMatch(row.body, /candidateName|[{}]/);
  assert.equal(row.kind, "automatic", "the row's type, tab and counts are unchanged");
  assert.equal(typeLabel(row), "Template");
  assert.equal(senderLine(row), "Sent by Rae Recruiter");
  // An automatic invite (no sender) reads as automatic, with the same text.
  world([logRow({ sent_by_name: null })]);
  const auto = (await fetchApplicationMessages(APP)).rows[0];
  assert.equal(typeLabel(auto), "Automatic");
  assert.equal(senderLine(auto), "Sent automatically");
  assert.equal(auto.subject, "Interview invitation");
  // An email row is untouched: HTML to text as before.
  world([
    logRow({ event: "rejected", subject: "Update", body: "<p>Hello</p>", sent_by_name: null }),
  ]);
  const email = (await fetchApplicationMessages(APP)).rows[0];
  assert.equal(email.subject, "Update");
  assert.equal(email.body.trim(), "Hello");
  assert.ok(!service.queries.some((q) => call(q.calls, "update") || call(q.calls, "insert")));
});

test("W6. the template names match what dispatch sends, and the stored shape is the one parsed", () => {
  const send = readFileSync(new URL("../../../../lib/whatsapp/send.ts", import.meta.url), "utf8");
  const block = /WHATSAPP_TEMPLATES = \{([\s\S]*?)\}/.exec(send)[1];
  const names = [...block.matchAll(/(\w+): "(\w+)"/g)].map((m) => m[2]).sort();
  assert.deepEqual(Object.keys(WHATSAPP_TEMPLATE_TITLES).sort(), names);
  const dispatch = readFileSync(
    new URL("../../../../lib/whatsapp/dispatch.ts", import.meta.url),
    "utf8",
  );
  assert.match(dispatch, /body: `\$\{template\}: \$\{JSON\.stringify\(vars\)\}`/);
  for (const k of Object.keys(VARS)) assert.match(dispatch, new RegExp(`\\b${k}[:,]`));
});

test("W7. the list and the detail both take their sender words from message-display.ts", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(client, /\{typeLabel\(row\)\}/);
  assert.match(client, /const provenance = senderLine\(row\);/);
  assert.doesNotMatch(client, /`Written by \$\{row\.sentByName\}`/);
  assert.doesNotMatch(client, /\{MESSAGE_KIND_LABELS\[row\.kind\]\}/);
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(actions, /\.\.\.displayMessage\(l, htmlToPlain\),/);
});

test("W8. the detail labels a rebuilt body 'Message summary'; a real body carries no label", async () => {
  world([logRow({})]);
  assert.equal((await fetchApplicationMessages(APP)).rows[0].bodySummary, true);
  world([
    logRow({ event: "rejected", subject: "Update", body: "<p>Hello</p>", sent_by_name: null }),
  ]);
  assert.equal("bodySummary" in (await fetchApplicationMessages(APP)).rows[0], false);
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(
    client,
    /\{row\.bodySummary && \(\s*<p\s+data-message-summary[^>]*>\s*Message summary\s*<\/p>\s*\)\}/,
  );
});

test("W9. the applicant drawer uses the same rule: a recruiter's send names them, Automatic only when nobody sent it", () => {
  const rows = [
    [{ kind: "automatic", event: "interview", sentByName: "Rae Recruiter" }, false],
    [{ kind: "automatic", event: "interview", sentByName: null }, true],
    [{ kind: "automatic", event: null, sentByName: null }, true],
    [{ kind: "written", event: "manual", sentByName: null }, false],
    [{ kind: "failed", event: "interview", sentByName: null }, false],
  ];
  for (const [row, auto] of rows) assert.equal(sentAutomatically(row), auto, JSON.stringify(row));
  const drawer = readFileSync(
    new URL("../applicants/_applicants-client.tsx", import.meta.url),
    "utf8",
  );
  // The trail line: its pill is the Messages Type label, its styling follows the rule.
  assert.match(drawer, /const automatic = sentAutomatically\(message\);/);
  assert.match(drawer, /\{\(automatic \|\| template\) && \([\s\S]{0,260}\{typeLabel\(message\)\}/);
  assert.doesNotMatch(drawer, /const automatic = message\.kind === "automatic";/);
  // The timeline: the system actor only when nobody sent it, otherwise the sender's name.
  assert.match(
    drawer,
    /const automatic = sentAutomatically\(m\);\s*const name = automatic \? AUTO_ACTOR : \(m\.sentByName \?\? "Someone"\);/,
  );
  assert.doesNotMatch(drawer, /const automatic = m\.kind === "automatic";/);
});
