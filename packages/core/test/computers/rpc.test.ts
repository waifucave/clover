// Lane J's computers methods for the app (computers/rpc.ts), bound to the real registry: a lone Mac lists itself; a
// lowering applies at once; a raise applies only from the user's own terminal (no card binds a call yet), never from
// the app; renames keep the old name as an alias; holds are listed with the user-working mark.
import { describe, expect, test } from "bun:test";
import { CLOVER_ERR, ERR, type Caller } from "@waifucave/clover-protocol";
import { computerMethods } from "../../src/computers/rpc";
import { CoreComputerRegistry } from "../../src/computers/registry";

const clock = { now: () => 1 };
const app: Caller = { kind: "user", client: "app" };
const cli: Caller = { kind: "user", client: "cli" };
const bot: Caller = { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" };

function make() {
  const registry = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" } });
  const m = computerMethods({ registry });
  const call = (method: string, params: unknown, caller: Caller = app) => m[method]!(params, { caller });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as { code?: number }).code);
  return { registry, call, code };
}

describe("computer.* for the app", () => {
  test("a lone Mac lists itself, and gets itself by name or old name; an unknown name is not found", async () => {
    const { registry, call, code } = make();
    const list = (await call("computer.list", {})) as { computers: { name: string; isMain: boolean }[] };
    expect(list.computers.map((c) => c.name)).toEqual(["Studio"]);
    expect(((await call("computer.get", { name: "Studio" })) as { computer: unknown }).computer).toEqual(registry.self());
    expect(await code(call("computer.get", { name: "Nowhere" }))).toBe(ERR.NOT_FOUND);
  });

  test("a lowering applies at once; a raise from the app is refused and changes nothing; from the terminal it applies", async () => {
    const { registry, call, code } = make();
    const start = registry.self().level;
    expect(await call("computer.setLevel", { name: "Studio", level: "read-only" })).toEqual({ applied: true });
    expect(registry.self().level).toBe("read-only");
    expect(await code(call("computer.setLevel", { name: "Studio", level: "automatic" }))).toBe(ERR.INVALID_REQUEST);
    expect(registry.self().level).toBe("read-only");
    expect(await call("computer.setLevel", { name: "Studio", level: start }, cli)).toEqual({ applied: true });
    expect(registry.self().level).toBe(start);
    // A peer's own variant (no name) isn't this door's.
    expect(await code(call("computer.setLevel", { level: "read-only" }))).toBe(ERR.INVALID_PARAMS);
  });

  test("a rename keeps the old name as an alias; a taken or bad name is refused", async () => {
    const { registry, call, code } = make();
    expect(await call("computer.rename", { name: "Studio", to: "Desk" })).toEqual({ applied: true });
    expect(registry.self()).toMatchObject({ name: "Desk", aliases: ["Studio"] });
    expect(((await call("computer.get", { name: "Studio" })) as { computer: { name: string } }).computer.name).toBe("Desk");
    expect(await code(call("computer.rename", { name: "Desk", to: "con" }))).not.toBe("ok");
  });

  test("hold.list gives the computer's holds and its user-working mark", async () => {
    const { registry, call } = make();
    expect(await call("hold.list", { computer: "Studio" })).toEqual({ holds: [], userWorking: false });
    const hold = registry.takeHold({ computer: "Studio", target: { kind: "app", app: "Safari" }, session: "s1", pluginId: "clover/cu" });
    registry.markUserWorking("Studio", "Notes");
    expect(await call("hold.list", { computer: "Studio" })).toEqual({ holds: [hold], userWorking: true });
  });

  test("only the user changes a computer", async () => {
    const { call, code } = make();
    expect(await code(call("computer.setLevel", { name: "Studio", level: "read-only" }, bot))).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(await code(call("computer.rename", { name: "Studio", to: "Desk" }, bot))).toBe(CLOVER_ERR.NOT_THE_USER);
  });
});
