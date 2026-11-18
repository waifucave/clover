// The ToolSettings conformance suite (spec revision 19, §6.7, G10). `runToolSettingsConformance(make)` registers every
// case against the implementation `make` builds; `tests/tool-settings.test.ts` runs it against FakeToolSettings, and lane
// TS runs it against the engine's. What it pins: the declared default, a server-wide value and a tool added later, the
// two values side by side, and what a bot or an agent gets.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import type { FakeToolSettings } from "../fakes/tool-settings";

export type ToolSettingsHarness = Pick<FakeToolSettings, keyof FakeToolSettings>;
export type ToolSettingsFactory = () => ToolSettingsHarness;

export function runToolSettingsConformance(make: ToolSettingsFactory): void {
  describe("ToolSettings", () => {
    test("with nothing stored: what the plugin declares, and ask", () => {
      const s = make();
      s.declare("blender", { Render: "preload", Export: "on-demand" });
      expect(s.list()).toEqual([
        { server: "blender", tool: "Export", declared: "on-demand", availability: "on-demand", permission: "ask" },
        { server: "blender", tool: "Render", declared: "preload", availability: "always", permission: "ask" },
      ]);
    });

    test("a whole server's value covers the tools it lists now; one added later starts at its own default", () => {
      const s = make();
      s.declare("blender", { Render: "preload", Export: "on-demand" });
      s.setAvailability("blender", undefined, "off");
      s.declare("blender", { Render: "preload", Export: "on-demand", Bake: "preload" });
      expect(s.list().map((r) => [r.tool, r.availability])).toEqual([["Bake", "always"], ["Export", "off"], ["Render", "off"]]);
      expect(isContractError((() => { try { s.setAvailability("blender", "Nope", "off"); } catch (e) { return e; } })(), "not_found")).toBe(true);
      expect(isContractError((() => { try { s.setPermission("ghost", undefined, "deny"); } catch (e) { return e; } })(), "not_found")).toBe(true);
    });

    test("availability and permission sit side by side, each its own", () => {
      const s = make();
      s.declare("blender", { Render: "preload" });
      const heard: string[] = [];
      s.watch((r) => heard.push(`${r.availability}/${r.permission}`));
      s.setPermission("blender", "Render", "deny");
      expect(s.exposure("blender", "Render", {})).toBe("preloaded");
      s.setAvailability("blender", "Render", "off");
      expect(s.row("blender", "Render")).toMatchObject({ availability: "off", permission: "deny" });
      expect(heard).toEqual(["always/deny", "off/deny"]);
    });

    test("what a session gets: off hidden, always preloaded, on demand behind Glossary or an agent's own tool search", () => {
      const s = make();
      s.declare("blender", { Render: "preload", Export: "on-demand", Bake: "on-demand" });
      s.setAvailability("blender", "Bake", "off");
      expect(s.exposure("blender", "Render", {})).toBe("preloaded");
      expect(s.exposure("blender", "Export", {})).toBe("glossary");
      expect(s.exposure("blender", "Export", { agent: { toolSearch: false } })).toBe("glossary");
      expect(s.exposure("blender", "Export", { agent: { toolSearch: true } })).toBe("agent-search");
      expect(s.exposure("blender", "Export", { agent: { toolSearch: false, holdsBack: false } })).toBe("preloaded");
      expect(s.exposure("blender", "Bake", { agent: { toolSearch: true } })).toBe("hidden");
      expect(s.exposure("blender", "Missing", {})).toBe("hidden");
    });
  });
}
