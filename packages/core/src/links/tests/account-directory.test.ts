// Signed-in computers finding each other (B2 of H-M1's review): the account channel of the handshake (a local stand-in
// for lane I's service) carries each device's addresses sealed to the other's X25519 key, a "dial now", presence and
// the account's lease; the driver publishes at start and keeps the account's socket open; two daemons on one account
// take each other from the account's list and link, with the lease on the account's record.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAccountToken } from "../../../../../services/shared/account-token";
import { startSignInStub } from "../../../../test-harness/src/signin-stub";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { Secret } from "../../contracts/secret-store";
import { SystemClock } from "../../clock/system-clock";
import { AccountClient } from "../../identity/account";
import { startFakeAccountService } from "../../identity/account-fake";
import { HandshakeClient, HANDSHAKE_AUDIENCE } from "../handshake";
import { startFakeHandshake } from "../handshake-fake";
import { MemoryNetwork } from "../memory-wire";
import { startDeviceLinks } from "../node";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function stack() {
  const auth = startSignInStub();
  stops.push(() => auth.stop());
  const service = startFakeAccountService({ authUrl: auth.url, anonKey: auth.anonKey });
  stops.push(() => service.stop());
  auth.addUser({ email: "someone@example.invalid", password: "correct horse" });
  // The handshake checks account tokens against the account service's JWKS, as lane I's service does.
  const tokens = new Map<string, { sub: string; dev: string }>();
  const hs = startFakeHandshake({ accountOf: (t) => tokens.get(t) });
  stops.push(() => hs.stop());
  const check = async (t: string) => {
    if (tokens.has(t)) return;
    const who = await verifyAccountToken(t, { issuer: service.issuer, audience: HANDSHAKE_AUDIENCE, jwks: service.jwks }).catch(() => null);
    if (who) tokens.set(t, { sub: who.account, dev: who.device });
  };
  return { auth, service, hs, check };
}

async function daemon(s: Awaited<ReturnType<typeof stack>>, net: MemoryNetwork, name: string) {
  const store = new MemorySecretStore();
  const home = mkdtempSync(join(tmpdir(), "clover-h-acctdir-"));
  const { DeviceKey } = await import("../../identity/device-key");
  const key = await DeviceKey.loadOrCreate(store);
  const account = new AccountClient({ config: { authUrl: s.auth.url, anonKey: s.auth.anonKey, serviceUrl: s.service.url }, store, device: key, clock });
  stops.push(() => account.close());
  await account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
  // The handshake's token check runs before each request reaches the stand-in.
  const handshake = new HandshakeClient({
    baseUrl: s.hs.url, clock,
    fetch: async (req) => {
      const auth = req.headers.get("authorization") ?? "";
      if (auth.startsWith("Bearer ")) await s.check(auth.slice(7));
      return fetch(req);
    },
  });
  const links = await startDeviceLinks({
    home, store, clock, self: { name, os: "macos" }, account, handshake, wire: (k) => net.endpoint(k.publicKey),
    mainComputer: { watchSleep: false, monotonic: () => performance.now() },
  });
  stops.push(() => links.close());
  return { links, account, key };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("the account channel", () => {
  test("two signed-in computers take each other from the account, publish sealed addresses, and link", async () => {
    const s = await stack();
    const net = new MemoryNetwork();
    const a = await daemon(s, net, "Studio");
    const b = await daemon(s, net, "Laptop");
    // Each one's driver took the other from the account's list, at start or from the account socket's presence.
    await a.links.refresh();
    await b.links.refresh();
    await waitFor(() => a.links.registry.get(b.key.id)?.addedBy === "account" && b.links.registry.get(a.key.id)?.addedBy === "account");
    await a.links.refresh();
    // A's record for B is at the service, sealed: B opens it, the service never sees an address in the clear.
    const rec = [...s.hs.accountRecordsFor(b.key.id)].find((r) => r.from === a.key.id && r.kind === "addr");
    expect(rec).toBeDefined();
    expect(rec!.box).not.toContain("127.0.0.1");
    await b.links.accountDirectory!.read();
    expect(await b.links.accountDirectory!.addr(a.key.id)).toMatchObject({ v: 1 });
    // And the link comes up.
    const link = await b.links.transport.connect(a.key.id);
    await waitFor(() => link.view().up);
  }, 30_000);

  test("a dial asks the peer to dial back now, through the account's socket", async () => {
    const s = await stack();
    const net = new MemoryNetwork();
    const a = await daemon(s, net, "Studio");
    const b = await daemon(s, net, "Laptop");
    await a.links.refresh();
    await b.links.refresh();
    await waitFor(() => a.links.registry.get(b.key.id) !== undefined && b.links.registry.get(a.key.id) !== undefined);
    await a.links.refresh();
    await b.links.refresh();
    // B's account socket is open: A's "dial now" is delivered straight to it.
    await waitFor(async () => (await a.links.accountDirectory!.dialNow(b.key.id)) === true);
  }, 30_000);

  test("the lease lives on the account's record: one computer holds it, the other follows the socket's pushes", async () => {
    const s = await stack();
    const net = new MemoryNetwork();
    const a = await daemon(s, net, "Studio");
    const b = await daemon(s, net, "Laptop");
    await a.links.refresh();
    await b.links.refresh();
    await waitFor(() => a.links.registry.get(b.key.id) !== undefined && b.links.registry.get(a.key.id) !== undefined);
    await a.links.main!.coordinator.chooseSelf();
    await waitFor(() => s.hs.accountLeases.size === 1 && [...s.hs.accountLeases.values()][0]!.holder === a.key.id);
    await waitFor(() => b.links.main!.lease.state().holder === a.key.id);
    expect(a.links.main!.lease.canAct()).toBe(true);
    expect(b.links.main!.lease.canAct()).toBe(false);
  }, 30_000);

  test("account-less pairs too: the driver publishes to the pair and keeps its socket open, so a dial-now arrives at once", async () => {
    const hs = startFakeHandshake();
    stops.push(() => hs.stop());
    const net = new MemoryNetwork();
    const make = async (name: string) => {
      const links = await startDeviceLinks({
        home: mkdtempSync(join(tmpdir(), "clover-h-pairdir-")), store: new MemorySecretStore(), clock, self: { name }, wire: (k) => net.endpoint(k.publicKey),
        handshake: new HandshakeClient({ baseUrl: hs.url, clock }), mainComputer: { watchSleep: false, monotonic: () => performance.now() },
      });
      stops.push(() => links.close());
      return links;
    };
    const a = await make("Studio");
    const b = await make("Laptop");
    const view = await a.pairing.begin();
    const joined = await b.pairing.join(view.qr!);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
    await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined && b.registry.pairWith(a.key.id)?.registeredAt !== undefined);
    // The pairing's "added" makes each driver refresh: publish, and open the pair's socket.
    await waitFor(async () => (await a.directory!.dialNow(b.key.id)) === true);
    expect(hs.log.some((l) => l.startsWith("PUT /v1/pairs/:id/records"))).toBe(true);
    // Both are in the group, so the lease lives on the group's record.
    await a.main!.coordinator.chooseSelf();
    const group = a.registry.group()!.id;
    // The laptop may have taken the lease by the automatic rule first; the user's choice has it handed back.
    await waitFor(() => hs.groups.get(group)?.lease.holder === a.registry.group()!.ownKey);
    await waitFor(() => a.main!.lease.canAct());
  }, 30_000);
});
