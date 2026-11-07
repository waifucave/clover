// The Lease conformance suite (review S15). `runLeaseConformance(make)` registers every case against the
// implementation `make` builds; `tests/lease.test.ts` runs it against FakeLeaseAuthority, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// one holder at a time, takeover only after a lapse, epochs, the
// fencing margin, and Hand over and quit.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { FAKE_LEASE_MARGIN_MS, FAKE_LEASE_TTL_MS, type FakeLeaseAuthority } from "../fakes/lease";
import type { LeaseState } from "../lease";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type LeaseHarness = Pick<FakeLeaseAuthority, keyof FakeLeaseAuthority>;
/** Builds the implementation under test from the options the fake takes. */
export type LeaseFactory = (...args: ConstructorParameters<typeof FakeLeaseAuthority>) => LeaseHarness;

export function runLeaseConformance(make: LeaseFactory): void {
  function setup() {
    const clock = new FakeClock();
    const authority = make({ clock, main: "studio" });
    return { clock, authority, studio: authority.lease("studio"), laptop: authority.lease("laptop") };
  }

  describe("Lease", () => {
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

    test("the deadline runs on the device's monotonic clock: a wrong wall clock changes nothing", async () => {
      const clock = new FakeClock();
      const authority = make({ clock, main: "studio" });
      const ahead = authority.lease("studio", { offsetMs: 10 * 60_000 });
      const behind = authority.lease("laptop", { offsetMs: -10 * 60_000 });
      await ahead.acquire();
      expect(ahead.wallNow() - behind.wallNow()).toBe(20 * 60_000);
      clock.advance(FAKE_LEASE_TTL_MS - FAKE_LEASE_MARGIN_MS - 1);
      expect(ahead.canAct()).toBe(true);
      clock.advance(1);
      expect(ahead.canAct()).toBe(false);
      clock.advance(FAKE_LEASE_MARGIN_MS);
      await behind.acquire();
      expect(behind.canAct()).toBe(true);
      expect(ahead.canAct()).toBe(false);
    });

    test("a main that slept past its lease never acts on it: after a wake, only a successful renew lets it act", async () => {
      const { clock, authority, studio, laptop } = setup();
      await studio.acquire();
      // Asleep for a minute (the monotonic clock counts sleep); the laptop took over meanwhile.
      clock.advance(60_000);
      await laptop.acquire();
      studio.wake();
      expect(studio.canAct()).toBe(false);
      expect(isContractError(await studio.renew().catch((e: unknown) => e), "not_main")).toBe(true);
      expect(studio.canAct()).toBe(false);
      // A short nap with the lease still held: still nothing until the renew.
      await laptop.renew();
      laptop.wake();
      expect(laptop.canAct()).toBe(false);
      authority.cutOff("laptop");
      expect(isContractError(await laptop.renew().catch((e: unknown) => e), "offline")).toBe(true);
      expect(laptop.canAct()).toBe(false);
      authority.cutOff("laptop", false);
      await laptop.renew();
      expect(laptop.canAct()).toBe(true);
    });

    test("with no account the devices' group holds the lease at the handshake, as an account does (item 85)", async () => {
      const clock = new FakeClock();
      const authority = make({ clock, account: false });
      const studio = authority.lease("studio");
      const laptop = authority.lease("laptop");
      await studio.acquire();
      expect(studio.canAct()).toBe(true);
      expect(isContractError(await laptop.acquire().catch((e: unknown) => e), "not_main")).toBe(true);
      await studio.release();
      await laptop.acquire({ byUser: true });
      expect(laptop.canAct()).toBe(true);
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
}
