// MOSS's connection to the engine (connection.ts) against the fake engine: the hello is the `app` role with
// `surface: "moss"` and the build's release, the engine's mount list for MOSS has nothing from plugins, a release behind
// the engine's is said as such and not dialled again, the engine's heartbeat is answered, and nothing is sent before the
// endpoint proves it holds the token.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineConnection, mossHello, type ConnectionState } from "../src/main/connection";
import { daemonEndpoint } from "../src/main/client";
import { startFakeEngine, type FakeEngine } from "./fake-engine/engine";

const homes: string[] = [];
const engines: FakeEngine[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "ma-"));
  homes.push(h);
  return h;
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function connect(e: FakeEngine, release = "0.124.0"): Promise<{ c: EngineConnection; states: ConnectionState[] }> {
  const states: ConnectionState[] = [];
  const c = new EngineConnection({ endpoint: daemonEndpoint(e.home), token: () => e.token, release, pid: process.pid, onState: (s) => states.push(s), sleep: () => new Promise((r) => setTimeout(r, 5)) });
  await c.start();
  return { c, states };
}

describe("MOSS's hello", () => {
  test("is the app role with the moss surface and the build's release", () => {
    expect(mossHello("t", "0.124.0", 1)).toMatchObject({ role: "app", surface: "moss", release: "0.124.0", clientName: "MOSS 0.124.0" });
  });

  test("connects as the moss surface, which mounts nothing from plugins", async () => {
    const e = await startFakeEngine({ home: home() });
    engines.push(e);
    const { c } = await connect(e);
    expect(c.state.kind).toBe("connected");
    const hello = c.state.kind === "connected" ? c.state.hello : undefined;
    expect(hello?.surface).toBe("moss");
    expect(hello?.mount).toEqual({ surface: "moss", points: [], places: [], browserPages: false, drawsCards: true });
    const sent = e.calls().find((x) => x.method === "protocol.hello")?.params as Record<string, unknown>;
    expect(sent).toMatchObject({ role: "app", surface: "moss", release: "0.124.0" });
    expect(sent.token).toBeUndefined(); // the fake's log leaves the token out; it was checked
    // The proof came first: nothing else went before it.
    expect(e.calls()[0]?.method).toBe("protocol.prove");
    c.stop();
  });

  test("answers the engine's heartbeat", async () => {
    const e = await startFakeEngine({ home: home() });
    engines.push(e);
    const { c } = await connect(e);
    expect(await e.ask("app.ping")).toEqual([{ ok: true }]);
    c.stop();
  });

  test("a release behind the engine's is said, and MOSS stops dialling", async () => {
    const e = await startFakeEngine({ home: home(), release: "0.125.0" });
    engines.push(e);
    const { c } = await connect(e, "0.124.0");
    expect(c.state).toEqual({ kind: "behind", needs: "0.125.0" });
    await new Promise((r) => setTimeout(r, 50));
    expect(e.calls().filter((x) => x.method === "protocol.hello").length).toBe(1);
    c.stop();
  });

  test("an endpoint that can't prove the token gets nothing", async () => {
    const e = await startFakeEngine({ home: home(), peerPid: () => 1 });
    engines.push(e);
    const states: ConnectionState[] = [];
    const c = new EngineConnection({ endpoint: daemonEndpoint(e.home), token: () => e.token, release: "0.124.0", pid: process.pid, onState: (s) => states.push(s), sleep: () => new Promise((r) => setTimeout(r, 20)) });
    void c.start();
    await new Promise((r) => setTimeout(r, 100));
    c.stop();
    expect(states.some((s) => s.kind === "connected")).toBe(false);
    expect(e.calls().some((x) => x.method === "protocol.hello")).toBe(false);
  });
});
