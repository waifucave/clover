// The fencing token on acts between computers (#187's lease contract, H-M2's review, check 2): every act this computer
// asks of another (a tree call, the direct path's `tree.judge`, `tree.receive`, `tree.send` and `tree.sent`, a tool
// call, a terminal call, a hold, Mirror's `mcp.mirror`, `computer.setLevel`) carries this computer's view of the
// group's lease as `fence`: its scope, epoch and holder. Every such act it serves is judged against its own lease
// (`FenceGuard`, fed only from its own lease's events).
//
// What a token proves: that the sender's view of the group's lease (scope, epoch, holder) is the same as the
// receiver's, so a computer whose view is behind (a main that lost its lease asleep or cut off, or any computer that
// missed a takeover) can't act through the others. It does not prove the sender is the main: every member of the group
// carries the same token. A stale token is refused, and when the receiver's own lease has a scope and a holder, so is
// an act without one, restart or not (the controller's ruling on #237). Lane H's lease feeds it; a node made with
// `lease: null` (no group yet) carries and judges nothing, and says so once in its log.
import { type FenceVerdict, type FencingToken } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { FenceGuard, fencingTokenOf, type Lease } from "../contracts/lease";

export interface ActFence {
  /** This computer's token for an act it asks of another; undefined without a lease. */
  token(): FencingToken | undefined;
  /** Judges the token on an act asked of this computer. */
  check(token: FencingToken | undefined): FenceVerdict;
}

/** The fence from this computer's lease: its token, and a guard fed only from its own lease's events. */
export function leaseFence(lease: Pick<Lease, "state" | "watch">): ActFence & { close(): void } {
  const guard = new FenceGuard();
  guard.observe(lease.state());
  const off = lease.watch((s) => guard.observe(s));
  return { token: () => fencingTokenOf(lease.state()), check: (t) => guard.check(t), close: () => off() };
}

/** `{ fence }` for an act's params, when there is a token. */
export function fenceParam(f: ActFence | undefined): { fence?: FencingToken } {
  const t = f?.token();
  return t ? { fence: t } : {};
}

/** Refuses an act whose token this computer's lease doesn't take (`not_main`); nothing without a fence. */
export function checkActFence(f: ActFence | undefined, token: unknown, what: string): void {
  if (!f) return;
  const v = f.check(token as FencingToken | undefined);
  if (v === "ok") return;
  throw new ContractError("not_main", v === "missing"
    ? `${what} came without the main computer's fencing token`
    : `${what} came from a computer whose lease is over (a stale fencing token)`, { fence: v });
}
