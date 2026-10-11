/**
 * An in-memory Recall.ai for the recording-bot tests. Same interface as
 * src/lib/recall/client.ts, so the bot logic runs against it unchanged, and it
 * follows the documented rules the logic depends on:
 *
 *   createBot           replays the first result for a repeated Idempotency-Key
 *   listBots            filters on every metadata pair
 *   deleteScheduledBot  'not_allowed' (405) once a bot has any status beyond
 *                       'ready'; 'already_gone' (404) for an unknown bot
 *   leaveCall           'not_in_call' (400) for a bot not in a call; otherwise
 *                       the bot ends: call_ended, then done if it recorded
 *   deleteRecording     removes the recording from its bot; 404 when unknown
 *
 * Every call is logged on `calls` as [method, ...args]. Scripting:
 *   failNext(method, error)   the next call to `method` throws `error`
 *   ambiguousNextCreate()     the next create makes the bot, then throws a
 *                             timeout, as a lost response would
 *   onCreate(fn)              runs `fn(bot)` inside the create, after the bot
 *                             exists and before the response: a booking can
 *                             change while the call is out
 *   beforeDelete(fn)          runs inside deleteScheduledBot before the check
 *   advance(id, codes, { recording })  status changes, optionally a recording
 *   add(bot)                  a bot made outside this test's flow
 *
 * Test-only. Nothing in the application imports this.
 */
import { randomUUID } from "node:crypto";
import { RecallApiError } from "../lib/recall/types.ts";

const clone = (v) => structuredClone(v);
const dispatched = (bot) => (bot.status_changes ?? []).some((c) => c.code !== "ready");
const ENDED = new Set(["call_ended", "recording_done", "done", "fatal", "media_expired"]);
const ended = (bot) => (bot.status_changes ?? []).some((c) => ENDED.has(c.code));

export function timeoutError(operation = "create bot") {
  return new RecallApiError({ operation, status: null, retryable: true, reason: "timed out" });
}

export function httpError(status, operation = "create bot", code = null) {
  return new RecallApiError({
    operation,
    status,
    code,
    retryable: status === 409 || status === 429 || status === 507 || status >= 500,
  });
}

export function fakeRecall() {
  const bots = new Map();
  const idem = new Map();
  const calls = [];
  const failures = [];
  let ambiguous = false;
  let onCreate = null;
  let beforeDelete = null;

  const maybeFail = (method) => {
    const i = failures.findIndex((f) => f.method === method);
    if (i >= 0) {
      const [f] = failures.splice(i, 1);
      throw f.error;
    }
  };
  const stamp = () => new Date().toISOString();

  return {
    calls,
    bots,
    count: (method) => calls.filter((c) => c[0] === method).length,
    failNext(method, error) {
      failures.push({ method, error });
    },
    ambiguousNextCreate() {
      ambiguous = true;
    },
    onCreate(fn) {
      onCreate = fn;
    },
    beforeDelete(fn) {
      beforeDelete = fn;
    },
    advance(id, codes, { recording = false } = {}) {
      const bot = bots.get(id);
      for (const code of codes)
        bot.status_changes.push({ code, sub_code: null, created_at: stamp() });
      if (recording) bot.recordings.push({ id: randomUUID(), status: { code: "done" } });
    },
    add(bot) {
      const full = { status_changes: [], recordings: [], metadata: {}, ...bot };
      bots.set(full.id, full);
      return full;
    },

    async createBot(request, options) {
      calls.push(["createBot", clone(request), { idempotencyKey: options.idempotencyKey }]);
      maybeFail("createBot");
      const prior = idem.get(options.idempotencyKey);
      if (prior && bots.has(prior)) return clone(bots.get(prior));
      const bot = {
        id: randomUUID(),
        join_at: request.join_at,
        metadata: { ...request.metadata },
        status_changes: [],
        recordings: [],
      };
      bots.set(bot.id, bot);
      idem.set(options.idempotencyKey, bot.id);
      if (onCreate) {
        const fn = onCreate;
        onCreate = null;
        await fn(clone(bot));
      }
      if (ambiguous) {
        ambiguous = false;
        throw timeoutError();
      }
      return clone(bot);
    },

    async retrieveBot(id) {
      calls.push(["retrieveBot", id]);
      maybeFail("retrieveBot");
      return bots.has(id) ? clone(bots.get(id)) : null;
    },

    async listBots(query) {
      calls.push(["listBots", clone(query)]);
      maybeFail("listBots");
      const pairs = Object.entries(query.metadata ?? {});
      const found = [...bots.values()].filter((b) =>
        pairs.every(([k, v]) => b.metadata?.[k] === v),
      );
      return { bots: found.map(clone), truncated: false };
    },

    async deleteScheduledBot(id) {
      calls.push(["deleteScheduledBot", id]);
      maybeFail("deleteScheduledBot");
      if (beforeDelete) {
        const fn = beforeDelete;
        beforeDelete = null;
        await fn(id);
      }
      const bot = bots.get(id);
      if (!bot) return "already_gone";
      if (dispatched(bot)) return "not_allowed";
      bots.delete(id);
      return "deleted";
    },

    async leaveCall(id) {
      calls.push(["leaveCall", id]);
      maybeFail("leaveCall");
      const bot = bots.get(id);
      if (!bot) return { outcome: "already_gone" };
      if (!dispatched(bot) || ended(bot)) return { outcome: "not_in_call" };
      bot.status_changes.push({
        code: "call_ended",
        sub_code: "bot_received_leave_call",
        created_at: stamp(),
      });
      if (bot.recordings.length)
        bot.status_changes.push({ code: "done", sub_code: null, created_at: stamp() });
      return { outcome: "left", bot: clone(bot) };
    },

    async deleteRecording(id) {
      calls.push(["deleteRecording", id]);
      maybeFail("deleteRecording");
      for (const bot of bots.values()) {
        const i = bot.recordings.findIndex((r) => r.id === id);
        if (i >= 0) {
          bot.recordings.splice(i, 1);
          return "deleted";
        }
      }
      return "already_gone";
    },
  };
}
