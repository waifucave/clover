// Parts inside a bot (§5.5, the owner's rule of November 14): a skill, an agent definition and a command that say
// `scope: "own-bot"` are that bot's alone (its conversation, side threads and the agents it starts); beside it, they
// serve every bot and coding agent as usual. The server's case is in plugin-mcp.test.ts. Temp folders; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { agentPluginParts } from "../../agents/plugin-reach";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import type { Manifest } from "../../contracts/sdk-types";
import { agentDefinitionOf, glossaryIndex } from "../../runtime-sdk/turn-loop/glossary";
import { partsServe } from "../../runtime-sdk/turn-loop/only-backends";
import { registryCommand, runCommand } from "../commands";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function mika() {
  const folder = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-b-ownbot-"))), "mika");
  temps.push(dirname(folder));
  const files: Record<string, string> = {
    "skills/mine/SKILL.md": "---\nname: mine\ndescription: Mika's own\n---\nMine.\n",
    "skills/shared/SKILL.md": "---\nname: shared\ndescription: For everyone\n---\nShared.\n",
    "agents/helper.md": "Help Mika.",
    "agents/anyone.md": "Help anyone.",
  };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, p)), { recursive: true });
    writeFileSync(join(folder, p), t);
  }
  const manifest = {
    manifest: 1, id: "mika", name: "Mika", version: "1.0.0", host: { entry: "server/index.ts" },
    contributes: {
      bot: { name: "Mika", instructions: "bot/instructions.md" },
      skills: [{ path: "skills/mine/SKILL.md", scope: "own-bot" }, "skills/shared/SKILL.md"],
      agents: [
        { id: "helper", name: "Helper", backend: "clover-code", instructions: "agents/helper.md", scope: "own-bot" },
        { id: "anyone", name: "Anyone", backend: "clover-code", instructions: "agents/anyone.md" },
      ],
      commands: [
        { name: "scene", description: "Scene", handler: "scene", scope: "own-bot" },
        { name: "note", description: "Note", handler: "note" },
      ],
    },
  } as unknown as Manifest;
  return new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [{ id: "mika", manifest, folder }] });
}

const sessions = {
  mika: { kind: "bot", bot: "mika" }, mikaSide: { kind: "side-thread", bot: "mika" }, mikaAgent: { kind: "agent", bot: "mika" },
  alpha: { kind: "bot", bot: "alpha" }, alphaAgent: { kind: "agent", bot: "alpha" }, coding: { kind: "coding" },
} as const;

describe("own-bot per entry", () => {
  test("a skill and an agent definition inside the bot: in Glossary and on an agent's bridge for its own sessions only", async () => {
    const reg = mika();
    const listed = (s: { kind: string; bot?: string }) => glossaryIndex({ tools: () => [], registry: reg, serves: (pluginId, entryScope) => partsServe(reg, pluginId, s, entryScope) })
      .filter((i) => i.kind === "skill" || i.kind === "agent").map((i) => i.name).sort();
    for (const s of [sessions.mika, sessions.mikaSide, sessions.mikaAgent]) expect(listed(s)).toEqual(["mika:anyone", "mika:helper", "mika:mine", "mika:shared"]);
    for (const s of [sessions.alpha, sessions.alphaAgent, sessions.coding]) expect(listed(s)).toEqual(["mika:anyone", "mika:shared"]);
    // Another bot's Agent can't start it by name either.
    const serve = (s: { kind: string; bot?: string }) => (pluginId: string, entryScope?: unknown) => partsServe(reg, pluginId, s, entryScope);
    expect(agentDefinitionOf(reg, "mika:helper", serve(sessions.mika))?.id).toBe("helper");
    expect(agentDefinitionOf(reg, "mika:helper", serve(sessions.alpha))).toBeUndefined();
    expect(agentDefinitionOf(reg, "mika:anyone", serve(sessions.alpha))?.id).toBe("anyone");
    // The skill folders an agent's backend reads (Claude Code's session plugin).
    const parts = agentPluginParts({ registry: reg });
    const skills = async (bot?: string) => (await parts.parts("s", { id: "s", kind: bot === undefined ? "coding" : "agent", backend: "claude-code", computer: "Studio", root: tmpdir(), ...(bot === undefined ? {} : { bot }) })).skills.map((x) => x.name).sort();
    expect(await skills("mika")).toEqual(["mika-mine", "mika-shared"]);
    expect(await skills("alpha")).toEqual(["mika-shared"]);
    expect(await skills()).toEqual(["mika-shared"]);
  });

  test("a command inside the bot: the user and that bot's sessions run it; another bot's or a coding session is refused", async () => {
    const reg = mika();
    const ran: string[] = [];
    const host = { invoke: async (c: { handler: string }) => { ran.push(c.handler); return { ok: true }; } };
    const o = { find: (n: string) => registryCommand(reg, n), host: host as never };
    const session = (s: { kind: string; bot?: string }) => ({ kind: "session", sessionId: "s1", sessionKind: s.kind, ...(s.bot === undefined ? {} : { bot: s.bot }) }) as unknown as Caller;
    const user = { kind: "user", device: "d".repeat(16), clientMessageId: "m", sentAt: 0 } as unknown as Caller;
    expect(registryCommand(reg, "mika.scene")?.scope).toBe("own-bot");
    for (const c of [user, session(sessions.mika), session(sessions.mikaSide), session(sessions.mikaAgent)]) await runCommand(o, { name: "mika.scene" }, c);
    expect(ran).toEqual(["scene", "scene", "scene", "scene"]);
    for (const s of [sessions.alpha, sessions.alphaAgent, sessions.coding]) {
      await expect(runCommand(o, { name: "mika.scene" }, session(s))).rejects.toThrow("mika.scene is mika's own: only you and mika run it");
    }
    // Beside the bot: anyone, as before.
    await runCommand(o, { name: "mika.note" }, session(sessions.alpha));
    expect(ran.at(-1)).toBe("note");
  });
});
