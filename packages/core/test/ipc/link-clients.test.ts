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

  test("the door's server refuses a hello that didn't come from a link the door made", async () => {
    const { server: s } = server();
    const door = linkClientServer(s);
    await expect(door.hello({ device: "p".repeat(32) }, 1, { role: "remote" }, () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    await expect(door.hello({ device: "p".repeat(32), link: true }, 1, { role: "app" }, () => {})).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
  });
});
