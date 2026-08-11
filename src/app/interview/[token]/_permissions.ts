/**
 * Camera and microphone permission state, and how to fix it per platform.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * getUserMedia collapses three different situations into one rejection:
 * never asked, asked and allowed, asked and blocked. A page that requests on
 * mount and shows "permission denied" on failure is wrong for two of the
 * three — and it is exactly wrong for the worst case, where Chrome has a
 * remembered block for the origin and suppresses the prompt entirely. The
 * candidate sees a hard failure they never triggered, on a page with no
 * support channel.
 *
 * So: query first, ask on a button press, and only claim "blocked" when the
 * browser actually says blocked.
 */

export type PermissionState = "unknown" | "prompt" | "granted" | "denied";

/**
 * Ask the Permissions API where we stand, without triggering a prompt.
 *
 * `unknown` is a real answer and the common one on Safari, which has never
 * shipped `navigator.permissions.query` for camera or microphone. It is
 * treated as `prompt` by the caller — showing the request button is right
 * whether or not we could look the state up.
 *
 * The two are queried separately because they can genuinely differ: allowing
 * the camera and blocking the mic is two clicks in Chrome's site settings.
 */
export async function queryMediaPermissions(): Promise<{
  camera: PermissionState;
  microphone: PermissionState;
}> {
  const fallback = { camera: "unknown" as const, microphone: "unknown" as const };
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return fallback;
  }

  const read = async (name: string): Promise<PermissionState> => {
    try {
      // `camera` and `microphone` are not in the standard PermissionName union,
      // so the cast is required even though every Chromium browser accepts
      // them. Firefox throws TypeError here, which the catch turns into
      // `unknown` rather than a false `denied`.
      const status = await navigator.permissions.query({
        name: name as PermissionName,
      });
      if (status.state === "granted") return "granted";
      if (status.state === "denied") return "denied";
      return "prompt";
    } catch {
      return "unknown";
    }
  };

  const [camera, microphone] = await Promise.all([
    read("camera"),
    read("microphone"),
  ]);
  return { camera, microphone };
}

/** Live updates, so flipping the toggle in site settings clears the block. */
export function watchMediaPermissions(
  onChange: () => void,
): () => void {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return () => {};
  }
  const statuses: PermissionStatus[] = [];
  let cancelled = false;

  for (const name of ["camera", "microphone"]) {
    navigator.permissions
      .query({ name: name as PermissionName })
      .then((status) => {
        if (cancelled) return;
        status.addEventListener("change", onChange);
        statuses.push(status);
      })
      .catch(() => {});
  }

  return () => {
    cancelled = true;
    for (const s of statuses) s.removeEventListener("change", onChange);
  };
}

// ── Platform-specific recovery ───────────────────────────────

export type Platform =
  | "ios-safari"
  | "android-chrome"
  | "desktop-chrome"
  | "desktop-safari"
  | "desktop-firefox"
  | "other";

/**
 * Which set of instructions to show.
 *
 * User-agent sniffing, which is normally the wrong tool — but the thing being
 * detected here IS the browser's own settings UI, and there is no capability
 * to feature-detect for "where is the permission toggle". Every branch falls
 * back to generic copy, so a miss degrades to something still true.
 *
 * iOS is checked before desktop Safari, and iPadOS is caught by the
 * touch-points test because it reports a Macintosh user agent.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (isIOS) return "ios-safari";
  if (/Android/.test(ua)) {
    return /Chrome|CriOS/.test(ua) ? "android-chrome" : "other";
  }
  if (/Firefox\//.test(ua)) return "desktop-firefox";
  // Chrome's UA contains "Safari", so Chrome/Edge must be ruled out first.
  if (/Edg\//.test(ua) || /Chrome\//.test(ua)) return "desktop-chrome";
  if (/Safari\//.test(ua)) return "desktop-safari";
  return "other";
}

export type Recovery = { lead: string; steps: string[] };

/**
 * How to unblock, in the words of the platform the candidate is actually on.
 *
 * The previous copy said "Tap the camera icon in the address bar… On iPhone:
 * Settings → Safari → Camera → Allow" to everyone, so a desktop Chrome user
 * read a tap instruction and an iPhone paragraph that did not apply, while an
 * actual iPhone user read about an address bar that has no camera icon.
 */
export function recoveryFor(platform: Platform): Recovery {
  switch (platform) {
    case "ios-safari":
      return {
        lead: "Safari is blocking your camera for this site.",
        steps: [
          "Tap the “AA” icon at the left of the address bar",
          "Choose Website Settings, then set Camera and Microphone to Allow",
          "Come back here and tap Try again",
          "Still stuck? Open Settings → Safari → Camera and set it to Ask or Allow",
        ],
      };
    case "android-chrome":
      return {
        lead: "Chrome is blocking your camera for this site.",
        steps: [
          "Tap the lock icon to the left of the address bar",
          "Tap Permissions, then turn Camera and Microphone on",
          "Come back here and tap Try again",
        ],
      };
    case "desktop-chrome":
      return {
        lead: "Your browser is blocking the camera for this site.",
        steps: [
          "Click the camera icon at the right-hand end of the address bar",
          "Choose “Always allow”, then click Done",
          "If there is no camera icon, click the icon to the LEFT of the address and set Camera and Microphone to Allow",
          "Reload this page",
        ],
      };
    case "desktop-safari":
      return {
        lead: "Safari is blocking the camera for this site.",
        steps: [
          "Open Safari → Settings → Websites → Camera",
          "Find this site in the list and set it to Allow",
          "Do the same under Websites → Microphone",
          "Reload this page",
        ],
      };
    case "desktop-firefox":
      return {
        lead: "Firefox is blocking the camera for this site.",
        steps: [
          "Click the camera icon in the address bar",
          "Clear the blocked setting, then reload this page",
          "Choose Allow when Firefox asks again",
        ],
      };
    default:
      return {
        lead: "Your browser is blocking the camera for this site.",
        steps: [
          "Open your browser's site settings for this page — usually the icon next to the web address",
          "Set Camera and Microphone to Allow",
          "Reload this page",
        ],
      };
  }
}

// ── Why the camera didn't start ──────────────────────────────

/**
 * getUserMedia fails for reasons with completely different fixes, and only one
 * of them is a permission.
 *
 * `blocked`  — the candidate (or a remembered decision) said no. Fixable here,
 *              by them, with the platform steps above.
 * `missing`  — there is no camera attached. NOTHING on this page can fix that
 *              and no setting is wrong, so sending them to site settings is a
 *              dead end that costs them their goodwill before they have said a
 *              word. The only honest route forward is a different device.
 * `in-use`   — another application holds the camera. Extremely common on a
 *              laptop with a video call already open, and the fix is one step
 *              that has nothing to do with the browser.
 * `unknown`  — everything else, including a driver fault or an AbortError.
 *              Retry is the only safe advice.
 */
export type MediaFault = "blocked" | "missing" | "in-use" | "unknown";

/**
 * Map a getUserMedia rejection onto the fault it actually represents.
 *
 * The legacy aliases matter: Firefox has shipped `TrackStartError` for a busy
 * device and `DevicesNotFoundError` for a missing one for years, and treating
 * either as "unknown" would put a Firefox user on the generic path when we know
 * exactly what happened.
 *
 * OverconstrainedError counts as `missing`: the constraints here are all
 * `ideal` hints except facingMode, so the only way to overconstrain is to have
 * no camera the request can be satisfied by — which reads to the candidate as
 * not having one.
 */
export function classifyMediaError(err: unknown): MediaFault {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "blocked";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "missing";
    case "NotReadableError":
    case "TrackStartError":
      return "in-use";
    default:
      return "unknown";
  }
}

export type FaultCopy = {
  /** Headline, stated as a fact rather than an accusation. */
  title: string;
  lead: string;
  steps: string[];
  /** What the action button should say, given what will actually help. */
  retryLabel: string;
  /**
   * True when the fix is somewhere else entirely — no camera on this machine.
   * The page then offers the link-on-another-device route instead of pretending
   * a retry will change anything.
   */
  switchDevice: boolean;
};

/**
 * What to show for a fault, in the words of the platform they are on.
 *
 * `blocked` reuses recoveryFor() unchanged — that copy was written against the
 * real settings UI of each browser and is still exactly right for a permission.
 * The other three get their own, because none of them is a permission.
 */
export function faultCopy(fault: MediaFault, platform: Platform): FaultCopy {
  if (fault === "blocked") {
    const recovery = recoveryFor(platform);
    return {
      title: "We can't reach your camera.",
      lead: recovery.lead,
      steps: recovery.steps,
      retryLabel: "Try again",
      switchDevice: false,
    };
  }

  if (fault === "missing") {
    const mobile = platform === "ios-safari" || platform === "android-chrome";
    return {
      title: "We couldn't find a camera on this device.",
      lead: "Nothing is set wrongly — this device just doesn't have a camera we can use.",
      steps: mobile
        ? [
            "Check nothing is covering the lens, then try again",
            "If your camera app doesn't work either, the interview link works on any other phone or laptop",
            "Your progress is saved, so you can pick up where you left off",
          ]
        : [
            "If you have an external webcam, plug it in and press Try again",
            "Otherwise open this same link on your phone — it works there and takes about the same time",
            "Your progress is saved, so nothing you have already recorded is lost",
          ],
      retryLabel: "Check again",
      switchDevice: true,
    };
  }

  if (fault === "in-use") {
    return {
      title: "Your camera is busy in another app.",
      lead: "Something else has hold of it — most often a video call left open.",
      steps: [
        "Close Zoom, Teams, Meet, FaceTime or any other app using your camera",
        "Close any other browser tab that has the camera on",
        "Come back here and press Try again",
      ],
      retryLabel: "Try again",
      switchDevice: false,
    };
  }

  return {
    title: "We couldn't start your camera.",
    lead: "Your browser didn't say why, which usually means a temporary glitch.",
    steps: [
      "Press Try again",
      "If that doesn't work, reload the page",
      "Still stuck? Open this link in a different browser, or on your phone",
    ],
    retryLabel: "Try again",
    switchDevice: false,
  };
}
