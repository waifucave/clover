// A fake clover-core for the app's tests, until lane C's daemon side of the pair (C-M1) lands. It speaks the pair's
// part of the protocol as agreed with lane C (src/main/pair/*.ts): `protocol.hello` with the `app` token from
// `<home>/run/app.token`, `events.subscribe`, `pair.status`, `pair.quit`, `pair.exiting`, `plugin.ui`, `ui.settings`,
// `layer.token`, and the daemon's own requests to the app (`app.quit`, `app.show`). As a program it is also lane C's
// login command (`autostart status|enable|start`), whose `start` "starts through the OS" by spawning itself detached.
//
// Everything it does goes to `<home>/fake/calls.jsonl`, which the tests read. It never touches a real home.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
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

export async function startFakeDaemon(opts: FakeOptions): Promise<FakeDaemon> {
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
    record(opts.home, "request", { method, ...(method === "protocol.hello" ? { role: params.role } : { params }) });
    if (method === "protocol.hello") {
      if (params.role !== "app" || params.token !== token) return fail(-32001, "unauthorized");
      authed.add(s);
      return reply({ ok: true, serverVersion: "fake", protocolVersion: 1, caller: { kind: "user", via: "app" }, device: "dev_fake", features: [] });
    }
    if (!authed.has(s)) return fail(-32001, "hello required first");
    switch (method) {
      case "events.subscribe":
        return reply({ ok: true });
      case "pair.status":
        return reply({ ...DEFAULT_STATUS, ...opts.status });
      case "pair.exiting":
        return reply({ ok: true });
      case "pair.quit":
        reply({ ok: true });
        resolveQuit({ handOver: params.handOver === true });
        return;
      case "plugin.ui":
        return reply({ plugins: opts.ui ?? [] });
      case "ui.settings":
        return reply({ picks: [], lists: [], ...opts.settings });
      case "layer.token":
        return reply({ token: `layer-${String(params.pluginId)}-${randomBytes(8).toString("hex")}` });
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
      const child = spawn(process.execPath, [...self, "daemon"], { detached: true, stdio: "ignore", env: process.env, windowsHide: true });
      child.unref();
      return;
    }
    process.exitCode = 2;
    return;
  }
  if (cmd === "daemon" && sub === "check-server") {
    // Lane C's pre-hello check: this user's daemon serves the endpoint when the fake's pid file names a live process.
    record(home, "check-server");
    const pidFile = join(fakeDir(home), "daemon.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    let alive = false;
    try {
      alive = pid > 0 && process.kill(pid, 0);
    } catch {
      alive = false;
    }
    const refuse = process.env.CLOVER_FAKE_CHECK_SERVER === "refuse";
    process.stdout.write(`${JSON.stringify(alive && !refuse ? { ok: true, pid, userSid: "S-1-5-21-fake", image: argv[argv.indexOf("--image") + 1] ?? "" } : { ok: false, reason: refuse ? "another user's process serves the pipe" : "no daemon" })}\n`);
    process.exitCode = alive && !refuse ? 0 : 1;
    return;
  }
  if (cmd === "daemon") {
    const uiFile = process.env.CLOVER_FAKE_UI;
    const ui = uiFile !== undefined && existsSync(uiFile) ? (JSON.parse(readFileSync(uiFile, "utf8")) as { plugins?: unknown[]; status?: Record<string, unknown>; settings?: Record<string, unknown> }) : {};
    let fake: FakeDaemon;
    // The pid first, so `daemon check-server` already names this process when an app dials the new endpoint.
    mkdirSync(fakeDir(home), { recursive: true });
    writeFileSync(join(fakeDir(home), "daemon.pid"), String(process.pid));
    try {
      fake = await startFakeDaemon({ home, ui: ui.plugins ?? [], ...(ui.status ? { status: ui.status } : {}), ...(ui.settings ? { settings: ui.settings } : {}) });
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
