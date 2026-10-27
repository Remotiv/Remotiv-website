/**
 * AVI commit 10: the live screen's state (machine.ts) and every screen it
 * draws (screens.tsx), rendered with react-dom/server. Plus the copy rule:
 * hyphens only, read from the TypeScript AST of every string the live screen,
 * its server routes and the "ended" link screen can show (comments exempt).
 *
 *   node --test "src/app/interview/?token?/_live/live-screens.test.ts"   (?token? matches [token]: brackets would be read as a glob)
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import ts from "typescript";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const { INITIAL, liveReducer, endingFrom } = await import("./machine.ts");
const { LiveScreens } = await import("./screens.tsx");
const { ENDING, BLOCKED, endingNote } = await import("./copy.ts");
const { TerminalScreen } = await import("../_terminal.tsx");

const go = (...actions) => actions.reduce(liveReducer, INITIAL);
const T = (event) => ({ t: "transport", event });
const JOIN = { ok: true, join: { mode: "mock", script: "completed", turnDetection: "server" } };
const IN_INTERVIEW = [
  { t: "begin" },
  { t: "consent_result", answer: "saved" },
  { t: "start" },
  { t: "start_result", answer: JOIN },
  T({ type: "started" }),
];

/* ── the machine ──────────────────────────────────────────────── */

test("the way through: welcome, consent, check, connecting, interview, saving, done", () => {
  let s = INITIAL;
  const seen = [s.screen];
  for (const a of [
    ...IN_INTERVIEW,
    T({ type: "ended", endReason: "completed", graceful: true }),
    { t: "video_saved" },
  ]) {
    s = liveReducer(s, a);
    if (seen.at(-1) !== s.screen) seen.push(s.screen);
  }
  assert.deepEqual(seen, [
    "welcome",
    "consent",
    "check",
    "connecting",
    "interview",
    "saving",
    "done",
  ]);
  assert.equal(s.ending, "completed");
});

test("the ending shown: completed needs graceful too (F15); End then the provider's end is the candidate's", () => {
  assert.equal(endingFrom("completed", true), "completed");
  assert.equal(endingFrom("completed", false), "other");
  assert.equal(endingFrom("candidate_left", false), "candidate_ended");
  assert.equal(endingFrom("timed_out", false), "timed_out");
  assert.equal(endingFrom(null, null), "other");
  assert.equal(go(...IN_INTERVIEW, T({ type: "dropped" })).ending, "connection_lost");
  assert.equal(go(...IN_INTERVIEW, T({ type: "error", code: "x" })).ending, "provider_error");
});

test("End: asked to confirm first; Keep going cancels; confirmed waits for the provider; no answer shows the candidate's end", () => {
  const asked = go(...IN_INTERVIEW, { t: "end_requested" });
  assert.equal(asked.confirmingEnd, true);
  assert.equal(liveReducer(asked, { t: "end_cancelled" }).confirmingEnd, false);
  const confirmed = liveReducer(asked, { t: "end_confirmed" });
  assert.deepEqual(
    [confirmed.screen, confirmed.endPressed, confirmed.ending],
    ["interview", true, null],
  );
  assert.equal(
    liveReducer(confirmed, T({ type: "ended", endReason: "candidate_left", graceful: false }))
      .ending,
    "candidate_ended",
  );
  assert.equal(liveReducer(confirmed, { t: "end_timeout" }).ending, "candidate_ended");
  assert.equal(
    liveReducer(go(...IN_INTERVIEW), { t: "end_timeout" }).ending,
    null,
    "not without End",
  );
});

test("what ended it is kept with the ending: session_complete with its reason, a drop, an error, no answer to End", () => {
  assert.deepEqual(
    go(...IN_INTERVIEW, T({ type: "ended", endReason: "completed", graceful: true })).endCause,
    {
      kind: "session_complete",
      endReason: "completed",
      graceful: true,
    },
  );
  assert.deepEqual(go(...IN_INTERVIEW, T({ type: "dropped" })).endCause, { kind: "dropped" });
  assert.deepEqual(go(...IN_INTERVIEW, T({ type: "error", code: "provider_error" })).endCause, {
    kind: "error",
    code: "provider_error",
  });
  const noAnswer = go(
    ...IN_INTERVIEW,
    { t: "end_requested" },
    { t: "end_confirmed" },
    { t: "end_timeout" },
  );
  assert.deepEqual(
    [noAnswer.ending, noAnswer.endCause],
    ["candidate_ended", { kind: "no_answer_to_end" }],
  );
  assert.equal(go(...IN_INTERVIEW).endCause, null);
});

test("the first end wins: nothing after it changes the screen or the ending", () => {
  const ended = go(...IN_INTERVIEW, T({ type: "dropped" }));
  for (const e of [
    { type: "ended", endReason: "completed", graceful: true },
    { type: "error", code: "x" },
    { type: "agent", state: "speaking" },
    { type: "agent_text", text: "late" },
  ]) {
    assert.deepEqual(liveReducer(ended, T(e)), ended, e.type);
  }
});

test("the interview: speaking, listening, thinking, captions, interruptions counted, time up shown", () => {
  let s = go(...IN_INTERVIEW);
  s = liveReducer(s, T({ type: "agent", state: "speaking" }));
  s = liveReducer(s, T({ type: "agent_text", text: "Tell me about a project." }));
  s = liveReducer(s, T({ type: "interrupted" }));
  s = liveReducer(s, T({ type: "agent", state: "listening" }));
  s = liveReducer(s, { t: "time_up" });
  assert.deepEqual(
    [s.agent, s.caption, s.interruptions, s.timeUp],
    ["listening", "Tell me about a project.", 1, true],
  );
  assert.equal(s.screen, "interview", "time up does not end it: the provider does");
});

test("start: busy and failures go to 'try again' (nothing used up); consent needed goes back; the rest block", () => {
  const atCheck = go({ t: "begin" }, { t: "consent_result", answer: "saved" });
  const busy = liveReducer(liveReducer(atCheck, { t: "start" }), {
    t: "start_result",
    answer: { ok: false, reason: "busy", retryAfterSeconds: 30 },
  });
  assert.equal(busy.screen, "busy");
  assert.equal(liveReducer(busy, { t: "start" }).screen, "connecting", "Try again starts again");
  const fail = (reason) =>
    liveReducer(liveReducer(atCheck, { t: "start" }), {
      t: "start_result",
      answer: { ok: false, reason },
    });
  assert.equal(fail("unavailable").screen, "busy");
  assert.equal(fail("consent_required").screen, "consent");
  assert.deepEqual(
    [fail("already_started").screen, fail("already_started").blocked],
    ["blocked", "already_started"],
  );
  assert.equal(fail("locked").blocked, "locked");
  assert.equal(
    liveReducer(liveReducer(atCheck, { t: "start" }), { t: "transport_failed" }).blocked,
    "unavailable",
  );
});

test("consent: saved continues; a failed save stays with an error; locked and closed block", () => {
  const atConsent = go({ t: "begin" }, { t: "consent_saving" });
  assert.equal(atConsent.savingConsent, true);
  const failed = liveReducer(atConsent, { t: "consent_result", answer: "failed" });
  assert.deepEqual(
    [failed.screen, failed.consentFailed, failed.savingConsent],
    ["consent", true, false],
  );
  assert.equal(liveReducer(atConsent, { t: "consent_result", answer: "locked" }).blocked, "locked");
  assert.equal(liveReducer(atConsent, { t: "consent_result", answer: "closed" }).blocked, "closed");
});

test("another tab: blocked before the interview, and 'Continue in this tab' goes back to the start", () => {
  const dup = liveReducer(INITIAL, { t: "block", blocked: "duplicate" });
  assert.equal(dup.blocked, "duplicate");
  assert.deepEqual([liveReducer(dup, { t: "unblock" }).screen], ["welcome"]);
  const phone = liveReducer(INITIAL, { t: "block", blocked: "phone" });
  assert.deepEqual(liveReducer(phone, { t: "unblock" }), phone, "only a duplicate tab unblocks");
});

/* ── the screens ──────────────────────────────────────────────── */

const CONSENT = {
  heading: "Before you start",
  intro: "Please read these.",
  rows: [{ lead: "Your interviewer is an AI", body: "Maya is an AI interviewer." }],
  smallPrint: "Small print.",
  checkbox: "I agree to be recorded.",
  version: "live-v1",
};

function render(state, over = {}) {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(LiveScreens, {
      state,
      companyName: "Acme Ltd",
      interviewer: "Maya",
      minutes: 20,
      questionCount: 8,
      consent: CONSENT,
      agreed: false,
      check: {
        cam: "pend",
        mic: "pend",
        net: "pend",
        micLevel: 0,
        fault: null,
        asked: false,
        requesting: false,
        platform: "desktop-chrome",
      },
      previewRef: noop,
      micLevel: 0.5,
      timeLeftSeconds: 754,
      pieces: [],
      on: new Proxy({}, { get: () => noop }),
      ...over,
    }),
  );
}
const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

test("welcome: who, how long, how many, computer only, one go; never the questions", () => {
  const html = text(render(INITIAL));
  assert.match(html, /A spoken conversation with Maya, Acme Ltd's AI interviewer/);
  assert.match(html, /About 8 questions, up to 20 minutes/);
  assert.match(html, /On a computer/);
  assert.match(html, /can't be paused or started again/);
});

test("consent: the live text, the privacy link, the box; no consent text shows the closed screen", () => {
  const html = render(go({ t: "begin" }));
  assert.match(html, /data-live-screen="consent"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /I agree to be recorded\./);
  assert.match(html, /disabled=""[^>]*>Agree and continue/);
  const locked = render(go({ t: "begin" }), { consent: null });
  assert.match(locked, /data-blocked="locked"/);
  assert.match(text(locked), /isn't open yet/);
});

test("check: blocked camera shows the steps for this browser; passed shows Start and what is recorded", () => {
  const atCheck = go({ t: "begin" }, { t: "consent_result", answer: "saved" });
  const blocked = text(
    render(atCheck, {
      check: {
        cam: "bad",
        mic: "bad",
        net: "ok",
        micLevel: 0,
        fault: "blocked",
        asked: false,
        requesting: false,
        platform: "desktop-safari",
      },
    }),
  );
  assert.match(blocked, /Camera or microphone blocked for this site/);
  assert.match(blocked, /Open Safari, then Settings, then Websites/);
  assert.doesNotMatch(blocked, /Allow camera and microphone/, "Try again, not a second Allow");
  const passed = render(atCheck, {
    check: {
      cam: "ok",
      mic: "ok",
      net: "ok",
      micLevel: 0.6,
      fault: null,
      asked: true,
      requesting: false,
      platform: "desktop-chrome",
    },
  });
  assert.match(passed, /<button[^>]*class="iv-btn iv-purple"[^>]*>Start the interview/);
  assert.doesNotMatch(passed, /disabled=""[^>]*>Start the interview/);
  assert.match(text(passed), /recorded from then until the end/);
});

test("interview: the interviewer's state and caption, the candidate's camera and level, time left, End; no Done button", () => {
  let s = go(
    ...IN_INTERVIEW,
    T({ type: "agent", state: "listening" }),
    T({ type: "agent_text", text: "Tell me about a project." }),
  );
  const html = render(s);
  assert.match(html, /data-agent="listening"/);
  assert.match(
    html,
    /role="status" aria-live="polite"[^>]*data-caption="true">Tell me about a project\./,
  );
  assert.match(html, /<video/);
  assert.match(text(html), /Time left 12:34/);
  assert.match(html, /data-action="end"/);
  assert.match(text(html), /Answer out loud\. Maya will continue when you've finished\./);
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(
    buttons,
    ["End interview"],
    "End is the only control: no Done speaking button (D6)",
  );
  s = liveReducer(s, { t: "end_requested" });
  const confirm = text(render(s));
  assert.match(confirm, /End the interview now\? You can't continue it afterwards\./);
  assert.match(confirm, /Keep going/);
});

test("saving: holds until every piece is saved; a failed piece offers Try again", () => {
  const s = go(...IN_INTERVIEW, T({ type: "dropped" }));
  const holding = render(s, {
    pieces: [
      { index: 0, state: "saved", bytes: 1 },
      { index: 1, state: "uploading", bytes: 1 },
    ],
  });
  assert.match(holding, /data-pieces-saved="1" data-pieces-total="2"/);
  assert.match(text(holding), /keep this page open/);
  const failed = text(render(s, { pieces: [{ index: 0, state: "failed", bytes: 1 }] }));
  assert.match(failed, /hasn't uploaded yet/);
  assert.match(failed, /Try again/);
});

test("every ending and every block has its own words; none claims an outcome or offers a restart", () => {
  for (const ending of Object.keys(ENDING)) {
    const s = { ...go(...IN_INTERVIEW, T({ type: "dropped" }), { t: "video_saved" }), ending };
    const html = render(s);
    assert.match(html, new RegExp(`data-ending="${ending}"`));
    assert.doesNotMatch(
      text(html),
      /passed|failed the|score|start again|restart|try the interview again/i,
      ending,
    );
  }
  for (const blocked of Object.keys(BLOCKED)) {
    const html = render({ ...INITIAL, screen: "blocked", blocked });
    assert.match(html, new RegExp(`data-blocked="${blocked}"`));
  }
  assert.match(
    text(render({ ...INITIAL, screen: "blocked", blocked: "phone" })),
    /Please open this link on a computer/,
  );
  assert.match(text(render({ ...INITIAL, screen: "busy" })), /Please try again shortly/);
});

test("the demo's ending note names the ending and what the provider sent; a candidate's screen never shows it", () => {
  const done = go(...IN_INTERVIEW, T({ type: "ended", endReason: "completed", graceful: true }), {
    t: "video_saved",
  });
  assert.doesNotMatch(render(done), /data-ending-note/, "off by default");
  const shown = text(render(done, { showEnding: true }));
  assert.match(
    shown,
    /Demo: ending "completed"\. The provider sent: session_complete, end_reason "completed", completed_gracefully true\./,
  );
  const dropped = go(...IN_INTERVIEW, T({ type: "dropped" }), { t: "video_saved" });
  assert.match(
    text(render(dropped, { showEnding: true })),
    /ending "connection_lost"\. The provider sent: the connection closed without session_complete\./,
  );
  assert.equal(
    endingNote("other", { kind: "session_complete", endReason: "completed", graceful: false }),
    'Demo: ending "other". The provider sent: session_complete, end_reason "completed", completed_gracefully false.',
    "completed but not graceful is not shown as completed (F15)",
  );
  // The real page never asks for it.
  const page = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /showEnding/);
});

test("the link after it has started: 'This interview has ended', never a way to start again", () => {
  const html = text(
    renderToStaticMarkup(createElement(TerminalScreen, { kind: "ended", companyName: "Acme Ltd" })),
  );
  assert.match(html, /This interview has ended/);
  assert.match(html, /can't start another one/);
});

/* ── hyphens only ─────────────────────────────────────────────── */

/** Every string literal, template piece and JSX text in a file: what can reach a screen. */
function strings(path) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  const file = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      out.push(node.text);
    else if (ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

test("hyphens only: no em or en dash in any string the live screen, its routes or the ended screen can show", () => {
  const files = [
    "./copy.ts",
    "./screens.tsx",
    "./live-flow.tsx",
    "./machine.ts",
    "./mock-voxagent.ts",
    "./live-server.ts",
    "./transport.ts",
    "./video-pieces.ts",
    "../../preview-live/_preview-live.tsx",
    "../../preview-live/page.tsx",
    "../../../../lib/interviews/live-start.ts",
    "../../../../lib/interviews/live-events.ts",
    "../../../../lib/interviews/live-event-codes.ts",
    "../../../api/interview/live/start/route.ts",
    "../../../api/interview/live/consent/route.ts",
    "../../../api/interview/live/event/route.ts",
  ];
  let checked = 0;
  for (const f of files) {
    for (const s of strings(f)) {
      checked += 1;
      assert.doesNotMatch(s, /[–—]/, `${f}: ${s.slice(0, 80)}`);
    }
  }
  assert.ok(checked > 200, `read ${checked} strings`);
  // The ended screen in _terminal.tsx: only its own block (the file's older copy is not this commit's).
  const terminal = readFileSync(new URL("../_terminal.tsx", import.meta.url), "utf8");
  const block = terminal.slice(
    terminal.indexOf('if (kind === "ended")'),
    terminal.indexOf('if (kind === "no-questions")'),
  );
  assert.ok(block.includes("This interview has ended"));
  const jsx = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(jsx, /[–—]/);
  // Control: the check does catch a dash.
  assert.match("a — b", /[–—]/);
});
