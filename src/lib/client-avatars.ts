// Photographic, client-facing candidate avatars used in batch views
// (admin batch detail + client batch view). Distinct from /public/avatars/
// which holds the illustrated admin-side avatars rendered everywhere else
// (talent, team, top-nav, applications). The two pools live in parallel
// directories so designers can swap either set without affecting the
// other surface.
//
// Pool sizes — keep these in sync with /public/client-avatars/.
const CLIENT_MALE_AVATAR_COUNT = 20;
const CLIENT_FEMALE_AVATAR_COUNT = 15;

import { detectGender } from "./avatars";

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0; // force 32-bit
  }
  return Math.abs(h);
}

/**
 * Returns a deterministic photographic avatar URL for client-facing
 * batch views. Same first+last name always resolves to the same image
 * within the pool, gender-matched when the first name is recognised
 * (otherwise falls back to the male pool, matching getAvatarUrl).
 */
export function getClientAvatarUrl(
  firstName?: string | null,
  lastName?: string | null,
): string {
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim() || "unknown";
  const gender = detectGender(firstName);
  const count =
    gender === "female"
      ? CLIENT_FEMALE_AVATAR_COUNT
      : CLIENT_MALE_AVATAR_COUNT;
  const num = (hashString(fullName) % count) + 1;
  const padded = String(num).padStart(3, "0");
  const folder = gender === "female" ? "female" : "male";
  return `/client-avatars/${folder}-${padded}.webp`;
}

// Re-export getInitials so consumers of this module don't need a second
// import from "@/lib/avatars" just for the fallback chip.
export { getInitials } from "./avatars";
