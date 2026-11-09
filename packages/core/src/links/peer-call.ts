// The `peer.call` door (B1 of the review; protocol `peerCallVerdict`): another computer runs a method here for a
// caller on its side. The receiver decides everything from what it can check itself:
// * who calls is the device the link authenticated (`from`), never the `as` the params claim; the call runs as that
//   peer (`Caller.kind: "peer"`), never as the user's own terminal, and never past the fence;
// * the role is a remote one (`remote` or `web`) and the method is on that role's allow list;
// * a `userOnly` or `change` method needs the user's signed answer bound to exactly this call: the receiver rebuilds
//   its own card for the call, compares hashes, checks the option, the device's answer key (item 91: a desktop's
//   app-held key, never the link key), the time, and claims the card once (`verifySignedAnswer`).
import { createHash } from "node:crypto";
import { type Caller, DEVICES_METHODS, peerCallVerdict } from "@waifucave/clover-protocol";
import {
  type AnswerDevices, type AnswerLedger, type CallCardRenderer, type SignedAnswerVerdict, verifySignedAnswer,
} from "../contracts/approval-broker";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";

export interface PeerCallDeps {
  /** This computer's name in the tree: what a bound card's `binds.computer` must say. */
  computer(): string;
  devices: AnswerDevices;
  ledger: AnswerLedger;
  render: CallCardRenderer;
  clock: { now(): number };
  /** Runs the method as the peer, under the role's allow list (lane C's server). */
  dispatch(method: string, params: unknown, caller: Extract<Caller, { kind: "peer" }>, role: "remote" | "web"): Promise<unknown>;
  /** Lets a test or lane C swap the signed-answer check (C owns `verifySignedAnswer`). */
  verify?: typeof verifySignedAnswer;
  /** The lease's fencing token (lease.ts `isStale`): a call stamped with an earlier lease's `fence` is refused. */
  isStale?(epoch: number, scope?: string): boolean;
}

/** What a call made for the main computer's bots carries: its lease's (scope, epoch), from `MainLease.fence()`. Lanes B
 *  and J: the same field on `peer.call`'s params and the tree's calls. */
export interface CallFence {
  scope: string;
  epoch: number;
}

export function fenceOf(raw: unknown): CallFence | undefined {
  const f = (raw as { fence?: { scope?: unknown; epoch?: unknown } } | undefined)?.fence;
  return f && typeof f.scope === "string" && typeof f.epoch === "number" && Number.isInteger(f.epoch) && f.epoch >= 0 ? { scope: f.scope, epoch: f.epoch } : undefined;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function peerCall(deps: PeerCallDeps, raw: unknown, from: string): Promise<{ result: unknown }> {
  const parsed = DEVICES_METHODS.peerCall.params.safeParse(raw);
  if (!parsed.success) throw new ContractError("invalid", "peer.call: bad params");
  const p = parsed.data;
  // An act of an old main is refused, not just marked late (H-M2's review): the receiver's own fence decides.
  const fence = fenceOf(raw);
  if (fence && deps.isStale?.(fence.epoch, fence.scope)) throw new ContractError("not_main", "the call comes from a main computer that has since lost the lease", { fence });
  const verdict = peerCallVerdict(p.method, p.role, p.as);
  if (verdict === "refused") throw new ContractError("refused", `${p.method} can't be called from another computer as ${p.role}${p.as.kind === "session" ? " for a session" : ""}`);
  if (verdict === "needs-answer") {
    if (!p.answer) throw new ContractError("refused", `${p.method} needs the user's signed answer`);
    const check = deps.verify ?? verifySignedAnswer;
    const v: SignedAnswerVerdict = await check(p.answer, {
      self: deps.computer(), method: p.method, params: p.params, now: deps.clock.now(), sha256, devices: deps.devices, ledger: deps.ledger, render: deps.render,
    });
    if (v !== "ok") throw new ContractError("refused", `the signed answer doesn't hold (${v})`);
  }
  const caller: Extract<Caller, { kind: "peer" }> = {
    kind: "peer", device: from,
    ...(p.as.kind === "session" ? { sessionId: p.as.sessionId, ...(p.as.bot ? { bot: p.as.bot } : {}) } : {}),
  };
  return { result: await deps.dispatch(p.method, p.params, caller, p.role) };
}

/** Mounts the door on the link transport. */
export function mountPeerCall(transport: Pick<LinkTransport, "handle">, deps: PeerCallDeps): Unsubscribe {
  return transport.handle(DEVICES_METHODS.peerCall.name, (params, from) => peerCall(deps, params, from));
}
