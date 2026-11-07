// Runs the Lease conformance suite against FakeLeaseAuthority, and checks the receiver's fencing guard.
import { describe, expect, test } from "bun:test";
import { runLeaseConformance } from "../conformance/lease";
import { FakeLeaseAuthority } from "../fakes/lease";
import { FenceGuard, fencingTokenOf } from "../lease";

runLeaseConformance((...args) => new FakeLeaseAuthority(...args));

describe("FenceGuard (H-M2's review, check 2)", () => {
  const lease = (epoch: number, holder: string | null, scope = "acct_1") => ({ holder, epoch, expiresAt: 0, scope } as Parameters<typeof fencingTokenOf>[0]);
  test("takes its own scope's tokens only, refuses older ones and a split takeover's, and then refuses an act without one", () => {
    const g = new FenceGuard();
    expect(g.check(undefined)).toBe("ok"); // nothing seen yet
    g.observe(lease(3, "studio"));
    const token = fencingTokenOf(lease(3, "studio"))!;
    expect(token).toEqual({ scope: "acct_1", epoch: 3, holder: "studio" });
    expect(g.check(token)).toBe("ok");
    expect(g.check(undefined)).toBe("missing");
    expect(g.check({ ...token, holder: "laptop" })).toBe("stale");
    expect(g.check({ ...token, scope: "group_9" })).toBe("stale");
    // A token ahead of the guard's own records is refused, and moves nothing (#187's check 2): a forged far-ahead epoch
    // can't lock out the real main.
    expect(g.check({ scope: "acct_1", epoch: 999, holder: "laptop" })).toBe("stale");
    expect(g.check(token)).toBe("ok");
    g.observe(lease(4, "laptop")); // its own records move it on
    expect(g.check({ scope: "acct_1", epoch: 4, holder: "laptop" })).toBe("ok");
    expect(g.check(token)).toBe("stale"); // epoch 3 is older now
    g.observe(lease(3, "studio")); // a late event never moves it back
    expect(g.check(token)).toBe("stale");
  });

  test("with a scope and a holder of its own, it refuses an act without a token outright: a restart doesn't reopen the door (#237's ruling)", () => {
    // A receiver that just started: its own lease has a holder, and it has seen no token yet.
    const restarted = new FenceGuard();
    restarted.observe(lease(3, "studio"));
    expect(restarted.check(undefined)).toBe("missing");
    expect(restarted.check(fencingTokenOf(lease(3, "studio")))).toBe("ok");
    // No holder yet (a lapsed lease, nobody took it): a tokenless act is judged as before, until a token is seen.
    const lapsed = new FenceGuard();
    lapsed.observe(lease(3, null));
    expect(lapsed.check(undefined)).toBe("ok");
    // No lease of its own at all: nothing to judge against.
    expect(new FenceGuard().check(undefined)).toBe("ok");
  });
});
