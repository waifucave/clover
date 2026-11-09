// Lane H's methods and events of the protocol's devices area (packages/protocol/src/devices.ts), as handlers lane C's
// server mounts, in the shape lane D's are (`MethodContext`, `MethodHandler`). The server applies the allow lists and
// `userOnly` first; these check the caller again where they change something, and turn a sensitive change into a
// sealed card unless the user makes it in their own terminal (§5.5): a device's add (`device.pair.confirm`) and its
// revoke (`device.revoke`).
//
// The main computer's methods (`main.get`, `main.set`, `main.handOver`, H-M2) are here too. Choosing the main is a
// sensitive change (§5.5): a sealed card unless the user is in their own terminal. Choosing another computer asks that
// computer, which shows its own card (`mountMainChoiceRequests`), since its main choice is its own to take. The peer
// methods (`peer.*`, `sync.*`) ride the link and aren't here.
import {
  CLOVER_ERR, DEVICES_METHODS, ERR,
  type AccountView, type Caller, type ChangeResult, type DeviceView, type LinkView, type MethodSpec,
} from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { ApprovalBroker, ApprovalRequest } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, isContractError, RPC_ERROR_OF, type Unsubscribe } from "../contracts/common";
import type { MainComputerHandle } from "../lease/main";
import { renameRemote } from "../links/relay";
import { answerKeyOf, type DeviceRecord } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { AccountClient } from "../identity/account";
import type { PairingService, PairingState } from "../links/pairing";
import { type RevokeOptions, revokeDevice } from "./account-devices";
import type { FileDeviceRegistry } from "./registry";

/** A JSON-RPC failure with the code a client branches on (lane D's shape). Its message never holds a secret. */
export class MethodError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "MethodError";
  }
}

export interface MethodContext {
  caller: Caller;
}

export type MethodHandler = (params: unknown, ctx: MethodContext) => Promise<unknown>;

function toMethodError(err: unknown): MethodError {
  if (err instanceof MethodError) return err;
  if (isContractError(err)) {
    const code = RPC_ERROR_OF[err.code] ?? ({ not_found: ERR.NOT_FOUND, invalid: ERR.INVALID_PARAMS } as Record<string, number>)[err.code] ?? ERR.INVALID_REQUEST;
    return new MethodError(code, err.message, { code: err.code });
  }
  return new MethodError(ERR.INTERNAL, err instanceof Error ? err.message : "failed");
}

function handler<S extends MethodSpec>(spec: S, impl: (params: z.output<S["params"]>, ctx: MethodContext) => Promise<z.input<S["result"]>> | z.input<S["result"]>): MethodHandler {
  return async (raw, ctx) => {
    const parsed = spec.params.safeParse(raw);
    if (!parsed.success) throw new MethodError(ERR.INVALID_PARAMS, `${spec.name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    try {
      return await impl(parsed.data as z.output<S["params"]>, ctx);
    } catch (err) {
      throw toMethodError(err);
    }
  };
}

function requireUser(ctx: MethodContext, what: string): void {
  if (ctx.caller.kind !== "user") throw new MethodError(CLOVER_ERR.NOT_THE_USER, `only the user can ${what}`);
}

/** The user in their own terminal (§5.1): a sensitive change there needs no card. */
const inTerminal = (ctx: MethodContext): boolean => ctx.caller.kind === "user" && ctx.caller.client === "cli";

/** What a device added by a card records when the broker answered before giving the card's id. */
export const UNNAMED_CARD = "card:unnamed";

/** Opens a sealed card and hands back its id with the decision still to come. */
/** Opens a card. `checked` is the children the answer checked, for a card with a checkbox per child (the group's
 *  cards: the computers to invite, the keys to keep). */
export type CardOpener = (req: ApprovalRequest) => Promise<{ card?: string; allowed: Promise<boolean>; checked?: Promise<readonly string[]> }>;

/** The opener over lane C's broker: the card's id comes from its `requested` event, the checked children from its
 *  `resolved` one. */
export function brokerCardOpener(broker: Pick<ApprovalBroker, "request" | "watch">): CardOpener {
  return (req) => new Promise((resolve) => {
    let settled = false;
    let cardId: string | undefined;
    let gotChecked: (c: readonly string[]) => void = () => undefined;
    const checked = new Promise<readonly string[]>((r) => (gotChecked = r));
    // The card is this request's own (`onCard`, INT #353's nit): never the first card of the same kind and change,
    // which a second change at the same time would raise too.
    const off: Unsubscribe = broker.watch((e) => {
      if (e.type === "resolved" && cardId !== undefined && e.cardId === cardId) {
        gotChecked(e.children ?? []);
        off();
      }
    });
    let allowed: Promise<boolean> = Promise.resolve(false);
    allowed = broker.request(req, {
      onCard: (id) => {
        if (settled) return;
        settled = true;
        cardId = id;
        resolve({ card: id, allowed, checked });
      },
    }).then((d) => d.allowed);
    void allowed.finally(() => {
      if (!settled) {
        settled = true;
        resolve({ allowed, checked });
      }
      // A card decided without a resolved event that names it (a level, a rule) checked nothing.
      setTimeout(() => {
        gotChecked([]);
        off();
      }, 0);
    }).catch(() => undefined);
  });
}

export interface DevicesMethodsDeps {
  registry: FileDeviceRegistry;
  pairing: PairingService;
  transport: Pick<LinkTransport, "links" | "watch" | "connect">;
  /** The main computer (the links' `main`); without it `main.*` answer that there's no lease here. */
  main?: Pick<MainComputerHandle, "lease" | "coordinator">;
  account?: AccountClient;
  clock: Clock;
  openCard: CardOpener;
  /** What revocation's fan-out needs beyond the registry. */
  revoke: Omit<RevokeOptions, "registry">;
}

export function devicesMethods(deps: DevicesMethodsDeps): Record<string, MethodHandler> {
  const M = DEVICES_METHODS;
  const { registry, pairing } = deps;
  const changeCard = (change: "device-add" | "device-revoke", what: string, device: string): ApprovalRequest => ({
    kind: "change", origin: "user", computers: [], effect: "other", change,
    fields: { title: { type: "text", text: what }, detail: { type: "list", items: [device] } },
  });

  return {
    [M.deviceList.name]: handler(M.deviceList, () => {
      const main = deps.main?.lease.state().main ?? null;
      return { devices: registry.list().map((d) => deviceView(d, registry.self().id, linkOf(deps.transport, d.id), d.id === main)) };
    }),

    [M.deviceRename.name]: handler(M.deviceRename, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "rename a device");
      const d = registry.get(p.id);
      if (!d || d.revokedAt !== undefined) throw new MethodError(ERR.NOT_FOUND, `no device ${p.id}`);
      // Another computer's name is its own: the rename goes to it, and it tells everyone (S4 of H-M1's review).
      if (d.runsCore && p.id !== registry.self().id) {
        try {
          await renameRemote(deps.transport, p.id, p.name);
        } catch (err) {
          if (isContractError(err, "offline")) throw new MethodError(CLOVER_ERR.COMPUTER_OFFLINE, `${d.name} is offline: rename it while it's on`);
          throw err;
        }
        return { applied: true };
      }
      await registry.rename(p.id, p.name);
      return { applied: true };
    }),

    [M.deviceRevoke.name]: handler(M.deviceRevoke, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "revoke a device");
      const d = registry.get(p.id);
      if (!d || d.revokedAt !== undefined) throw new MethodError(ERR.NOT_FOUND, `no device ${p.id}`);
      if (p.id === registry.self().id) throw new MethodError(ERR.INVALID_REQUEST, "this device can't revoke itself");
      const run = () => revokeDevice({ registry, ...deps.revoke }, p.id, "revoked by the user");
      if (inTerminal(ctx)) {
        await run();
        return { applied: true };
      }
      const opened = await deps.openCard(changeCard("device-revoke", `Revoke ${d.name}?`, `${d.name} (${d.kind})`));
      if (!opened.card) {
        if (!(await opened.allowed)) throw new MethodError(ERR.INVALID_REQUEST, "refused");
        await run();
        return { applied: true };
      }
      void opened.allowed.then((ok) => (ok ? run() : undefined)).catch(() => undefined);
      return { applied: false, card: opened.card };
    }),

    [M.devicePairBegin.name]: handler(M.devicePairBegin, async (_p, ctx) => {
      requireUser(ctx, "pair a device");
      return pairing.begin();
    }),

    [M.devicePairJoin.name]: handler(M.devicePairJoin, async (p, ctx) => {
      requireUser(ctx, "pair a device");
      return pairing.join(p.code);
    }),

    [M.devicePairConfirm.name]: handler(M.devicePairConfirm, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "pair a device");
      const state = pairing.get(p.pairingId);
      if (!state) throw new MethodError(ERR.NOT_FOUND, `no pairing ${p.pairingId}`);
      if (inTerminal(ctx)) {
        await pairing.confirm(p.pairingId, p.words, { terminal: true });
        return { applied: true };
      }
      const name = state.peer ? `${state.peer.name} (${state.peer.kind})` : "a device";
      const opened = await deps.openCard(changeCard("device-add", `Add ${state.peer?.name ?? "this device"}?`, name));
      if (!opened.card) {
        // Answered before its id was known: still a card's answer, never the user's terminal.
        if (!(await opened.allowed)) throw new MethodError(ERR.INVALID_REQUEST, "refused");
        await pairing.confirm(p.pairingId, p.words, { card: UNNAMED_CARD, allowed: Promise.resolve(true) });
        return { applied: true };
      }
      void pairing.confirm(p.pairingId, p.words, { card: opened.card, allowed: opened.allowed }).catch(() => undefined);
      return { applied: false, card: opened.card };
    }),

    [M.devicePairCancel.name]: handler(M.devicePairCancel, async (p, ctx) => {
      requireUser(ctx, "cancel a pairing");
      await pairing.cancel(p.pairingId);
      return { ok: true as const };
    }),

    [M.accountStatus.name]: handler(M.accountStatus, async (): Promise<AccountView> => (deps.account ? deps.account.status() : { signedIn: false })),

    [M.accountSignIn.name]: handler(M.accountSignIn, async (p, ctx) => {
      requireUser(ctx, "sign in");
      if (!deps.account) throw new MethodError(ERR.INVALID_REQUEST, "accounts aren't set up on this computer");
      const { url, done } = await deps.account.startSignIn(p.provider);
      void done.catch(() => undefined);
      return { url };
    }),

    [M.accountSignOut.name]: handler(M.accountSignOut, async (_p, ctx) => {
      requireUser(ctx, "sign out");
      await deps.account?.signOut();
      return { ok: true as const };
    }),

    // TODO(H-M3, lane B's heldBy): once lane B's follow-up (lane/b-m1-followups, fd143e92e) is on main, `LeaseView` has
    // `heldBy`: fill it here and in `lease_changed` below, from this computer's registry: `self` for this device, a
    // known computer by its name, `unknown` for a holder it doesn't know (not paired yet, or removed), null with none.
    [M.mainGet.name]: handler(M.mainGet, () => ({ lease: mustMain(deps).lease.state() })),

    [M.mainSet.name]: handler(M.mainSet, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "choose the main computer");
      const main = mustMain(deps);
      const d = registry.get(p.device);
      if (!d || d.revokedAt !== undefined) throw new MethodError(ERR.NOT_FOUND, `no device ${p.device}`);
      if (!d.runsCore) throw new MethodError(ERR.INVALID_PARAMS, `${d.name} doesn't run Clover's core, so it can't be the main computer`);
      if (p.device !== registry.self().id) {
        // That computer's choice is its own: it shows its own card (any of the user's devices may answer it).
        try {
          const link = await deps.transport.connect(p.device);
          return await link.request<ChangeResult>(MAIN_CHOOSE, {});
        } catch (err) {
          if (isContractError(err, "offline")) throw new MethodError(CLOVER_ERR.COMPUTER_OFFLINE, `${d.name} is offline: choose it while it's on`);
          throw err;
        }
      }
      return chooseHere(main, deps.openCard, d.name, inTerminal(ctx));
    }),

    [M.mainHandOver.name]: handler(M.mainHandOver, async (_p, ctx) => {
      requireUser(ctx, "hand the bots over");
      return mustMain(deps).coordinator.handOver();
    }),

    [M.clockStatus.name]: handler(M.clockStatus, () => deps.clock.status()),

    [M.linkList.name]: handler(M.linkList, () => ({ links: deps.transport.links() })),
  };
}

/** The link's own request asking this computer to become the main one: it shows its own card first. */
export const MAIN_CHOOSE = "link.lease.choose";

function mustMain(deps: Pick<DevicesMethodsDeps, "main">): NonNullable<DevicesMethodsDeps["main"]> {
  if (!deps.main) throw new MethodError(ERR.INVALID_REQUEST, "there's no main computer on this daemon");
  return deps.main;
}

const mainCard = (name: string): ApprovalRequest => ({
  kind: "change", origin: "user", computers: [], effect: "other", change: "main-computer",
  fields: { title: { type: "text", text: `Make ${name} the main computer?` }, detail: { type: "list", items: [name] } },
});

/** Makes this computer the main one: at once from the user's terminal, otherwise once its card is approved. */
async function chooseHere(main: NonNullable<DevicesMethodsDeps["main"]>, openCard: CardOpener, name: string, terminal: boolean): Promise<ChangeResult> {
  if (terminal) {
    await main.coordinator.chooseSelf();
    return { applied: true };
  }
  const opened = await openCard(mainCard(name));
  if (!opened.card) {
    if (!(await opened.allowed)) throw new MethodError(ERR.INVALID_REQUEST, "refused");
    await main.coordinator.chooseSelf();
    return { applied: true };
  }
  void opened.allowed.then((ok) => (ok ? main.coordinator.chooseSelf() : undefined)).catch(() => undefined);
  return { applied: false, card: opened.card };
}

/** Takes another computer's request that this one become the main computer (the user chose it there): this computer
 *  shows its own sealed card, since a peer's word never makes the choice by itself (review N7, `main-computer`). */
export function mountMainChoiceRequests(o: {
  transport: Pick<LinkTransport, "handle">; registry: FileDeviceRegistry; main: NonNullable<DevicesMethodsDeps["main"]>; openCard: CardOpener;
}): Unsubscribe {
  return o.transport.handle(MAIN_CHOOSE, async (_raw, from) => {
    const d = o.registry.get(from);
    if (!d || d.revokedAt !== undefined || !d.runsCore) throw new ContractError("refused", "only a paired computer asks");
    const self = o.registry.self();
    return chooseHere(o.main, o.openCard, self.name, false);
  });
}

function linkOf(t: Pick<LinkTransport, "links">, id: string): LinkView | undefined {
  return t.links().find((l) => l.peer === id);
}

export function deviceView(d: DeviceRecord, self: string, link: LinkView | undefined, isMain = false): DeviceView {
  // A phone that names no answer key answers with its own device key; how its OS holds that isn't recorded yet.
  // A phone answers with its own answer key only, never its link key (item 91).
  const answers = answerKeyOf(d) === undefined || (d.kind === "phone" && d.answerKey === undefined) ? undefined : { held: d.answerKey?.held ?? ("none" as const) };
  return {
    id: d.id, name: d.name, kind: d.kind, runsCore: d.runsCore, online: d.id === self || link?.up === true, isThis: d.id === self, isMain, addedAt: d.addedAt,
    ...(d.os ? { os: d.os } : {}), ...(d.computer ? { computer: d.computer } : {}), ...(d.hasDisplay !== undefined ? { hasDisplay: d.hasDisplay } : {}),
    ...(link ? { link } : {}), ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}), ...(answers ? { answers } : {}),
  };
}

/** The devices area's events, from the registry, the links, the pairings and the account. */
export function devicesEvents(
  deps: { registry: FileDeviceRegistry; transport: Pick<LinkTransport, "links" | "watch">; pairing: PairingService; account?: AccountClient; clock: { now(): number }; main?: Pick<MainComputerHandle, "lease"> },
  emit: (event: Record<string, unknown> & { type: string; ts: number }) => void,
): Unsubscribe {
  const ts = () => deps.clock.now();
  const self = deps.registry.self().id;
  const offs: Unsubscribe[] = [];
  offs.push(deps.registry.watch((c) => {
    if (c.type === "revoked") emit({ type: "device_removed", ts: ts(), id: c.id, revoked: true });
    else emit({ type: "device_changed", ts: ts(), device: deviceView(c.device, self, linkOf(deps.transport, c.device.id)) });
  }));
  offs.push(deps.transport.watch((link) => {
    emit({ type: "link_changed", ts: ts(), link });
    const d = deps.registry.get(link.peer);
    if (d && d.revokedAt === undefined) emit({ type: "device_changed", ts: ts(), device: deviceView(d, self, link) });
  }));
  offs.push(deps.pairing.watch((c) => {
    if (c.type !== "changed") return;
    const step = pairingStep(c.pairing);
    emit({
      type: "pairing_changed", ts: ts(), pairingId: c.pairing.view.pairingId, step,
      ...(step === "words" && c.pairing.view.words ? { words: c.pairing.view.words } : {}),
      ...(c.pairing.error ? { reason: c.pairing.error } : {}),
    });
  }));
  if (deps.account) offs.push(deps.account.watch((account) => emit({ type: "account_changed", ts: ts(), account })));
  if (deps.main) {
    let last = "";
    offs.push(deps.main.lease.watch((lease) => {
      const key = JSON.stringify(lease);
      if (key === last) return;
      last = key;
      // TODO(H-M3, lane B's heldBy): `heldBy` as in `main.get` once B's follow-up is on main.
      emit({ type: "lease_changed", ts: ts(), lease });
    }));
  }
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

function pairingStep(p: PairingState): "waiting" | "words" | "card" | "done" | "failed" | "expired" {
  switch (p.status) {
    case "waiting": return "waiting";
    case "words": return "words";
    case "confirmed": return "card";
    case "paired": return "done";
    case "cancelled": return "failed";
    case "failed": return p.error === "expired" ? "expired" : "failed";
  }
}
