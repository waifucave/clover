// The controller's principle for updates: every line the OK card shows from the tree is covered. For each kind of line
// the card builder can emit (describeOk, hookOkLines, backgroundOkLines, agentEnvLines), an update whose manifest adds or alters that line
// asks for the OK again (`updateAddsTrigger`); a plain code change doesn't. The lines left out on purpose say why.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { updateAddsTrigger } from "../changes";
import { readPluginFolder, treeOkLines } from "../folders";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

type Files = Record<string, string>;
const BASE = {
  manifest: 1, id: "luna", name: "Luna", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv" } } },
};
const BASE_FILES: Files = { "bin/srv": "#!/bin/sh\necho srv\n" };

async function snap(manifest: Record<string, unknown>, files: Files = {}) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-trig-"))), "luna");
  temps.push(dirname(dir));
  for (const [path, text] of Object.entries({ ...BASE_FILES, ...files, "clover.json": JSON.stringify(manifest) })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    if (path.startsWith("bin/")) chmodSync(join(dir, path), 0o755);
  }
  const r = await readPluginFolder(dir, { source: "index", provenance: { by: "user-app", at: 0 } });
  const issues = r.inputs.flatMap((i) => i.issues ?? []).filter((i) => i.severity === "error").map((i) => i.message);
  expect([manifest.version, issues, r.snapshot !== undefined]).toEqual([manifest.version, [], true]);
  return { snapshot: r.snapshot!, lines: treeOkLines(dir, r.tree!) };
}

const withContrib = (c: Record<string, unknown>, top: Record<string, unknown> = {}) => ({ ...BASE, ...top, version: "1.1.0", contributes: { ...BASE.contributes, ...c } });
const srv = (extra: Record<string, unknown>) => ({ mcpServers: { srv: { type: "stdio", command: "bin/srv", ...extra } } });

describe("every OK-card line an update adds or alters asks again", () => {
  test("each kind of line", async () => {
    const base = await snap(BASE);
    const cases: [string, Record<string, unknown>, Files?][] = [
      // describeOk: what it is (data → code is the class rank; a data base is checked below).
      ["It adds: (a new kind of contribution)", withContrib({ hooks: [{ id: "h", on: ["turn.start"], command: "bin/hook" }] }), { "bin/hook": "#!/bin/sh\n" }],
      ["a capability's line", withContrib({}, { capabilities: ["notify"] })],
      ["the hosts it reaches", withContrib({}, { capabilities: ["network:api.example.com"] })],
      ["this computer or the local network", withContrib({}, { capabilities: ["network:localhost:8080"] })],
      ["hosts from its settings", withContrib({}, { capabilities: ["network:${setting:region}.example.com"], settings: { region: { type: "string", title: "Region" } } })],
      ["code fetched at run time", withContrib(srv({ command: "npx", args: ["-y", "some-server"] }))],
      ["read-only tools", withContrib(srv({ readOnly: ["search"] }))],
      ["keys in a server's environment", withContrib(srv({ env: { KEY: "${secret:key}" } }), { settings: { key: { type: "secret", title: "Key" } } })],
      // "It runs its own programs" comes with a stdio server (the base has one) or a node host, which only a bundled
      // plugin may have; a helper is refused, so it never reaches the card.
      ["add-ons of its own", withContrib({}, { addons: { description: "Effects" } })],
      ["adult content", withContrib({}, { adult: true })],
      // hookOkLines.
      ["what its hooks see", withContrib({ hooks: [{ id: "h", on: ["message.in"], command: "bin/hook" }] }), { "bin/hook": "#!/bin/sh\n" }],
      // The agent backend line (the controller's ruling) and agentEnvLines.
      ["an agent backend", withContrib({ agentBackends: [{ id: "codex", name: "Codex", protocol: "acp", command: "bin/agent" }] }), { "bin/agent": "#!/bin/sh\n" }],
      ["what an agent backend gets from your environment", withContrib({ agentBackends: [{ id: "codex", name: "Codex", protocol: "acp", command: "bin/agent", quirks: "quirks.json" }] }), { "bin/agent": "#!/bin/sh\n", "quirks.json": JSON.stringify({ launch: { envAllow: ["HOME_TOKEN"] } }) }],
      // backgroundOkLines: what it runs without being asked.
      ["host code that starts at once (host.start)", withContrib({}, { host: { entry: "host/index.js", start: "each" } }), { "host/index.js": "export {};\n" }],
      ["routine triggers", withContrib({ triggers: [{ type: "luna-ping", title: "Ping", handler: "ping" }] }, { host: { entry: "host/index.js" } }), { "host/index.js": "export const ping = {};\n" }],
      // The card's title and the plugin list name it: the label.
      ["its name", { ...BASE, version: "1.1.0", name: "Clover Settings" }],
      ["its author", { ...BASE, version: "1.1.0", author: { name: "waifucave" } }],
    ];
    for (const [kind, manifest, files] of cases) {
      const next = await snap(manifest, files);
      expect([kind, next.lines.some((l) => !base.lines.includes(l)) || kind === "its name" || kind === "its author"]).toEqual([kind, true]);
      expect([kind, updateAddsTrigger(base.snapshot, next.snapshot) !== undefined]).toEqual([kind, true]);
    }
    // An agent backend already on the card, its program changed: the line alters, and asks.
    const agent = (command: string) => withContrib({ agentBackends: [{ id: "codex", name: "Codex", protocol: "acp", command }] });
    const a1 = await snap(agent("bin/agent"), { "bin/agent": "#!/bin/sh\n", "bin/agent2": "#!/bin/sh\n" });
    const a2 = await snap({ ...agent("bin/agent2"), version: "1.2.0" }, { "bin/agent": "#!/bin/sh\n", "bin/agent2": "#!/bin/sh\n" });
    expect(updateAddsTrigger(a1.snapshot, a2.snapshot)).toBe("it adds or changes an agent backend");
    // Host code that already ran on demand now starts at once, or moves from the main to every computer: its line alters.
    const host = (start?: string) => withContrib({}, { host: { entry: "host/index.js", ...(start ? { start } : {}) } });
    const h0 = await snap(host(), { "host/index.js": "export {};\n" });
    const h1 = await snap({ ...host("main"), version: "1.2.0" }, { "host/index.js": "export {};\n" });
    const h2 = await snap({ ...host("each"), version: "1.3.0" }, { "host/index.js": "export {};\n" });
    expect(updateAddsTrigger(h0.snapshot, h1.snapshot)).toContain("It runs in the background from the moment Clover starts, on your main computer.");
    expect(updateAddsTrigger(h1.snapshot, h2.snapshot)).toContain("on every computer it's installed on");
    // A data plugin that now runs code: its first line alters.
    const data = await snap({ manifest: 1, id: "luna", name: "Luna", version: "1.0.0" }, {});
    expect(updateAddsTrigger(data.snapshot, base.snapshot)).toBe("it now runs code");
    // A child with code is new on the card's tree.
    const child = await snap(BASE, { "plugins/extra/clover.json": JSON.stringify({ manifest: 1, name: "Extra", engines: { clover: `^${PLUGIN_API_VERSION}` }, contributes: { mcpServers: { x: { type: "stdio", command: "bin/x" } } } }), "plugins/extra/bin/x": "#!/bin/sh\n" });
    expect(updateAddsTrigger(base.snapshot, child.snapshot)).toContain("its child extra is new");
  });

  test("not a trigger: a code change, the version, and a line taken away", async () => {
    const base = await snap({ ...BASE, capabilities: ["notify"] });
    // Code changes ride the OK given (§5.1).
    expect(updateAddsTrigger(base.snapshot, (await snap({ ...BASE, version: "1.1.0", capabilities: ["notify"] }, { "bin/srv": "#!/bin/sh\necho new\n" })).snapshot)).toBeUndefined();
    // A capability given up takes a line away; nothing new is shown.
    expect(updateAddsTrigger(base.snapshot, (await snap({ ...BASE, version: "1.1.0" })).snapshot)).toBeUndefined();
  });

  // Left out of `treeOkLines` on purpose, so never compared: the source line (where it came from, not
  // the tree), the wrapper's lines (the install record's; wrapped plugins don't update), and the per-computer lines (code
  // on Windows and Linux reads the logins, no sandbox on this computer, host code held to its proxy), which follow the
  // class and the computer, both judged above or not the update's.
});
