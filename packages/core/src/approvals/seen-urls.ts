// The web addresses a bot's conversation has already seen (§9.1, the controller's ruling on fetch, amended after the
// adversarial review): at ask for risky actions a bot reads a page whose address came from the user's own message or a
// web search's hit without asking. Nothing else feeds it: never a fetched page's text or links (a page could list
// `https://evil.example/c/0 … /c/z` and have the bot spell a file out one fetch at a time), never a search hit's title
// or snippet (the pages wrote those too), never a message from another bot or agent. An address the model found on a
// page, or put together itself, goes to the safety reviewer, and to a card when it isn't sure.
//
// How an address counts as seen: scheme, host and port, and the path, as they are; the fragment never matters. One
// with a query string counts only when that exact address was seen. One without counts when any seen address had the
// same origin and path.
//
// And a budget on fetches that ran without a card, seen or not (the reviewer's too): at most `FETCHES_PER_DOMAIN` to
// one registrable domain and `FETCHES_PER_TURN` in all, per turn of the USER's (the adversarial review's block on
// fc72e8118). Past it, a fetch is no longer contained: the reviewer judges it (told how many went to that domain), then
// a card. Only a turn the user's own message starts (a relayed one when signed) resets it: never a fold, an agent's
// report, a background task's notification, a wake, another bot's message or a continuation, any of which a bot can
// bring about itself. It is one budget per conversation: a session the bot started under it (`rootOf`) draws on its
// root's; a routine's run is its own root, so it gets the budget once per scheduled run.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import type { TurnInput } from "../contracts/session-host";
import { originOf } from "../contracts/session-host";

/** The most addresses one conversation keeps; the oldest go first. */
export const SEEN_URLS_MAX = 5_000;
/** The most conversations kept; the one used longest ago goes first (its fetches then ask again). */
export const SEEN_SESSIONS_MAX = 200;
/** The most conversations' budgets kept, apart from their seen addresses (so touching many sessions never evicts a
 *  root's budget back to a fresh one); the one used longest ago goes first. */
export const BUDGETS_MAX = 5_000;
/** The most text read for addresses at once (a long page is read up to here). */
const SCAN_MAX = 2_000_000;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;

/** The most fetches without a card to one registrable domain in one turn, and in all. */
export const FETCHES_PER_DOMAIN = 5;
export const FETCHES_PER_TURN = 20;

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

const HIT_HEAD_RE = /^(\d+)\. /;
const HIT_URL_RE = /^ {3}(https?:\/\/\S+?)(?: \(\d{4}-\d{2}-\d{2}\))?$/;

/** A web search's hits' addresses, as the bundled web plugin writes its results (`formatResults`), read strictly from
 *  the first line: hit 1, 2, 3 … in turn, each a line `<n>. <title>`, the address on the line under it, then its
 *  indented snippet lines, and a blank line before the next. A title is on one line and every snippet line is
 *  indented, so nothing a page wrote starts a line at the margin; anything else (an error, "No results.", a page's
 *  text) gives no hits, or none past where it stops fitting. */
export function searchHits(text: string): string[] {
  const lines = text.slice(0, SCAN_MAX).split(/\r\n|\r|\n/);
  const out: string[] = [];
  let i = 0;
  while (i + 1 < lines.length) {
    const head = HIT_HEAD_RE.exec(lines[i]!);
    if (head === null || Number(head[1]) !== out.length + 1) break;
    const url = HIT_URL_RE.exec(lines[i + 1]!);
    if (url === null) break;
    out.push(url[1]!);
    i += 2;
    while (i < lines.length && lines[i]!.startsWith("   ")) i++;
    if (i < lines.length && lines[i] !== "") break;
    i++;
  }
  return out;
}

/** The registrable domain a fetch's budget counts under: the host's last two labels (an IP address, or a host of one
 *  label, whole). The repo keeps no public-suffix list, so `a.co.uk` and `b.co.uk` count as one (`co.uk`): never
 *  finer than the real registrable domain, so the budget only ever runs out sooner. */
export function registrableDomain(raw: string): string | undefined {
  let host: string;
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return undefined; }
  if (host === "") return undefined;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/** One turn's fetches without a card so far. */
interface TurnFetches {
  total: number;
  byDomain: Map<string, number>;
}

/** Where a fetch stands against its turn's budget (`SeenUrls.take`). */
export interface FetchBudget {
  domain: string;
  /** This fetch's place among the turn's fetches to its domain, and in all (counting itself). */
  toDomain: number;
  inAll: number;
  /** Whether it is within the budget. */
  within: boolean;
  /** Gives the place back: the fetch was carded or refused after all. */
  release(): void;
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
  readonly #budgets = new Map<string, TurnFetches>();
  readonly #rootOf: (sessionId: string) => string | undefined;

  /** `rootOf`: the conversation a session's fetches are charged to (the session itself by default); undefined when
   *  that can't be known, and then the session has no budget at all. */
  constructor(o: { rootOf?: (sessionId: string) => string | undefined } = {}) {
    this.#rootOf = o.rootOf ?? ((id) => id);
  }

  /** The budget `sessionId`'s fetches draw on: its root's, made at 0 the first time the root is met; undefined when
   *  its root can't be known. */
  #budget(sessionId: string): { root: string; t: TurnFetches } | undefined {
    let root: string | undefined;
    try { root = this.#rootOf(sessionId); } catch { root = undefined; }
    if (root === undefined) return undefined;
    let t = this.#budgets.get(root);
    if (t !== undefined) this.#budgets.delete(root);
    this.#budgets.set(root, (t ??= { total: 0, byDomain: new Map() }));
    while (this.#budgets.size > BUDGETS_MAX) this.#budgets.delete(this.#budgets.keys().next().value!);
    return { root, t };
  }

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

  /** A web search's result (the bundled plugin's, as the tool returned it, before any hook): its hits' addresses. */
  searchResult(sessionId: string, response: unknown): void {
    const s = this.#of(sessionId);
    for (const text of stringsOf(response)) for (const u of searchHits(text)) s.add(u);
  }

  /** A new turn of the session (never a message folded into a running one), started from `origin`: only the user's own
   *  message (`originOf` says "user" for a signed relay too) starts its root's budget again. */
  turnStarted(sessionId: string, origin: TurnOrigin | undefined): void {
    if (origin !== "user") return;
    const b = this.#budget(sessionId);
    if (b !== undefined) this.#budgets.set(b.root, { total: 0, byDomain: new Map() });
  }

  /** Takes a place in the turn's budget for a fetch of `url` (a fetch that may run without a card: the caller gives
   *  it back with `release` when it was carded or refused); undefined for an address that isn't http(s). Past the
   *  budget the place is still counted, so each fetch after it is told how far past it is. */
  take(sessionId: string, url: string): FetchBudget | undefined {
    const domain = registrableDomain(url);
    if (domain === undefined || normalUrl(url) === null) return undefined;
    const b = this.#budget(sessionId);
    // No root to charge (the host isn't up yet, or the session's chain can't be followed): never within the budget.
    if (b === undefined) return { domain, toDomain: FETCHES_PER_DOMAIN + 1, inAll: FETCHES_PER_TURN + 1, within: false, release: () => {} };
    const { t } = b;
    const toDomain = (t.byDomain.get(domain) ?? 0) + 1;
    const inAll = t.total + 1;
    t.byDomain.set(domain, toDomain);
    t.total = inAll;
    let released = false;
    return {
      domain, toDomain, inAll, within: toDomain <= FETCHES_PER_DOMAIN && inAll <= FETCHES_PER_TURN,
      release: () => {
        if (released) return;
        released = true;
        t.total--;
        t.byDomain.set(domain, (t.byDomain.get(domain) ?? 1) - 1);
      },
    };
  }

  seen(sessionId: string, url: string): boolean {
    return this.#sessions.get(sessionId)?.seen(url) ?? false;
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

/** The conversation a session's fetches are charged to: up its `parent` chain to a bot's conversation or a routine's
 *  run (a side thread), the first that is one. Undefined (no budget: no fetch is contained) for a session the host
 *  doesn't know, or whose chain is broken, a loop or too long: never a fresh root of its own. */
export function budgetRootOf(sessionId: string, get: (id: string) => { kind: string; parent?: string } | undefined): string | undefined {
  let id = sessionId;
  const met = new Set<string>();
  for (let i = 0; i < 32; i++) {
    const v = get(id);
    if (v === undefined) return undefined;
    if (v.kind === "bot" || v.kind === "side-thread") return id;
    if (v.parent === undefined) return id;
    met.add(id);
    if (met.has(v.parent)) return undefined;
    id = v.parent;
  }
  return undefined;
}
