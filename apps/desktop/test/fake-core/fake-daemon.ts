// A fake clover-core for the app's tests, until lane C's daemon side of the pair (C-M1) lands. It speaks the pair's
// part of the protocol as agreed with lane C (src/main/pair/*.ts): `protocol.hello` with the `app` token from
// `<home>/run/app.token`, `events.subscribe`, `pair.status`, `pair.quit`, `pair.exiting`, `plugin.ui`, `ui.settings`,
// `layer.token`, and the daemon's own requests to the app (`app.quit`, `app.show`). As a program it is also lane C's
// login command (`autostart status|enable|start`), whose `start` "starts through the OS" by spawning itself detached.
//
// Everything it does goes to `<home>/fake/calls.jsonl`, which the tests read. It never touches a real home.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { CardAnswerProof, Card } from "@waifucave/clover-protocol";
import { daemonEndpoint } from "../../src/main/protocol/client";

export interface FakeOptions {
  home: string;
  /** `plugin.ui`'s answer. */
  ui?: unknown[];
  /** `ui.settings`'s answer. */
  settings?: Record<string, unknown>;
  /** `pair.status`'s answer. */
  status?: Record<string, unknown>;
  /** Mint a token (default) or use this one. */
  token?: string;
  /** Model providers, for the welcome guide (`point.list`, `plugin.get`, `plugin.auth.*`). */
  models?: FakeModel[];
  /** Answer `plugin.list` (and `plugin.setEnabled`, `plugin.remove`) from `ui`, for the plugin manager. */
  listPlugins?: boolean;
  /** `protocol.prove`: the pid it says it sees at the other end (default: its own, for an app in this process), or
   *  a refusal: `refuse` (an old daemon with no method at all), `peak` (lane C's ambiguous-pid code) or `wrong`. */
  prove?: number | "refuse" | "peak" | "wrong";
  /** The cards the app sees: whole ones through `card.list` (the app's role), `card_requested` events at makePair's
   *  notification path, and `card_pending` (ids only) for layers. */
  cards?: readonly { card: Record<string, unknown> }[];
  /** `card.answer`'s verdict, one per call: a default accept, or a shape the test sets (a false, a reason...). */
  answerVerdict?: readonly Record<string, unknown>[];
  /** `computer.acting`'s answer: is a computer-use session acting on this computer now (default no)? */
  acting?: boolean;
}

export interface FakeModel {
  id: string;
  name: string;
  terms?: string;
  auth: { method: "api-key" | "oauth-pkce" }[];
}

export interface FakeDaemon {
  token: string;
  endpoint: string;
  /** Ends every connection and stops listening, without a word: a crash, as the app sees it. */
  crash(): Promise<void>;
  /** Stops on purpose: asks each app connection to quit first. */
  quitApps(reason?: "quit" | "update"): Promise<void>;
  /** Asks the app to show something. */
  show(what: unknown): Promise<unknown>;
  /** Any request to each app connection: its answers (a result, or the error). */
  request(method: string, params: unknown): Promise<unknown[]>;
  /** Raw lines to each app connection, written at once (one chunk). */
  write(lines: readonly unknown[]): void;
  /** Lane C's SIGTERM: `app.quit` to each app, then gone at once, without waiting for an answer. */
  quitAndDie(): Promise<void>;
  connections(): number;
  close(): Promise<void>;
  /** Resolves when `pair.quit` was called (with its params). */
  quitRequested: Promise<{ handOver: boolean }>;
}

export function fakeDir(home: string): string {
  return join(home, "fake");
}

export function record(home: string, event: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(fakeDir(home), { recursive: true });
  appendFileSync(join(fakeDir(home), "calls.jsonl"), `${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...extra })}\n`);
}

export function readCalls(home: string): { event: string; [k: string]: unknown }[] {
  const file = join(fakeDir(home), "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event: string });
}

const DEFAULT_STATUS = { bots: [], routines: 0, agents: 0, canHandOver: false, safeMode: false };

/** `card.answer`'s有自己的 verdicts (consume in order) and the answers the fake saw, per fake's options root. Each
 *  `startFakeDaemon` lays its own queue in. */
const cardVerdict: Record<string, unknown>[] = [];
const answerRecord: { id?: unknown; option?: unknown; at?: unknown; device?: unknown }[] = [];

export async function startFakeDaemon(opts: FakeOptions): Promise<FakeDaemon> {
  answerRecord.length = 0;
  cardVerdict.length = 0;
  if (opts.answerVerdict !== undefined) cardVerdict.push(...opts.answerVerdict);
  const endpoint = daemonEndpoint(opts.home);
  mkdirSync(join(opts.home, "run"), { recursive: true });
  if (process.platform !== "win32") rmSync(endpoint, { force: true });
  const token = opts.token ?? randomBytes(32).toString("hex");
  writeFileSync(join(opts.home, "run", "app.token"), `${token}\n`, { mode: 0o600 });
  const sockets = new Set<Socket>();
  const outgoing = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;
  let resolveQuit!: (p: { handOver: boolean }) => void;
  const quitRequested = new Promise<{ handOver: boolean }>((r) => (resolveQuit = r));
  const authed = new WeakSet<Socket>();
  const signedIn = new Set<string>();
  const layerTokens = new Map<string, string>();
  const layerOf = new WeakMap<Socket, string>();
  let terminals = 0;
  const off = new Set<string>();
  const removed = new Set<string>();
  const summary = (id: string, name: string, source: string) => ({
    id, ...(id.includes("/") ? { parent: id.split("/")[0] } : {}), name, version: "1.0.0", state: "enabled", enabled: true, source, class: "code",
    namespace: id.split("/")[0]!.replace(/-/g, "_"), scope: "everywhere", adult: false, children: [], dev: false,
  });

  const send = (s: Socket, msg: unknown) => {
    if (!s.destroyed) s.write(`${JSON.stringify(msg)}\n`);
  };

  const handle = (s: Socket, msg: Record<string, unknown>) => {
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;
    if (method === undefined) {
      if (typeof id === "number") outgoing.get(id)?.(msg);
      return;
    }
    const reply = (result: unknown) => id !== undefined && send(s, { jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => id !== undefined && send(s, { jsonrpc: "2.0", id, error: { code, message } });
    const params = (msg.params ?? {}) as Record<string, unknown>;
    // A key the app sends for a sign-in is never written down, here as in the daemon: only its length.
    const logged = typeof params.key === "string" ? { ...params, key: `<${params.key.length} characters>` } : params;
    record(opts.home, "request", { method, ...(method === "protocol.hello" ? { role: params.role } : { params: logged }) });
    // Lane C's proof, before the hello: an HMAC under the app token over the app's nonce and the pid at the other end.
    if (method === "protocol.prove" && !authed.has(s)) {
      if (opts.prove === "refuse") return fail(-32601, "no protocol.prove");
      if (opts.prove === "peak") return fail(-32020, "the pid at this end of the pipe is ambiguous");
      const pid = typeof opts.prove === "number" ? opts.prove : process.pid;
      const proof = createHmac("sha256", opts.prove === "wrong" ? "not-the-token" : token).update(`clover-daemon-proof\0${String(params.nonce)}\0${pid}`).digest("base64url");
      return reply({ proof, pid });
    }
    if (method === "protocol.hello") {
      // A layer's connection: the token `layer.token` minted, for that plugin only.
      if (params.role === "layer") {
        if (typeof params.token !== "string" || layerTokens.get(params.token) !== params.pluginId) return fail(-32001, "unauthorized");
        authed.add(s);
        layerOf.set(s, params.pluginId as string);
        return reply({ ok: true, serverVersion: "fake", protocolVersion: 1, caller: { kind: "plugin", pluginId: params.pluginId }, device: "dev_fake", features: [] });
      }
      if (params.role !== "app" || params.token !== token) return fail(-32001, "unauthorized");
      authed.add(s);
      return reply({ ok: true, serverVersion: "fake", protocolVersion: 1, caller: { kind: "user", via: "app" }, device: "dev_fake", features: [] });
    }
    // A layer's calls: what the fake knows a layer may ask (the terminal's, events), answered as that plugin.
    const layer = layerOf.get(s);
    if (layer !== undefined) {
      if (method === "events.subscribe") return reply({ ok: true });
      if (method === "terminal.open") {
        const id = `term_${++terminals}`;
        reply({ terminalId: id });
        setTimeout(() => send(s, { jsonrpc: "2.0", method: "core.event", params: { type: "terminal_output", ts: Date.now(), terminalId: id, data: "\u001b[?2004h$ " } }), 10);
        return;
      }
      if (method === "terminal.write" || method === "terminal.resize" || method === "terminal.close") return reply({ ok: true });
      // The bots the registry's bot plugins are, and no sessions, computers or devices yet.
      const bots = (opts.ui ?? []).map((v) => v as { pluginId: string; isBot?: boolean; name?: string }).filter((v) => v.isBot === true)
        .map((v) => ({ id: v.pluginId, name: v.name ?? v.pluginId, model: "fake/model", userLayer: [], state: "idle", computer: "Laptop", mainSession: `${v.pluginId}:main` }));
      if (method === "bot.list") return reply({ bots });
      if (method === "bot.get") {
        const bot = bots.find((b) => b.id === params.id);
        return bot === undefined ? fail(-32004, "no such bot") : reply({ bot });
      }
      if (method === "session.list") return reply({ sessions: [] });
      if (method === "computer.list") return reply({ computers: [] });
      if (method === "device.list") return reply({ devices: [] });
      return fail(-32003, `a layer doesn't call ${method} here`);
    }
    if (!authed.has(s)) return fail(-32001, "hello required first");
    switch (method) {
      case "events.subscribe":
        return reply({ ok: true });
      case "computer.acting":
        // Whether a computer-use session drives this computer right now (a test's own control).
        return reply({ ...(opts.acting === true ? { running: true, session: "s_cu" } : { running: false }) });
      case "card.list":
        return reply({ cards: (opts.cards ?? []).map((c) => c.card) });
      case "card.frame":
        // A channel minted for one card's sealed frame; a fake's own count of the only shape it holds.
        return reply({ channel: `fake-card-${String(params.id).slice(-8)}-${randomBytes(8).toString("hex")}` });
      case "card.answer": {
        // The protocol's own contracts first (the review's own ask), then the fake's own verdict.
        const proof = CardAnswerProof.safeParse(params.proof);
        if (!proof.success) return fail(-32602, `card.answer's proof isn't one: ${proof.error.issues[0]?.message ?? "no proof"}`);
        const w = proof.data.via === "device" ? { via: proof.data.via, device: proof.data.device, at: proof.data.at } : { via: proof.data.via, frame: proof.data.frame, at: proof.data.at };
        record(opts.home, "request", { method: "card.answer", params: { id: params.id, option: params.option, ...w } });
        answerRecord.push({ id: params.id, option: params.option, ...w });
        const verdict = cardVerdict.length > 0 ? cardVerdict.shift()! : { accepted: true };
        return reply(verdict);
      }
      case "pair.status":
        return reply({ ...DEFAULT_STATUS, ...opts.status });
      case "pair.exiting":
        return reply({ ok: true });
      case "pair.quit":
        reply({ ok: true });
        resolveQuit({ handOver: params.handOver === true });
        return;
      // The app's laptop suspends: the lease goes without leaving (§6.4), and nobody takes the bots from this fake.
      case "main.handOver":
        return reply({ to: null });
      case "plugin.ui":
        return reply({ plugins: opts.ui ?? [] });
      case "ui.settings":
        return reply({ picks: [], lists: [], ...opts.settings });
      case "layer.token": {
        const t = `layer-${String(params.pluginId)}-${randomBytes(8).toString("hex")}`;
        layerTokens.set(t, String(params.pluginId));
        return reply({ token: t });
      }
      case "point.list":
        if (opts.models === undefined) return fail(-32601, "no point.list");
        return reply({ points: [{ name: "models", shape: "list", declaredBy: "core", spot: false, occupants: opts.models.map((m) => ({ pluginId: m.id, entry: "models" })), waiting: [], replacesShipped: false, private: false }] });
      case "plugin.get": {
        const m = opts.models?.find((x) => x.id === params.id);
        if (m === undefined) return fail(-32004, "no such plugin");
        return reply({ plugin: { ...summary(m.id, m.name, "index"), manifest: { contributes: { models: [{ provider: m.id, name: m.name, ...(m.terms !== undefined ? { terms: m.terms } : {}), catalog: [], auth: m.auth }] } }, provenance: { by: "user-app", at: 0 }, capabilities: [], networkHosts: [], helperPermissions: [], issues: [], logTail: [], pinned: false } });
      }
      case "plugin.auth.list": {
        const m = opts.models?.find((x) => x.id === params.id);
        return reply({ auth: (m?.auth ?? []).map((a, index) => ({ index, method: a.method, state: signedIn.has(`${m!.id}#${index}`) ? "signed-in" : "signed-out" })) });
      }
      case "plugin.auth.signIn": {
        const m = opts.models?.find((x) => x.id === params.id);
        const a = m?.auth[Number(params.index)];
        if (m === undefined || a === undefined) return fail(-32004, "no such sign-in");
        if (a.method === "api-key") {
          if (typeof params.key !== "string" || params.key === "") return fail(-32602, "a key is needed");
          signedIn.add(`${m.id}#${String(params.index)}`);
          return reply({ state: "signed-in" });
        }
        return reply({ state: "signed-out", authorizeUrl: "https://auth.example/authorize?client_id=fixture" });
      }
      case "plugin.list":
        if (opts.listPlugins !== true) return fail(-32601, "no plugin.list");
        return reply({ plugins: (opts.ui ?? []).map((v) => v as { pluginId: string; name?: string; source?: string }).filter((v) => !removed.has(v.pluginId.split("/")[0]!)).map((v) => ({ ...summary(v.pluginId, v.name ?? v.pluginId, v.source === "bundled" ? "bundled" : "index"), enabled: !off.has(v.pluginId), state: off.has(v.pluginId) ? "disabled" : "enabled" })) });
      case "plugin.setEnabled":
        if (params.enabled === false) off.add(String(params.id));
        else off.delete(String(params.id));
        return reply({ applied: true });
      case "plugin.remove":
        removed.add(String(params.id));
        return reply({ ok: true });
      default:
        return fail(-32601, `no ${method}`);
    }
  };

  const server: Server = createServer((s) => {
    sockets.add(s);
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "") {
          try {
            handle(s, JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* not JSON */
          }
        }
        nl = buf.indexOf("\n");
      }
    });
    s.on("close", () => {
      sockets.delete(s);
      record(opts.home, "disconnected");
    });
    s.on("error", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  record(opts.home, "listening", { endpoint });

  const ask = (method: string, params: unknown) =>
    Promise.all([...sockets].filter((s) => authed.has(s)).map((s) => new Promise<unknown>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => resolve({ timeout: true }), 5000);
      outgoing.set(id, (m) => {
        clearTimeout(timer);
        resolve(m.result ?? m.error);
      });
      send(s, { jsonrpc: "2.0", id, method, params });
    })));

  const stopListening = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    server.close(() => resolve());
  });

  return {
    token,
    endpoint,
    quitRequested,
    connections: () => [...sockets].filter((s) => authed.has(s)).length,
    async crash() {
      record(opts.home, "crash");
      await stopListening();
    },
    async quitApps(reason = "quit") {
      await ask("app.quit", { reason });
    },
    async show(what) {
      return (await ask("app.show", { what }))[0];
    },
    request: ask,
    async quitAndDie() {
      record(opts.home, "quit-and-die");
      for (const s of sockets) if (authed.has(s)) send(s, { jsonrpc: "2.0", id: nextId++, method: "app.quit", params: { reason: "quit" } });
      await stopListening();
    },
    write(lines) {
      for (const s of sockets) if (authed.has(s)) s.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    },
    close: stopListening,
  };
}

/** The fake as a program: `daemon` runs it; `autostart status|enable|start` is the login command. */
async function main(argv: string[]): Promise<void> {
  const home = process.env.CLOVER_HOME;
  if (home === undefined || home === "") throw new Error("CLOVER_HOME must be set");
  const [cmd, sub] = argv;
  const registered = join(fakeDir(home), "registered");
  if (cmd === "autostart") {
    record(home, `autostart-${sub}`);
    if (sub === "status") {
      // Lane C's text form.
      process.stdout.write(existsSync(registered) ? "autostart: enabled (fake) [registered]\n" : "autostart: disabled\n");
      return;
    }
    if (sub === "enable") {
      mkdirSync(fakeDir(home), { recursive: true });
      writeFileSync(registered, "1");
      return;
    }
    if (sub === "start") {
      // "Through the OS": a detached process of its own, never the caller's child for long.
      const self = process.argv[1] !== undefined && process.argv[1].endsWith(".ts") ? [process.argv[1]] : [];
      // The app that asked is the daemon's other end: the fake's `protocol.prove` names it, as the real one sees it.
      const child = spawn(process.execPath, [...self, "daemon"], { detached: true, stdio: "ignore", env: { ...process.env, CLOVER_FAKE_APP_PID: String(process.ppid) }, windowsHide: true });
      child.unref();
      return;
    }
    process.exitCode = 2;
    return;
  }
  if (cmd === "daemon") {
    const uiFile = process.env.CLOVER_FAKE_UI;
    const ui = uiFile !== undefined && existsSync(uiFile) ? (JSON.parse(readFileSync(uiFile, "utf8")) as { plugins?: unknown[]; status?: Record<string, unknown>; settings?: Record<string, unknown>; models?: FakeModel[]; listPlugins?: boolean }) : {};
    let fake: FakeDaemon;
    // The pid first, for the tests that stop it.
    mkdirSync(fakeDir(home), { recursive: true });
    writeFileSync(join(fakeDir(home), "daemon.pid"), String(process.pid));
    try {
      fake = await startFakeDaemon({ home, ui: ui.plugins ?? [], ...(ui.status ? { status: ui.status } : {}), ...(ui.settings ? { settings: ui.settings } : {}), ...(ui.models ? { models: ui.models } : {}), ...(ui.listPlugins ? { listPlugins: true } : {}), prove: process.env.CLOVER_FAKE_PROVE === "refuse" || process.env.CLOVER_FAKE_PROVE === "wrong" ? process.env.CLOVER_FAKE_PROVE : Number(process.env.CLOVER_FAKE_APP_PID ?? process.pid) });
    } catch (err) {
      record(home, "listen-failed", { error: String(err) });
      process.exit(0);
    }
    record(home, "daemon-started");
    process.on("SIGTERM", () => process.exit(0));
    const q = await fake.quitRequested;
    record(home, "daemon-quit", q);
    setTimeout(() => process.exit(0), 100);
    return;
  }
  process.exitCode = 2;
}

if (import.meta.main) await main(process.argv.slice(2));
