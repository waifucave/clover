// C-M3 item 3: a paired phone speaks the Clover protocol over its link to the real Clover server: its hello takes the
// core's token for that device only, it is the user on that device, `remote`'s allow list holds, and the server's own
// core.event sender reaches it, once.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION, ERR } from "@waifucave/clover-protocol";
import { SystemClock } from "../../src/clock/system-clock";
import { CloverTokens, ERR_UNAUTHORIZED } from "../../src/auth/clover-tokens";
import { SessionProcesses } from "../../src/auth/clover-caller";
import { createCloverServer } from "../../src/ipc/clover";
import { LINK_CONN_ID_BASE, linkClientServer, mountCloverRemoteClients } from "../../src/ipc/link-clients";
import { REMOTE_RPC_LABEL } from "../../src/links/remote-clients";
import { makeLinkCluster } from "../../src/links/testing";
import { CloverLinkTransport } from "../../src/links/transport";
import { FileDeviceRegistry } from "../../src/devices/registry";
import { DeviceKey } from "../../src/identity/device-key";
import { generateEd25519 } from "../../src/identity/keys";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const server = () => {
  const tokens = new CloverTokens({ appToken: "a".repeat(43), verifyCli: async () => false });
  const s = createCloverServer({ tokens, processes: new SessionProcesses(), serverVersion: "test", deviceId: "d".repeat(32) });
  stops.push(() => s.dispose());
  return { tokens, server: s };
};

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("remote clients over links, on the Clover server", () => {
  test("a phone is the user on that device, under remote's list, and gets its subscribed core events once", async () => {
    const c = await makeLinkCluster(["Studio"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const phoneKey = await DeviceKey.fromKey(generateEd25519());
    const phoneReg = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-c-phone-")), key: phoneKey, clock, self: { name: "Phone", kind: "phone" } });
    await studio.registry.add({ id: phoneKey.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phoneKey.publicKeyBase64 }, { via: "terminal" });
    await phoneReg.add({ id: studio.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", publicKey: studio.key.publicKeyBase64 }, { via: "terminal" });
    const phone = new CloverLinkTransport({ self: phoneKey.id, wire: c.net.endpoint(phoneKey.publicKey), registry: phoneReg, clock, directory: { target: () => ({ key: studio.key.publicKey }) } });
    stops.push(() => phone.close());

    const { tokens, server: s } = server();
    stops.push(mountCloverRemoteClients({ transport: studio.transport, registry: studio.registry, server: s, tokens }));

    const st = (await phone.connect(studio.id)).openStream(REMOTE_RPC_LABEL, "control");
    const got: Record<string, unknown>[] = [];
    st.onData((chunk) => got.push(JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>));
    const send = (m: unknown) => st.write(new TextEncoder().encode(JSON.stringify(m)));
    await send({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: "a".repeat(43), clientName: "Clover iOS" } });
    await waitFor(() => got.some((m) => m.id === 1));
    expect(got.find((m) => m.id === 1)!.result).toMatchObject({ ok: true, caller: { kind: "user", client: "ios", device: phoneKey.id } });
    const conn = s.connections().find((x) => x.role === "remote")!;
    expect(conn.connId).toBeGreaterThan(LINK_CONN_ID_BASE);
    await send({ jsonrpc: "2.0", id: 2, method: "pair.quit", params: { handOver: false } });
    await send({ jsonrpc: "2.0", id: 3, method: "events.subscribe", params: { areas: ["approvals"] } });
    await waitFor(() => got.some((m) => m.id === 2) && got.some((m) => m.id === 3));
    expect((got.find((m) => m.id === 2)!.error as { code: number }).code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(got.find((m) => m.id === 3)!.result).toEqual({ ok: true });
    expect(s.coreEvent({ type: "card_resolved", ts: 1, id: "card_0a1b2c3d", outcome: "denied" })).toBe(1);
    expect(s.coreEvent({ type: "device_removed", ts: 1, id: "x", revoked: true })).toBe(0); // not subscribed
    await waitFor(() => got.some((m) => m.method === "core.event"));
    await Bun.sleep(50);
    expect(got.filter((m) => m.method === "core.event")).toEqual([{ jsonrpc: "2.0", method: "core.event", params: { type: "card_resolved", ts: 1, id: "card_0a1b2c3d", outcome: "denied" } }]);
    st.end();
    await waitFor(() => s.connections().length === 0);
  });

  test("linkHello takes only the core's token for that device and role", async () => {
    const { tokens, server: s } = server();
    const hello = (token: string, role: string, device: string) => ({ protocolVersion: CLOVER_PROTOCOL_VERSION, role, device, token, clientName: "x" });
    const phone = "p".repeat(32), other = "q".repeat(32);
    const forOther = tokens.mint({ role: "remote", device: other });
    await expect(s.linkHello(1, hello(forOther, "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED });
    const asWeb = tokens.mint({ role: "web", device: phone });
    await expect(s.linkHello(2, hello(asWeb, "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED });
    await expect(s.linkHello(3, hello(tokens.mint({ role: "remote", device: phone }), "web", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    const ok = await s.linkHello(5, hello(tokens.mint({ role: "remote", device: phone }), "remote", phone), { device: phone, role: "remote" }, () => {});
    expect(ok.conn.caller).toEqual({ kind: "user", client: "ios", device: phone });
    await expect(s.linkHello(5, hello(tokens.mint({ role: "remote", device: phone }), "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR.INVALID_REQUEST });
  });

  test("the door's server: the device from the door's socket, the role from the registry, never the hello", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32), laptop = "l".repeat(32);
    const devices = new Map<string, { kind: string; revokedAt?: number }>([[phone, { kind: "phone" }], [laptop, { kind: "desktop" }], ["r".repeat(32), { kind: "phone", revokedAt: 1 }]]);
    const door = linkClientServer(s, { get: (id) => devices.get(id) as never });
    const hello = (role: string, device: string) => ({ protocolVersion: CLOVER_PROTOCOL_VERSION, role, device, clientName: "x", token: tokens.mint({ role: "remote", device: phone }) });
    await expect(door.hello({ device: phone }, 1, hello("remote", phone), () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED }); // no link mark
    await expect(door.hello({ device: laptop, link: true }, 2, hello("remote", laptop), () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED }); // a computer
    await expect(door.hello({ device: "r".repeat(32), link: true }, 3, hello("remote", "r".repeat(32)), () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED }); // revoked
    await expect(door.hello({ device: phone, link: true }, 4, hello("web", phone), () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED }); // the hello's role isn't the registry's
    expect((await door.hello({ device: phone, link: true }, 5, hello("remote", phone), () => {})).conn.role).toBe("remote");
    // A refusal before linkHello still spends the token the door minted for that hello.
    const spent: string[] = [];
    const spending = linkClientServer(s, { get: (id) => devices.get(id) as never }, (t) => { spent.push(t); tokens.revoke(t); });
    const h = hello("remote", laptop);
    await expect(spending.hello({ device: laptop, link: true }, 6, h, () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    expect(spent).toEqual([h.token]);
  });

  test("each minted token is spent by its hello, and the server closes a link connection itself", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    let ended = 0;
    for (let i = 0; i < 5; i++) {
      const token = tokens.mint({ role: "remote", device: phone });
      const p = { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "remote", device: phone, token, clientName: "x" };
      await s.linkHello(10 + i, p, { device: phone, role: "remote" }, () => {}, () => { ended++; });
      await expect(s.linkHello(100 + i, p, { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED }); // spent
    }
    // A refused hello spends its token too.
    await expect(s.linkHello(200, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "web", device: phone, token: tokens.mint({ role: "remote", device: phone }), clientName: "x" }, { device: phone, role: "remote" }, () => {})).rejects.toBeDefined();
    expect(size()).toBe(0);
    expect(s.endConnections((c) => c.caller.kind === "user" && c.caller.device === phone)).toBe(5);
    expect(ended).toBe(5);
  });

  test("a hello that doesn't parse still spends its token; a device revoked during the hello isn't registered", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    const token = tokens.mint({ role: "remote", device: phone });
    await expect(s.linkHello(1, { role: "remote", device: phone, token }, { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    expect(size()).toBe(0);
    // Revoked while its token was checked: the door's registry says so by the time it would be registered.
    const devices = new Map<string, { kind: string; revokedAt?: number }>([[phone, { kind: "phone" }]]);
    const realVerify = tokens.verify.bind(tokens);
    tokens.verify = async (h) => { const b = await realVerify(h); devices.set(phone, { kind: "phone", revokedAt: 1 }); return b; };
    const door = linkClientServer(s, { get: (id) => devices.get(id) as never });
    const hello = { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "remote", device: phone, clientName: "x", token: tokens.mint({ role: "remote", device: phone }) };
    await expect(door.hello({ device: phone, link: true }, 2, hello, () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    expect(s.connections()).toEqual([]);
    expect(size()).toBe(0);
  });

  test("revoking a device drops the tokens still minted for it and closes its connections", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32), other = "o".repeat(32);
    let fire!: (c: { type: "revoked"; id: string }) => void;
    const off = mountCloverRemoteClients({
      transport: { onStream: () => () => {} }, server: s, tokens,
      registry: { get: () => undefined, watch: (fn) => { fire = fn as never; return () => {}; } },
    });
    stops.push(off);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    tokens.mint({ role: "remote", device: phone });
    tokens.mint({ role: "web", device: phone });
    tokens.mint({ role: "remote", device: other });
    let ended = false;
    await s.linkHello(1, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "remote", device: phone, token: tokens.mint({ role: "remote", device: phone }), clientName: "x" }, { device: phone, role: "remote" }, () => {}, () => { ended = true; });
    expect(size()).toBe(3);
    fire({ type: "revoked", id: phone });
    expect(size()).toBe(1);
    expect(ended).toBe(true);
  });
});
