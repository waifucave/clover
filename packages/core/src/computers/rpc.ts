// Lane J's computers methods for the app, the CLI and layers (packages/protocol/src/computers.ts: `computer.list`,
// `computer.get`, `computer.setLevel`, `computer.rename`, `hold.list`), bound to the computer registry the node keeps
// (registry.ts). On a lone Mac the list is this computer; the others join it as their links come up. The server applies
// the allow lists and `userOnly` first; these check the caller again where they change something.
//
// * A level's lowering applies at once. A raise takes proof (§5.5, `LevelRaiseProof`): the user's own terminal
//   (`terminal`), or the approved card that binds `computer.setLevel` for this computer and level. Lane C's broker
//   doesn't bind a card to a call yet, so a raise from anywhere but the terminal is refused for now, never applied.
// * Another computer's level changes on that computer (§8.5): the registry sends a lowering there, and refuses a raise
//   that carries no answer signed for that computer's own card.
// * A peer's own `computer.setLevel` (its level, with no name) rides the link (peers.ts), never this door.
import { COMPUTERS_METHODS, ERR, levelAbove, type ChangeResult } from "@waifucave/clover-protocol";
import type { ComputerRegistry } from "../contracts/computer-registry";
import { MethodError, handler, requireUser, type MethodContext, type MethodHandler } from "../rpc/handler";

export interface ComputerMethodsDeps {
  registry: Pick<ComputerRegistry, "list" | "get" | "setLevel" | "rename" | "holds" | "userWorking">;
}

/** The user in their own terminal (§5.1): a raise there needs no card. */
const inTerminal = (ctx: MethodContext): boolean => ctx.caller.kind === "user" && ctx.caller.client === "cli";

export function computerMethods(deps: ComputerMethodsDeps): Record<string, MethodHandler> {
  const M = COMPUTERS_METHODS;
  const { registry } = deps;
  const must = (name: string) => {
    const c = registry.get(name);
    if (!c) throw new MethodError(ERR.NOT_FOUND, `no computer ${name}`);
    return c;
  };
  return {
    [M.computerList.name]: handler(M.computerList, () => ({ computers: registry.list() })),

    [M.computerGet.name]: handler(M.computerGet, (p) => ({ computer: must(p.name) })),

    [M.computerSetLevel.name]: handler(M.computerSetLevel, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "change a computer's level");
      if (!("name" in p)) throw new MethodError(ERR.INVALID_PARAMS, "computer.setLevel names the computer");
      const c = must(p.name);
      if (levelAbove(p.level, c.level)) {
        if (!inTerminal(ctx)) {
          throw new MethodError(ERR.INVALID_REQUEST, `raising ${c.name}'s level takes the user's answer on its card, which this version can't open yet: raise it from your terminal`);
        }
        await registry.setLevel(c.name, p.level, { via: "terminal" });
        return { applied: true };
      }
      await registry.setLevel(c.name, p.level);
      return { applied: true };
    }),

    [M.computerRename.name]: handler(M.computerRename, async (p, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "rename a computer");
      await registry.rename(must(p.name).name, p.to);
      return { applied: true };
    }),

    [M.holdList.name]: handler(M.holdList, (p) => {
      const c = must(p.computer);
      return { holds: registry.holds(c.name), userWorking: registry.userWorking(c.name).length > 0 };
    }),
  };
}
