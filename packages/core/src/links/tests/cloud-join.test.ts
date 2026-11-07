// A cloud computer joins the main computer (spec §9.2; lane INT's PR 2): the main issues a join ticket that pins its
// signed link key, the VM presents its single-use token at the pair door, and both sides confirm by the token. The
// token is consumed once at the door, bound to the device the link authenticated: presented again by another device,
// expired, or used already, it is refused. Only the main computer issues a ticket or takes a VM in; a ticket whose
// pinned key was swapped is refused before anything is dialled. Lane H's in-memory network; lane J's `PairingTokens`
// behind a door shaped as lane J's `CloudPairingDoor` (its `CloudComputers.door` adds the tenure and the VM's record).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { PairingTokens } from "../../computers/cloud";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { fromBase64Url, toBase64Url } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { decode, encode } from "../codec";
import { MemoryNetwork } from "../memory-wire";
import { PairingService, TOKEN_REFUSED } from "../pairing";

const clock = new SystemClock();
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** The main computer: its door takes VMs' tokens from `tokens` while `main.is` says it is the main computer. */
async function mainComputer(net: MemoryNetwork, tokens: PairingTokens) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-int-main-")), key, clock, self: { name: "Studio", os: "macos" } });
  const main = { is: true };
  /** Each token the door consumed, and the device it is bound to. */
  const bound: { computer: string; device: string }[] = [];
  const door = {
    consume: async (token: string, device: string) => {
      const computer = tokens.consume(token);
      if (computer === null) return null;
      bound.push({ computer, device });
      return { computer };
    },
  };
  const pairing = new PairingService({
    self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null,
    cloud: { isMain: () => main.is, consume: (t, d) => door.consume(t, d) },
  });
  cleanup.push(() => pairing.close());
  return { key, registry, pairing, main, bound, door };
}

/** A VM's daemon, named `computer`. */
async function vm(net: MemoryNetwork, computer: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-int-vm-")), key, clock, self: { name: computer, computer, os: "linux" } });
  const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null });
  cleanup.push(() => pairing.close());
  return { key, registry, pairing };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  if (!isContractError(err)) throw new Error(`expected a refusal, got ${String(err)}`);
  return err.message;
};

describe("a cloud computer's join (§9.2)", () => {
  test("the VM pairs with its ticket and token: both sides add the other, by the token, with no words; the token is used once", async () => {
    const net = new MemoryNetwork();
    const tokens = new PairingTokens({ clock });
    const studio = await mainComputer(net, tokens);
    const hetzner = await vm(net, "hetzner-1");
    const token = tokens.mint("hetzner-1");
    const ticket = studio.pairing.issueTicket("hetzner-1");
    await hetzner.pairing.joinTicket(ticket, token);
    await waitFor(() => studio.registry.get(hetzner.key.id) !== undefined);
    expect(studio.registry.get(hetzner.key.id)).toMatchObject({ computer: "hetzner-1", runsCore: true, addedBy: "cloud-token" });
    expect(hetzner.registry.get(studio.key.id)).toMatchObject({ name: "Studio", addedBy: "cloud-token" });
    expect(studio.bound).toEqual([{ computer: "hetzner-1", device: hetzner.key.id }]); // bound to the device the link authenticated
    expect(tokens.consume(token)).toBeNull(); // once
    expect(tokens.waiting("hetzner-1")).toBe(false);
  });

  test("a token is refused when it was used already, when it has expired, or when another device presented it first", async () => {
    const net = new MemoryNetwork();
    const tokens = new PairingTokens({ clock, ttlMs: 2_000 });
    const studio = await mainComputer(net, tokens);

    // Used: the first VM pairs; a second device named the same presents the same token.
    const used = tokens.mint("hetzner-1");
    await (await vm(net, "hetzner-1")).pairing.joinTicket(studio.pairing.issueTicket("hetzner-1"), used);
    const again = await vm(net, "hetzner-1");
    expect(await refusal(again.pairing.joinTicket(studio.pairing.issueTicket("hetzner-1"), used))).toBe(TOKEN_REFUSED);
    expect(again.registry.list()).toHaveLength(1);
    expect(studio.registry.get(again.key.id)).toBeUndefined();

    // Another device: the token was presented first by the device it is bound to (whose pairing was cut off midway),
    // so a second device presenting it is refused.
    const first = await vm(net, "gcp-2");
    const second = await vm(net, "gcp-2");
    const token = tokens.mint("gcp-2");
    expect(await studio.door.consume(token, first.key.id)).toEqual({ computer: "gcp-2" });
    expect(await refusal(second.pairing.joinTicket(studio.pairing.issueTicket("gcp-2"), token))).toBe(TOKEN_REFUSED);
    expect(studio.registry.get(second.key.id)).toBeUndefined();
    expect(studio.bound.filter((b) => b.computer === "gcp-2")).toEqual([{ computer: "gcp-2", device: first.key.id }]);

    // Expired: past the token's hour (here 2 s), even with a fresh ticket.
    const late = tokens.mint("hetzner-3");
    await Bun.sleep(2_200);
    const slow = await vm(net, "hetzner-3");
    expect(await refusal(slow.pairing.joinTicket(studio.pairing.issueTicket("hetzner-3"), late))).toBe(TOKEN_REFUSED);
    expect(studio.registry.get(slow.key.id)).toBeUndefined();
  });

  test("a token made for another computer, and a ticket for another computer, are refused", async () => {
    const net = new MemoryNetwork();
    const tokens = new PairingTokens({ clock });
    const studio = await mainComputer(net, tokens);
    const hetzner = await vm(net, "hetzner-1");
    // The VM checks the ticket names it before dialling.
    expect(await refusal(hetzner.pairing.joinTicket(studio.pairing.issueTicket("gcp-2"), tokens.mint("gcp-2")))).toBe("the join ticket is for gcp-2, not this computer");
    // The door checks the token was made for the ticket's computer.
    expect(await refusal(hetzner.pairing.joinTicket(studio.pairing.issueTicket("hetzner-1"), tokens.mint("gcp-9")))).toBe("the pairing token was made for another computer");
    expect(studio.registry.get(hetzner.key.id)).toBeUndefined();
  });

  test("only the main computer issues a ticket, and a computer that stopped being main takes no VM in", async () => {
    const net = new MemoryNetwork();
    const tokens = new PairingTokens({ clock });
    const studio = await mainComputer(net, tokens);
    studio.main.is = false;
    expect(() => studio.pairing.issueTicket("hetzner-1")).toThrow("only the main computer issues a join ticket");
    // A ticket issued while it was main, presented after the lease moved on.
    studio.main.is = true;
    const ticket = studio.pairing.issueTicket("hetzner-1");
    studio.main.is = false;
    const hetzner = await vm(net, "hetzner-1");
    const token = tokens.mint("hetzner-1");
    expect(await refusal(hetzner.pairing.joinTicket(ticket, token))).toBe("this computer isn't the main computer");
    expect(tokens.waiting("hetzner-1")).toBe(true); // nothing was consumed
    // A computer with no cloud side at all issues none either.
    const plain = await vm(net, "Laptop");
    expect(() => plain.pairing.issueTicket("hetzner-1")).toThrow("only the main computer issues a join ticket");
  });

  test("a ticket whose pinned key doesn't match its signature is refused before anything is dialled", async () => {
    const net = new MemoryNetwork();
    const tokens = new PairingTokens({ clock });
    const studio = await mainComputer(net, tokens);
    const impostor = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const ticket = studio.pairing.issueTicket("hetzner-1");
    const fields = decode(fromBase64Url(ticket.slice("clover-join:1:".length))!) as unknown[];
    fields[2] = impostor.publicKey; // the pinned key swapped for another computer's
    const swapped = `clover-join:1:${toBase64Url(encode(fields))}`;
    const hetzner = await vm(net, "hetzner-1");
    expect(await refusal(hetzner.pairing.joinTicket(swapped, tokens.mint("hetzner-1")))).toBe("the join ticket isn't signed by the computer it pins");
    // A plain pairing code is no ticket.
    expect(await refusal(hetzner.pairing.joinTicket((await studio.pairing.begin()).qr!, tokens.mint("hetzner-1")))).toBe("not a join ticket");
  });
});
