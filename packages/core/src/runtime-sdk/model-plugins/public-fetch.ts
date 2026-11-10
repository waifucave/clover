// A bundled plugin's `net.fetch` to a public website outside its `network:` list (`network:public`, the plugin SDK's
// catalog: bundled only, OK text "connects to any public website, through Clover's web safeguards"): today only the
// web plugin's WebFetch. B's gate lets the host through only when the plugin's GRANTED set holds `network:public`
// (daemon-host.ts `allowNetwork`); this is the fetch that then runs, with no key and Winter's web safeguards.
//
// * No key, ever: a request that names an `auth` entry is refused (keys go only to the plugin's declared hosts, through
//   the keyed fetch), and every request header that could carry one is dropped (`authorization`,
//   `proxy-authorization`, `cookie`, and the keyed fetch's placements `x-api-key`, `api-key`, `x-goog-api-key`).
// * The URL is the model's, so hostile: `https:` only, no user name or password, the default port only, at most
//   `PUBLIC_URL_MAX_CHARS`, and not on the dangerous-domain list (Winter's, `checkDangerousDomain`, with the user's
//   additions). Each redirect hop is checked the same way and followed by hand, at most `PUBLIC_MAX_HOPS`.
// * The pinned fetch underneath (pinned-fetch.ts): public addresses only, after DNS and on every hop. A private
//   address is refused; there is no card to allow one (Winter asked first; this doesn't yet, and says so). The model
//   reads only that the name resolves to a private address; the address itself goes to the daemon's log.
// * Size and time: the body is cut at `PUBLIC_BODY_MAX_BYTES`, a head must come within `PUBLIC_HEAD_MS`, a body that
//   sends nothing for `PUBLIC_IDLE_MS` ends, and the whole fetch, body included, ends at `PUBLIC_TOTAL_MS` (so a page
//   that sends a byte just inside the idle limit can't hold the tool call and the fetch slot until the size cap).
// * One audit line per fetch in `<home>/audit.jsonl`: the plugin, the host, the path's length, the status or the
//   refusal. Never the path, the query or the fragment.
import { ContractError } from "../../contracts/common";
import { checkDangerousDomain } from "../../agent/tools/page-core";
import type { PlatformFetch } from "../../plugin-host/pinned-fetch";

export const PUBLIC_URL_MAX_CHARS = 4096;
export const PUBLIC_MAX_HOPS = 5;
export const PUBLIC_BODY_MAX_BYTES = 10 * 1024 * 1024;
export const PUBLIC_HEAD_MS = 30_000;
export const PUBLIC_IDLE_MS = 30_000;
export const PUBLIC_TOTAL_MS = 60_000;

/** Request headers dropped on the way to a public host: any that could carry a key or a session. */
export const PUBLIC_DROPPED_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-goog-api-key"] as const;

export interface PublicFetchOptions {
  /** The pinned fetch (public addresses only). */
  fetch: PlatformFetch;
  /** The user's additions to the dangerous-domain list. */
  dangerousAdded?: () => readonly string[];
  /** The audit sink (`<home>/audit.jsonl`). */
  audit?: (line: Record<string, unknown>) => void;
  /** The daemon's log: a refusal's detail the model doesn't get (the private address a name resolved to). */
  log?: (line: string) => void;
  /** Tests only: shorter time limits. */
  limits?: { headMs?: number; idleMs?: number; totalMs?: number };
}

/** Why a URL may not be fetched as a public website, or undefined. */
export function publicUrlRefusal(raw: string, added: readonly string[] = []): string | undefined {
  if (raw.length > PUBLIC_URL_MAX_CHARS) return `a public address is at most ${PUBLIC_URL_MAX_CHARS} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "it isn't an absolute address";
  }
  if (url.protocol !== "https:") return "a public website is reached over https only";
  if (url.username !== "" || url.password !== "") return "an address with a user name or password is refused";
  if (url.port !== "") return "a public website is reached on its default port only";
  const hit = checkDangerousDomain(url.toString(), added);
  if (hit !== null) return `${url.hostname} is on the list of domains Clover never fetches`;
  return undefined;
}

export function publicFetch(o: PublicFetchOptions): (pluginId: string, raw: string, init: RequestInit, options: Record<string, unknown> | undefined) => Promise<Response> {
  const headMs = o.limits?.headMs ?? PUBLIC_HEAD_MS;
  const idleMs = o.limits?.idleMs ?? PUBLIC_IDLE_MS;
  const totalMs = o.limits?.totalMs ?? PUBLIC_TOTAL_MS;
  return async (pluginId, raw, init, options) => {
    const audit = (url: string, outcome: Record<string, unknown>) => {
      let host = "";
      let pathLength = 0;
      try {
        const u = new URL(url);
        host = u.hostname;
        pathLength = u.pathname.length;
      } catch {
        /* nothing to record but the outcome */
      }
      o.audit?.({ kind: "network", tool: "net.fetch", via: "network:public", plugin: pluginId, host, pathLength, ...outcome });
    };
    const refuse = (url: string, why: string): never => {
      audit(url, { outcome: "refused" });
      throw new ContractError("refused", why);
    };
    const auth = options?.auth;
    if (auth !== undefined && auth !== false) refuse(raw, "no key goes to a host outside the plugin's network: list: a public website gets the request without one");
    const added = o.dangerousAdded?.() ?? [];
    const first = publicUrlRefusal(raw, added);
    if (first !== undefined) refuse(raw, first);
    const headers = new Headers(init.headers);
    for (const h of PUBLIC_DROPPED_HEADERS) headers.delete(h);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const headTimer = setTimeout(() => controller.abort(new ContractError("timeout", `no answer within ${headMs / 1000} s`)), headMs);
    // The whole fetch's deadline, body included; cleared when the body ends or the fetch fails before one.
    const totalTimer = setTimeout(() => controller.abort(new ContractError("timeout", `the page took more than ${totalMs / 1000} s`)), totalMs);
    let url = raw;
    let response: Response;
    try {
      for (let hop = 0; ; hop++) {
        try {
          response = await o.fetch(url, { method, headers, body, redirect: "manual", signal: controller.signal });
        } catch (err) {
          const reason = controller.signal.reason as unknown;
          if (reason instanceof ContractError) refuse(url, reason.message);
          // The pinned fetch's refusal (a private address) or a transport failure. A private address reaches the model
          // only as that: the address the name resolved to stays in the daemon's log.
          audit(url, { outcome: "failed" });
          const message = err instanceof Error ? err.message : String(err);
          if (/private address/.test(message)) {
            o.log?.(`[net.fetch] ${pluginId} (network:public): ${message}`);
            let host = "the address";
            try {
              host = new URL(url).hostname;
            } catch {
              /* the generic name */
            }
            throw new ContractError("failed", `${host} resolves to a private address, which a plugin's fetch doesn't reach (asking first isn't available: the request is refused)`);
          }
          throw new ContractError("failed", `the page couldn't be fetched: ${message}`);
        }
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (location === null) break;
        void response.body?.cancel().catch(() => {});
        if (hop + 1 >= PUBLIC_MAX_HOPS) refuse(url, `more than ${PUBLIC_MAX_HOPS} redirects`);
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return refuse(url, "the redirect's target isn't an address");
        }
        const why = publicUrlRefusal(next, added);
        if (why !== undefined) refuse(next, `the redirect was refused: ${why}`);
        if (body instanceof ReadableStream && response.status !== 303) refuse(next, "the redirect would send a streamed body a second time");
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
        }
        url = next;
      }
    } catch (err) {
      clearTimeout(totalTimer);
      throw err;
    } finally {
      clearTimeout(headTimer);
    }
    audit(url, { outcome: "ok", status: response!.status });
    const res = response!;
    if (res.body === null) {
      clearTimeout(totalTimer);
      init.signal?.removeEventListener("abort", onAbort);
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    // The body: cut at its cap, ended after a silence or at the deadline. Each read races the abort, so a limit holds
    // even if the transport underneath doesn't end its stream on the signal.
    const reader = res.body.getReader();
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    let total = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      clearTimeout(idle);
      clearTimeout(totalTimer);
      init.signal?.removeEventListener("abort", onAbort);
    };
    const capped = new ReadableStream<Uint8Array>({
      pull: async (c) => {
        idle = setTimeout(() => controller.abort(new ContractError("timeout", `the page sent nothing for ${idleMs / 1000} s`)), idleMs);
        let r: Awaited<ReturnType<typeof reader.read>>;
        try {
          r = await Promise.race([reader.read(), aborted]);
        } catch (err) {
          end();
          void reader.cancel().catch(() => {});
          const reason = controller.signal.reason as unknown;
          c.error(reason instanceof ContractError ? reason : err);
          return;
        }
        clearTimeout(idle);
        if (r.done) {
          end();
          c.close();
          return;
        }
        total += r.value.length;
        if (total > PUBLIC_BODY_MAX_BYTES) {
          end();
          void reader.cancel().catch(() => {});
          c.error(new ContractError("invalid", `the page passed ${PUBLIC_BODY_MAX_BYTES} bytes`));
          return;
        }
        c.enqueue(r.value);
      },
      cancel: () => {
        end();
        void reader.cancel().catch(() => {});
      },
    }, { highWaterMark: 0 });
    return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
