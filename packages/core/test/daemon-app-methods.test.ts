// The app's methods lane D adds (K's audit), on a real daemon over its socket: the archive of the previous app's
// sessions and the user's apps' plan readings answer the app; `session.answer` is the bot side's (its own tests).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { SystemClock } from "../src/clock/system-clock";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { cloverCall } from "../src/ipc/clover-client";
import { HandshakeClient } from "../src/links/handshake";
import { startFakeHandshake } from "../src/links/handshake-fake";
import { MemoryNetwork } from "../src/links/memory-wire";

const clock = new SystemClock();
let stops: Array<() => unknown> = [];
let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const s of stops.reverse()) await s();
  stops = [];
});

describe("the app's archive and plan methods, on a booted daemon", () => {
  test("archive.list and archive.history read this home's own sessions; usage.plans answers", async () => {
    const hs = startFakeHandshake();
    stops.push(() => hs.stop());
    const net = new MemoryNetwork();
    const home = mkdtempSync(join(tmpdir(), "clover-d-app-"));
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      links: {
        wire: (k) => net.endpoint(k.publicKey), handshake: new HandshakeClient({ baseUrl: hs.url, clock }), publicTime: null,
        mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
      },
      parts: { bots: false, node: false, userHome: mkdtempSync(join(tmpdir(), "clover-d-app-user-")) },
    });
    const id = daemon.sessions.createSession("global", { mode: "chat" });
    daemon.sessions.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "an old chat", clientName: "t" });
    const app = { role: "cli" as const, token: daemon.tokens.harness, clientName: "lane-d-test" };
    const call = <T>(method: string, params: unknown = {}) => cloverCall(daemon!.socketPath, app, method, params) as Promise<T>;
    const listed = await call<{ sessions: { id: string; mode: string; messages: number }[]; more: boolean }>("archive.list", {});
    expect(listed.sessions).toEqual([expect.objectContaining({ id, mode: "chat", messages: 2 })]);
    const history = await call<{ events: { type: string }[] }>("archive.history", { id });
    expect(history.events.map((e) => e.type)).toEqual(["session_created", "user_message"]);
    const plans = await call<{ readings: unknown[] }>("usage.plans", {});
    expect(Array.isArray(plans.readings)).toBe(true);
  });
});
