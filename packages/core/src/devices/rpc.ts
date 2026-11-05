// Lane H's methods and events of the protocol's devices area (packages/protocol/src/devices.ts), as handlers lane C's
// server mounts, in the shape lane D's are (`MethodContext`, `MethodHandler`). The server applies the allow lists and
// `userOnly` first; these check the caller again where they change something, and turn a sensitive change into a
// sealed card unless the user makes it in their own terminal (§5.5): a device's add (`device.pair.confirm`) and its
// revoke (`device.revoke`).
//
// Not here yet: `main.*` (the lease, H-M2), and the peer methods (`peer.*`, `sync.*`), which ride the link.
import {
  CLOVER_ERR, DEVICES_METHODS, ERR,
  type AccountView, type Caller, type ChangeResult, type DeviceView, type LinkView, type MethodSpec,
} from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { ApprovalBroker, ApprovalRequest } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { isContractError, RPC_ERROR_OF, type Unsubscribe } from "../contracts/common";
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

/** Opens a sealed card and hands back its id with the decision still to come. */
export type CardOpener = (req: ApprovalRequest) => Promise<{ card?: string; allowed: Promise<boolean> }>;

/** The opener over lane C's broker: the card's id comes from its `requested` event. */
export function brokerCardOpener(broker: Pick<ApprovalBroker, "request" | "watch">): CardOpener {
  return (req) => new Promise((resolve) => {
    let settled = false;
    let off: Unsubscribe = () => undefined;
    const allowed = broker.request(req).then((d) => d.allowed);
    off = broker.watch((e) => {
      if (settled || e.type !== "requested" || e.card.kind !== req.kind || e.card.change !== req.change) return;
      settled = true;
      off();
      resolve({ card: e.card.id, allowed });
    });
    void allowed.then(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({ allowed });
    });
  });
}

export interface DevicesMethodsDeps {
  registry: FileDeviceRegistry;
  pairing: PairingService;
  transport: Pick<LinkTransport, "links" | "watch">;
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
    [M.deviceList.name]: handler(M.deviceList, () => ({ devices: registry.list().map((d) => deviceView(d, registry.self().id, linkOf(deps.transport, d.id))) })),

    [M.deviceRename.name]: handler(M.deviceRename, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "rename a device");
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
        if (!(await opened.allowed)) throw new MethodError(ERR.INVALID_REQUEST, "refused");
        await pairing.confirm(p.pairingId, p.words, { terminal: true });
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

    [M.clockStatus.name]: handler(M.clockStatus, () => deps.clock.status()),

    [M.linkList.name]: handler(M.linkList, () => ({ links: deps.transport.links() })),
  };
}

function linkOf(t: Pick<LinkTransport, "links">, id: string): LinkView | undefined {
  return t.links().find((l) => l.peer === id);
}

export function deviceView(d: DeviceRecord, self: string, link: LinkView | undefined): DeviceView {
  // A phone that names no answer key answers with its own device key; how its OS holds that isn't recorded yet.
  const answers = answerKeyOf(d) === undefined ? undefined : { held: d.answerKey?.held ?? ("none" as const) };
  return {
    id: d.id, name: d.name, kind: d.kind, runsCore: d.runsCore, online: d.id === self || link?.up === true, isThis: d.id === self, isMain: false, addedAt: d.addedAt,
    ...(d.os ? { os: d.os } : {}), ...(d.computer ? { computer: d.computer } : {}), ...(d.hasDisplay !== undefined ? { hasDisplay: d.hasDisplay } : {}),
    ...(link ? { link } : {}), ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}), ...(answers ? { answers } : {}),
  };
}

/** The devices area's events, from the registry, the links, the pairings and the account. */
export function devicesEvents(
  deps: { registry: FileDeviceRegistry; transport: Pick<LinkTransport, "links" | "watch">; pairing: PairingService; account?: AccountClient; clock: { now(): number } },
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
