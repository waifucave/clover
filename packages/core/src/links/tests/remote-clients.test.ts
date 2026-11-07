// RPC and events over links, for remote clients: a paired phone says hello on its link and speaks the Clover protocol
// to the daemon as `remote`, under that role's allow list, with the token the core minted for its device; it gets the
// core events of the areas it subscribed to that its role may see; a computer can't open the door.
import { afterEach, describe, expect, test } from "bun:test";
import { allowedMethods, CLOVER_ERR, type CloverRole } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { Listeners } from "../../contracts/common";
import { generateEd25519 } from "../../identity/keys";
import { DeviceKey } from "../../identity/device-key";
import { mountRemoteClients, REMOTE_RPC_LABEL, type RemoteConn, type RemoteRpcServer } from "../remote-clients";
import { makeLinkCluster } from "../testing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

/** Lane C's server as far as the door goes: the token's binding, the role's allow list, the hello's answer. */
function fakeServer(minted: Map<string, { role: string; device: string }>) {
  const calls: { method: string; role: CloverRole }[] = [];
  const closed: number[] = [];
  const server: RemoteRpcServer = {
    async hello(_socket, connId, params) {
      const p = params as { token: string; role: CloverRole; device: string };
      const b = minted.get(p.token);
      if (!b || b.role !== p.role || b.device !== p.device) throw Object.assign(new Error("unauthorized"), { code: -32001 });
      const conn: RemoteConn = { connId, role: p.role, areas: new Set() };
      return { conn, result: { ok: true, serverVersion: "test", protocolVersion: 1, caller: { kind: "user", client: "remote" }, device: "me", features: [] } as never };
    },
    async handle(conn, method, params) {
      if (!allowedMethods(conn.role).has(method)) throw Object.assign(new Error("refused"), { code: CLOVER_ERR.ROLE_REFUSED });
      calls.push({ method, role: conn.role });
      if (method === "events.subscribe") for (const a of (params as { areas: string[] }).areas) conn.areas.add(a);
      return { ok: true };
    },
    closed(conn) {
      if (conn) closed.push(conn.connId);
    },
  };
  return { server, calls, closed };
}

describe("remote clients over links", () => {
  test("a phone says hello as remote, calls under remote's list, and gets the events it subscribed to", async () => {
    const c = await makeLinkCluster(["Studio"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    // A phone paired with the studio: its own key, its own transport.
    const { CloverLinkTransport } = await import("../transport");
    const { FileDeviceRegistry } = await import("../../devices/registry");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const phoneKey = await DeviceKey.fromKey(generateEd25519());
    const phoneReg = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-phone-")), key: phoneKey, clock, self: { name: "Phone", kind: "phone" } });
    await studio.registry.add({ id: phoneKey.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phoneKey.publicKeyBase64 }, { via: "terminal" });
    await phoneReg.add({ id: studio.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", publicKey: studio.key.publicKeyBase64 }, { via: "terminal" });
    const phone = new CloverLinkTransport({ self: phoneKey.id, wire: c.net.endpoint(phoneKey.publicKey), registry: phoneReg, clock, directory: { target: () => ({ key: studio.key.publicKey }) } });
    stops.push(() => phone.close());

    const minted = new Map<string, { role: string; device: string }>();
    const { server, calls, closed } = fakeServer(minted);
    const events = new Listeners<{ type: string; [k: string]: unknown }>();
    stops.push(mountRemoteClients({
      transport: studio.transport, registry: studio.registry, server,
      tokens: { mint: (b) => { const t = `tok_${minted.size}`; minted.set(t, b); return t; } },
      coreEvents: (fn) => events.add(fn),
    }));

    const s = (await phone.connect(studio.id)).openStream(REMOTE_RPC_LABEL, "control");
    const got: Record<string, unknown>[] = [];
    s.onData((chunk) => got.push(JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>));
    const send = (m: unknown) => s.write(new TextEncoder().encode(JSON.stringify(m)));
    await send({ jsonrpc: "2.0", id: 1, method: "device.list", params: {} });
    await send({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: 1, role: "app", token: "a stolen token", clientName: "Clover iOS" } });
    await send({ jsonrpc: "2.0", id: 3, method: "device.list", params: {} });
    await send({ jsonrpc: "2.0", id: 4, method: "pair.status", params: {} });
    await send({ jsonrpc: "2.0", id: 5, method: "events.subscribe", params: { areas: ["devices"] } });
    await waitFor(() => got.length >= 5);
    const byId = (id: number) => got.find((m) => m.id === id)!;
    expect((byId(1).error as { message: string }).message).toBe("say hello first");
    // Whatever role and token it named, it is the phone, as remote, with the core's token for it.
    expect(byId(2).result).toMatchObject({ ok: true });
    expect([...minted.values()]).toEqual([{ role: "remote", device: phoneKey.id }]);
    expect(byId(3).result).toEqual({ ok: true });
    expect((byId(4).error as { code: number }).code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(calls.map((x) => x.role)).toEqual(["remote", "remote"]);
    // Core events: only a subscribed area, and only types remote may see.
    events.emit({ type: "device_removed", ts: 1, id: "x", revoked: true });
    events.emit({ type: "link_changed", ts: 1, link: { peer: "x", up: true } });
    events.emit({ type: "plugin_changed", ts: 1 });
    await waitFor(() => got.some((m) => m.method === "core.event"));
    await Bun.sleep(50);
    expect(got.filter((m) => m.method === "core.event").map((m) => (m.params as { type: string }).type)).toEqual(["device_removed"]);
    s.end();
    await waitFor(() => closed.length === 1);
  });

  test("a computer can't open the client door", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock });
    stops.push(() => c.close());
    const { server } = fakeServer(new Map());
    stops.push(mountRemoteClients({ transport: c.devices.get("Studio")!.transport, registry: c.devices.get("Studio")!.registry, server, tokens: { mint: () => "t" } }));
    const s = (await c.devices.get("Laptop")!.transport.connect(c.devices.get("Studio")!.id)).openStream(REMOTE_RPC_LABEL, "control");
    const err = await new Promise<Error | undefined>((resolve) => s.onEnd(resolve));
    expect(err?.message).toContain("aborted");
  });
});

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
