// A plugin with a bot and parts beside it (§5.5, the owner's rule of November 14): one switch for every part beside the
// bot, which keeps the bot; the OK card's checkbox for them; and a part that moves from inside the bot to beside it asks
// again. Temp folders and an in-memory store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogPointDecl, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Manifest } from "../../contracts/sdk-types";
import { classifyChange, updateAddsTrigger, workshopAdds } from "../changes";
import { RegistryCore, type OkCardRaiser } from "../core";
import { readPluginFolder } from "../folders";
import { memoryRegistryStore } from "../state";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Mika: a bot, an island tab beside it, a tool server beside it and one inside it (`own-bot`), her tab's composer. */
const MIKA = (over: Record<string, unknown> = {}): Manifest => ({
  manifest: 1, id: "mika", name: "Mika", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  host: { entry: "server/index.ts" }, client: { entry: "client/index.tsx" },
  contributes: {
    bot: { name: "Mika", instructions: "bot/instructions.md" },
    mcpServers: { stage: { type: "host", scope: "own-bot" }, notes: { type: "host" } },
    ui: [{ spot: "composer", id: "pane", style: "tab/pane.json" }, { spot: "island.tab", id: "day", title: "Mika's day", component: "Day", app: true }],
  },
  ...over,
} as Manifest);

const states = (reg: RegistryCore, point: string) => reg.entries(point).filter((c) => c.pluginId === "mika").map((c) => `${c.ref}:${c.state}${c.reason ? ` (${c.reason})` : ""}`);

describe("the switch for the parts beside a bot", () => {
  test("off: every part beside the bot is off with why, the bot and its inside parts run; it survives a restart; the plugin's own switch turns everything off", async () => {
    const store = memoryRegistryStore();
    const reg = new RegistryCore({ catalog: catalogPointDecl, store });
    reg.putAll([{ id: "mika", manifest: MIKA(), treeHash: "sha256:1", approved: true }]);
    expect(reg.get("mika")?.parts).toEqual({ app: { enabled: true, has: ["island.tab", "mcpServers"] } });
    expect(await reg.setEnabled("mika", false, { part: "app" })).toEqual({ applied: true });
    expect(reg.get("mika")?.state).toBe("running");
    expect(reg.get("mika")?.parts?.app.enabled).toBe(false);
    expect(states(reg, "ui")).toEqual(["ui/0:waiting (waiting for `composer`)", "ui/1:off (its app parts are off)"]);
    expect(states(reg, "mcpServers")).toEqual(["mcpServers/stage:active", "mcpServers/notes:off (its app parts are off)"]);
    expect(states(reg, "bot")).toEqual(["bot:active"]);
    // Kept in the records.
    const again = new RegistryCore({ catalog: catalogPointDecl, store });
    again.putAll([{ id: "mika", manifest: MIKA(), treeHash: "sha256:1" }]);
    expect([again.get("mika")?.state, again.get("mika")?.parts?.app.enabled]).toEqual(["running", false]);
    expect(states(again, "mcpServers")).toEqual(["mcpServers/stage:active", "mcpServers/notes:off (its app parts are off)"]);
    // The plugin's own switch: everything off, and on again with the parts beside the bot still off.
    await again.setEnabled("mika", false);
    expect([again.get("mika")?.state, states(again, "bot"), states(again, "mcpServers")]).toEqual(["off", [], []]);
    await again.setEnabled("mika", true);
    expect(states(again, "mcpServers")).toEqual(["mcpServers/stage:active", "mcpServers/notes:off (its app parts are off)"]);
    await again.setEnabled("mika", true, { part: "app" });
    // On (nothing in this registry declares the spots, so they wait for them, as any entry would).
    expect(states(again, "ui")).toEqual(["ui/0:waiting (waiting for `composer`)", "ui/1:waiting (waiting for `island.tab`)"]);
  });

  test("a plugin with no parts beside a bot (no bot, or all inside it) has no such switch", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([
      { id: "tarot", manifest: { manifest: 1, name: "Tarot", contributes: { mcpServers: { cards: { type: "host" } } } } as Manifest, treeHash: "sha256:t", approved: true },
      { id: "mika", manifest: MIKA({ contributes: { bot: { name: "Mika", instructions: "i.md" }, mcpServers: { stage: { type: "host", scope: "own-bot" } } } }), treeHash: "sha256:m", approved: true },
    ]);
    expect([reg.get("tarot")?.parts, reg.get("mika")?.parts]).toEqual([undefined, undefined]);
    await expect(reg.setEnabled("tarot", false, { part: "app" })).rejects.toThrow("has no parts beside a bot to switch");
  });

  test("the OK card has a checkbox for them; installed with it unticked, the bot runs and they stay off", async () => {
    let seen: { children: { id: string; label: string; checked: boolean }[] } | undefined;
    let answer: ((a: { approved: boolean; children?: readonly string[] }) => void) | undefined;
    const cards: OkCardRaiser = { raise: (req, answered) => { seen = req; answer = answered; return "card_ok000001"; } };
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards });
    reg.putAll([{ id: "mika", manifest: MIKA(), treeHash: "sha256:1", approved: false }]);
    expect((await reg.installed("mika", "app")).card).toBe("card_ok000001");
    expect(seen?.children).toEqual([{ id: "mika#app", label: "Its parts beyond Mika's tab", checked: true }]);
    answer!({ approved: true, children: [] });
    await Bun.sleep(0);
    expect([reg.get("mika")?.state, reg.get("mika")?.parts?.app.enabled]).toEqual(["running", false]);
    expect(states(reg, "ui")).toEqual(["ui/0:waiting (waiting for `composer`)", "ui/1:off (its app parts are off)"]);
  });
});

describe("a part that moves from inside the bot to beside it asks again", () => {
  const FILES: Record<string, string> = { "bot/instructions.md": "You are Mika.", "server/index.ts": "export {};\n", "client/index.tsx": "export const Day = () => null;\n", "tab/pane.json": "{\"theme\":1,\"name\":\"Pane\",\"tokens\":{}}\n", "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nA.\n", "skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\nB.\n" };
  async function snap(manifest: Manifest) {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-b-parts-"))), "mika");
    temps.push(dirname(dir));
    for (const [path, text] of Object.entries({ ...FILES, "clover.json": JSON.stringify(manifest) })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const r = await readPluginFolder(dir, { source: "local", provenance: { by: "user-app", at: 0 } });
    expect(r.inputs.flatMap((i) => i.issues ?? []).filter((i) => i.severity === "error")).toEqual([]);
    return r.snapshot!;
  }
  const withSkills = (skills: unknown[], ui?: unknown[]) => MIKA({ contributes: { ...(MIKA().contributes as object), skills, ...(ui === undefined ? {} : { ui }) } });

  test("a tool's or skill's `own-bot` dropped, or `app: true` added to an entry, asks on an edit, an update and a bot's own edit; a reorder doesn't", async () => {
    const ok = await snap(withSkills([{ path: "skills/a/SKILL.md", scope: "own-bot" }, "skills/b/SKILL.md"]));
    const moved = await snap(withSkills(["skills/a/SKILL.md", "skills/b/SKILL.md"]));
    expect(updateAddsTrigger(ok, moved)).toBe("it moves a part from inside its bot to beside it, for every bot and every tab");
    expect(workshopAdds(ok, moved)).toBe("it moves a part from inside its bot to beside it, for every bot and every tab");
    expect(classifyChange(ok, moved)).toBe("asks-again");
    const server = await snap(MIKA({ contributes: { ...(MIKA().contributes as object), skills: [{ path: "skills/a/SKILL.md", scope: "own-bot" }, "skills/b/SKILL.md"], mcpServers: { stage: { type: "host" }, notes: { type: "host" } } } }));
    expect(updateAddsTrigger(ok, server)).toBe("it moves a part from inside its bot to beside it, for every bot and every tab");
    const app = await snap(withSkills([{ path: "skills/a/SKILL.md", scope: "own-bot" }, "skills/b/SKILL.md"], [{ spot: "composer", id: "pane", style: "tab/pane.json", app: true }, { spot: "island.tab", id: "day", title: "Mika's day", component: "Day", app: true }]));
    expect(updateAddsTrigger(ok, app)).toBe("it moves a part from inside its bot to beside it, for every bot and every tab");
    // The same parts in another order: nothing moved.
    const reordered = await snap(withSkills(["skills/b/SKILL.md", { path: "skills/a/SKILL.md", scope: "own-bot" }]));
    expect(updateAddsTrigger(ok, reordered)).toBeUndefined();
    // A snapshot kept before the parts were recorded isn't compared.
    const old = { ...ok, plugins: Object.fromEntries(Object.entries(ok.plugins).map(([k, fp]) => [k, { ...fp, parts: undefined }])) };
    expect(updateAddsTrigger(old, moved)).toBeUndefined();
  });
});
