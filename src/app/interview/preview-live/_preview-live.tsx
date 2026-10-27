"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endsInterview, type LiveEventKind } from "@/lib/interviews/live-event-codes";
import type { MockScriptId } from "@/lib/interviews/live-provider/types";
import { LiveFlowCore } from "../[token]/_live/live-flow";
import type { LiveServer } from "../[token]/_live/live-server";
import type { MockVoice } from "../[token]/_live/mock-lines";
import {
  LISTEN_MS,
  MOCK_SCRIPT_VERSION,
  type MockSignal,
  type MockVoxAgent,
} from "../[token]/_live/mock-voxagent";
import type { LiveConsentView } from "../[token]/_live/screens";
import type { VoxAgentTransport } from "../[token]/_live/transport";
import type { PieceMime } from "../[token]/_live/video-pieces";
import { loadPreviewVoice, PREVIEW_INTERVIEWER } from "./mock-voice";

/**
 * The demo around the live screen (development only, see page.tsx): the real
 * LiveFlowCore with MockVoxAgent, and an in-memory server that logs what the
 * real routes would receive. The panel is not part of the candidate screen.
 *
 * Log entries marked "ends the interview" are the reports that would stamp
 * live_ended_at on the server (endsInterview, live-events.ts); every other
 * report is a record only. A closed tab's report is kept in localStorage, so
 * it shows on the next visit.
 */

/**
 * A moving test pattern and a pulsing tone instead of the camera and the
 * microphone, for a browser that cannot give either (the demo only).
 */
function testPattern(ctx: AudioContext): Promise<MediaStream> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const g = canvas.getContext("2d");
  let frame = 0;
  const draw = () => {
    if (!g) return;
    g.fillStyle = "#2e2470";
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = "#d9f972";
    g.font = "bold 36px sans-serif";
    g.fillText("Test pattern", 40, 70);
    g.fillText(new Date().toLocaleTimeString(), 40, 120);
    g.beginPath();
    g.arc(320 + 200 * Math.sin(frame / 15), 320, 40, 0, 2 * Math.PI);
    g.fill();
    frame += 1;
  };
  draw();
  window.setInterval(draw, 66);
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1.5;
  const depth = ctx.createGain();
  depth.gain.value = 0.25;
  lfo.connect(depth).connect(gain.gain);
  gain.gain.value = 0.3;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  const video = canvas.captureStream(15).getVideoTracks()[0];
  return Promise.resolve(new MediaStream([video, ...dest.stream.getAudioTracks()]));
}

type Script = MockScriptId | "busy";
/** Every ending, in the order the bar shows them. */
const SCRIPTS: { id: Script; label: string; what: string }[] = [
  {
    id: "completed",
    label: "Completed",
    what: "Three questions, a follow-up, an interruption and the question again, then Sarah's closing line.",
  },
  {
    id: "interruption",
    label: "Interruption",
    what: "One question, cut off and asked again, then the close.",
  },
  {
    id: "candidate_ends",
    label: "Candidate ends",
    what: "Long pauses: press End interview to end it yourself.",
  },
  {
    id: "timed_out",
    label: "Time limit",
    what: "One question, then Sarah stops at the time limit.",
  },
  { id: "provider_error", label: "Provider error", what: "One question, then the provider fails." },
  {
    id: "connection_lost",
    label: "Connection drop",
    what: "One question, then the connection closes.",
  },
  {
    id: "busy",
    label: "Busy",
    what: "Refused as busy first; Try again starts the Completed interview.",
  },
];
const BEACON_KEY = "remotiv-preview-live-beacons";

/** The demo buttons: the server's detection, simulated. What each note says, done or not. */
const SIMULATE: Record<MockSignal, { label: string; done: string; notNow: string }> = {
  repeat: {
    label: "Simulate: candidate asks to repeat",
    done: "Simulated: the candidate asks to repeat. Sarah says the question again.",
    notNow:
      "Not sent: Sarah repeats only while she is listening. Press it after she finishes asking.",
  },
  cut_in: {
    label: "Simulate: candidate cuts in",
    done: "Simulated: the candidate cuts in. Sarah stops at once.",
    notNow: "Not sent: the candidate can cut in only while Sarah is speaking.",
  },
  answer_done: {
    label: "Simulate: answer finished",
    done: "Simulated: the answer is finished. Sarah moves on.",
    notNow: "Not sent: Sarah is not waiting for an answer right now.",
  },
  drop: {
    label: "Simulate: connection drop",
    done: "Simulated: the connection drops.",
    notNow: "Not sent: the interview is not running.",
  },
};
const SIGNALS: MockSignal[] = ["repeat", "cut_in", "answer_done", "drop"];
/** A cut-in event this soon after the button is the button's; any other is the script's own. */
const PRESS_WINDOW_MS = 500;

type LogLine = { at: string; text: string; ends: boolean };
type StoredPiece = {
  index: number;
  bytes: number;
  startedAtMs: number | null;
  durationMs: number | null;
  last: boolean;
  confirmed: boolean;
  url: string | null;
};

const PANEL =
  "fixed bottom-4 right-4 z-50 w-[360px] max-h-[86vh] overflow-auto rounded-2xl border border-black/10 bg-white p-4 text-[12.5px] text-[#17131f] shadow-2xl";
const BTN = "rounded-full border border-black/15 px-3 py-1.5 font-semibold hover:bg-black/5";

export function PreviewLive({ company, consent }: { company: string; consent: LiveConsentView }) {
  const [script, setScript] = useState<Script>("completed");
  const [minutes, setMinutes] = useState(20);
  const [pieceSeconds, setPieceSeconds] = useState(15);
  const [failUploads, setFailUploads] = useState(false);
  const [pattern, setPattern] = useState(false);
  const [run, setRun] = useState(0);
  // Its own tab lock per page load: two demo pages never block each other.
  const [pageId] = useState(() => Math.random().toString(36).slice(2));
  const [log, setLog] = useState<LogLine[]>([]);
  const [pieces, setPieces] = useState<StoredPiece[]>([]);
  const [transport, setTransport] = useState<VoxAgentTransport | null>(null);
  const [previous, setPrevious] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [note, setNote] = useState<{ text: string; key: number } | null>(null);
  const lastCutInPress = useRef(0);
  // The clips start loading as the page opens, so Start does not wait for them.
  const voice = useMemo(() => {
    let loading: Promise<MockVoice> | null = null;
    return () => {
      loading ??= loadPreviewVoice();
      return loading;
    };
  }, []);
  useEffect(() => {
    void voice();
  }, [voice]);
  // Every press leaves a note on screen for a few seconds.
  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 4500);
    return () => window.clearTimeout(id);
  }, [note]);
  // What the mock sent, in order, as the screen received it.
  useEffect(() => {
    if (!transport) return;
    const t0 = performance.now();
    return transport.subscribe((e) => {
      const at = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
      let line: string = e.type;
      if (e.type === "agent") line = e.state;
      if (e.type === "agent_text")
        line = `says "${e.text.slice(0, 48)}${e.text.length > 48 ? "..." : ""}"`;
      if (e.type === "ended")
        line = `session_complete (${e.endReason}, graceful ${String(e.graceful)})`;
      if (e.type === "error") line = `error (${e.code})`;
      if (e.type === "interrupted") {
        const pressed = performance.now() - lastCutInPress.current < PRESS_WINDOW_MS;
        line = pressed ? "interrupted (your button)" : "interrupted (the script's cut-in)";
        if (!pressed) {
          setNote({
            text: "Scripted: the candidate cuts in here. Sarah stops at once, says she will finish the question, then asks it again.",
            key: Date.now(),
          });
        }
      }
      setEvents((list) => [...list, `${at} ${line}`]);
    });
  }, [transport]);
  const failRef = useRef(failUploads);
  failRef.current = failUploads;
  const startsRef = useRef(0);
  const blobs = useRef(new Map<number, Blob>()).current;

  useEffect(() => {
    try {
      setPrevious(JSON.parse(localStorage.getItem(BEACON_KEY) ?? "[]") as string[]);
    } catch {
      setPrevious([]);
    }
  }, []);

  const add = useCallback((text: string, ends = false) => {
    setLog((l) => [...l, { at: new Date().toLocaleTimeString(), text, ends }]);
  }, []);

  const server = useMemo<LiveServer>(() => {
    const report = (kind: LiveEventKind, detail: string | null | undefined, how: string) =>
      add(`${how} ${kind}${detail ? ` (${detail})` : ""}`, endsInterview(kind));
    return {
      async consent() {
        add("POST consent: saved live-v1");
        return "saved";
      },
      async start() {
        startsRef.current += 1;
        // Busy on the first try, then a slot is free: the retry path.
        if (script === "busy" && startsRef.current === 1) {
          add("POST start: 503 busy (nothing stored)");
          return { ok: false, reason: "busy", retryAfterSeconds: 30 };
        }
        const played: MockScriptId = script === "busy" ? "completed" : script;
        add(`POST start: 200 join ticket (mock, ${played})`);
        return { ok: true, join: { mode: "mock", script: played, turnDetection: "server" } };
      },
      event(kind, detail) {
        report(kind, detail, "POST event");
      },
      beacon(kind, detail) {
        report(kind, detail, "beacon");
        try {
          const kept = JSON.parse(localStorage.getItem(BEACON_KEY) ?? "[]") as string[];
          kept.push(`${new Date().toLocaleTimeString()} ${kind}`);
          localStorage.setItem(BEACON_KEY, JSON.stringify(kept.slice(-10)));
        } catch {
          // Storage off: the log line above is all there is.
        }
      },
      pieces: {
        async reserve(index: number, _mime: PieceMime) {
          setPieces((ps) =>
            ps.some((x) => x.index === index)
              ? ps
              : [
                  ...ps,
                  {
                    index,
                    bytes: 0,
                    startedAtMs: null,
                    durationMs: null,
                    last: false,
                    confirmed: false,
                    url: null,
                  },
                ],
          );
          return { url: `preview://piece/${index}` };
        },
        async upload(url: string, blob: Blob) {
          if (failRef.current) {
            add(`PUT ${url}: failed (uploads set to fail)`);
            throw new Error("upload failed");
          }
          const index = Number(url.split("/").pop());
          blobs.set(index, blob);
        },
        async confirm(p) {
          const blob = blobs.get(p.index);
          add(
            `POST video-confirm: piece ${p.index}, ${Math.round(p.durationMs / 1000)}s${p.last ? ", last" : ""}`,
          );
          setPieces((ps) =>
            ps.map((x) =>
              x.index === p.index
                ? {
                    ...x,
                    bytes: blob?.size ?? 0,
                    startedAtMs: p.startedAtMs,
                    durationMs: p.durationMs,
                    last: p.last,
                    confirmed: true,
                    url: blob ? URL.createObjectURL(blob) : null,
                  }
                : x,
            ),
          );
        },
      },
    };
  }, [add, script, blobs]);

  const restart = () => {
    startsRef.current = 0;
    blobs.clear();
    setLog([]);
    setPieces([]);
    setTransport(null);
    setEvents([]);
    setRun((r) => r + 1);
  };

  const say = useCallback((text: string) => {
    setNote({ text, key: Date.now() });
  }, []);
  const signal = (s: MockSignal) => {
    if (s === "cut_in") lastCutInPress.current = performance.now();
    const acted = (transport as MockVoxAgent | null)?.signal(s) ?? false;
    say(acted ? SIMULATE[s].done : SIMULATE[s].notNow);
  };
  const pick = (next: Script) => {
    setScript(next);
    restart();
  };
  const current = SCRIPTS.find((x) => x.id === script);

  return (
    <>
      <div
        className="border-b border-black/10 bg-white px-4 py-3 text-[12.5px] text-[#17131f]"
        data-demo-scripts
      >
        <div className="mx-auto flex max-w-[960px] flex-wrap items-center gap-2">
          <span className="mr-1 font-extrabold">Demo script:</span>
          {SCRIPTS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={x.id === script}
              data-script={x.id}
              className={`rounded-full border px-3 py-1 font-semibold ${
                x.id === script
                  ? "border-[#7e47ff] bg-[#7e47ff] text-white"
                  : "border-black/15 hover:bg-black/5"
              }`}
              onClick={() => pick(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <p className="mx-auto mt-2 mb-0 max-w-[960px] text-black/60">
          <b className="text-black/80">{current?.label}:</b> {current?.what} Picking a script starts
          it again from the welcome screen. Sarah speaks each line (a recorded clip, macOS voice
          Samantha), but the mock cannot hear you: it moves on {LISTEN_MS / 1000} seconds after each
          question, or when you press &ldquo;Simulate: answer finished&rdquo; in the panel. Speaking
          to it does nothing.
          <span className="ml-1 text-black/40" data-script-version>
            ({MOCK_SCRIPT_VERSION})
          </span>
        </p>
      </div>
      <LiveFlowCore
        key={run}
        server={server}
        tabKey={`preview-live-${pageId}-${run}`}
        onTransport={setTransport}
        pieceMs={pieceSeconds * 1000}
        getMedia={pattern ? testPattern : undefined}
        companyName={company}
        companyInitial={company[0]}
        jobTitle="Backend Engineer"
        interviewer={PREVIEW_INTERVIEWER}
        minutes={minutes}
        questionCount={8}
        consent={consent}
        showEnding
        mockVoice={voice}
      />
      {note && (
        <div
          key={note.key}
          role="status"
          className="fixed left-1/2 top-4 z-[60] max-w-[520px] -translate-x-1/2 rounded-xl bg-[#17131f] px-4 py-3 text-[13px] font-semibold text-white shadow-2xl"
          data-demo-note
        >
          {note.text}
        </div>
      )}
      <aside className={PANEL} aria-label="Demo controls" data-demo-panel>
        <p className="m-0 mb-1 text-[13px] font-extrabold">
          Demo controls (the mock can't hear you)
        </p>
        <p className="m-0 mb-3 text-[11.5px] text-black/55">
          Not part of the candidate screen. MockVoxAgent, no database, made-up content. The consent
          text is the draft, placeholders included.
        </p>

        <label className="mb-2 flex items-center justify-between gap-2">
          Time limit (minutes)
          <input
            className="w-16 rounded-md border border-black/15 px-2 py-1"
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="mb-2 flex items-center justify-between gap-2">
          Video piece length (seconds)
          <input
            className="w-16 rounded-md border border-black/15 px-2 py-1"
            type="number"
            min={5}
            value={pieceSeconds}
            onChange={(e) => setPieceSeconds(Math.max(5, Number(e.target.value) || 5))}
          />
        </label>
        <label className="mb-2 flex items-center gap-2">
          <input type="checkbox" checked={pattern} onChange={(e) => setPattern(e.target.checked)} />
          Test pattern instead of the camera and microphone
        </label>
        <label className="mb-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={failUploads}
            onChange={(e) => setFailUploads(e.target.checked)}
          />
          Video uploads fail (to see retry and Try again)
        </label>
        <button
          type="button"
          className={`${BTN} mb-3 w-full bg-[#7e47ff] text-white hover:bg-[#6d38f0]`}
          onClick={restart}
        >
          Restart with these settings
        </button>

        <p className="m-0 mb-1 font-bold">Simulate what the candidate does</p>
        <p className="m-0 mb-2 text-[11.5px] text-black/55">
          The real server will hear these. The mock cannot, so press the button instead of speaking.
        </p>
        <div className="mb-3 flex flex-col gap-2">
          {SIGNALS.map((s) => (
            <button
              key={s}
              type="button"
              className={`${BTN} text-left`}
              disabled={!transport}
              data-simulate={s}
              onClick={() => signal(s)}
            >
              {SIMULATE[s].label}
            </button>
          ))}
        </div>

        <p className="m-0 mb-1 font-bold">What Sarah's side sent, in order</p>
        <ol className="m-0 mb-3 max-h-40 list-none space-y-0.5 overflow-auto p-0" data-demo-events>
          {events.map((line, i) => (
            <li
              key={`${i}-${line}`}
              className={
                line.startsWith("interrupted", line.indexOf(" ") + 1)
                  ? "font-bold text-[#7a4e05]"
                  : ""
              }
            >
              {line}
            </li>
          ))}
        </ol>

        <p className="m-0 mb-1 font-bold">What the server would receive</p>
        <ol className="m-0 mb-3 list-none space-y-0.5 p-0" data-demo-log>
          {log.map((l, i) => (
            <li key={`${l.at}-${i}`} className={l.ends ? "font-bold text-[#04342c]" : ""}>
              <span className="text-black/45">{l.at}</span> {l.text}
              {l.ends ? " - ends the interview (live_ended_at)" : ""}
            </li>
          ))}
        </ol>

        <p className="m-0 mb-1 font-bold">Video pieces</p>
        <ul className="m-0 mb-3 list-none space-y-1.5 p-0" data-demo-pieces>
          {pieces.map((x) => (
            <li key={x.index}>
              v{x.index}:{" "}
              {x.confirmed
                ? `${Math.round(x.bytes / 1024)} KB, starts ${Math.round((x.startedAtMs ?? 0) / 1000)}s, ${Math.round((x.durationMs ?? 0) / 1000)}s${x.last ? ", last" : ""}`
                : "reserved, recording or uploading"}
              {x.url && (
                // biome-ignore lint/a11y/useMediaCaption: the candidate's own camera, for the demo
                <video className="mt-1 w-full rounded-md" src={x.url} controls />
              )}
            </li>
          ))}
        </ul>

        {previous.length > 0 && (
          <>
            <p className="m-0 mb-1 font-bold">Reports from a closed tab (sendBeacon)</p>
            <ul className="m-0 list-none p-0">
              {previous.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </>
  );
}
