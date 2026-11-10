// The web addresses a bot's conversation has already seen (§9.1, the controller's ruling on fetch): at ask for risky
// actions a bot reads a page whose address came from the user's own message, a search result or a link on a page it
// already read, without asking. An address the model put together itself (it could carry anything the bot has read, in
// its path or query) goes to the safety reviewer, and to a card when it isn't sure.
//
// How an address counts as seen: scheme, host and port, and the path, as they are; the fragment never matters. One
// with a query string counts only when that exact address was seen. One without counts when any seen address had the
// same origin and path. Only the user's own messages and the bundled web tools' results feed it: never a message
// from another bot or agent, which a model wrote.
import type { TurnInput } from "../contracts/session-host";
import { originOf } from "../contracts/session-host";

/** The most addresses one conversation keeps; the oldest go first. */
export const SEEN_URLS_MAX = 5_000;
/** The most conversations kept; the one used longest ago goes first (its fetches then ask again). */
export const SEEN_SESSIONS_MAX = 200;
/** The most text read for addresses at once (a long page is read up to here). */
const SCAN_MAX = 2_000_000;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;

/** An address as compared: its parsed form without the fragment, or null for one that isn't http(s). */
export function normalUrl(raw: string): { full: string; originPath: string; query: boolean } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  u.hash = "";
  return { full: u.href, originPath: `${u.origin}${u.pathname}`, query: u.search !== "" };
}

/** The addresses written in `text`, with the punctuation a sentence puts after one taken off. */
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, SCAN_MAX).matchAll(URL_RE)) out.push(m[0].replace(/[.,;:!?]+$/, ""));
  return out;
}

/** Every string inside a tool's result (its text blocks and nested fields). */
function stringsOf(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 10_000) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) stringsOf(x, out, depth + 1);
  return out;
}

class SessionUrls {
  readonly full = new Map<string, true>();
  readonly originPath = new Map<string, true>();
  add(raw: string): void {
    const n = normalUrl(raw);
    if (n === null) return;
    for (const [m, k] of [[this.full, n.full], [this.originPath, n.originPath]] as const) {
      m.delete(k);
      m.set(k, true);
      while (m.size > SEEN_URLS_MAX) m.delete(m.keys().next().value!);
    }
  }
  seen(raw: string): boolean {
    const n = normalUrl(raw);
    if (n === null) return false;
    return n.query ? this.full.has(n.full) : this.originPath.has(n.originPath);
  }
}

/** Each conversation's seen addresses, in memory (a restart forgets them: a fetch then asks as it did). */
export class SeenUrls {
  readonly #sessions = new Map<string, SessionUrls>();

  #of(sessionId: string): SessionUrls {
    let s = this.#sessions.get(sessionId);
    if (s !== undefined) this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, (s ??= new SessionUrls()));
    while (this.#sessions.size > SEEN_SESSIONS_MAX) this.#sessions.delete(this.#sessions.keys().next().value!);
    return s;
  }

  /** A turn's input: only the user's own message (a relayed one only when signed) counts. */
  input(sessionId: string, input: TurnInput): void {
    if (input.from !== "user" || originOf(input) !== "user") return;
    for (const u of urlsIn(input.text)) this.#of(sessionId).add(u);
  }

  /** A bundled web tool's result: the search's hits, the page's links. */
  result(sessionId: string, response: unknown): void {
    const s = this.#of(sessionId);
    for (const text of stringsOf(response)) for (const u of urlsIn(text)) s.add(u);
  }

  seen(sessionId: string, url: string): boolean {
    return this.#sessions.get(sessionId)?.seen(url) ?? false;
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
