// A plugin's remote MCP server (`mcpServers` entry of `type: "http"`, spec §5.3, §6.7): the core is its MCP client, over
// the Streamable HTTP transport, for the bots' sessions (PluginMcp opens it as it opens a `host` or `stdio` server).
// Before this, such a server was accepted and shown on the OK card and never listed: a pasted MCP URL (`wrap mcp-url`)
// or a wrapped Claude plugin's http server silently never appeared.
//
// * **Where it reaches:** only the entry's own `url`, the host its OK named (§5.3: "the host of every field whose format
//   is `url`, an `http` server's `url`", listed on the OK card as a network host), through the core's pinned fetch
//   (the keyed fetch's rules): the name resolved once and connected to by the address checked, never an environment
//   proxy. A name that resolves to a loopback or private address is refused unless the name says it's local
//   (`localhost`, `*.local`), as §5.3 says for a plugin's hosts; plain `http:` only to such a local name. Redirects
//   are refused (a server that moved is the user's to paste again), so nothing reaches a host the OK didn't name.
// * **Its `url` and `headers`** may name the plugin's settings and secrets (`${setting:…}`, `${secret:…}`), filled at
//   each open from the user's values, never logged; `${secretFile:…}` names no file here (there is no process) and is
//   refused.
// * **The transport:** each JSON-RPC message is a POST of JSON, `Accept: application/json, text/event-stream`; the
//   answer is JSON or an event stream whose `data:` lines are messages; a notification's is 202 with no body. The
//   session id the server gives at `initialize` (`Mcp-Session-Id`) goes on every later request with the protocol
//   version; a 404 on a session means it ended, so the channel closes and the next use opens a new one. A failed
//   request answers its id with an error (the reason, never the URL's secret parts), so the caller isn't left waiting.
//   `close` ends the session (a DELETE, best effort) and aborts what is in flight.
// * **Limits:** a message is at most `HTTP_MCP_MESSAGE_MAX` bytes; a longer answer fails its request.
import { parseInterpolation, interpolate } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { McpChannel, PluginHost } from "../contracts/plugin-host";
import type { Contribution, PluginRegistry } from "../contracts/plugin-registry";
import type { Secret } from "../contracts/secret-store";
import { localHostName, type PlatformFetch } from "../plugin-host/pinned-fetch";

/** The most one message (a JSON answer, or one event's data) may hold. */
export const HTTP_MCP_MESSAGE_MAX = 8 * 1024 * 1024;

/** A plugin's http entry as its manifest gives it. */
interface HttpEntry {
  type: "http";
  name?: string;
  url: string;
  headers?: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface HttpMcpOptions {
  registry: Pick<PluginRegistry, "entries" | "get">;
  /** The plugin's own settings: a device value wins over the account's. */
  settings(pluginId: string): { account: Record<string, unknown>; device: Record<string, unknown> };
  /** The plugin's own secrets. */
  secrets(pluginId: string): { get(name: string): Promise<{ value: Secret } | null> };
  /** The core's pinned fetch for a public host (`pinnedFetch()`), and one that may reach a local-named host's private
   *  address (`pinnedFetch(seam, { localNames: true })`). */
  fetch: PlatformFetch;
  localFetch: PlatformFetch;
  log?(line: string): void;
}

/** Opens a plugin's `http` MCP servers as channels, for PluginMcp (`PluginMcpOptions.http`). */
export class HttpMcpOpener implements Pick<PluginHost, "openMcp"> {
  readonly #o: HttpMcpOptions;
  constructor(o: HttpMcpOptions) {
    this.#o = o;
  }

  async openMcp(pluginId: string, server: string): Promise<McpChannel> {
    const nameOf = (c: Contribution) => (c.value as { name?: string }).name ?? c.entryId ?? c.ref.split("/").pop()!;
    const c = this.#o.registry.entries("mcpServers").find((e) => e.pluginId === pluginId && e.state === "active" && isObject(e.value) && e.value.type === "http" && nameOf(e) === server);
    if (c === undefined) throw new ContractError("not_installed", `${pluginId} has no http MCP server ${server} here`);
    const entry = c.value as HttpEntry;
    if (typeof entry.url !== "string") throw new ContractError("invalid", `${pluginId}'s MCP server ${server} has no url`);
    // The secrets it names, fetched now and kept only in the filled values.
    const names = new Set<string>();
    for (const v of [entry.url, ...Object.values(entry.headers ?? {})]) {
      const parsed = parseInterpolation(v);
      if (!parsed.ok) throw new ContractError("invalid", `${pluginId}'s MCP server ${server}: ${parsed.error}`);
      for (const p of parsed.parts) {
        if (p.kind === "secretFile") throw new ContractError("invalid", `${pluginId}'s MCP server ${server} is remote: \${secretFile:${p.key}} names a file only a local program reads; use \${secret:${p.key}}`);
        if (p.kind === "secret") names.add(p.key);
      }
    }
    const store = this.#o.secrets(pluginId);
    const secrets = new Map<string, string>();
    for (const name of names) {
      const v = await store.get(name);
      if (v !== null) secrets.set(name, v.value.reveal());
    }
    const settings = this.#o.settings(pluginId);
    const fill = {
      plugin: "", data: "",
      setting: (k: string) => {
        const v = Object.prototype.hasOwnProperty.call(settings.device, k) ? settings.device[k] : Object.prototype.hasOwnProperty.call(settings.account, k) ? settings.account[k] : undefined;
        return v === undefined || v === null ? undefined : String(v);
      },
      secret: (k: string) => secrets.get(k),
    };
    let url: URL;
    let headers: Record<string, string>;
    try {
      url = new URL(interpolate(entry.url, fill));
      headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, interpolate(v, fill)]));
    } catch (err) {
      // Which value is missing, never the values.
      throw new ContractError("failed", `${pluginId}'s MCP server ${server} can't open: ${err instanceof Error ? err.message : "its url or headers don't fill"}`);
    } finally {
      secrets.clear();
    }
    const local = localHostName(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new ContractError("refused", `${pluginId}'s MCP server ${server}: only https reaches a remote server (plain http only a local name such as localhost)`);
    }
    if (url.username !== "" || url.password !== "") throw new ContractError("refused", `${pluginId}'s MCP server ${server}: its url carries a user name or password`);
    return new HttpChannel({ url, headers, fetch: local ? this.#o.localFetch : this.#o.fetch, label: `${pluginId}/${server}`, ...(this.#o.log ? { log: this.#o.log } : {}) });
  }
}

/** One session with a remote MCP server. */
class HttpChannel implements McpChannel {
  readonly #listeners = new Set<(m: Record<string, unknown>) => void>();
  readonly #inFlight = new Set<AbortController>();
  #session: string | undefined;
  #version: string | undefined;
  #closed = false;

  constructor(private readonly o: { url: URL; headers: Record<string, string>; fetch: PlatformFetch; label: string; log?: (line: string) => void }) {}

  get closed(): boolean {
    return this.#closed;
  }

  onMessage(fn: (message: Record<string, unknown>) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  send(message: Record<string, unknown>, _as?: Caller): void {
    if (this.#closed) return;
    void this.#post(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const a of this.#inFlight) a.abort();
    this.#inFlight.clear();
    if (this.#session !== undefined) {
      void this.o.fetch(this.o.url.toString(), { method: "DELETE", headers: this.#headers(false), redirect: "manual" }).catch(() => undefined);
    }
  }

  #deliver(m: unknown): void {
    if (Array.isArray(m)) {
      for (const x of m) this.#deliver(x);
      return;
    }
    if (!isObject(m) || this.#closed) return;
    // The protocol version the server agreed, for the requests after the handshake.
    if (isObject(m.result) && typeof m.result.protocolVersion === "string") this.#version = m.result.protocolVersion;
    for (const fn of this.#listeners) fn(m);
  }

  #headers(post: boolean): Headers {
    const h = new Headers(this.o.headers);
    if (post) {
      h.set("content-type", "application/json");
      h.set("accept", "application/json, text/event-stream");
    }
    if (this.#session !== undefined) h.set("mcp-session-id", this.#session);
    if (this.#version !== undefined) h.set("mcp-protocol-version", this.#version);
    return h;
  }

  /** A failed request answers its own id, so the caller hears why at once. */
  #fail(message: Record<string, unknown>, why: string): void {
    if (message.id === undefined || message.method === undefined) {
      this.o.log?.(`http MCP ${this.o.label}: ${why}`);
      return;
    }
    this.#deliver({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: why } });
  }

  async #post(message: Record<string, unknown>): Promise<void> {
    const abort = new AbortController();
    this.#inFlight.add(abort);
    try {
      const res = await this.o.fetch(this.o.url.toString(), { method: "POST", headers: this.#headers(true), body: JSON.stringify(message), redirect: "manual", signal: abort.signal });
      const session = res.headers.get("mcp-session-id");
      if (session !== null && session !== "") this.#session = session;
      if (res.status === 202 || res.status === 204) return void (await res.body?.cancel().catch(() => undefined));
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        return this.#fail(message, `the server answered a redirect (${res.status}), which a plugin's server doesn't follow: the OK named this url's host only`);
      }
      if (res.status === 404 && this.#session !== undefined) {
        // Its session ended: this channel goes, and the next use opens a new one.
        await res.body?.cancel().catch(() => undefined);
        this.#fail(message, "the server ended its session");
        this.close();
        return;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return this.#fail(message, res.status === 401 || res.status === 403 ? `the server refused the request (${res.status}): its key or sign-in is missing or wrong` : `the server answered ${res.status}`);
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/event-stream")) return await this.#events(res, message);
      const text = await readCapped(res);
      if (text === undefined) return this.#fail(message, `the server's answer was over ${HTTP_MCP_MESSAGE_MAX} bytes`);
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return this.#fail(message, "the server's answer isn't JSON");
      }
      this.#deliver(parsed);
    } catch (err) {
      if (abort.signal.aborted) return;
      const name = err instanceof Error ? err.name : "";
      const code = (err as { code?: unknown } | null)?.code;
      this.#fail(message, name === "PinnedFetchRefused" ? (err as Error).message : `the server couldn't be reached${typeof code === "string" ? ` (${code})` : ""}`);
    } finally {
      this.#inFlight.delete(abort);
    }
  }

  /** An event stream: each event's `data:` lines joined are one message. */
  async #events(res: Response, message: Record<string, unknown>): Promise<void> {
    const reader = res.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let size = 0;
    const flush = () => {
      if (data.length === 0) return;
      const text = data.join("\n");
      data = [];
      size = 0;
      try {
        this.#deliver(JSON.parse(text));
      } catch {
        // An event that isn't a message (a comment, a keep-alive) is skipped.
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") flush();
        else if (line.startsWith("data:")) {
          const piece = line.slice(5).replace(/^ /, "");
          size += piece.length;
          if (size > HTTP_MCP_MESSAGE_MAX) {
            await reader.cancel().catch(() => undefined);
            return this.#fail(message, `the server's answer was over ${HTTP_MCP_MESSAGE_MAX} bytes`);
          }
          data.push(piece);
        }
      }
      if (buffer.length > HTTP_MCP_MESSAGE_MAX) {
        await reader.cancel().catch(() => undefined);
        return this.#fail(message, `the server's answer was over ${HTTP_MCP_MESSAGE_MAX} bytes`);
      }
    }
    flush();
  }
}

/** A body read whole, or undefined past the cap. */
async function readCapped(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > HTTP_MCP_MESSAGE_MAX) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
