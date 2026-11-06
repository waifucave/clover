// Lane D's `BotRelay` over the link (D-M2's ask; spec §6.4 "Messages, interrupts and the main computer"): how a
// message reaches a bot's conversation when it runs on another computer.
//
// * **The user's message** goes as `peer.session.send` (relay.ts), as its device sent it, signature and all; the
//   computer running the bot checks the signature and decides whether the turn is the user's.
// * **Another session's message** (a bot's `SendMessage`, a routine's result, an agent's report) goes as the link's own
//   `link.session.deliver`. The receiver takes it only from a paired computer, and only as what it says it is (a bot's
//   or a routine's message is never the user's: lane D's host keeps `originOf`).
// * Computers are named by their tree name (`DeviceRecord.computer`), as lane D's main computer names them.
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { DeliveredInput, Disposition } from "../contracts/session-host";
import type { FileDeviceRegistry } from "../devices/registry";
import { type CallFence, fenceOf } from "./peer-call";
import { relayUserMessage, type RelayParams } from "./relay";

/** The link's own request for another session's message to a session on the receiving computer. */
export const SESSION_DELIVER = "link.session.deliver";

/** What `link.session.deliver` takes (B's #187): a bot's, an agent's, a routine's message, or a task notification. */
const DELIVERED_FROM = new Set(["bot", "agent", "task-notification", "routine"]);

/** D's `BotRelay` (bots/service.ts), structurally. */
export interface LinkBotRelay {
  sendUser(computer: string, session: string, p: { message: RelayParams["message"]; device: string; sentAt: number }): Promise<{ seq: number }>;
  deliver(computer: string, session: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }>;
}

/** The device a computer's tree name names, among the paired computers. */
export function deviceOfComputer(registry: Pick<FileDeviceRegistry, "list">, computer: string): string | undefined {
  const lower = computer.toLowerCase();
  return registry.list().find((d) => d.runsCore && d.computer?.toLowerCase() === lower)?.id;
}

/** `fence`: this computer's lease token (`MainLease.fence()`), stamped on every message it delivers for its bots. */
export function linkBotRelay(o: { transport: Pick<LinkTransport, "connect">; registry: Pick<FileDeviceRegistry, "list">; fence?: () => CallFence }): LinkBotRelay {
  const device = (computer: string): string => {
    const id = deviceOfComputer(o.registry, computer);
    if (!id) throw new ContractError("bot_asleep", `${computer} isn't a paired computer`);
    return id;
  };
  const asleep = (computer: string, err: unknown): never => {
    // The computer running the bot can't be reached: the draft is kept (§6.4), and the error says so.
    if (err instanceof ContractError && (err.code === "offline" || err.code === "computer_offline")) throw new ContractError("bot_asleep", `can't reach ${computer}, the computer running the bot`);
    throw err;
  };
  return {
    sendUser: (computer, session, p) =>
      relayUserMessage(o.transport, device(computer), { id: session, message: p.message, device: p.device, sentAt: p.sentAt }).catch((e: unknown) => asleep(computer, e)),
    async deliver(computer, session, input) {
      try {
        const link = await o.transport.connect(device(computer));
        const fence = o.fence?.();
        return await link.request<{ disposition: Disposition; seq: number }>(SESSION_DELIVER, { id: session, input, ...(fence ? { fence } : {}) });
      } catch (e) {
        return asleep(computer, e);
      }
    },
  };
}

/** Takes other computers' session messages for lane D's host (`DurableSessionHost.deliver`), from paired computers only. */
export function mountSessionDelivery(
  transport: Pick<LinkTransport, "handle">,
  registry: Pick<FileDeviceRegistry, "get">,
  deliver: (session: string, input: DeliveredInput, from: string) => Promise<{ disposition: Disposition; seq: number }>,
  opts: { isStale?(epoch: number, scope?: string): boolean } = {},
): Unsubscribe {
  return transport.handle(SESSION_DELIVER, async (raw, from) => {
    const d = registry.get(from);
    if (!d || d.revokedAt !== undefined || !d.runsCore) throw new ContractError("refused", "only a paired computer delivers a session's message");
    const p = raw as { id?: unknown; input?: { from?: unknown; text?: unknown } } | undefined;
    if (typeof p?.id !== "string" || typeof p.input !== "object" || p.input === null) throw new ContractError("invalid", "link.session.deliver takes a session and an input");
    // An old main's message is refused, not taken late (H-M2's review).
    const fence = fenceOf(raw);
    if (fence && opts.isStale?.(fence.epoch, fence.scope)) throw new ContractError("not_main", "the message comes from a main computer that has since lost the lease", { fence });
    // Never the user's: a user's message comes only through `peer.session.send`, with its device's signature.
    if (typeof p.input.from !== "string" || !DELIVERED_FROM.has(p.input.from) || typeof p.input.text !== "string") throw new ContractError("invalid", "not a session's message");
    return deliver(p.id, p.input as DeliveredInput, from);
  });
}
