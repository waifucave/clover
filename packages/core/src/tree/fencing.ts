// The fencing token on acts between computers (#187's lease contract, H-M2's review, check 2): every act this computer
// asks of another (a tree call, the direct path's `tree.judge`, `tree.receive`, `tree.send` and `tree.sent`, a tool
// call, `computer.setLevel`) carries this computer's lease token as `fence`, and every such act it serves is judged
// against its own lease (`FenceGuard`): a stale token, or none once it has seen one for its scope, is refused, so a
// main that lost its lease without knowing, asleep or cut off, can't act through the others. Lane H's lease stamps
// and feeds it; without a lease (tests, a computer with no account group yet) nothing is carried or judged.
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
