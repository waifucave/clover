import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { chooseTarget, memoryOf, pillTargets, storageMemory, targetId, type PillBot, type PillTargetEntry } from "../src/model/targets";
import { BarMenus } from "../src/ui/Bar";
import { PillApp, PillHostContext, type PillHost } from "../src/ui/host";
import manifest from "../clover.json" with { type: "json" };
import * as client from "../client/index";

const BOTS: PillBot[] = [
  { id: "alpha", name: "Alpha", color: "#B9A6FF" },
  { id: "luna", name: "Luna", color: "#7FD6C2" },
];
const ENTRIES: PillTargetEntry[] = [
  { pluginId: "home", pluginName: "Home", id: "lights", title: "Lights", order: 600 },
  { pluginId: "blender", pluginName: "Blender", id: "scene", title: "Scene" },
  { pluginId: "agents", pluginName: "Agents", id: "codex", title: "Codex" },
];

describe("the pill's targets", () => {
  test("bots first in their order, then the plugins' targets in the spot's order", () => {
    const targets = pillTargets(BOTS, ENTRIES);
    expect(targets.map((t) => [t.id, t.name, t.detail])).toEqual([
      ["bot:alpha", "Alpha", undefined],
      ["bot:luna", "Luna", undefined],
      ["plugin:agents#codex", "Codex", "Agents"],
      ["plugin:blender#scene", "Scene", "Blender"],
      ["plugin:home#lights", "Lights", "Home"],
    ]);
    expect(targets[2]!.ref).toEqual({ kind: "plugin", pluginId: "agents", entry: "codex" });
    // A bot and an entry of the same name never share an id.
    expect(targetId({ kind: "bot", bot: "codex" })).not.toBe(targetId({ kind: "plugin", pluginId: "codex", entry: "codex" }));
  });

  test("the remembered target while it exists, else the first bot, else the first target", () => {
    const targets = pillTargets(BOTS, ENTRIES);
    expect(chooseTarget(targets, "plugin:home#lights")?.name).toBe("Lights");
    expect(chooseTarget(targets, "bot:gone")?.name).toBe("Alpha");
    expect(chooseTarget(pillTargets([], ENTRIES), null)?.name).toBe("Codex");
    expect(chooseTarget([], null)).toBeNull();
  });

  test("the memory survives blocked storage, and forgets nothing it was told while it runs", () => {
    const blocked = storageMemory(() => {
      throw new Error("blocked");
    });
    expect(blocked.get()).toBeNull();
    blocked.set("bot:luna");
    expect(blocked.get()).toBe("bot:luna");
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    const kept = storageMemory(() => fake);
    kept.set("plugin:home#lights");
    expect(storageMemory(() => fake).get()).toBe("plugin:home#lights");
  });

  test("the menu: the plugins' targets after the bots, under a hairline, with their plugin's name", () => {
    const targets = pillTargets(BOTS, ENTRIES);
    const { container } = render(<BarMenus menu="targets" target={targets[0]!} targets={targets} width={420} />);
    const items = [...container.querySelectorAll(".clp-menu-item")];
    expect(items.map((i) => i.textContent)).toEqual(["AAlpha", "LLuna", "CCodexAgents", "SSceneBlender", "LLightsHome"]);
    expect(container.querySelectorAll(".clp-menu-divider")).toHaveLength(1);
    expect(container.querySelector(".clp-menu-divider")?.nextElementSibling?.textContent).toBe("CCodexAgents");
  });
});

describe("PillApp, the app.surface entry", () => {
  test("messages the remembered target; picking another remembers it; a send goes to the one shown", async () => {
    const send = mock((_ref: unknown, _text: string) => {});
    const memory = memoryOf("bot:luna");
    const host: PillHost = { bots: BOTS, targets: ENTRIES, memory, send };
    const { container } = render(
      <PillHostContext.Provider value={host}>
        <PillApp props={{ surface: "pill" }} />
      </PillHostContext.Provider>,
    );
    expect(container.querySelector(".clp-portrait")?.textContent).toBe("L");
    const field = container.querySelector("textarea")!;
    act(() => {
      fireEvent.change(field, { target: { value: "dim the lights" } });
    });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([{ kind: "bot", bot: "luna" }, "dim the lights"]);
    // Pick a plugin's target from the menu.
    act(() => {
      fireEvent.click(container.querySelector(".clp-portrait")!.closest("button")!);
    });
    act(() => {
      fireEvent.click(screen.getByText("Scene").closest("button")!);
    });
    expect(memory.get()).toBe("plugin:blender#scene");
    expect(container.querySelector(".clp-portrait")?.textContent).toBe("S");
    act(() => {
      fireEvent.change(field, { target: { value: "render it" } });
    });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(send.mock.calls[1]).toEqual([{ kind: "plugin", pluginId: "blender", entry: "scene" }, "render it"]);
  });

  test("without a host or any target it draws nothing", () => {
    expect(render(<PillApp props={{ surface: "pill" }} />).container.innerHTML).toBe("");
    const host: PillHost = { bots: [], memory: memoryOf(), send: () => {} };
    expect(
      render(
        <PillHostContext.Provider value={host}>
          <PillApp props={{ surface: "pill" }} />
        </PillHostContext.Provider>,
      ).container.innerHTML,
    ).toBe("");
  });

  test("the manifest names PillApp, an export of the client entry", () => {
    for (const entry of manifest.contributes.ui) expect(typeof (client as Record<string, unknown>)[entry.component]).toBe("function");
    expect(manifest.capabilities).toEqual(["approvals", "bots.read", "conversation.post"]);
  });
});
