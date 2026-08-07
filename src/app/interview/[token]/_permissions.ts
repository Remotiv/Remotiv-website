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
