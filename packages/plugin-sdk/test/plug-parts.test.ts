// Inside the bot and beside it (§5.5, the owner's rule of November 14): what the parts of a plugin with a bot are, and
// the OK card's lines for them. A plugin in the shape of before (Alpha's, a bot-built one with flat `ui` entries) keeps
// the meaning and the lines its OK showed; the new fields add lines of their own.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { botPartLines, describeOk, partScopeOf, pluginParts, skillItem, validateManifest } from "../src/index";

const ALPHA = JSON.parse(readFileSync(join(import.meta.dir, "../../../plugins/alpha/clover.json"), "utf8")) as Record<string, unknown>;
const engines = { clover: "^1.0.0" };

describe("a plugin in today's shape keeps its meaning and its OK lines", () => {
  test("Alpha: her UI, her stage server (scope `own-bot`), skills, agent, hooks and commands are inside her; her island line is beside; her OK lines are as they were", () => {
    const r = validateManifest(ALPHA, { bundled: true });
    expect(r.issues).toEqual([]);
    const parts = pluginParts(r.manifest);
    // The island's point is the island's plug, not her tab: beside her, under the switch. Her stage tools are hers alone.
    expect(parts.beside.map((p) => p.ref)).toEqual(["island.line/0"]);
    expect(parts.inside.map((p) => p.ref)).toEqual(["ui/0", "ui/1", "ui/2", "ui/3", "ui/4", "ui/5", "locales/0", "locales/1", "mcpServers/stage", "skills/0", "agents/0", "hooks/0", "hooks/1", "hooks/2", "commands/0", "commands/1", "commands/2"]);
    expect(describeOk(r)).toEqual([
      "alpha runs code on your computers.",
      "It adds: bot, themes, mcpServers, hooks, island.line, skills, agents, commands, locales, ui.",
      "It puts a line of text on the island, with its name beside it, in the island's own style, when Clover isn't in front.",
      "It sees all your bots and their settings.",
      "It reads your conversations with all your bots.",
      "It lets its own buttons move around Clover's window.",
      "It sees which tab and panels are showing.",
      "It sees your bot's figure.",
      "It moves your bot's figure.",
      "Its components reach no host; its host code can reach any host.",
      "It adds an agent definition Study buddy: instructions an agent follows when your bot hands it work.",
      "Its server stage says this tool only reads, so at the default approval level it runs without asking: stage_status.",
      "Its server stage says these tools only change its own display, so at the default level they run without asking: celebrate, pin_note, play_motion, set_expression, set_mood, set_scene, toggle_outfit, unpin_note.",
    ]);
  });

  test("a bot-built plugin with flat `ui` entries and a tool: the UI inside its tab, the tool beside it (every bot), the same lines", () => {
    const r = validateManifest({
      manifest: 1, id: "reel", name: "Reel", version: "0.1.0", engines, host: { entry: "server/index.ts" }, client: { entry: "client/index.tsx" },
      contributes: {
        bot: { name: "Reel", instructions: "bot/instructions.md" },
        mcpServers: { clips: { type: "host" } },
        ui: [{ spot: "conversation", id: "pane", style: "tab/pane.json" }, { spot: "bot.side", component: "Room" }],
      },
    });
    expect(r.issues).toEqual([]);
    expect(pluginParts(r.manifest).beside.map((p) => p.ref)).toEqual(["mcpServers/clips"]);
    expect(botPartLines(r.manifest)).toEqual([]);
    expect(describeOk(r)).toEqual([
      "reel runs code on your computers.",
      "It adds: bot, mcpServers, ui.",
      "Its components reach no host; its host code can reach any host.",
    ]);
  });
});

describe("the new fields", () => {
  const mika = (contributes: Record<string, unknown>) => validateManifest({
    manifest: 1, id: "mika", name: "Mika", version: "0.1.0", engines, host: { entry: "server/index.ts" }, client: { entry: "client/index.tsx" },
    contributes: { bot: { name: "Mika", instructions: "bot/instructions.md" }, ...contributes },
  });

  test("an `app: true` part and a replaced panel each add a line; `own-bot` keeps a part inside", () => {
    const r = mika({
      mcpServers: { stage: { type: "host", scope: "own-bot" }, notes: { type: "host" } },
      skills: [{ path: "skills/mine/SKILL.md", scope: "own-bot" }, "skills/shared/*/SKILL.md"],
      ui: [
        { spot: "island.tab", id: "day", title: "Mika's day", component: "Day", app: true },
        { spot: "panel", key: "browser", component: "MikaBrowser" },
        { spot: "panel", key: "agent", id: "agent", style: "tab/agent.json" },
      ],
    });
    expect(r.issues).toEqual([]);
    const parts = pluginParts(r.manifest);
    expect(parts.beside.map((p) => p.key)).toEqual(["ui:island.tab#day", "mcpServers:notes", "skills:skills/shared/*/SKILL.md"]);
    expect(parts.inside.map((p) => p.key)).toEqual(["ui:panel#panel[browser]", "ui:panel#agent[agent]", "mcpServers:stage", "skills:skills/mine/SKILL.md"]);
    // A restyle (`style`) replaces nothing; a component or a web view does.
    expect(botPartLines(r.manifest)).toEqual(["Everywhere, with a switch of its own: an island tab, tools, skills.", "It replaces the Browser panel on Mika's tab."]);
    const lines = describeOk(r);
    expect(lines.indexOf("Everywhere, with a switch of its own: an island tab, tools, skills.")).toBe(lines.indexOf("It adds: bot, mcpServers, skills, ui.") + 1);
  });

  test("a row for its bot in the sidebar (`sidebar.bot`, keyed by bot id) only as a part beside the bot, named on the Everywhere line", () => {
    const row = (app: boolean) => mika({ ui: [{ spot: "sidebar.bot", key: "mika", component: "Row", ...(app ? { app: true } : {}) }] });
    expect(row(false).issues.map((i) => i.code)).toEqual(["bot_spot_not_offered"]);
    expect(row(true).issues).toEqual([]);
    expect(botPartLines(row(true).manifest)).toEqual(["Everywhere, with a switch of its own: the bots' sidebar rows."]);
  });

  test("an entry on a point another plugin declares is beside the bot; one on a point of its own tree is inside", () => {
    const parts = pluginParts({ id: "mika", contributes: { bot: { name: "Mika" }, "island.line": [{ id: "day", handler: "line" }], "mika.scenes": [{ id: "beach" }], "avatar.formats": [{ id: "png" }] } });
    expect(parts.beside.map((p) => [p.ref, p.kind])).toEqual([["island.line/0", "island.line"], ["avatar.formats/0", "avatar.formats"]]);
    expect(parts.inside.map((p) => p.ref)).toEqual(["mika.scenes/0"]);
    // A child of a bot's tree: its parent's points are its tree's own.
    expect(pluginParts({ contributes: { bot: { name: "Kid" }, "mika.scenes": [{ id: "cave" }] } }, { id: "mika" }).inside.map((p) => p.ref)).toEqual(["mika.scenes/0"]);
  });

  test("a plugin with no bot has no inside, no beside and no such line, whatever it marks", () => {
    const r = validateManifest({ manifest: 1, id: "tarot", name: "Tarot", version: "0.1.0", engines, client: { entry: "c.tsx" }, contributes: { ui: [{ spot: "island.tab", title: "Tarot", component: "T", app: true }] } });
    expect(pluginParts(r.manifest)).toEqual({ inside: [], beside: [] });
    expect(botPartLines(r.manifest)).toEqual([]);
  });

  test("a part's scope is its own, else its plugin's, else its top plugin's, else both; a skill item is a glob or `{ path, scope }`", () => {
    expect([partScopeOf("own-bot", { scope: "bots" }), partScopeOf(undefined, { scope: "bots" }), partScopeOf(undefined, {}, { scope: "own-bot" }), partScopeOf(undefined, {})]).toEqual(["own-bot", "bots", "own-bot", "both"]);
    expect([skillItem("s/*/SKILL.md"), skillItem({ path: "s/SKILL.md", scope: "own-bot" }), skillItem(3)]).toEqual([{ path: "s/*/SKILL.md" }, { path: "s/SKILL.md", scope: "own-bot" }, undefined]);
  });
});
