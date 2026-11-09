// `command.run` checks args against the command's schema for every caller before the handler runs (F-M3's review N4).
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../../contracts/common";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { toMethodError } from "../../rpc/handler";
import { runCommand, type RunnableCommand } from "../commands";

const COMMANDS: RunnableCommand[] = [
  {
    name: "tarot.draw", pluginId: "tarot", handler: "draw",
    args: { type: "object", required: ["cards"], properties: { cards: { type: "integer", minimum: 1, maximum: 3 }, spread: { enum: ["line", "cross"] } } },
  },
  { name: "tarot.shuffle", pluginId: "tarot", handler: "shuffle" },
];

function runner() {
  const calls: InvokeRequest[] = [];
  const o = {
    find: (name: string) => COMMANDS.find((c) => c.name === name),
    host: { invoke: async <R>(req: InvokeRequest) => { calls.push(req); return { drawn: req.args } as R; } },
  };
  return { o, calls };
}

const CALLERS: Caller[] = [
  { kind: "user", client: "app" },
  { kind: "user", client: "cli" },
  { kind: "session", sessionId: "s_1", sessionKind: "bot", bot: "luna" },
  { kind: "plugin", pluginId: "deck" },
  { kind: "core" },
];

describe("command.run", () => {
  test("args that fit reach the handler, with the caller", async () => {
    const { o, calls } = runner();
    expect(await runCommand(o, { name: "tarot.draw", args: { cards: 2, spread: "line" } }, CALLERS[0]!)).toEqual({ result: { drawn: { cards: 2, spread: "line" } } });
    expect(calls).toEqual([{ pluginId: "tarot", handler: "draw", args: { cards: 2, spread: "line" }, caller: CALLERS[0]! }]);
    expect(await runCommand(o, { name: "tarot.shuffle" }, CALLERS[0]!)).toEqual({ result: { drawn: {} } });
  });

  test("args that don't fit never reach the handler, for every caller: invalid_args with the path, never the value", async () => {
    const secret = "my-private-text";
    const bad: Array<[unknown, string, string]> = [
      [{ cards: 0 }, "/cards", "minimum"],
      [{ cards: 1.5 }, "/cards", "type"],
      [{ cards: secret }, "/cards", "type"],
      [{}, "/cards", "required"],
      [{ cards: 1, spread: secret }, "/spread", "enum"],
      [{ cards: 1, extra: secret }, "/extra", "additionalProperties"],
      [[secret], "", "type"],
    ];
    for (const caller of CALLERS) {
      for (const [args, path, keyword] of bad) {
        const { o, calls } = runner();
        const err = await runCommand(o, { name: "tarot.draw", args }, caller).then(() => undefined, (e: unknown) => e);
        expect([caller.kind, path, isContractError(err, "invalid_args")]).toEqual([caller.kind, path, true]);
        expect((err as { detail?: unknown }).detail).toEqual({ path, keyword });
        expect(JSON.stringify(err) + (err as Error).message).not.toContain(secret);
        expect(calls).toEqual([]);
      }
    }
    // A command with no schema takes no args.
    const { o, calls } = runner();
    const err = await runCommand(o, { name: "tarot.shuffle", args: { n: 1 } }, CALLERS[0]!).then(() => undefined, (e: unknown) => e);
    expect(isContractError(err, "invalid_args")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an unknown command is not_installed; invalid_args travels as invalid params with its path", async () => {
    const { o } = runner();
    const err = await runCommand(o, { name: "tarot.nope" }, CALLERS[0]!).then(() => undefined, (e: unknown) => e);
    expect(isContractError(err, "not_installed")).toBe(true);
    const bad = await runCommand(o, { name: "tarot.draw", args: { cards: 9 } }, CALLERS[0]!).then(() => undefined, (e: unknown) => e);
    const wire = toMethodError(bad);
    expect(wire.code).toBe(-32602);
    expect(wire.data).toEqual({ code: "invalid_args", path: "/cards", keyword: "maximum" });
  });
});
