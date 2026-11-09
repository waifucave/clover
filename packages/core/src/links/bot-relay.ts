// Lane D's `BotRelay` over the link (D-M2's ask; spec §6.4 "Messages, interrupts and the main computer"): how a
// message reaches a bot's conversation when it runs on another computer.
//
// * **The user's message** goes as `peer.session.send` (relay.ts), as its device sent it, signature and all; the
//   computer running the bot checks the signature and decides whether the turn is the user's.
// * **Another session's message** (a bot's `SendMessage`, a routine's result, an agent's report) goes as the link's own
//   `link.session.deliver`. The receiver takes it only from a paired computer, and only as what it says it is (a bot's
//   or a routine's message is never the user's: lane D's host keeps `originOf`):
//   - the request must be the protocol's own `link.session.deliver` (the schema, strict per kind), its `computer` the
//     link's own peer;
//   - its session must be a bot's: a bot's main conversation or one of its side threads, for a bot installed here
//     (`botDeliveryCheck`) — never an agent's, a coding session or anything else of the user's;
//   - a bot's message (`botSenderCheck`) names a session of its own: from its main conversation (`b_<bot>`), only the
//     computer that runs that bot sends it; from another session of the bot (a side thread, which may run elsewhere),
//     never another bot's main conversation.
// * Computers are named by their tree name (`DeviceRecord.computer`), as lane D's main computer names them.
import { DEVICES_METHODS, type SessionView } from "@waifucave/clover-protocol";
import { mainSessionIdFor, SESSION_ID_PREFIX } from "../sessions/ids";
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

/** `fence`: this computer's lease token (`MainLease.fence()`), stamped on every message it delivers for its bots.
 *  `self`: this computer's tree name, which the receiver checks against the link's peer. */
export function linkBotRelay(o: { transport: Pick<LinkTransport, "connect">; registry: Pick<FileDeviceRegistry, "list">; self: () => string; fence?: () => CallFence }): LinkBotRelay {
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
        return await link.request<{ disposition: Disposition; seq: number }>(SESSION_DELIVER, { id: session, computer: o.self(), input, ...(fence ? { fence } : {}) });
      } catch (e) {
        return asleep(computer, e);
      }
    },
  };
}

/** What the receiving side checks of a delivery beyond its shape: where it goes and who it says it's from. Throws. */
export type DeliveryCheck = (session: string, input: DeliveredInput, peer: { device: string; computer: string }) => void;

/** Lane D's check for the bots' host: only a bot's own sessions here take another computer's message, and a bot's
 *  message only from the computer running that bot. */
export function botDeliveryCheck(o: {
  host: { get(id: string): Pick<SessionView, "kind" | "bot"> | undefined };
  bots: { has(bot: string): boolean; computerFor(bot: string): string | undefined };
}): DeliveryCheck {
  return (session, input, peer) => {
    const view = o.host.get(session);
    // The same answer for a session that isn't here and one that isn't a bot's: nothing about what else is here.
    if (view === undefined || (view.kind !== "bot" && view.kind !== "side-thread") || view.bot === undefined || !o.bots.has(view.bot)) {
      throw new ContractError("refused", `${session} isn't a bot's conversation here`);
    }
    if (input.from === "bot") botSenderCheck(o.bots, input, peer.computer);
  };
}

/** A bot's message from another computer names a session of its own: from its main conversation only when that computer
 *  runs the bot (a bot this computer doesn't know runs nowhere it can tell, so that is refused too), and from one of its
 *  other sessions (a side thread, on whatever computer runs it) never another bot's main conversation. Throws. */
export function botSenderCheck(
  bots: { has(bot: string): boolean; computerFor(bot: string): string | undefined },
  input: { bot: string; session: string },
  computer: string,
): void {
  const own = mainSessionIdFor(input.bot);
  if (input.session === own) {
    const runner = bots.has(input.bot) ? bots.computerFor(input.bot) : undefined;
    if (runner === undefined || runner.toLowerCase() !== computer.toLowerCase()) throw new ContractError("refused", `${input.bot} doesn't run on ${computer}`);
  } else if (input.session.startsWith(SESSION_ID_PREFIX.bot)) {
    throw new ContractError("refused", `${input.session} isn't ${input.bot}'s`);
  }
}

/** Takes other computers' session messages for lane D's host (`DurableSessionHost.deliver`), from paired computers only. */
export function mountSessionDelivery(
  transport: Pick<LinkTransport, "handle">,
  registry: Pick<FileDeviceRegistry, "get">,
  deliver: (session: string, input: DeliveredInput, from: string) => Promise<{ disposition: Disposition; seq: number }>,
  opts: { isStale?(epoch: number, scope?: string): boolean; check?: DeliveryCheck } = {},
): Unsubscribe {
  return transport.handle(SESSION_DELIVER, async (raw, from) => {
    const d = registry.get(from);
    if (!d || d.revokedAt !== undefined || !d.runsCore) throw new ContractError("refused", "only a paired computer delivers a session's message");
    // Never the user's: a user's message comes only through `peer.session.send`, with its device's signature. The
    // input is exactly one of the protocol's kinds (strict: no field it doesn't name).
    const p = DEVICES_METHODS.linkSessionDeliver.params.safeParse(raw);
    if (!p.success || !DELIVERED_FROM.has(p.data.input.from)) throw new ContractError("invalid", "not a session's message");
    if (d.computer === undefined || d.computer.toLowerCase() !== p.data.computer.toLowerCase()) {
      throw new ContractError("refused", "the message names another computer than the one sending it");
    }
    // An old main's message is refused, not taken late (H-M2's review).
    const fence = fenceOf(raw);
    if (fence && opts.isStale?.(fence.epoch, fence.scope)) throw new ContractError("not_main", "the message comes from a main computer that has since lost the lease", { fence });
    const input = p.data.input as DeliveredInput;
    opts.check?.(p.data.id, input, { device: from, computer: d.computer });
    return deliver(p.data.id, input, from);
  });
}
