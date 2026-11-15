// `plugin.install { from: "wrap" }` (spec §5.1 "wrapped automatically") for the data-only items: an agent-skill
// folder and a Claude-style agent file become a generated plugin in the plugins folder, accepted as-is, named
// `skill-<name>` / `agent-<name>`, recorded as wrapped (the OK says so), and waiting for the user's OK like any install.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDetail } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { frontMatter } from "../../registry/wrap";
import { pluginRegistryMethods } from "../registry-methods";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const APP = { caller: { kind: "user", client: "app" } } as never;
const CLI = { caller: { kind: "user", client: "cli" } } as never;
const SKILL = "---\nname: PDF Tools!\ndescription: \"Fill and merge PDFs\"\nallowed-tools: Read, Bash\n---\n# PDF tools\n\nUse pdftk.\n";
const AGENT = "---\nname: code-reviewer\ndescription: Reviews a diff for bugs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.\n";

async function world() {
  const home = temp("clover-wrap-");
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
  const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
  const call = (name: string, params: unknown, ctx = APP) => m[name]!(params, ctx);
  const install = (kind: string, value: string, ctx = APP) => call("plugin.install", { source: { from: "wrap", kind, value } }, ctx) as Promise<{ id: string; state: string; card?: string }>;
  const refused = (kind: string, value: string) => install(kind, value).then(() => "installed", (e: Error) => `refused: ${e.message}`);
  return { home, broker, opened, call, install, refused };
}

describe("wrapping a skill folder or an agent file", () => {
  test("a skill folder becomes skill-<name>: copied as-is under skills/, listed, recorded as wrapped, waiting for its OK", async () => {
    const w = await world();
    try {
      const src = join(temp("clover-wrap-src-"), "pdf");
      mkdirSync(join(src, "scripts"), { recursive: true });
      writeFileSync(join(src, "SKILL.md"), SKILL);
      writeFileSync(join(src, "scripts", "merge.sh"), "#!/bin/sh\npdftk \"$@\"\n", { mode: 0o755 });
      const r = await w.install("skill-folder", src);
      expect([r.id, r.state]).toEqual(["skill-pdf-tools", "found"]);
      const dest = join(w.home, "plugins", "skill-pdf-tools");
      const manifest = JSON.parse(readFileSync(join(dest, "clover.json"), "utf8"));
      expect(manifest).toMatchObject({ manifest: 1, id: "skill-pdf-tools", name: "PDF Tools!", description: "Fill and merge PDFs", contributes: { skills: ["skills/pdf-tools"] }, generated: { from: "skill-folder", by: "user" } });
      expect(readFileSync(join(dest, "skills", "pdf-tools", "SKILL.md"), "utf8")).toBe(SKILL);
      expect(readFileSync(join(dest, "skills", "pdf-tools", "scripts", "merge.sh"), "utf8")).toContain("pdftk");
      const detail = PluginDetail.parse(((await w.call("plugin.get", { id: "skill-pdf-tools" })) as { plugin: unknown }).plugin);
      expect(detail.source).toBe("wrapped");
      expect(detail.provenance).toMatchObject({ by: "user-app", wrapped: { from: "skill-folder" } });
      const card = w.broker.cards().find((c) => c.id === r.card)!;
      expect(card).toMatchObject({ kind: "plugin-ok", pluginId: "skill-pdf-tools" });
      expect(JSON.stringify(card)).toContain("Clover made this plugin around a skill folder (SKILL.md)");
      // The same skill again: its own plugin, a number added.
      expect((await w.install("skill-folder", src, CLI)).id).toBe("skill-pdf-tools-2");
      expect(readdirSync(join(w.home, "run", "plugin-install"))).toEqual([]);
    } finally {
      w.opened.close();
    }
  });

  test("an agent file becomes agent-<name>: the file as-is under agents/, listed", async () => {
    const w = await world();
    try {
      const file = join(temp("clover-wrap-agent-"), "reviewer.md");
      writeFileSync(file, AGENT);
      const r = await w.install("agent-file", file);
      expect(r.id).toBe("agent-code-reviewer");
      const dest = join(w.home, "plugins", "agent-code-reviewer");
      expect(JSON.parse(readFileSync(join(dest, "clover.json"), "utf8"))).toMatchObject({ id: "agent-code-reviewer", name: "code-reviewer", contributes: { agents: ["agents/code-reviewer.md"] }, generated: { from: "agent-file" } });
      expect(readFileSync(join(dest, "agents", "code-reviewer.md"), "utf8")).toBe(AGENT);
      expect(PluginDetail.parse(((await w.call("plugin.get", { id: "agent-code-reviewer" })) as { plugin: unknown }).plugin).provenance.wrapped).toEqual({ from: "agent-file" });
      // No front matter: the file's name names it.
      const plain = join(temp("clover-wrap-agent-"), "Triage Bot.md");
      writeFileSync(plain, "You sort issues.\n");
      expect((await w.install("agent-file", plain)).id).toBe("agent-triage-bot");
    } finally {
      w.opened.close();
    }
  });

  test("refused, nothing left behind: no SKILL.md, a folder that's a plugin already, a link out of the item, a file that isn't Markdown, a missing path", async () => {
    const w = await world();
    try {
      const base = temp("clover-wrap-bad-");
      const none = join(base, "none");
      mkdirSync(none);
      writeFileSync(join(none, "README.md"), "no skill here");
      const plugin = join(base, "plugin");
      mkdirSync(plugin);
      writeFileSync(join(plugin, "SKILL.md"), SKILL);
      writeFileSync(join(plugin, "clover.json"), JSON.stringify({ manifest: 1, id: "plugin", name: "P" }));
      const leaky = join(base, "leaky");
      mkdirSync(leaky);
      writeFileSync(join(leaky, "SKILL.md"), SKILL);
      symlinkSync("/etc/hosts", join(leaky, "hosts"));
      const txt = join(base, "agent.txt");
      writeFileSync(txt, AGENT);
      expect(await w.refused("skill-folder", none)).toContain("has no SKILL.md");
      expect(await w.refused("skill-folder", plugin)).toContain("it's a plugin already");
      expect(await w.refused("skill-folder", leaky)).toStartWith("refused:");
      expect(await w.refused("agent-file", txt)).toContain("isn't an agent file");
      expect(await w.refused("agent-file", join(base, "missing.md"))).toContain("doesn't exist");
      expect(existsSync(join(w.home, "plugins")) ? readdirSync(join(w.home, "plugins")) : []).toEqual([]);
      expect(existsSync(join(w.home, "run", "plugin-install")) ? readdirSync(join(w.home, "run", "plugin-install")) : []).toEqual([]);
    } finally {
      w.opened.close();
    }
  });

  test("front matter: key: value lines, quotes off, nothing without the fence", () => {
    expect(frontMatter(SKILL)).toEqual({ name: "PDF Tools!", description: "Fill and merge PDFs", "allowed-tools": "Read, Bash" });
    expect(frontMatter("# just text\nname: no\n")).toEqual({});
    expect(frontMatter("---\r\nname: 'quoted'\r\n---\r\nbody")).toEqual({ name: "quoted" });
  });
});
