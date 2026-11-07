// Reads a Chromium net log (`--log-net-log=<file>`) for what left the machine: host-name lookups, sockets and network
// requests. The UI test records one in every Electron run and asserts that plugin layers looked nothing up and opened
// nothing beyond loopback (the E-M1 review's should-fix 8), and that S9's DNS-prefetch probe stays closed while its
// positive control, the same document without its `Connection-Allowlist`, does reach the resolver (B1).
//
// The file is one JSON object, `{"constants": …, "events": [ … ]}`, written an event per line; a run that exits fast
// may leave it unterminated, so the events are read line by line.
import { readFileSync } from "node:fs";

export interface NetActivity {
  /** Host names the resolver was asked for, lowercased, without scheme or port. */
  lookups: string[];
  /** Addresses sockets connected to (`ip:port`). */
  sockets: string[];
  /** http(s) and ws(s) URLs requested. */
  requests: string[];
  /** How many events the log held, so an empty log isn't mistaken for a quiet one. */
  events: number;
}

function hostOf(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.replace(/\/.*$/, "");
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  const colon = h.lastIndexOf(":");
  if (colon > 0 && h.indexOf(":") === colon) h = h.slice(0, colon);
  return h;
}

export function isLoopback(address: string): boolean {
  const a = address.trim().toLowerCase();
  const host = a.startsWith("[") ? a.slice(1, a.indexOf("]")) : a.includes(".") ? a.split(":")[0]! : a;
  return host === "::1" || host === "localhost" || /^127\./.test(host);
}

export function readNetLog(path: string): NetActivity {
  const text = readFileSync(path, "utf8");
  const at = text.indexOf('"events"');
  if (at < 0) throw new Error(`${path} is not a net log`);
  const head = text.slice(0, at).replace(/,\s*$/, "");
  const constants = (JSON.parse(`${head}}`) as { constants: { logEventTypes: Record<string, number> } }).constants;
  const names = new Map<number, string>(Object.entries(constants.logEventTypes).map(([name, id]) => [id, name]));
  const out: NetActivity = { lookups: [], sockets: [], requests: [], events: 0 };
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const raw of text.slice(text.indexOf("[", at) + 1).split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("{")) continue;
    let e: { type?: number; params?: Record<string, unknown> };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    out.events++;
    const name = names.get(e.type ?? -1) ?? "";
    const p = e.params ?? {};
    if ((name.startsWith("HOST_RESOLVER") || name.startsWith("DNS_")) && typeof (p.host ?? p.hostname) === "string") add(out.lookups, hostOf(String(p.host ?? p.hostname)));
    if (name === "TCP_CONNECT" && Array.isArray(p.address_list)) for (const a of p.address_list) add(out.sockets, String(a));
    if ((name === "TCP_CONNECT_ATTEMPT" || name === "UDP_CONNECT") && typeof p.address === "string") add(out.sockets, p.address);
    if (name === "URL_REQUEST_START_JOB" && typeof p.url === "string" && /^(https?|wss?):/i.test(p.url)) add(out.requests, p.url);
  }
  return out;
}

/** Chromium's resolver checks once whether IPv6 is reachable, with a UDP `connect` to Google's public DNS that sends
 *  no packet, when it first resolves a name. Only a run that resolves a name (the DNS probe's positive control) has
 *  it. */
export const IPV6_REACHABILITY_PROBE = "[2001:4860:4860::8888]:443";

/** What a run sent off the machine, beyond loopback and what it is allowed (the probe's control and its effects). */
export function offMachine(activity: NetActivity, allowed: { lookups?: readonly string[]; sockets?: readonly string[]; ports?: readonly number[] } = {}): { lookups: string[]; sockets: string[]; requests: string[] } {
  const port = (s: string) => Number(s.slice(s.lastIndexOf(":") + 1));
  return {
    lookups: activity.lookups.filter((h) => !isLoopback(h) && !(allowed.lookups ?? []).includes(h)),
    sockets: activity.sockets.filter((s) => !isLoopback(s) && !(allowed.sockets ?? []).includes(s) && !(allowed.ports ?? []).includes(port(s))),
    requests: activity.requests,
  };
}
