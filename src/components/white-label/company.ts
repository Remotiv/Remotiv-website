/**
 * Company identity helpers shared by the white-label public pages.
 *
 * A plain module — no "server-only", no React — so either side of a client
 * boundary can use it.
 *
 * The careers page carries its own copies of `displayHost` and `websiteHref`
 * from before this module existed. They are character-identical; pointing that
 * page here is a one-line change and should happen the next time /careers is in
 * scope. Noted rather than done, because that page is out of scope for this
 * pass and a drive-by edit to a shipped page is how a rebuild acquires
 * unrelated risk.
 */

/** The bare host, for display — the design shows "acme.com", not the scheme. */
export function displayHost(website: string): string {
  return website.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** An href that works whether or not Settings stored the scheme. */
export function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

/**
 * First letters of up to two words, for the lettermark.
 *
 * Never returns empty: a company with no usable name still gets a character
 * rather than a blank square, which the handoff calls out by name.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  return (letters || name[0] || "?").toUpperCase();
}
