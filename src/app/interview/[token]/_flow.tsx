"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Lightbulb,
  Loader,
  Lock,
  Mic,
  MicOff,
  Save,
  Send,
  TriangleAlert,
  User,
  Video,
  VideoOff,
  Wifi,
} from "lucide-react";
import type { CandidateQuestion, CandidateSession } from "@/lib/interviews/types";
import { InterviewShell, UnsupportedScreen } from "./_terminal";
import {
  detectPlatform,
  type PermissionState,
  type Platform,
  queryMediaPermissions,
  recoveryFor,
  watchMediaPermissions,
} from "./_permissions";

/**
 * The candidate flow: Welcome → Consent → Tech check → Recording → Review.
 *
 * ── Practice is a constant, not a question ───────────────────
 *
 * PRACTICE below is local to this file and never leaves it. It has no row in
 * interview_questions, is never uploaded, and its position (-1) is not a
 * position the API would accept. Modelling it as a real question with
 * required:false would eventually get it treated as one — counted, scored, or
 * shown to the hiring team.
 *
 * ── Resume is not a feature, it is the upload design ─────────
 *
 * Every answer uploads the moment it is recorded. `question.answered` comes
 * from the answers table via the server loader, so returning to the link opens
 * at the first unanswered question with no client-side progress state to keep
 * in sync. A dropped connection costs the answer in flight and nothing else.
 */

/**
 * The practice round has ALWAYS had its own prompt — nothing overrode it. The
 * bug was the wording: "Tell us a little about yourself" IS an interview
 * question, and near-identical to the first real question on most jobs, so
 * candidates answered the same thing twice and the round stopped being a
 * setup check.
 *
 * This is deliberately not answerable well or badly. Counting gives an
 * immediate read on mic level; breakfast produces a few seconds of natural,
 * unrehearsed speech to watch back. Neither is worth practising.
 */
const PRACTICE = {
  question: "Count slowly to five, then say what you had for breakfast.",
  prepSeconds: 8,
  answerSeconds: 60,
};

const PREP_SKIPPABLE_AT = 8;

const PHASE_LABEL = {
  prep: "Get ready",
  rec: "Recording",
  uploading: "Saving",
  review: "Watch it back",
} as const;

const PHASE_PILL = {
  prep: "bg-[var(--sky-tint)] text-[var(--sky-ink)]",
  rec: "bg-[var(--red-tint)] text-[var(--red-ink)]",
  uploading: "bg-[var(--mint-tint)] text-[var(--mint-ink)]",
  review: "bg-[var(--lime)] text-[#2F3A00]",
} as const;

/**
 * Upload watchdogs. The stall timer is reset by every progress event, so this
 * is "no bytes moved for 45s", not "the upload took 45s" — a slow uplink is
 * not a failure. The hard ceiling is the backstop.
 */
const UPLOAD_STALL_MS = 45_000;

/**
 * Stop watchdog, in two stages.
 *
 * The old single 3s stage declared failure AND set the finishing latch, so a
 * flush that completed at 3.1s had its chunks discarded by handleStopped's own
 * guard. On mobile Chrome a 2-minute answer legitimately takes longer than 3s
 * to finalise, so the watchdog was destroying good recordings and telling the
 * candidate to record them again.
 *
 * SOFT only changes the wording — it never touches state. HARD gives up
 * waiting for onstop and salvages the chunks already in hand, which with
 * start(1000) is everything except the final partial second.
 */
const STOP_SOFT_MS = 4_000;
const STOP_HARD_MS = 20_000;

/** TEMPORARY — separates "slow to stop" from "onstop never fires". */
const IV_STOP_DEBUG = true;
function stopLog(label: string, data: Record<string, unknown>): void {
  if (!IV_STOP_DEBUG || typeof console === "undefined") return;
  // warn, not log: Chrome's console filter can hide Info entirely.
  console.warn(`[stop] ${label}`, data);
}
const UPLOAD_HARD_TIMEOUT_MS = 10 * 60_000;

/**
 * Recording bitrate.
 *
 * Unset, Chrome picks ~2.5 Mbps, which measured at ~257 KB/s — a 120-second
 * answer was 31.6MB. That is far more than a framed, mostly static talking
 * head needs, and candidates upload it over Pakistani mobile networks.
 *
 * Video is cut hard; AUDIO IS NOT. Audio is what Whisper transcribes and what
 * the reviewer actually judges, so 64 kbps is kept rather than shaved — the
 * saving is not worth a worse transcript.
 *
 * 400k + 64k ≈ 58 KB/s, so a 120s answer is ~7MB against 31.6MB: about a
 * 4.5x reduction. If it needs to go lower, dropping the CAPTURE resolution
 * from 720x1280 is the better next lever than cutting bitrate further — the
 * same bits over fewer pixels look better than fewer bits over more.
 */
const VIDEO_BITS_PER_SECOND = 400_000;
const AUDIO_BITS_PER_SECOND = 64_000;

type Screen = "welcome" | "consent" | "tech" | "record" | "review" | "done";
const FLOW: Screen[] = ["welcome", "consent", "tech", "record", "review"];

type CheckState = "pend" | "ok" | "bad";

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.max(0, total % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * The deadline, in the CANDIDATE's locale and timezone.
 *
 * `undefined` locale means "resolve from the environment" — and the server's
 * environment is not the candidate's. Node resolved en-GB ("11 Aug, 13:31")
 * while the browser resolved en-US ("Aug 11, 1:31 PM"), so React discarded
 * the server tree and re-rendered on every load.
 *
 * The candidate's timezone is the whole point of the value and is knowable
 * only in the browser, so this is deliberately client-only rather than pinned
 * to a fixed locale: a deadline stated in our timezone is one they will miss.
 * See useDeadline below for how the first paint is handled.
 */
function fmtDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Empty on the server and on the first client render — which is what makes
 * the two agree — then filled after mount. The label ("Complete by") ships in
 * the server HTML either way, so nothing reflows; only the value appears.
 */
function useDeadline(iso: string): string {
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(fmtDeadline(iso));
  }, [iso]);
  return value;
}

/**
 * Container negotiation.
 *
 * Chrome, Edge and Android emit WebM; Safari — including every iPhone — emits
 * MP4 and returns false for every WebM type, so a WebM-only list produces a
 * MediaRecorder that never starts on a large share of candidates. VP9 first
 * where it exists because it is materially smaller on a mobile upload, then
 * VP8, then the MP4 path, then a bare recorder using whatever the browser
 * picks.
 *
 * The upload route sniffs the bytes it receives rather than trusting the type,
 * and accepts both containers, so either branch lands correctly.
 */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported throws on some older WebViews rather than returning
      // false. Treated as unsupported and the loop continues.
    }
  }
  return null;
}

export function InterviewFlow({
  token,
  session,
}: {
  token: string;
  session: CandidateSession;
}) {
  const [questions, setQuestions] = useState<CandidateQuestion[]>(session.questions);
  const [screen, setScreen] = useState<Screen>("welcome");
  const [supported, setSupported] = useState<boolean | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // -1 is the practice round; 0.. indexes `questions`.
  const [qi, setQi] = useState(-1);
  const [phase, setPhase] = useState<"prep" | "rec" | "uploading" | "review">("prep");
  /**
   * Object URL for the practice clip, and the ONLY thing ever done with that
   * blob. It is never uploaded and never reaches interview_answers — see the
   * practice branch of handleStopped, which returns before uploadAnswer.
   */
  const [practiceClip, setPracticeClip] = useState<string | null>(null);
  const [prepLeft, setPrepLeft] = useState(PRACTICE.prepSeconds);
  const [recLeft, setRecLeft] = useState(0);
  const [uploadPct, setUploadPct] = useState(0);

  const [agreed, setAgreed] = useState(false);
  const [agreeErr, setAgreeErr] = useState(false);

  const [camCheck, setCamCheck] = useState<CheckState>("pend");
  const [micCheck, setMicCheck] = useState<CheckState>("pend");
  const [netCheck, setNetCheck] = useState<CheckState>("pend");
  const [micLevel, setMicLevel] = useState(0);
  /**
   * What the browser says about permission, BEFORE we ask.
   *
   * "prompt" and "denied" are different situations with different fixes and
   * must not collapse into one message: prompt means the candidate simply has
   * not been asked yet, denied means the origin carries a remembered block and
   * no amount of pressing Allow will help until they clear it.
   */
  const [camPerm, setCamPerm] = useState<PermissionState>("unknown");
  const [micPerm, setMicPerm] = useState<PermissionState>("unknown");
  /** True only after getUserMedia actually rejected with a permission error. */
  const [requestFailed, setRequestFailed] = useState(false);
  const [requesting, setRequesting] = useState(false);
  /**
   * Whether the media request has actually been made this session.
   *
   * State, not `streamRef.current !== null` read during render: a ref is not
   * reactive, so that expression was only ever correct by the luck of a
   * neighbouring setState re-rendering just after the stream landed.
   */
  const [hasRequested, setHasRequested] = useState(false);
  const [platform, setPlatform] = useState<Platform>("other");

  const [watching, setWatching] = useState<{ position: number; url: string } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  /** Set while a stop is being handled, so auto-stop and Done can't both fire. */
  const finishingRef = useRef(false);
  /**
   * Always the CURRENT handleStopped.
   *
   * recorder.onstop is assigned once, inside a useCallback memoised on the
   * answer limit — so it captured whatever handleStopped existed when that
   * callback was last built. PRACTICE.answerSeconds and the wizard's default
   * answer limit are both 120, so moving from practice to question 1 did not
   * change the limit, did not rebuild the callback, and left onstop holding a
   * closure where qi was still -1. Every real answer took the practice branch:
   * no upload, no error, nothing on screen.
   *
   * A ref re-pointed on every render removes the class of bug rather than the
   * instance — the handler can never be older than the state it reads.
   */
  const stoppedRef = useRef<(mime: string, parts: Blob[]) => Promise<void>>(
    async () => {},
  );
  /** Fires if the recorder never reports a stop, so Done is never silent. */
  const stopWatchdogRef = useRef<number | null>(null);
  const stopHardRef = useRef<number | null>(null);
  const stopProbeRef = useRef<number | null>(null);
  const stopRequestedAtRef = useRef(0);
  /**
   * Salvage path: rebuilds the blob from the chunks THIS recording has already
   * delivered. Re-pointed by beginRecording so it always closes over the live
   * recording's own array.
   */
  const recoverRef = useRef<(() => void) | null>(null);
  const [stopSlow, setStopSlow] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    setSupported(
      typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        pickMimeType() !== null,
    );
  }, []);

  /**
   * Release the camera.
   *
   * Stopping every track is the only thing that turns the hardware light off —
   * dropping the element's srcObject does not. A page that leaves the light on
   * after someone navigates away is alarming and, reasonably, reads as being
   * recorded without consent.
   */
  const releaseCamera = useCallback(() => {
    try {
      recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recorderRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;

    if (videoRef.current) videoRef.current.srcObject = null;

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  /**
   * Drop the practice clip and free the blob.
   *
   * createObjectURL pins the whole recording in memory until revoked — a few
   * MB held for the rest of the session on a phone that has none to spare.
   */
  const clearPracticeClip = useCallback(() => {
    setPracticeClip((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
  }, []);

  // Belt and braces: revoke on unmount too, so navigating away mid-practice
  // does not leak the blob.
  useEffect(() => clearPracticeClip, [clearPracticeClip]);

  // Unmount, tab close and bfcache all release. `pagehide` rather than
  // `beforeunload` because iOS Safari does not reliably fire the latter.
  useEffect(() => {
    const onHide = () => releaseCamera();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      releaseCamera();
    };
  }, [releaseCamera]);

  // ── Tech check ─────────────────────────────────────────────

  /** Read the current state without triggering a prompt. */
  const readPermissions = useCallback(async () => {
    const { camera, microphone } = await queryMediaPermissions();
    setCamPerm(camera);
    setMicPerm(microphone);
    return { camera, microphone };
  }, []);

  useEffect(() => {
    if (screen !== "tech") return;
    void readPermissions();
    // Live: flipping the toggle in site settings clears the blocked state
    // without the candidate having to find the Try again button.
    return watchMediaPermissions(() => {
      void readPermissions();
    });
  }, [screen, readPermissions]);

  const runTechCheck = useCallback(async () => {
    setHasRequested(true);
    setRequestFailed(false);
    setCamCheck("pend");
    setMicCheck("pend");
    setNetCheck("pend");
    releaseCamera();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Portrait: candidates hold phones upright, and recording portrait
        // avoids both letterboxing and a rotation prompt.
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } },
        audio: true,
      });
    } catch (err) {
      // The real DOMException name, not a generic failure — the fix is always
      // a permission toggle and the copy has to say which one.
      const name = err instanceof DOMException ? err.name : "";
      setCamCheck("bad");
      setMicCheck("bad");
      // Only a real permission rejection counts as blocked. NotFoundError (no
      // camera attached) and NotReadableError (another app holds it) are
      // different problems, and telling someone to change a setting that is
      // already correct sends them in circles.
      setRequestFailed(name === "NotAllowedError" || name === "SecurityError");
      // Re-read: Chrome flips the stored state to "denied" the moment the
      // prompt is dismissed, so this is what turns a first refusal into the
      // recovery instructions on the next render.
      await readPermissions();
      return;
    }

    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      void videoRef.current.play().catch(() => {});
    }
    setCamCheck(stream.getVideoTracks().length > 0 ? "ok" : "bad");

    // Live level meter, from the real track. A mic that is muted at the OS
    // level enumerates fine and produces silence, which a static "ok" would
    // hide until the first answer came back empty.
    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtor) {
        const ctx = new AudioCtor();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let peak = 0;
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let max = 0;
          for (const v of buf) max = Math.max(max, Math.abs(v - 128));
          const level = Math.min(1, max / 40);
          setMicLevel(level);
          peak = Math.max(peak, level);
          if (peak > 0.12) setMicCheck("ok");
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
        // If nothing is heard in four seconds the mic still passes — a quiet
        // room is not a broken microphone, and blocking on it would strand
        // people who simply did not speak.
        window.setTimeout(() => setMicCheck((s) => (s === "pend" ? "ok" : s)), 4000);
      } else {
        setMicCheck(stream.getAudioTracks().length > 0 ? "ok" : "bad");
      }
    } catch {
      setMicCheck(stream.getAudioTracks().length > 0 ? "ok" : "bad");
    }

    // Connection: a real round trip to our own origin rather than a claimed
    // downlink, because what matters is whether an upload will reach US.
    try {
      const started = performance.now();
      const res = await fetch(`/api/interview/ping?t=${Date.now()}`, {
        method: "HEAD",
        cache: "no-store",
      });
      const ms = performance.now() - started;
      setNetCheck(res.ok && ms < 4000 ? "ok" : "bad");
    } catch {
      setNetCheck("bad");
    }

    await readPermissions();
  }, [releaseCamera, readPermissions]);

  /*
   * The media request is NOT fired on mount.
   *
   * An automatic request that the browser silently suppresses — which is what
   * a remembered block does — looks like the page is broken. Pressing a button
   * makes the prompt expected, and on an origin that is already granted the
   * effect below presses it for them so nobody sees a pointless extra step.
   */
  useEffect(() => {
    if (screen !== "tech") return;
    if (streamRef.current) return;
    /*
     * Chrome stores camera and microphone permission INDEPENDENTLY, and its
     * site-settings UI flips them one at a time. Requiring both to read
     * "granted" meant someone who allowed the camera there sat watching three
     * spinners forever, because nothing ever called this function.
     *
     * So: run as soon as either is granted and neither is denied. If the
     * ungranted one then prompts, that is the normal prompt; if it fails, its
     * own row reports it.
     */
    const anyGranted = camPerm === "granted" || micPerm === "granted";
    const noneDenied = camPerm !== "denied" && micPerm !== "denied";
    if (!anyGranted || !noneDenied) return;
    void runTechCheck();
  }, [screen, camPerm, micPerm, runTechCheck]);

  async function requestAccess() {
    setRequesting(true);
    await runTechCheck();
    setRequesting(false);
  }

  /*
   * Re-attach the live stream when the screen changes.
   *
   * Tech check and Recorder each render their own <video>, so moving between
   * them mounts a NEW element with an empty srcObject while the stream itself
   * is still running. Without this the candidate sees a black stage on the
   * first question and assumes the camera failed — the stream is fine, the
   * element just never received it.
   */
  useEffect(() => {
    const el = videoRef.current;
    const stream = streamRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.muted = true;
      void el.play().catch(() => {});
    }
  }, [screen, qi, phase]);

  const techPassed = camCheck === "ok" && micCheck === "ok" && netCheck === "ok";
  const techFailed = camCheck === "bad" || micCheck === "bad" || netCheck === "bad";

  // ── Recording ──────────────────────────────────────────────

  const current = qi < 0 ? null : questions[qi];
  const limit = current?.answerSeconds ?? PRACTICE.answerSeconds;
  const prepFor = current?.prepSeconds ?? PRACTICE.prepSeconds;

  /** Cancel every stop timer. Called by onstop and by the salvage path. */
  const clearStopTimers = useCallback(() => {
    for (const ref of [stopWatchdogRef, stopHardRef]) {
      if (ref.current !== null) window.clearTimeout(ref.current);
      ref.current = null;
    }
    // An interval, not a timeout — cleared with the matching call rather than
    // relying on the two id spaces happening to be shared.
    if (stopProbeRef.current !== null) window.clearInterval(stopProbeRef.current);
    stopProbeRef.current = null;
  }, []);

  /**
   * Stop, and wait properly.
   *
   * MediaRecorder.stop() is fire-and-forget, so silence had to be eliminated —
   * but the first attempt eliminated it by declaring failure at 3 seconds and
   * discarding the recording, which is worse than the silence. A candidate who
   * spoke for two minutes and is told to do it again may simply close the tab.
   *
   * So nothing is thrown away. The soft stage only changes the wording; the
   * hard stage salvages the chunks already delivered rather than abandoning
   * them.
   */
  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      // Nothing to stop is itself worth saying — the alternative is a button
      // press that vanishes.
      setToast("That recording had already stopped. Tap Start over to retry.");
      setPhase("prep");
      return;
    }

    setPhase("uploading");
    setUploadPct(0);
    setStopSlow(false);
    clearStopTimers();
    stopRequestedAtRef.current = Date.now();

    stopLog("stop() requested", {
      state: recorder.state,
      mime: recorder.mimeType,
      recordedMs: Date.now() - startedAtRef.current,
    });

    // Is the recorder alive but slow, or genuinely wedged? This is the fact
    // that separates the two, so it is sampled rather than inferred.
    stopProbeRef.current = window.setInterval(() => {
      stopLog("still waiting", {
        msSinceStop: Date.now() - stopRequestedAtRef.current,
        state: recorderRef.current?.state ?? "gone",
      });
    }, 1000);

    stopWatchdogRef.current = window.setTimeout(() => {
      stopWatchdogRef.current = null;
      stopLog("SOFT stage — still no onstop", {
        msSinceStop: Date.now() - stopRequestedAtRef.current,
        state: recorderRef.current?.state ?? "gone",
      });
      // Copy only. No latch, no phase change, nothing discarded.
      setStopSlow(true);
    }, STOP_SOFT_MS);

    stopHardRef.current = window.setTimeout(() => {
      stopHardRef.current = null;
      if (finishingRef.current) return;
      stopLog("HARD stage — salvaging chunks", {
        msSinceStop: Date.now() - stopRequestedAtRef.current,
        state: recorderRef.current?.state ?? "gone",
        canRecover: recoverRef.current !== null,
      });
      clearStopTimers();
      /*
       * onstop is not coming. Everything start(1000) already delivered is in
       * hand — a WebM missing only its final partial second is still a valid
       * stream with complete clusters, so it uploads and plays. Salvaging is
       * strictly better than telling someone their two minutes are gone.
       */
      if (recoverRef.current) {
        recoverRef.current();
      } else {
        finishingRef.current = true;
        setPhase("prep");
        setToast("Your browser didn't finish that recording. Tap Start over to retry.");
      }
    }, STOP_HARD_MS);

    try {
      recorder.stop();
    } catch (err) {
      stopLog("stop() THREW", { error: String(err) });
      clearStopTimers();
      setPhase("prep");
      setToast("Couldn't stop that recording. Tap Start over to retry.");
    }
  }, [clearStopTimers]);

  /**
   * PUT the blob to a signed storage URL, with progress and a stall watchdog.
   *
   * XHR rather than fetch for `upload.onprogress` — a candidate on a slow
   * connection watching a motionless spinner assumes it has hung and starts
   * over, which is how one lost answer becomes six.
   *
   * TWO timeouts, because they catch different failures:
   *   - a STALL watchdog reset on every progress event, so a genuinely slow
   *     but advancing upload is never killed (the point, on a mobile network
   *     where 7MB can legitimately take minutes);
   *   - a hard ceiling, so an upload that somehow reports progress forever
   *     still ends.
   * Before this there was neither, and a stalled connection sat on "Saving…"
   * with no exit at all.
   */
  const putToSignedUrl = useCallback(
    (url: string, blob: Blob, contentType: string) =>
      new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        const xhr = new XMLHttpRequest();
        let stallTimer: number | null = null;
        let settled = false;

        const finish = (result: { ok: true } | { ok: false; error: string }) => {
          if (settled) return;
          settled = true;
          if (stallTimer !== null) window.clearTimeout(stallTimer);
          resolve(result);
        };

        const armStall = () => {
          if (stallTimer !== null) window.clearTimeout(stallTimer);
          stallTimer = window.setTimeout(() => {
            xhr.abort();
            finish({
              ok: false,
              error: "That upload stopped responding.",
            });
          }, UPLOAD_STALL_MS);
        };

        xhr.open("PUT", url);
        xhr.setRequestHeader("content-type", contentType);
        xhr.timeout = UPLOAD_HARD_TIMEOUT_MS;

        xhr.upload.onprogress = (e) => {
          armStall();
          if (e.lengthComputable) {
            // Capped at 95: the row is not written until confirm returns, and
            // showing 100% before the answer actually exists is a lie.
            setUploadPct(Math.min(95, Math.round((e.loaded / e.total) * 95)));
          }
        };
        xhr.onload = () =>
          finish(
            xhr.status >= 200 && xhr.status < 300
              ? { ok: true }
              : { ok: false, error: "That answer didn't upload." },
          );
        xhr.onerror = () =>
          finish({
            ok: false,
            error: "Your connection dropped before that answer finished uploading.",
          });
        xhr.ontimeout = () =>
          finish({ ok: false, error: "That upload took too long." });
        xhr.onabort = () => finish({ ok: false, error: "That upload was interrupted." });

        armStall();
        xhr.send(blob);
      }),
    [],
  );

  /**
   * Upload one answer — mint, PUT, confirm.
   *
   * The bytes go straight to Supabase Storage. They used to go through
   * /api/interview/answer as multipart form data, which cannot work in
   * production: Vercel caps a serverless request body at 4.5MB and a default
   * 120-second answer is ~7MB even at the reduced bitrate below (it was
   * ~31.6MB before). Localhost has no such cap, which is why every test
   * passed.
   *
   * Confirm is what makes the answer real. Until it returns, the object is
   * unreferenced and invisible to playback, resume and submit.
   */
  const uploadAnswer = useCallback(
    async (
      blob: Blob,
      position: number,
      seconds: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const kind = blob.type.includes("mp4") ? "mp4" : "webm";
      const contentType = kind === "mp4" ? "video/mp4" : "video/webm";

      const readError = async (res: Response, fallback: string) => {
        try {
          return ((await res.json()) as { error?: string }).error ?? fallback;
        } catch {
          return fallback;
        }
      };

      let signed: Response;
      try {
        signed = await fetch("/api/interview/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, position, kind }),
        });
      } catch {
        return { ok: false, error: "Your connection dropped before that answer saved." };
      }
      if (!signed.ok) {
        return { ok: false, error: await readError(signed, "Couldn't start that upload.") };
      }
      const { url } = (await signed.json()) as { url?: string };
      if (!url) return { ok: false, error: "Couldn't start that upload." };

      const put = await putToSignedUrl(url, blob, contentType);
      if (!put.ok) return put;

      setUploadPct(97);

      let confirmed: Response;
      try {
        confirmed = await fetch("/api/interview/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, position, duration: seconds, kind }),
        });
      } catch {
        return {
          ok: false,
          error: "Your answer uploaded but we couldn't save it.",
        };
      }
      if (!confirmed.ok) {
        return {
          ok: false,
          error: await readError(confirmed, "Your answer uploaded but didn't save."),
        };
      }

      setUploadPct(100);
      return { ok: true };
    },
    [token, putToSignedUrl],
  );

  const beginRecording = useCallback(() => {
    if (!streamRef.current) return;
    const mime = pickMimeType();
    finishingRef.current = false;
    stopRequestedAtRef.current = 0;
    setStopSlow(false);

    /*
     * One array per recording, captured in this closure — NOT a ref shared by
     * every recorder the page creates.
     *
     * MediaRecorder.stop() flushes its final chunk asynchronously, so an
     * abandoned recording (Start over, or the stop watchdog) can deliver one
     * last chunk after the next recording has already begun. With a shared
     * array that chunk lands in the next answer's buffer, and a stray cluster
     * fragment ahead of a valid stream yields a file that either plays badly
     * or fails the upload route's magic-byte check outright.
     *
     * Scoped this way, a late chunk from a dead recorder can only ever reach
     * the dead recorder's own array, which nothing reads.
     */
    const chunks: Blob[] = [];

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(streamRef.current, {
        ...(mime ? { mimeType: mime } : {}),
        // Hints, not guarantees — every browser is free to ignore them, and
        // one that does is no worse off than before.
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
    } catch {
      setToast("This browser couldn't start recording.");
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
      // THE discriminator: a chunk arriving after stop() was requested means
      // the recorder is alive and merely slow, not wedged.
      if (stopRequestedAtRef.current > 0) {
        stopLog("chunk AFTER stop()", {
          msSinceStop: Date.now() - stopRequestedAtRef.current,
          size: e.data.size,
          chunks: chunks.length,
          state: recorder.state,
        });
      }
    };
    const finalMime = () => recorder.mimeType || mime || "video/webm";

    // Salvage entry point for the hard watchdog — same handler, same chunks.
    recoverRef.current = () => {
      void stoppedRef.current(finalMime(), chunks);
    };

    recorder.onstop = () => {
      stopLog("onstop ARRIVED", {
        msSinceStop: stopRequestedAtRef.current
          ? Date.now() - stopRequestedAtRef.current
          : null,
        chunks: chunks.length,
        totalBytes: chunks.reduce((n, c) => n + c.size, 0),
        alreadyFinishing: finishingRef.current,
      });
      clearStopTimers();
      // The chunks travel WITH the callback, so the handler can never read a
      // different recording's buffer.
      void stoppedRef.current(finalMime(), chunks);
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    // A timeslice means partial data survives a crash mid-answer rather than
    // the whole blob being lost with the recorder.
    recorder.start(1000);
    setRecLeft(limit);
    setPhase("rec");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, clearStopTimers]);

  /** Runs once the recorder has flushed. Practice is discarded here. */
  async function handleStopped(mime: string, parts: Blob[]) {
    // Whoever gets here first wins — onstop or the salvage path. Both do the
    // same work with the same chunks, so the loser is a genuine no-op rather
    // than a discarded recording.
    if (finishingRef.current) return;
    finishingRef.current = true;
    setStopSlow(false);

    const seconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    const blob = new Blob(parts, { type: mime });

    // A zero-byte blob means the recorder produced nothing. Uploading it would
    // fail server-side with a confusing message; saying so here is clearer —
    // and for practice it would mean handing an empty blob to a <video>.
    if (blob.size === 0) {
      setPhase("prep");
      setToast("That recording came through empty. Tap Start over to try again.");
      return;
    }

    /*
     * PRACTICE STOPS HERE. Nothing is uploaded and nothing is stored — this
     * returns before uploadAnswer, so no signed URL is minted, no object is
     * PUT and no interview_answers row is written.
     *
     * The blob is turned into an object URL purely so the candidate can watch
     * it back locally. That is the only thing a practice round can actually
     * prove: a green tick says the mic is readable, it does not say the OS
     * has it muted or that they are backlit into a silhouette.
     */
    if (qi < 0) {
      setPracticeClip((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      setPhase("review");
      return;
    }

    const question = questions[qi];
    if (!question) {
      // Previously a bare `return` — the overlay would have sat on "Saving…"
      // forever with no way out. Silence is the failure mode being eliminated.
      setPhase("prep");
      setToast("Something went wrong finding that question. Tap Start over.");
      return;
    }

    setPhase("uploading");
    setUploadPct(0);
    const result = await uploadAnswer(blob, question.position, seconds);

    if (!result.ok) {
      setPhase("prep");
      // Named as one answer, because that is the whole cost — every earlier
      // answer is already a committed row on the server.
      setToast(`${result.error} Tap Start over to record this one again.`);
      return;
    }

    setQuestions((prev) =>
      prev.map((q, i) =>
        i === qi ? { ...q, answered: true, recordedSeconds: seconds } : q,
      ),
    );
    setToast(`Answer ${qi + 1} saved`);
    setPhase("prep");

    const next = questions.findIndex((q, i) => i > qi && !q.answered);
    if (next === -1) setScreen("review");
    else setQi(next);
  }

  // Re-pointed on every render, so onstop always calls today's closure.
  stoppedRef.current = handleStopped;

  function firstUnanswered(): number {
    const idx = questions.findIndex((q) => !q.answered);
    return idx === -1 ? 0 : idx;
  }

  // Prep countdown.
  useEffect(() => {
    if (screen !== "record" || phase !== "prep") return;
    setPrepLeft(prepFor);
    const id = window.setInterval(() => {
      setPrepLeft((left) => {
        if (left <= 1) {
          window.clearInterval(id);
          beginRecording();
          return 0;
        }
        return left - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, phase, qi, prepFor]);

  // Record countdown — auto-stops at zero so a limit is a limit.
  useEffect(() => {
    if (phase !== "rec") return;
    const id = window.setInterval(() => {
      setRecLeft((left) => {
        if (left <= 1) {
          window.clearInterval(id);
          stopRecorder();
          return 0;
        }
        return left - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, stopRecorder]);

  // ── Consent ────────────────────────────────────────────────

  async function acceptConsent() {
    if (!agreed) {
      // A disabled button would not explain itself; the error names the gate.
      setAgreeErr(true);
      setToast("Please confirm you agree to be recorded");
      return;
    }
    try {
      await fetch("/api/interview/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Consent is stamped server-side and is idempotent; a failed stamp must
      // not block someone who has already agreed on screen.
    }
    setScreen("tech");
  }

  // ── Review ─────────────────────────────────────────────────

  const outstanding = questions.filter((q) => q.required && !q.answered);

  async function submit() {
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await fetch("/api/interview/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setSubmitErr(body.error ?? "Couldn't submit. Please try again.");
        setSubmitting(false);
        return;
      }
      releaseCamera();
      setScreen("done");
    } catch {
      setSubmitErr("Your connection dropped. Your answers are saved — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function watch(position: number) {
    try {
      const res = await fetch(
        `/api/interview/playback?token=${encodeURIComponent(token)}&position=${position}`,
      );
      const body = (await res.json()) as { url?: string; error?: string };
      if (!body.url) {
        setToast(body.error ?? "Couldn't load that answer.");
        return;
      }
      // A short-lived signed URL, minted server-side. The storage path itself
      // never reaches this component.
      setWatching({ position, url: body.url });
    } catch {
      setToast("Couldn't load that answer.");
    }
  }

  if (supported === false) {
    return (
      <InterviewShell
        companyName={session.companyName}
        companyInitial={session.companyInitial}
        jobTitle={session.jobTitle}
      >
        <UnsupportedScreen />
      </InterviewShell>
    );
  }

  const stepIndex = FLOW.indexOf(screen);

  return (
    <div className="iv">
      <div className="iv-wrap">
        <div className="iv-sheet">
          <div className="flex items-center gap-3 px-0.5 pb-[18px] pt-[22px]">
            <span className="iv-sora flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--purple-tint)] text-lg font-extrabold tracking-[-0.03em] text-[var(--purple-ink)]">
              {session.companyInitial}
            </span>
            <div className="min-w-0">
              <p className="m-0 truncate text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--t1)]">
                {session.companyName}
              </p>
              <p className="m-0 mt-0.5 truncate text-[12.5px] leading-tight text-[var(--t3)]">
                {session.jobTitle}
              </p>
            </div>
            {stepIndex > -1 && (
              <span className="ml-auto shrink-0 whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--surface)] px-[11px] py-[5px] text-[11.5px] font-bold text-[var(--t3)]">
                Step {stepIndex + 1} of 5
              </span>
            )}
          </div>

          {stepIndex > -1 && (
            <div className="iv-rail">
              {FLOW.map((s, i) => (
                <i
                  key={s}
                  className={i < stepIndex ? "done" : i === stepIndex ? "on" : ""}
                />
              ))}
            </div>
          )}

          {screen === "welcome" && (
            <Welcome
              session={session}
              questionCount={questions.length}
              onStart={() => setScreen("consent")}
            />
          )}

          {screen === "consent" && (
            <Consent
              companyName={session.companyName}
              agreed={agreed}
              error={agreeErr}
              onToggle={(v) => {
                setAgreed(v);
                setAgreeErr(false);
              }}
              onContinue={() => void acceptConsent()}
            />
          )}

          {screen === "tech" && (
            <TechCheck
              videoRef={videoRef}
              cam={camCheck}
              mic={micCheck}
              net={netCheck}
              micLevel={micLevel}
              /* Blocked ONLY when the browser says so, or when a real
                 permission rejection came back. A first-time visitor with no
                 stored decision is never shown recovery instructions. */
              blocked={
                camPerm === "denied" || micPerm === "denied" || requestFailed
              }
              asked={hasRequested}
              requesting={requesting}
              platform={platform}
              onRequest={() => void requestAccess()}
              passed={techPassed}
              failed={techFailed}
              onRetry={() => {
                void requestAccess();
                setToast("Checking again…");
              }}
              onContinue={() => {
                setQi(-1);
                setPhase("prep");
                setScreen("record");
              }}
            />
          )}

          {screen === "record" && (
            <Recorder
              videoRef={videoRef}
              isPractice={qi < 0}
              index={qi}
              total={questions.length}
              text={current?.question ?? PRACTICE.question}
              phase={phase}
              prepLeft={prepLeft}
              recLeft={recLeft}
              limit={limit}
              uploadPct={uploadPct}
              stopSlow={stopSlow}
              companyName={session.companyName}
              canSkipPrep={prepFor >= PREP_SKIPPABLE_AT}
              onSkipPrep={beginRecording}
              onStartOver={() => {
                stopRecorder();
                finishingRef.current = true;
                setPhase("prep");
                setToast("Starting that answer again");
              }}
              onDone={() => stopRecorder()}
              practiceClip={practiceClip}
              onPracticeAgain={() => {
                clearPracticeClip();
                setPhase("prep");
              }}
              onPracticeDone={() => {
                clearPracticeClip();
                setQi(firstUnanswered());
                setPhase("prep");
                setToast("Practice done — nothing was saved");
              }}
            />
          )}

          {screen === "review" && (
            <Review
              questions={questions}
              allowRerecord={session.allowRerecord}
              companyName={session.companyName}
              outstanding={outstanding.length}
              submitting={submitting}
              error={submitErr}
              onWatch={(p) => void watch(p)}
              onRecord={(i) => {
                setQi(i);
                setPhase("prep");
                setScreen("record");
              }}
              onSubmit={() => void submit()}
            />
          )}

          {screen === "done" && <Submitted companyName={session.companyName} />}

          <div className="mt-auto px-0.5 pt-5 text-center">
            <p className="m-0 text-xs leading-relaxed text-[var(--t3)]">
              <span className="inline-flex items-center gap-1.5 font-bold text-[var(--t2)]">
                Powered by{" "}
                <b className="iv-sora font-extrabold tracking-[-0.02em] text-[var(--t1)]">
                  Remotiv<i className="not-italic text-[var(--purple)]">.</i>
                </b>
              </span>
            </p>
            <p className="m-0 mt-1.5 text-xs leading-relaxed text-[var(--t3)]">
              Your recordings are handled by Remotiv on behalf of {session.companyName}.
            </p>
          </div>
        </div>
      </div>

      {watching && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(20,16,32,0.72)] p-4 backdrop-blur-sm">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setWatching(null)}
            className="absolute inset-0 cursor-default"
          />
          <div className="relative w-full max-w-[360px]">
            {/* biome-ignore lint/a11y/useMediaCaption: candidate's own recording, no track exists */}
            <video
              src={watching.url}
              controls
              autoPlay
              playsInline
              className="w-full rounded-2xl bg-black"
            />
            <button
              type="button"
              onClick={() => setWatching(null)}
              className="iv-btn iv-ghost mt-3"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="iv-toast show">
          <Check className="size-4 shrink-0 text-[var(--mint)]" strokeWidth={2.6} />
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────

function Welcome({
  session,
  questionCount,
  onStart,
}: {
  session: CandidateSession;
  questionCount: number;
  onStart: () => void;
}) {
  const deadline = useDeadline(session.expiresAt);

  return (
    <div className="iv-card">
      <h1 className="iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]">
        Your video interview
      </h1>
      <p className="m-0 mb-5 text-sm leading-relaxed text-[var(--t2)]">
        {questionCount} question{questionCount === 1 ? "" : "s"}, answered{" "}
        <span className="iv-hl">in your own time</span> — no scheduling, no call.
        {session.allowRerecord
          ? " You can re-record anything before you submit."
          : " Each answer is recorded once, so take a moment before you start."}
      </p>

      <div className="mb-[18px] overflow-hidden rounded-[14px] border border-[var(--line)]">
        <Fact label="Questions" value={String(questionCount)} />
        <Fact label="Time needed" value={`About ${session.estimatedMinutes} minutes`} />
        <Fact label="Complete by" value={deadline} amber />
      </div>

      {/* Above the button on purpose — this is the single most
          anxiety-reducing thing on the page. */}
      <div className="mb-4 flex gap-[11px] rounded-[14px] border border-[rgba(73,215,167,0.3)] bg-[var(--mint-tint)] px-[15px] py-[13px]">
        <Check
          className="mt-px size-[17px] shrink-0 text-[var(--mint-ink)]"
          strokeWidth={2}
        />
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--mint-ink)]">
          <b className="font-bold">There&apos;s a practice round first.</b> It
          isn&apos;t recorded or shared — it&apos;s just to get comfortable.
        </p>
      </div>

      <button type="button" onClick={onStart} className="iv-btn iv-purple">
        Get started
        <ArrowRight className="size-[17px]" strokeWidth={2.2} />
      </button>
      <p className="m-0 mt-[11px] text-center text-[12.5px] leading-relaxed text-[var(--t3)]">
        Works on your phone. You&apos;ll need camera and microphone access.
      </p>
    </div>
  );
}

function Fact({
  label,
  value,
  amber,
}: {
  label: string;
  value: string;
  amber?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3.5 border-b border-[var(--line-soft)] px-3.5 py-3 text-[13.5px] last:border-b-0">
      <span className="text-[var(--t3)]">{label}</span>
      <b
        className={`text-right font-bold ${amber ? "text-[var(--amber-ink)]" : "text-[var(--t1)]"}`}
      >
        {value}
      </b>
    </div>
  );
}

function Consent({
  companyName,
  agreed,
  error,
  onToggle,
  onContinue,
}: {
  companyName: string;
  agreed: boolean;
  error: boolean;
  onToggle: (v: boolean) => void;
  onContinue: () => void;
}) {
  return (
    <div className="iv-card">
      <h1 className="iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]">
        Before you start
      </h1>
      <p className="m-0 mb-5 text-sm leading-relaxed text-[var(--t2)]">
        Please read these — they matter.
      </p>

      {/* Four distinct icons carrying four distinct meanings. A single generic
          glyph on all four would flatten "you're being recorded" and "a person
          decides" into the same statement. */}
      <div className="mb-[18px] overflow-hidden rounded-[14px] border border-[var(--line)]">
        <ConsentRow
          icon={<Video className="size-[15px]" strokeWidth={1.9} />}
          tint="bg-[var(--sky-tint)] text-[var(--sky-ink)]"
          lead="You're being recorded"
          body={`Your video answers are saved and shared with ${companyName}'s hiring team.`}
        />
        <ConsentRow
          icon={<Lightbulb className="size-[15px]" strokeWidth={1.9} />}
          tint="bg-[var(--purple-tint)] text-[var(--purple)]"
          lead="AI helps review, a person decides"
          body="Answers are transcribed and reviewed with AI assistance. Every hiring decision is made by a human — nothing is automated."
        />
        <ConsentRow
          icon={<Lock className="size-[15px]" strokeWidth={1.9} />}
          tint="bg-[var(--mint-tint)] text-[var(--mint-ink)]"
          lead="Kept for 6 months, then deleted"
          body="Recordings are stored securely by Remotiv and removed automatically after six months."
        />
        <ConsentRow
          icon={<TriangleAlert className="size-[15px]" strokeWidth={1.9} />}
          tint="bg-[var(--amber-tint)] text-[var(--amber-ink)]"
          lead="Answer in your own words"
          body="Reading from an AI tool is easy to spot and counts against you. We'd rather hear you think."
        />
      </div>

      <label
        className={`mb-4 flex cursor-pointer items-start gap-3 rounded-[14px] border bg-[var(--inset)] p-3.5 transition-colors ${
          error
            ? "border-[var(--red)] shadow-[0_0_0_3px_rgba(224,82,75,0.13)]"
            : "border-[var(--line)] hover:border-[var(--line-strong)]"
        }`}
      >
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-px size-5 shrink-0 accent-[var(--purple)]"
        />
        <span className="text-[13.5px] font-semibold leading-relaxed text-[var(--t1)]">
          I understand and agree to be recorded.
        </span>
      </label>

      <button type="button" onClick={onContinue} className="iv-btn iv-purple">
        Continue
        <ArrowRight className="size-[17px]" strokeWidth={2.2} />
      </button>
    </div>
  );
}

function ConsentRow({
  icon,
  tint,
  lead,
  body,
}: {
  icon: React.ReactNode;
  tint: string;
  lead: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 border-b border-[var(--line-soft)] p-3.5 last:border-b-0">
      <span
        className={`flex size-[30px] shrink-0 items-center justify-center rounded-[9px] ${tint}`}
      >
        {icon}
      </span>
      <p className="m-0 text-[13px] leading-relaxed text-[var(--t2)]">
        <b className="mb-0.5 block text-[13.5px] font-bold text-[var(--t1)]">{lead}</b>
        {body}
      </p>
    </div>
  );
}

function TechCheck({
  videoRef,
  cam,
  mic,
  net,
  micLevel,
  blocked,
  asked,
  requesting,
  platform,
  onRequest,
  passed,
  failed,
  onRetry,
  onContinue,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cam: CheckState;
  mic: CheckState;
  net: CheckState;
  micLevel: number;
  /** The browser holds a remembered block, or the request was refused. */
  blocked: boolean;
  /** Whether we have asked yet — separates "not yet" from "said no". */
  asked: boolean;
  requesting: boolean;
  platform: Platform;
  onRequest: () => void;
  passed: boolean;
  failed: boolean;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const recovery = recoveryFor(platform);
  return (
    <div className="iv-card">
      <h1 className="iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]">
        Check your setup
      </h1>
      <p className="m-0 mb-5 text-sm leading-relaxed text-[var(--t2)]">
        All three need to pass before you start. This takes a few seconds.
      </p>

      <div className="iv-stage mx-auto" style={{ maxWidth: 210 }}>
        {/* biome-ignore lint/a11y/useMediaCaption: live self-view, no track exists */}
        <video ref={videoRef} playsInline muted autoPlay className="mirror" />
        {cam !== "ok" && (
          <div className="relative z-[1] flex flex-col items-center gap-2.5 text-white/20">
            <User className="size-[46px]" strokeWidth={1.4} />
            <span className="text-xs font-semibold text-white/[0.34]">
              {blocked
                ? "No camera access"
                : asked
                  ? "Starting camera…"
                  : "Camera preview"}
            </span>
          </div>
        )}
      </div>

      <div className="mb-4 overflow-hidden rounded-[14px] border border-[var(--line)]">
        <CheckRow
          state={cam}
          running={asked}
          okIcon={<Video className="size-[15px]" strokeWidth={2} />}
          badIcon={<VideoOff className="size-[15px]" strokeWidth={2} />}
          title={cam === "bad" && blocked ? "Camera blocked" : "Camera"}
          sub={
            cam === "ok"
              ? "Looking good — you're centred"
              : cam === "bad"
                ? blocked
                  ? "Blocked for this site"
                  : "Couldn't start your camera"
                : asked
                  ? "Starting up…"
                  : "Not checked yet"
          }
        />
        <CheckRow
          state={mic}
          running={asked}
          okIcon={<Mic className="size-[15px]" strokeWidth={2} />}
          badIcon={<MicOff className="size-[15px]" strokeWidth={2} />}
          title={mic === "bad" && blocked ? "Microphone blocked" : "Microphone"}
          sub={
            mic === "ok"
              ? "Picking up sound clearly"
              : mic === "bad"
                ? blocked
                  ? "Blocked for this site"
                  : "Couldn't start your microphone"
                : asked
                  ? "Say something to test it"
                  : "Not checked yet"
          }
          meter={mic !== "bad" ? micLevel : undefined}
        />
        <CheckRow
          state={net}
          running={asked}
          okIcon={<Wifi className="size-[15px]" strokeWidth={2} />}
          badIcon={<Wifi className="size-[15px]" strokeWidth={2} />}
          title="Connection"
          sub={
            net === "ok"
              ? "Stable — fast enough for video"
              : net === "bad"
                ? "Too slow or unreachable right now"
                : asked
                  ? "Checking upload speed…"
                  : "Not checked yet"
          }
        />
      </div>

      {blocked && (
        <div className="mb-4 flex gap-[11px] rounded-[14px] border border-[rgba(224,82,75,0.26)] bg-[var(--red-tint)] px-[15px] py-[13px]">
          <VideoOff
            className="mt-px size-[17px] shrink-0 text-[var(--red-ink)]"
            strokeWidth={2}
          />
          {/* Only the steps for the browser they are actually in. The previous
              copy told a desktop Chrome user to "tap" and then explained
              iPhone Settings, so half of it was wrong wherever it was read. */}
          <div className="min-w-0">
            <p className="m-0 text-[12.5px] leading-relaxed text-[var(--red-ink)]">
              <b className="font-bold">We can&apos;t reach your camera.</b>{" "}
              {recovery.lead}
            </p>
            <ol className="m-0 mt-2 list-decimal pl-[18px] text-[12.5px] leading-relaxed text-[var(--red-ink)]">
              {recovery.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/* The request is a button press, never automatic. A browser that
          silently suppresses an auto-request leaves a page that looks broken;
          a prompt the candidate asked for is a prompt they expect. */}
      {/* Shown whenever we have not successfully acquired a stream — including
          on a blocked origin. Chrome hid this entirely when the permission was
          remembered as denied, which left a page with recovery steps and no
          way to act on them without a reload. Pressing it after clearing the
          block is the whole recovery path. */}
      {!asked && (
        <button
          type="button"
          onClick={onRequest}
          disabled={requesting}
          className="iv-btn iv-purple mb-2.5"
        >
          {requesting
            ? "Waiting for your browser…"
            : blocked
              ? "Try asking again"
              : "Allow camera and microphone"}
          {!requesting && <Video className="size-[17px]" strokeWidth={2.2} />}
        </button>
      )}

      {(asked || blocked) && (
        <button
          type="button"
          onClick={onContinue}
          disabled={!passed}
          className="iv-btn iv-purple"
        >
          Try a practice question
          <ArrowRight className="size-[17px]" strokeWidth={2.2} />
        </button>
      )}

      {(failed || blocked) && (
        <button
          type="button"
          onClick={onRetry}
          disabled={requesting}
          className="iv-btn iv-ghost mt-2.5"
        >
          {requesting ? "Checking…" : "Try again"}
        </button>
      )}

      <p className="m-0 mt-[11px] text-center text-[12.5px] leading-relaxed text-[var(--t3)]">
        {passed
          ? "All set. The practice round is next — it isn't recorded."
          : blocked
            ? "Follow the steps above, then tap Try again."
            : !asked
              ? "Your browser will ask for permission. Nothing is recorded during this check."
              : failed
                ? "Fix the item above, then try again."
                : "Hold your phone upright. Find a quiet spot with light on your face."}
      </p>
    </div>
  );
}

function CheckRow({
  state,
  running,
  okIcon,
  badIcon,
  title,
  sub,
  meter,
}: {
  state: CheckState;
  /** True only while a check is genuinely in flight. */
  running: boolean;
  okIcon: React.ReactNode;
  badIcon: React.ReactNode;
  title: string;
  sub: string;
  meter?: number;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--line-soft)] px-3.5 py-3 text-[13.5px] last:border-b-0">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
          state === "ok"
            ? "bg-[var(--mint-tint)] text-[var(--mint-ink)]"
            : state === "bad"
              ? "bg-[var(--red-tint)] text-[var(--red-ink)]"
              : "bg-[var(--inset)] text-[var(--t4)]"
        }`}
      >
        {state === "ok" ? (
          <Check className="size-3.5" strokeWidth={2.4} />
        ) : state === "bad" ? (
          badIcon
        ) : running ? (
          <span className="iv-spin" />
        ) : (
          // A spinner on a check nobody has started reads as "hanging". An
          // idle dot reads as "not yet", which is what pend actually means.
          <span className="size-1.5 rounded-full bg-[var(--t4)]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-bold leading-tight text-[var(--t1)]">
          {title}
        </span>
        <span
          className={`mt-0.5 block text-xs leading-snug ${
            state === "bad" ? "font-semibold text-[var(--red-ink)]" : "text-[var(--t3)]"
          }`}
        >
          {sub}
        </span>
      </span>
      {meter !== undefined && (
        <span className="flex shrink-0 items-center gap-[3px]">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <i
              key={i}
              className={`w-[3px] rounded-sm transition-all ${
                meter * 7 > i ? "bg-[var(--mint)]" : "bg-[var(--line-strong)]"
              }`}
              style={{ height: 6 + (meter * 7 > i ? i * 1.6 : 0) }}
            />
          ))}
        </span>
      )}
      {state === "ok" && okIcon && <span className="sr-only">{title} ready</span>}
    </div>
  );
}

function Recorder({
  videoRef,
  isPractice,
  index,
  total,
  text,
  phase,
  prepLeft,
  recLeft,
  limit,
  uploadPct,
  stopSlow,
  companyName,
  canSkipPrep,
  onSkipPrep,
  onStartOver,
  onDone,
  practiceClip,
  onPracticeAgain,
  onPracticeDone,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isPractice: boolean;
  index: number;
  total: number;
  text: string;
  phase: "prep" | "rec" | "uploading" | "review";
  prepLeft: number;
  recLeft: number;
  limit: number;
  uploadPct: number;
  stopSlow: boolean;
  companyName: string;
  canSkipPrep: boolean;
  onSkipPrep: () => void;
  onStartOver: () => void;
  onDone: () => void;
  practiceClip: string | null;
  onPracticeAgain: () => void;
  onPracticeDone: () => void;
}) {
  const low = recLeft <= 15;
  return (
    <div className="iv-card">
      <div className="mb-[11px] flex items-center justify-between gap-3">
        {/* The number now lives on the stage with the question. This row keeps
            only the phase, so the card header does not repeat itself. */}
        <span className="text-[11.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--t3)]">
          {isPractice ? "Practice" : `${index + 1} of ${total}`}
        </span>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-[11px] py-1 text-[11.5px] font-bold ${
            PHASE_PILL[phase]
          }`}
        >
          {phase === "uploading" && isPractice ? "Finishing" : PHASE_LABEL[phase]}
        </span>
      </div>

      {/* The question is NOT above the stage any more.
          It sat at the top of a ~780px-tall column while the candidate's eyes
          were on their own face in the middle — someone who knew a question
          existed still had to hunt for it, and a candidate who misses it
          answers the wrong thing.

          It is now burned into the top of the video itself, over a gradient
          scrim. That puts it exactly where the eye already is, it cannot
          scroll away from the preview because it moves with it, and it stays
          on screen for the whole recording rather than only before it. The
          scrim sits in the headroom above the face, which is dead space in a
          9:16 self-view. */}
      <div className="iv-stage">
        {/* Colours come from .iv-stage-scoped classes, not text-* utilities:
            `.iv-stage p` outranks a bare utility, so a utility here silently
            loses and the text renders dark. */}
        <div className="iv-qscrim pointer-events-none absolute inset-x-0 top-0 z-[4] px-3.5 pb-9 pt-3">
          <p className="iv-qlabel m-0 mb-1 text-[10.5px] font-extrabold uppercase tracking-[0.1em]">
            {isPractice ? "Practice question" : `Question ${index + 1} of ${total}`}
          </p>
          <p className="iv-q m-0 text-[15px] font-bold leading-snug tracking-[-0.01em]">
            {text}
          </p>
        </div>

        {/* biome-ignore lint/a11y/useMediaCaption: live self-view, no track exists */}
        <video ref={videoRef} playsInline muted autoPlay className="mirror" />

        {isPractice && (
          <span className="absolute right-3 top-3 z-[5] rounded-full bg-[var(--lime)] px-2.5 py-1 text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[#2F3A00]">
            Practice · not shared
          </span>
        )}

        {phase === "rec" && !isPractice && (
          <span className="absolute right-3 top-3 z-[5] inline-flex items-center gap-[7px] rounded-full bg-[rgba(224,82,75,0.92)] px-[11px] py-[5px] text-[11px] font-extrabold tracking-[0.08em] text-white">
            <span className="iv-blink size-1.5 rounded-full bg-white" />
            REC
          </span>
        )}

        {phase === "rec" && (
          <>
            <div className="absolute inset-x-3 bottom-3 z-[2] flex items-center justify-between gap-2.5">
              <span
                className={`rounded-full px-3 py-1.5 text-[12.5px] font-bold tabular-nums text-white backdrop-blur ${
                  low ? "bg-[rgba(224,82,75,0.9)]" : "bg-[rgba(20,16,32,0.66)]"
                }`}
              >
                {mmss(recLeft)} left
              </span>
              <span className="rounded-full bg-[rgba(20,16,32,0.5)] px-3 py-1.5 text-[12.5px] font-bold text-white backdrop-blur">
                {isPractice ? "Practice" : `${index + 1} of ${total}`}
              </span>
            </div>
            <div className="absolute inset-x-0 bottom-0 z-[2] h-[3px] bg-white/[0.16]">
              <i
                className={`block h-full transition-[width] duration-1000 ease-linear ${low ? "bg-[var(--red)]" : "bg-[var(--mint)]"}`}
                style={{ width: `${(recLeft / limit) * 100}%` }}
              />
            </div>
          </>
        )}

        {phase === "prep" && (
          <div className="absolute inset-0 z-[3] flex flex-col items-center justify-center gap-2 bg-[rgba(20,16,32,0.82)] p-6 text-center backdrop-blur-[3px]">
            {/* The prep overlay covers the stage, so it has to carry the
                question too — otherwise the one moment designed for reading it
                is the one moment it is hidden. */}
            <p className="iv-q m-0 mb-1 max-w-[280px] text-[15px] font-bold leading-snug">
              {text}
            </p>
            <p className="iv-dimmer m-0 text-[11px] font-extrabold uppercase tracking-[0.14em]">
              Recording starts in
            </p>
            <p className="iv-sora m-0 my-0.5 text-[52px] font-extrabold leading-none tracking-[-0.05em]">
              {prepLeft}
            </p>
            <p className="iv-dim m-0 max-w-[230px] text-[13px] leading-relaxed">
              Read the question, take a breath. You&apos;ll have {mmss(limit)} to answer.
            </p>
            {canSkipPrep && (
              <button
                type="button"
                onClick={onSkipPrep}
                className="mt-3.5 rounded-full border border-white/20 bg-white/[0.14] px-[18px] py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-white/[0.24]"
              >
                Start now
              </button>
            )}
          </div>
        )}

        {phase === "review" && practiceClip && (
          <div className="absolute inset-0 z-[6] flex flex-col bg-[var(--ink)]">
            {/* NOT mirrored. The live preview is flipped because an unmirrored
                self-view reads as wrong, but the recording itself is not —
                and this is the one moment the candidate should see what the
                hiring team will see. */}
            {/* biome-ignore lint/a11y/useMediaCaption: the candidate's own unsaved practice clip */}
            <video
              src={practiceClip}
              controls
              autoPlay
              playsInline
              className="size-full object-contain"
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] bg-gradient-to-b from-[rgba(10,8,18,0.9)] to-transparent px-3.5 pb-7 pt-3">
              <p className="iv-qlabel m-0 mb-1 text-[10.5px] font-extrabold uppercase tracking-[0.1em]">
                Your practice recording
              </p>
              <p className="iv-q m-0 text-[13.5px] font-bold leading-snug">
                Can you see and hear yourself clearly?
              </p>
            </div>
          </div>
        )}

        {phase === "uploading" && (
          <div className="absolute inset-0 z-[3] flex flex-col items-center justify-center gap-3 bg-[rgba(20,16,32,0.86)] p-6 text-center backdrop-blur-[3px]">
            <Loader className="size-8 animate-spin text-white/70" strokeWidth={2} />
            {/* Practice passes through this phase for the moment between Done
                and the clip being ready. Nothing is uploaded then, so it must
                not say "saving" — a practice round that claims to save would
                contradict every other line on the screen. */}
            {/* A slow flush is NOT an error and must not read like one. The
                phone is still finalising the file; the answer is not at risk,
                and the previous copy ("your browser didn't finish that
                recording") sent people to re-record perfectly good answers. */}
            <p className="m-0 text-[13px] font-semibold">
              {stopSlow
                ? "Still finishing your recording…"
                : isPractice
                  ? "Getting your clip ready…"
                  : `Saving your answer… ${uploadPct}%`}
            </p>
            {stopSlow && (
              <p className="iv-dim m-0 max-w-[240px] text-[11.5px] leading-relaxed">
                This can take a few seconds on a phone. Please don&apos;t close
                this page.
              </p>
            )}
            {!isPractice && !stopSlow && (
              <>
                <div className="h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-white/20">
                  <i
                    className="block h-full rounded-full bg-[var(--mint)] transition-[width]"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
                <p className="iv-dim m-0 text-[11.5px] leading-relaxed">
                  Keep this page open until it finishes.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Sticky so Done is always reachable with a thumb — the portrait stage
          is taller than any phone viewport. */}
      {/* The review actions live in the STICKY row rather than inside the
          overlay: at 375px the stage is ~539px tall, so a control placed under
          the video would sit below the fold and the candidate would have to
          scroll past their own face to continue. */}
      <div className="iv-brow iv-recbtns">
        {phase === "review" ? (
          <>
            <button type="button" onClick={onPracticeAgain} className="iv-btn iv-ghost">
              Record again
            </button>
            <button type="button" onClick={onPracticeDone} className="iv-btn iv-purple">
              Start question 1
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onStartOver}
              disabled={phase !== "rec"}
              className="iv-btn iv-ghost"
            >
              Start over
            </button>
            <button
              type="button"
              onClick={onDone}
              disabled={phase !== "rec"}
              className="iv-btn iv-dark"
            >
              Done
            </button>
          </>
        )}
      </div>

      <div className="mt-3.5 flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--inset)] px-3.5 py-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--mint)] text-[var(--mint-ink)]">
          {isPractice ? (
            <Lock className="size-3" strokeWidth={3} />
          ) : (
            <Save className="size-3" strokeWidth={3} />
          )}
        </span>
        <p className="m-0 text-xs leading-relaxed text-[var(--t2)]">
          {isPractice ? (
            <>
              <b className="font-bold text-[var(--t1)]">This one isn&apos;t saved.</b>{" "}
              Practice is just for you — nothing here is uploaded or shared with{" "}
              {companyName}.
            </>
          ) : (
            <>
              <b className="font-bold text-[var(--t1)]">Saved as you go.</b> Each answer
              uploads the moment you finish it — if your connection drops you&apos;ll
              only lose the one you&apos;re on.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Review({
  questions,
  allowRerecord,
  companyName,
  outstanding,
  submitting,
  error,
  onWatch,
  onRecord,
  onSubmit,
}: {
  questions: CandidateQuestion[];
  allowRerecord: boolean;
  companyName: string;
  outstanding: number;
  submitting: boolean;
  error: string | null;
  onWatch: (position: number) => void;
  onRecord: (index: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="iv-card">
      <h1 className="iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]">
        Review your answers
      </h1>
      <p className="m-0 mb-5 text-sm leading-relaxed text-[var(--t2)]">
        {allowRerecord
          ? `Re-record anything you're not happy with. Once you submit, they go to ${companyName}.`
          : `Have a last look. Once you submit, they go to ${companyName}.`}
      </p>

      <div className="mb-4 overflow-hidden rounded-[14px] border border-[var(--line)]">
        {questions.map((q, i) => (
          <div
            key={q.id}
            className={`flex items-center gap-3 border-b border-[var(--line-soft)] px-3.5 py-3 last:border-b-0 ${
              q.answered ? "" : "bg-[#FEFCF7]"
            }`}
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-lg text-[11.5px] font-extrabold ${
                q.answered
                  ? "bg-[var(--mint-tint)] text-[var(--mint-ink)]"
                  : "bg-[var(--amber-tint)] text-[var(--amber-ink)]"
              }`}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-bold leading-snug tracking-[-0.01em] text-[var(--t1)]">
                {q.shortLabel}
              </span>
              <span
                className={`mt-0.5 block text-xs ${
                  q.answered
                    ? "text-[var(--t3)]"
                    : "font-bold text-[var(--amber-ink)]"
                }`}
              >
                {q.answered
                  ? `Recorded · ${mmss(q.recordedSeconds ?? 0)}`
                  : "Not recorded yet"}
              </span>
            </span>
            <span className="flex shrink-0 gap-2">
              {q.answered && (
                <button
                  type="button"
                  onClick={() => onWatch(q.position)}
                  className="min-h-[34px] rounded-full border border-[var(--line-strong)] bg-[var(--surface)] px-3 py-1.5 text-xs font-bold text-[var(--t2)] transition-colors hover:border-[var(--ink)] hover:bg-[var(--ink)] hover:text-white"
                >
                  Watch
                </button>
              )}
              {/* Re-record follows the session's allow_rerecord. When it is off
                  an already-recorded answer offers nothing — a button that
                  refused server-side would be worse than no button. */}
              {(!q.answered || allowRerecord) && (
                <button
                  type="button"
                  onClick={() => onRecord(i)}
                  className="min-h-[34px] rounded-full border border-[var(--purple)] bg-[var(--surface)] px-3 py-1.5 text-xs font-bold text-[var(--purple)] transition-colors hover:bg-[var(--purple)] hover:text-white"
                >
                  {q.answered ? "Re-record" : "Record"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div
        className={`mb-4 flex gap-[11px] rounded-[14px] border px-[15px] py-[13px] ${
          outstanding > 0
            ? "border-[rgba(224,160,32,0.3)] bg-[var(--amber-tint)]"
            : "border-[rgba(73,215,167,0.3)] bg-[var(--mint-tint)]"
        }`}
      >
        {outstanding > 0 ? (
          <CircleAlert
            className="mt-px size-[17px] shrink-0 text-[var(--amber-ink)]"
            strokeWidth={2}
          />
        ) : (
          <Check
            className="mt-px size-[17px] shrink-0 text-[var(--mint-ink)]"
            strokeWidth={2}
          />
        )}
        <p
          className={`m-0 text-[12.5px] leading-relaxed ${
            outstanding > 0 ? "text-[var(--amber-ink)]" : "text-[var(--mint-ink)]"
          }`}
        >
          {outstanding > 0 ? (
            <>
              <b className="font-bold">
                {outstanding} question{outstanding === 1 ? "" : "s"} still to answer.
              </b>{" "}
              You can submit once every question is recorded.
            </>
          ) : (
            <>
              <b className="font-bold">All {questions.length} recorded.</b> Have a last
              look, then send them over — you can&apos;t change them afterwards.
            </>
          )}
        </p>
      </div>

      {error && (
        <p className="m-0 mb-4 rounded-[14px] bg-[var(--red-tint)] px-[15px] py-3 text-[12.5px] font-semibold leading-relaxed text-[var(--red-ink)]">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={outstanding > 0 || submitting}
        className="iv-btn iv-purple"
      >
        {submitting ? "Submitting…" : "Submit interview"}
        <Send className="size-[17px]" strokeWidth={2.2} />
      </button>
      <p className="m-0 mt-[11px] text-center text-[12.5px] leading-relaxed text-[var(--t3)]">
        {outstanding > 0
          ? `Answer all ${questions.length} questions to submit.`
          : "Submitting is final."}
      </p>
    </div>
  );
}

function Submitted({ companyName }: { companyName: string }) {
  return (
    <div className="iv-card">
      <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
        <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--mint-tint)] text-[var(--mint-ink)]">
          <Check className="size-[34px]" strokeWidth={2.2} />
        </span>
        <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
          That&apos;s everything — thank you
        </h1>
        <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
          Your answers are with {companyName}&apos;s hiring team.
        </p>
        <div className="mt-4 w-full rounded-[14px] border border-[var(--line)] p-3.5 text-left">
          <p className="m-0 mb-2.5 text-xs font-extrabold uppercase tracking-[0.06em] text-[var(--t3)]">
            What happens next
          </p>
          <ol className="m-0 list-decimal pl-[19px] text-[13px] leading-[1.7] text-[var(--t2)]">
            <li>A person reviews your answers, usually within 3 working days.</li>
            <li className="mt-1">
              You&apos;ll hear back by email either way — we don&apos;t leave people
              guessing.
            </li>
            <li className="mt-1">
              If it&apos;s a match, {companyName} will reach out to arrange a live
              conversation.
            </li>
          </ol>
        </div>
        <p className="m-0 mt-4 text-[13px] leading-relaxed text-[var(--t3)]">
          You can close this page now. The link won&apos;t work again.
        </p>
      </div>
    </div>
  );
}
