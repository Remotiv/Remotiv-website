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

/**
 * A logo URL, safe to drop into a CSS `background-image` value.
 *
 * The URL is ours — `getPublicUrl` over a `${companyId}/${uuid}.${ext}` path —
 * so nothing user-controlled reaches it today. Escaped anyway, because the
 * value crosses from data into a STYLESHEET, where a stray quote or paren stops
 * being a broken image and starts being a way to close the url() and write
 * another declaration. Cheap here, and the guarantee about that path is not one
 * this function can see.
 *
 * Returns undefined for anything unusable, so the caller renders no layer at
 * all rather than `url("")` — which browsers resolve against the current
 * document and re-request the page as an image.
 */
export function cssUrl(url: string | null | undefined): string | undefined {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return undefined;
  // Only http(s). A data: or javascript: value has no business here.
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  /*
   * An explicit map, NOT encodeURIComponent — it leaves ( ) ' ! * ~ alone, so a
   * regex handing it those characters silently passes them straight through and
   * reads as protection it is not providing.
   *
   * Inside `url("…")` the characters that end the value are the double quote, a
   * backslash, and a newline. All three are encoded here; the parens are
   * encoded too because they end an UNQUOTED url() and it costs nothing to be
   * correct for both forms.
   */
  const safe = trimmed.replace(
    /["'()\\\n\r]/g,
    (c) =>
      ({
        '"': "%22",
        "'": "%27",
        "(": "%28",
        ")": "%29",
        "\\": "%5C",
        "\n": "%0A",
        "\r": "%0D",
      })[c] ?? c,
  );
  return `url("${safe}")`;
}
