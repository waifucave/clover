// What the address bar does with what was typed, and how a tab is named when its page has no title yet.

/** `https:`, `about:blank`, `mailto:x`: a scheme, as a URL has one. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `localhost:4321/docs` and `example.com:8080` read as a scheme (`localhost:`) to the pattern above, but are a host
 *  and a port: the port's digits give them away. */
const HOST_PORT = /^[^\s/?#:@]+:\d+(?:[/?#]|$)/;
/** A name a person would type as a host: `localhost`, `example.com`, `a.b.example.co.uk`, an IPv4 address, or a
 *  bracketed IPv6 address; then an optional port, and an optional path, query or fragment. The last label of a
 *  dotted name must start with a letter (`example.com` yes, `1.5` and `v2.0` no), so a number or a version is not
 *  taken for a site. A phrase with spaces is not a host. */
const HOST_LIKE = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?::\d+)?(?:[/?#]\S*)?$/i;
/** Hosts that never serve https in practice: the machine itself. A page on it is plain http. */
const LOOPBACK = /^(?:localhost|[^/?#:]*\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/** What goes to `browser.navigate`. A host or host/path with no scheme gets `https://` (`http://` for the machine
 *  itself, which has no certificate); anything else goes as typed, trimmed, and the browser refuses what it cannot
 *  open: the refusal shows in the bar in plain words, so there is no second list of good addresses here. */
export function normalizeAddress(input: string): string {
  const typed = input.trim();
  if (typed === "") return typed;
  if (SCHEME.test(typed) && !HOST_PORT.test(typed)) return typed;
  if (HOST_LIKE.test(typed)) return `${LOOPBACK.test(typed) ? "http" : "https"}://${typed}`;
  return typed;
}

/** `https://www.example.com/a` → `www.example.com`; empty when the URL has no host (`about:blank`) or is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** A tab's name: its page's title, else its host, else nothing (the row says "New tab"). */
export function tabName(title: string, url: string): string {
  const t = title.trim();
  if (t !== "") return t;
  return hostOf(url);
}
