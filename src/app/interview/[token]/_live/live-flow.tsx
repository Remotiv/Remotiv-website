"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { providerEndDetail } from "@/lib/interviews/live-event-codes";
import {
  classifyMediaError,
  detectPlatform,
  type MediaFault,
  type Platform,
} from "../_permissions";
import { useTabLock } from "../_tab-lock";
import { InterviewShell } from "../_terminal";
import { createWebAudioOut } from "./audio-out";
import { INTERVIEW, SAVING } from "./copy";
import { httpLiveServer, type LiveServer } from "./live-server";
import { INITIAL, liveReducer } from "./machine";
import type { MockVoiceLoader } from "./mock-lines";
import type { MockStepsLoader } from "./mock-voxagent";
import { type CheckState, type LiveConsentView, LiveScreens } from "./screens";
import { createTransport, type TransportEvent, type VoxAgentTransport } from "./transport";
import { baseMime, PieceRecorder, type PieceView, type RecorderLike } from "./video-pieces";

/**
 * The AI Video Interview candidate screen (AVI commit 10), in Remotiv's
 * design. Computer only in v1.
 *
 * It owns the camera and microphone (one stream for the check, the
 * conversation and the video), the conversation (a VoxAgentTransport: today
 * MockVoxAgent only), the camera video in pieces (PieceRecorder, through the
 * 10a routes) and the reports to the server (live-server.ts). What it shows
 * is the reducer's state (machine.ts), drawn by screens.tsx.
 *
 * ── What it never does ───────────────────────────────────────
 *
 * It never sees a provider key: the server starts the conversation and hands
 * back a join ticket. It never decides an outcome: the ending it shows is a
 * message, and what it reports (end pressed, the tab closing, the connection
 * dropping, the time limit) is a record only. It never restarts a
 * conversation: once started, the link shows "This interview has ended". It
 * does no end-of-turn detection: that stays behind the transport.
 *
 * ── The video is protected ───────────────────────────────────
 *
 * Whatever ends the conversation, the last piece is stopped and uploaded like
 * the others, the end screen waits until every piece is saved, and the page
 * warns before it is closed while one is not.
 */

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];
const VIDEO_BITS_PER_SECOND = 400_000;
const AUDIO_BITS_PER_SECOND = 64_000;
/** How loud a sound counts as the microphone working, on the 0..1 meter. */
const MIC_OK_LEVEL = 0.12;
/** How long to wait for the provider to confirm an End before showing the end anyway. */
const END_CONFIRM_MS = 10_000;

function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type) && baseMime(type)) return type;
    } catch {
      // isTypeSupported throws on some older browsers: unsupported.
    }
  }
  return null;
}

function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    pickRecorderMime() !== null
  );
}

export type LiveFlowProps = {
  companyName: string;
  companyInitial: string;
  jobTitle: string;
  interviewer: string;
  minutes: number;
  questionCount: number;
  consent: LiveConsentView | null;
};

/** The real screen: its server is Remotiv's API, for this token. */
export function LiveInterviewFlow({ token, ...props }: LiveFlowProps & { token: string }) {
  const server = useMemo(() => httpLiveServer(token), [token]);
  return <LiveFlowCore {...props} server={server} tabKey={token} />;
}

export function LiveFlowCore({
  server,
  tabKey,
  onTransport,
  pieceMs,
  getMedia,
  showEnding = false,
  mockVoice,
  mockSteps,
  ...p
}: LiveFlowProps & {
  server: LiveServer;
  tabKey: string;
  /** The demo panel's handle on the transport (preview-live only). */
  onTransport?: (transport: VoxAgentTransport | null) => void;
  /** Shorter video pieces for the demo; default PIECE_MS. */
  pieceMs?: number;
  /** The camera and microphone; the demo can pass a test pattern. Default getUserMedia. */
  getMedia?: (ctx: AudioContext) => Promise<MediaStream>;
  /** The demo only: name the ending and what the provider sent. Never on a candidate's screen. */
  showEnding?: boolean;
  /** The demo only: the mock's spoken clips. The candidate page never passes it. */
  mockVoice?: MockVoiceLoader;
  /** The demo only: a replayed session's script. The candidate page never passes it. */
  mockSteps?: MockStepsLoader;
}) {
  const [state, dispatch] = useReducer(liveReducer, INITIAL);
  const [agreed, setAgreed] = useState(false);
  const [cam, setCam] = useState<CheckState>("pend");
  const [mic, setMic] = useState<CheckState>("pend");
  const [net, setNet] = useState<CheckState>("pend");
  const [micLevel, setMicLevel] = useState(0);
  const [fault, setFault] = useState<MediaFault | null>(null);
  const [asked, setAsked] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [platform, setPlatform] = useState<Platform>("other");
  const [pieces, setPieces] = useState<PieceView[]>([]);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef<number | null>(null);
  const videoEls = useRef(new Set<HTMLVideoElement>());
  const transportRef = useRef<VoxAgentTransport | null>(null);
  const recorderRef = useRef<PieceRecorder | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const screenRef = useRef(state.screen);
  screenRef.current = state.screen;
  const reportedSaved = useRef(false);
  const endTimer = useRef<number | null>(null);

  const tab = useTabLock(tabKey);

  useEffect(() => {
    const platformNow = detectPlatform();
    setPlatform(platformNow);
    if (platformNow === "ios-safari" || platformNow === "android-chrome") {
      dispatch({ t: "block", blocked: "phone" });
    } else if (!supported()) {
      dispatch({ t: "block", blocked: "unsupported" });
    }
  }, []);

  useEffect(() => {
    if (tab.role === "duplicate" && screenRef.current !== "interview") {
      dispatch({ t: "block", blocked: "duplicate" });
    }
    if (tab.role === "superseded") {
      transportRef.current?.close();
      recorderRef.current?.stop();
      dispatch({ t: "block", blocked: "superseded" });
    }
  }, [tab.role]);

  const previewRef = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    videoEls.current.add(el);
    if (streamRef.current && el.srcObject !== streamRef.current) el.srcObject = streamRef.current;
  }, []);

  const stopMedia = useCallback(() => {
    if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
    meterRef.current = null;
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
  }, []);

  const checkConnection = useCallback(async () => {
    setNet("pend");
    const t0 = performance.now();
    try {
      const res = await fetch(`/api/interview/ping?t=${Date.now()}`, { cache: "no-store" });
      setNet(res.ok && performance.now() - t0 < 3000 ? "ok" : "bad");
    } catch {
      setNet("bad");
    }
  }, []);

  const ask = useCallback(async () => {
    setRequesting(true);
    setFault(null);
    void checkConnection();
    // Made on this click, so the browser lets it play the interviewer later.
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    try {
      const stream = getMedia
        ? await getMedia(ctx)
        : await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
      streamRef.current = stream;
      for (const el of videoEls.current) el.srcObject = stream;
      setAsked(true);
      setCam(stream.getVideoTracks()[0]?.readyState === "live" ? "ok" : "bad");
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let max = 0;
        for (const v of data) max = Math.max(max, Math.abs(v - 128));
        const level = Math.min(1, max / 40);
        setMicLevel(level);
        if (level >= MIC_OK_LEVEL) setMic("ok");
        meterRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      setFault(classifyMediaError(err));
      setCam("bad");
      setMic("bad");
    } finally {
      setRequesting(false);
    }
  }, [checkConnection, getMedia]);

  const retryCheck = useCallback(() => {
    stopMedia();
    setAsked(false);
    setCam("pend");
    setMic("pend");
    setNet("pend");
    void ask();
  }, [ask, stopMedia]);

  const stopRecording = useCallback(() => {
    if (endTimer.current !== null) window.clearTimeout(endTimer.current);
    endTimer.current = null;
    const recorder = recorderRef.current;
    if (!recorder) {
      // Over before any video was recorded: nothing to save.
      stopMedia();
      dispatch({ t: "video_saved" });
      return;
    }
    recorder.stop();
  }, [stopMedia]);

  const onEvent = useCallback(
    (event: TransportEvent) => {
      dispatch({ t: "transport", event });
      if (event.type === "started") {
        startedAtRef.current = performance.now();
        server.event("conversation_started");
        const stream = streamRef.current;
        const recorderMime = pickRecorderMime();
        const mime = recorderMime ? baseMime(recorderMime) : null;
        if (stream && recorderMime && mime) {
          const recorder = new PieceRecorder({
            mime,
            sink: server.pieces,
            makeRecorder: () => {
              const r = new MediaRecorder(stream, {
                mimeType: recorderMime,
                videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
                audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
              });
              const like: RecorderLike = {
                start: (timeslice) => r.start(timeslice),
                stop: () => r.stop(),
                ondataavailable: null,
                onstop: null,
              };
              r.ondataavailable = (e) => like.ondataavailable?.(e);
              r.onstop = () => like.onstop?.();
              return like;
            },
            now: () => performance.now() - (startedAtRef.current ?? performance.now()),
            pieceMs,
            onChange: setPieces,
          });
          recorderRef.current = recorder;
          recorder.start();
        }
      } else if (event.type === "ended") {
        server.event("provider_complete", providerEndDetail(event.endReason, event.graceful));
        stopRecording();
      } else if (event.type === "dropped") {
        server.event("connection_lost");
        stopRecording();
      } else if (event.type === "error") {
        server.event("provider_error", "error");
        stopRecording();
      }
    },
    [server, stopRecording, pieceMs],
  );

  const start = useCallback(async () => {
    dispatch({ t: "start" });
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    void ctx.resume();
    const answer = await server.start();
    dispatch({ t: "start_result", answer });
    if (!answer.ok) return;
    let transport: VoxAgentTransport;
    try {
      transport = createTransport(answer.join, {
        interviewerName: p.interviewer,
        mockVoice,
        mockSteps,
      });
    } catch {
      server.event("provider_error", "error");
      dispatch({ t: "transport_failed" });
      return;
    }
    transportRef.current = transport;
    onTransport?.(transport);
    transport.subscribe(onEvent);
    try {
      await transport.connect({ mic: streamRef.current, audioOut: createWebAudioOut(ctx) });
    } catch {
      server.event("provider_error", "error");
      dispatch({ t: "transport_failed" });
    }
  }, [server, p.interviewer, onEvent, onTransport, mockVoice, mockSteps]);

  const endConfirm = useCallback(() => {
    dispatch({ t: "end_confirmed" });
    server.event("end_pressed");
    transportRef.current?.end();
    // The provider ends the session and says so; if it never does, the
    // candidate is not left waiting. Nothing is recorded as the provider's end.
    endTimer.current = window.setTimeout(() => {
      transportRef.current?.close();
      dispatch({ t: "end_timeout" });
      recorderRef.current?.stop();
      if (!recorderRef.current) dispatch({ t: "video_saved" });
    }, END_CONFIRM_MS);
  }, [server]);

  // The time limit, on the conversation's clock. Shown and reported; the provider ends it.
  useEffect(() => {
    if (state.screen !== "interview") return;
    const limit = p.minutes * 60;
    const id = window.setInterval(() => {
      const started = startedAtRef.current;
      if (started === null) return;
      const left = limit - (performance.now() - started) / 1000;
      setTimeLeft(Math.max(0, left));
      if (left <= 0 && !state.timeUp) {
        dispatch({ t: "time_up" });
        server.event("timer_reached");
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [state.screen, state.timeUp, p.minutes, server]);

  // Every piece saved: the ending can show, and the camera light goes off.
  useEffect(() => {
    const recorder = recorderRef.current;
    if (!state.ending || !recorder) return;
    if (!pieces.some((x) => x.state === "recording")) stopMedia();
    if (recorder.drained && !reportedSaved.current) {
      reportedSaved.current = true;
      server.event("video_saved");
      dispatch({ t: "video_saved" });
    }
  }, [pieces, state.ending, server, stopMedia]);

  // A closed tab is reported, and nothing else: it does not end the interview.
  useEffect(() => {
    const live = () => ["connecting", "interview", "saving"].includes(screenRef.current);
    const onHide = () => {
      if (live()) server.beacon("tab_closed");
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const unsaved = (recorderRef.current?.unsaved ?? 0) > 0;
      if (screenRef.current === "interview" || (screenRef.current === "saving" && unsaved)) {
        e.preventDefault();
        e.returnValue =
          screenRef.current === "interview" ? INTERVIEW.leaveWarning : SAVING.leaveWarning;
      }
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [server]);

  useEffect(
    () => () => {
      transportRef.current?.close();
      stopMedia();
      void ctxRef.current?.close().catch(() => {});
    },
    [stopMedia],
  );

  const wide = state.screen === "interview";
  return (
    <InterviewShell
      companyName={p.companyName}
      companyInitial={p.companyInitial}
      jobTitle={p.jobTitle}
      wide={wide}
    >
      <LiveScreens
        state={state}
        companyName={p.companyName}
        interviewer={p.interviewer}
        minutes={p.minutes}
        questionCount={p.questionCount}
        consent={p.consent}
        agreed={agreed}
        check={{ cam, mic, net, micLevel, fault, asked, requesting, platform }}
        previewRef={previewRef}
        micLevel={micLevel}
        timeLeftSeconds={timeLeft ?? p.minutes * 60}
        pieces={pieces}
        showEnding={showEnding}
        on={{
          begin: () => dispatch({ t: "begin" }),
          toggleAgree: setAgreed,
          agree: async () => {
            dispatch({ t: "consent_saving" });
            dispatch({ t: "consent_result", answer: await server.consent() });
          },
          ask: () => void ask(),
          retryCheck,
          start: () => void start(),
          retryStart: () => void start(),
          endRequest: () => dispatch({ t: "end_requested" }),
          endCancel: () => dispatch({ t: "end_cancelled" }),
          endConfirm,
          retryVideo: () => recorderRef.current?.retryFailed(),
          takeOver: () => {
            tab.takeOver();
            dispatch({ t: "unblock" });
          },
        }}
      />
    </InterviewShell>
  );
}
