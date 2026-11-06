// Lane D's relay of a user's message to the computer that runs the bot (`peer.session.send`, review N3; D's ask for
// H-M1), over the link, and what makes its signature checkable there: each computer tells its peers its own name and
// answer key, signed with its link key, whenever a link comes up and whenever they change (`DEVICE_UPDATE`).
//
// The sending device signs `userMessageSigningInput` with the key it answers cards with (`AnswerKey.signUserMessage`
// on a desktop's app). The relaying computer passes the message on as it came; the receiver checks it with
// `verifyUserMessage` against its own registry, and a message without a good signature still arrives, as a `peer`
// turn (lane D's host decides that).
import { DEVICES_METHODS } from "@waifucave/clover-protocol";
import type { z } from "zod";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import { fromBase64, toBase64 } from "../identity/bytes";
import type { DeviceKey } from "../identity/device-key";
import { type FileDeviceRegistry, peerUpdateStatement } from "../devices/registry";

export type RelayParams = z.input<typeof DEVICES_METHODS.peerSessionDeliver.params>;

/** Sends a user's message to the computer running its bot; resolves with the seq that computer gave it. */
export async function relayUserMessage(transport: Pick<LinkTransport, "connect">, computer: string, params: RelayParams): Promise<{ seq: number }> {
  const parsed = DEVICES_METHODS.peerSessionDeliver.params.safeParse(params);
  if (!parsed.success) throw new ContractError("invalid", "peer.session.send: bad params");
  const link = await transport.connect(computer);
  return link.request<{ seq: number }>(DEVICES_METHODS.peerSessionDeliver.name, parsed.data);
}

/** Takes relayed messages for lane D's host: only from a paired computer, with the params the protocol says. `deliver`
 *  is D's (it checks the signature with `verifyUserMessage` and decides the turn's origin). */
export function mountUserMessageRelay(
  transport: Pick<LinkTransport, "handle">,
  registry: Pick<FileDeviceRegistry, "get">,
  deliver: (params: z.output<typeof DEVICES_METHODS.peerSessionDeliver.params>, from: string) => Promise<{ seq: number }>,
): Unsubscribe {
  return transport.handle(DEVICES_METHODS.peerSessionDeliver.name, async (raw, from) => {
    const relayer = registry.get(from);
    if (!relayer || relayer.revokedAt !== undefined || !relayer.runsCore) throw new ContractError("refused", "only a paired computer relays a message");
    const parsed = DEVICES_METHODS.peerSessionDeliver.params.safeParse(raw);
    if (!parsed.success) throw new ContractError("invalid", "peer.session.send: bad params");
    return deliver(parsed.data, from);
  });
}

/** The link's own notification for a device's signed name and answer key (not a protocol method: it never leaves
 *  the link). */
export const DEVICE_UPDATE = "link.device.update";

interface UpdateWire {
  update: { name?: string; answerKey?: { publicKey: string; held: string } | null; at: number };
  signature: string;
}

/** Keeps the peers' records of this device current, and takes theirs: on every link that comes up, and whenever this
 *  device's name or answer key changes. */
export function shareDeviceUpdates(
  o: { transport: Pick<LinkTransport, "connect" | "links" | "watch" | "onNotify">; registry: FileDeviceRegistry; key: DeviceKey; clock: { now(): number } },
): Unsubscribe {
  const own = (): UpdateWire => {
    const self = o.registry.self();
    // Strictly after the last one sent, so a receiver's replay check never drops a real change.
    const at = Math.max(Math.floor(o.clock.now()), lastAt + 1);
    lastAt = at;
    const update = { name: self.name, answerKey: self.answerKey ? { publicKey: self.answerKey.publicKey, held: self.answerKey.held } : null, at };
    return { update, signature: toBase64(o.key.sign(peerUpdateStatement(self.id, update))) };
  };
  let lastAt = 0;
  const send = (peer: string) => {
    void o.transport.connect(peer).then((link) => link.notify(DEVICE_UPDATE, own())).catch(() => undefined);
  };
  const offs: Unsubscribe[] = [];
  offs.push(o.transport.onNotify(DEVICE_UPDATE, (raw, from) => {
    const m = raw as Partial<UpdateWire> | undefined;
    const sig = typeof m?.signature === "string" ? fromBase64(m.signature) : null;
    if (!m?.update || typeof m.update.at !== "number" || !sig) return;
    void o.registry.applyPeerUpdate(from, m.update as Parameters<FileDeviceRegistry["applyPeerUpdate"]>[1], sig);
  }));
  // Once per link coming up, not on every change of its path or round trip.
  const up = new Set<string>();
  offs.push(o.transport.watch((v) => {
    if (v.up && !up.has(v.peer)) {
      up.add(v.peer);
      send(v.peer);
    } else if (!v.up) up.delete(v.peer);
  }));
  offs.push(o.registry.watch((c) => {
    if (c.type !== "changed" || c.device.id !== o.registry.self().id) return;
    for (const l of o.transport.links()) if (l.up) send(l.peer);
  }));
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
