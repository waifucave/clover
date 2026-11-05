// Pins the ComputerRegistry contract through FakeComputerRegistry: names and aliases, levels, holds, the user-working
// mark, the action-running signal and Clover's windows.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { callBindingInput, cardHashInput, type Card, type Level } from "@waifucave/clover-protocol";
import type { CardRecord } from "../approval-broker";
import { isContractError } from "../common";
import { holdsOverlap, levelRaiseCall, type ComputerChange } from "../computer-registry";
import { FakeClock } from "../fakes/clock";
import { FakeComputerRegistry } from "../fakes/computer-registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

function setup() {
  return new FakeComputerRegistry({
    clock: new FakeClock(),
    self: { name: "Studio", device: "studio0000000000000" },
    others: [{ name: "Laptop1", device: "laptop000000000000", os: "windows", hasDisplay: true }],
  });
}

describe("FakeComputerRegistry", () => {
  test("new computers start at ask for risky actions", () => {
    const reg = setup();
    expect(reg.self()).toMatchObject({ name: "Studio", level: "ask-risky", state: "online", link: "self", aliases: [] });
    expect(reg.list().map((c) => c.name)).toEqual(["Studio", "Laptop1"]);
  });

  test("a renamed computer keeps its old name as an alias; names are unique letters, digits and hyphens", async () => {
    const reg = setup();
    await reg.rename("Laptop1", "Laptop-2");
    expect(reg.get("Laptop1")).toMatchObject({ name: "Laptop-2", aliases: ["Laptop1"] });
    expect(isContractError(await reg.rename("Studio", "Laptop-2").catch((e: unknown) => e), "conflict")).toBe(true);
    expect(isContractError(await reg.rename("Studio", "My Studio").catch((e: unknown) => e), "invalid")).toBe(true);
    expect(isContractError(err(() => reg.add({ name: "Laptop1", device: "x000000000000000" })), "conflict")).toBe(true);
  });

  test("a raise takes the approved card binding this computer and level, once; lowering takes nothing", async () => {
    const reg = setup();
    const refused = async (p: Promise<unknown>) => isContractError(await p.catch((e: unknown) => e), "refused");
    const record = (name: string, level: Level, over: Partial<CardRecord> = {}): CardRecord => {
      const { method, params } = levelRaiseCall(name, level);
      const unhashed = {
        id: `card_${name.toLowerCase()}${level.replace(/-/g, "")}`.padEnd(29, "0").slice(0, 29), kind: "change" as const, change: "computer-level" as const,
        computer: name, origin: "user" as const, issuedAt: 1, expiresAt: null, fields: {},
        options: [{ id: "approve", kind: "approve" as const, label: "Raise" }, { id: "deny", kind: "deny" as const, label: "Keep" }],
        binds: { computer: name, method, params: sha256(callBindingInput(method, params)) },
      };
      return { card: { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card, outcome: "approved", optionId: "approve", ...over };
    };
    expect(await refused(reg.setLevel("Studio", "automatic"))).toBe(true);
    // A card for another computer, another level, or a denied one is no proof.
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: record("Laptop1", "automatic") }))).toBe(true);
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: record("Studio", "accept-edits") }))).toBe(true);
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: record("Studio", "automatic", { outcome: "denied", optionId: "deny" }) }))).toBe(true);
    // A signed answer needs a device registry to check it, which this fake wasn't given.
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "signed", answer: { card: record("Studio", "automatic").card, option: "approve", device: "phone0000000000000", at: 1, signature: "AAAA" } }))).toBe(true);
    const good = record("Studio", "automatic");
    await reg.setLevel("Studio", "automatic", { via: "card", record: good });
    expect(reg.self().level).toBe("automatic");
    await reg.setLevel("Studio", "read-only");
    expect(reg.self().level).toBe("read-only");
    // The same card never raises twice.
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toBe(true);
    await reg.setLevel("Studio", "ask", { via: "terminal" });
    expect(reg.self().level).toBe("ask");
  });

  test("holds: an app hold and a window hold of it conflict across sessions; two windows don't", () => {
    const reg = setup();
    const hold = reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" });
    const e = err(() => reg.takeHold({ computer: "Studio", target: { kind: "window", app: "Figma", window: "Design" }, session: "s_b", pluginId: "opensky" }));
    expect(isContractError(e, "held")).toBe(true);
    expect((e as { detail: unknown }).detail).toEqual({ holder: "s_a", hold: hold.id });
    expect(reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" }).id).toBe(hold.id);
    reg.takeHold({ computer: "Studio", target: { kind: "window", app: "Safari", window: "One" }, session: "s_a", pluginId: "opensky" });
    reg.takeHold({ computer: "Studio", target: { kind: "window", app: "Safari", window: "Two" }, session: "s_b", pluginId: "opensky" });
    expect(reg.holds("Studio")).toHaveLength(3);
    expect(holdsOverlap({ kind: "window", app: "A", window: "1" }, { kind: "window", app: "A", window: "1" })).toBe(true);
    expect(holdsOverlap({ kind: "app", app: "A" }, { kind: "app", app: "B" })).toBe(false);
  });

  test("every session lets go at its turn end", () => {
    const reg = setup();
    reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" });
    reg.takeHold({ computer: "Laptop1", target: { kind: "app", app: "Excel" }, session: "s_a", pluginId: "opensky" });
    reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Mail" }, session: "s_b", pluginId: "opensky" });
    expect(reg.releaseSession("s_a")).toBe(2);
    expect(reg.holds().map((h) => h.session)).toEqual(["s_b"]);
  });

  test("the user's work in an app refuses a hold until their message or a card answer lifts the mark", () => {
    const reg = setup();
    reg.markUserWorking("Studio", "Figma");
    expect(isContractError(err(() => reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" })), "user_working")).toBe(true);
    reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Mail" }, session: "s_a", pluginId: "opensky" });
    reg.releaseSession("s_a");
    expect(reg.userWorking("Studio")).toEqual(["Figma"]);
    reg.liftUserWorking("Studio");
    expect(reg.userWorking("Studio")).toEqual([]);
    reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" });
  });

  test("an offline computer refuses a hold at once", () => {
    const reg = setup();
    reg.setOnline("Laptop1", false);
    expect(isContractError(err(() => reg.takeHold({ computer: "Laptop1", target: { kind: "app", app: "Excel" }, pluginId: "opensky" })), "computer_offline")).toBe(true);
  });

  test("the action-running signal and Clover's windows, per computer", () => {
    const reg = setup();
    const changes: ComputerChange[] = [];
    reg.watch((c) => changes.push(c));
    reg.setActionRunning("Studio", true);
    reg.setActionRunning("Studio", true);
    expect(reg.isActionRunning("Studio")).toBe(true);
    expect(reg.isActionRunning("Laptop1")).toBe(false);
    reg.setActionRunning("Studio", false);
    expect(changes).toEqual([{ type: "action-running", computer: "Studio", running: true }, { type: "action-running", computer: "Studio", running: false }]);
    reg.setCloverWindows("Studio", [{ id: "main", x: 0, y: 0, width: 800, height: 600 }]);
    expect(reg.cloverWindows("Studio")).toEqual([{ id: "main", x: 0, y: 0, width: 800, height: 600 }]);
    expect(reg.cloverWindows("Laptop1")).toEqual([]);
  });
});
