// Pins the Lease contract through FakeLeaseAuthority: one holder at a time, takeover only after a lapse, epochs, the
// fencing margin, and Hand over and quit.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { FAKE_LEASE_MARGIN_MS, FAKE_LEASE_TTL_MS, FakeLeaseAuthority } from "../fakes/lease";
import type { LeaseState } from "../lease";

function setup() {
  const clock = new FakeClock();
  const authority = new FakeLeaseAuthority({ clock, main: "studio" });
  return { clock, authority, studio: authority.lease("studio"), laptop: authority.lease("laptop") };
}

describe("FakeLeaseAuthority", () => {
  test("the first holder gets epoch 1 and is the refresher", async () => {
    const { clock, studio, laptop } = setup();
    expect(studio.state()).toEqual({ main: "studio", holder: null, epoch: 0, expiresAt: null, refresher: null, state: "lapsed" });
    expect(await studio.acquire()).toEqual({ main: "studio", holder: "studio", epoch: 1, expiresAt: clock.now() + FAKE_LEASE_TTL_MS, refresher: "studio", state: "held" });
    expect(studio.canAct()).toBe(true);
    expect(laptop.canAct()).toBe(false);
  });

  test("another computer takes over only after the lease lapses, with a new epoch", async () => {
    const { clock, studio, laptop } = setup();
    await studio.acquire();
    expect(isContractError(await laptop.acquire().catch((e: unknown) => e), "not_main")).toBe(true);
    clock.advance(FAKE_LEASE_TTL_MS);
    expect(laptop.state().state).toBe("lapsed");
    expect(await laptop.acquire()).toMatchObject({ holder: "laptop", epoch: 2 });
    expect(isContractError(await studio.renew().catch((e: unknown) => e), "not_main")).toBe(true);
  });

  test("a holder that can't renew stops acting a margin before its lease ends", async () => {
    const { clock, authority, studio } = setup();
    await studio.acquire();
    authority.cutOff("studio");
    expect(isContractError(await studio.renew().catch((e: unknown) => e), "offline")).toBe(true);
    clock.advance(FAKE_LEASE_TTL_MS - FAKE_LEASE_MARGIN_MS - 1);
    expect(studio.canAct()).toBe(true);
    clock.advance(1);
    expect(studio.canAct()).toBe(false);
    expect(studio.state().holder).toBe("studio");
  });

  test("renewing keeps the epoch and pushes the expiry", async () => {
    const { clock, studio } = setup();
    await studio.acquire();
    clock.advance(20_000);
    expect(await studio.renew()).toMatchObject({ epoch: 1, expiresAt: clock.now() + FAKE_LEASE_TTL_MS });
    expect(await studio.acquire()).toMatchObject({ epoch: 1 });
  });

  test("Hand over and quit releases at once, so another computer takes the bots", async () => {
    const { studio, laptop } = setup();
    await studio.acquire();
    await studio.release();
    expect(await laptop.acquire()).toMatchObject({ holder: "laptop", epoch: 2 });
  });

  test("a computer that can't reach the handshake can't take over, and sees the lease as unreachable", async () => {
    const { authority, laptop } = setup();
    authority.cutOff("laptop");
    expect(laptop.state().state).toBe("unreachable");
    expect(isContractError(await laptop.acquire().catch((e: unknown) => e), "offline")).toBe(true);
  });

  test("watchers hear a lapse with no renewal", async () => {
    const { clock, studio, laptop } = setup();
    const seen: LeaseState[] = [];
    laptop.watch((s) => seen.push(s));
    await studio.acquire();
    clock.advance(FAKE_LEASE_TTL_MS);
    expect(seen.map((s) => s.state)).toEqual(["held", "lapsed"]);
  });
});
