// `plugin.install { from: "wrap" }` for MCP server configs, MCP addresses and Claude Code plugin folders (spec §5.1):
// one generated plugin per server, keys moved into the plugin's secrets, `${CLAUDE_PLUGIN_ROOT}` and friends rewritten,
// `userConfig` as settings, Claude-style hooks under `sh`, unused parts named. The network (the owner's ruling,
// 2026-11-10): a wrapper with a local server or hook gets `network: "any"` on its install record, which the OK states
// and the fence reads; tried on real processes against a native plugin with no hosts, and a wrapper edited to name one.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDetail } from "@waifucave/clover-protocol";
import { darwinDescribe } from "../../../test/helpers/darwin-only";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { pluginFenceProfile } from "../../registry/plugin-fence";
import { ensurePluginRunFiles, guardedMcpServer } from "../../registry/plugin-run";
import { claudeHooks, mcpServersOf, wrapperNetworkOpen, wrapperOpensNetwork } from "../../registry/wrap";
import { startPluginHost } from "../daemon-host";
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
// Dummy values only: no real key goes in a test.
const KEY = "dummy-key-0000";

type Installed = { id: string; state: string; card?: string; more?: { id: string; card?: string }[] };

async function world(o: { secrets?: boolean } = {}) {
  const home = temp("clover-wrapm-");
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
  const m = pluginRegistryMethods({
    opened, host: { restart: async () => {} }, home,
    ...(o.secrets === false ? {} : { secrets }),
  });
  const call = (name: string, params: unknown) => m[name]!(params, APP);
  const install = (kind: string, value: string) => call("plugin.install", { source: { from: "wrap", kind, value } }) as Promise<Installed>;
  const refused = (kind: string, value: string) => install(kind, value).then(() => "installed", (e: Error) => `refused: ${e.message}`);
  const manifest = (id: string) => JSON.parse(readFileSync(join(home, "plugins", id, "clover.json"), "utf8"));
  const pluginsLeft = () => (existsSync(join(home, "plugins")) ? readdirSync(join(home, "plugins")) : []);
  const detail = async (id: string) => PluginDetail.parse(((await call("plugin.get", { id })) as { plugin: unknown }).plugin);
  return { home, broker, secrets, opened, call, install, refused, manifest, pluginsLeft, detail };
}

describe("wrapping an MCP server's config or address", () => {
  test("one plugin per server, mcp-<name>, its namespace the server's; every header and env value moved into the plugin's secrets", async () => {
    const w = await world();
    try {
      const config = JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${KEY}` } },
          docs: { type: "sse", url: "https://docs.example.com/sse" },
          blender: { command: "uvx", args: ["blender-mcp"], env: { BLENDER_TOKEN: KEY } },
        },
      });
      const r = await w.install("mcp-config", config);
      expect([r.id, ...(r.more ?? []).map((m) => m.id)]).toEqual(["mcp-linear", "mcp-docs", "mcp-blender"]);
      expect(r.card).toBeDefined();
      for (const m of r.more!) expect(m.card).toBeDefined();
      const linear = w.manifest("mcp-linear");
      expect(linear).toMatchObject({
        id: "mcp-linear", namespace: "linear", generated: { from: "mcp-config", by: "user" },
        settings: { "header.Authorization": { type: "secret" } },
        contributes: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "${secret:header.Authorization}" } } } },
      });
      expect(linear.engines).toBeUndefined();
      // `sse` is served as `http`.
      expect(w.manifest("mcp-docs").contributes.mcpServers.docs.type).toBe("http");
      const blender = w.manifest("mcp-blender");
      expect(blender.engines?.clover).toStartWith("^");
      expect(blender.contributes.mcpServers.blender).toEqual({ type: "stdio", command: "uvx", args: ["blender-mcp"], env: { BLENDER_TOKEN: "${secret:BLENDER_TOKEN}" } });
      // No key on disk; each in its own plugin's secrets.
      for (const id of ["mcp-linear", "mcp-blender"]) expect(readFileSync(join(w.home, "plugins", id, "clover.json"), "utf8")).not.toContain(KEY);
      expect(await w.secrets.get({ owner: { kind: "plugin", pluginId: "mcp-linear" }, name: "header.Authorization" })).not.toBeNull();
      expect((await w.secrets.list({ kind: "plugin", pluginId: "mcp-blender" })).map((s) => s.ref.name)).toEqual(["BLENDER_TOKEN"]);
      // The network grant: on the local server's record only (an http server is reached by the runtime, not a plugin
      // process), shown by plugin.get and stated on its OK.
      expect((await w.detail("mcp-blender")).provenance.wrapped).toEqual({ from: "mcp-config", network: "any" });
      expect((await w.detail("mcp-linear")).provenance.wrapped).toEqual({ from: "mcp-config" });
      const blenderCard = JSON.stringify(w.broker.cards().find((c) => c.id === r.more![1]!.card));
      expect(blenderCard).toContain("It can reach any host on the network");
      expect(blenderCard).not.toContain("reaches no host");
      expect(JSON.stringify(w.broker.cards().find((c) => c.id === r.card))).not.toContain("any host on the network");
      // The bare map, as pasted from a settings file, is the same.
      expect((await w.install("mcp-config", JSON.stringify({ linear: { url: "https://mcp.linear.app/mcp" } }))).id).toBe("mcp-linear-2");
    } finally {
      w.opened.close();
    }
  });

  test("an address gives one http server named by its host", async () => {
    const w = await world();
    try {
      const r = await w.install("mcp-url", "https://mcp.example.com/mcp");
      expect(r.id).toBe("mcp-example-com");
      expect(w.manifest("mcp-example-com")).toMatchObject({ namespace: "example-com", generated: { from: "mcp-url" }, contributes: { mcpServers: { "example-com": { type: "http", url: "https://mcp.example.com/mcp" } } } });
      expect(await w.refused("mcp-url", "ftp://example.com")).toContain("http or https");
      expect(await w.refused("mcp-url", "https://u:p@example.com/")).toContain("no user name or password");
    } finally {
      w.opened.close();
    }
  });

  test("refused, nothing left: not JSON, a server with neither command nor url, a bad field, keys with no secret store", async () => {
    const w = await world({ secrets: false });
    try {
      expect(await w.refused("mcp-config", "{nope")).toContain("isn't JSON");
      expect(await w.refused("mcp-config", JSON.stringify({ a: { args: [] } }))).toContain("needs a `command` or a `url`");
      expect(await w.refused("mcp-config", JSON.stringify({ a: { command: "x", args: "y" } }))).toContain("list of strings");
      // The second server is bad: the first isn't installed either.
      expect(await w.refused("mcp-config", JSON.stringify({ a: { url: "https://a.example.com" }, b: { url: "file:///etc" } }))).toContain("http or https");
      expect(await w.refused("mcp-config", JSON.stringify({ a: { url: "https://a.example.com", headers: { K: KEY } } }))).toContain("credential store");
      expect(w.pluginsLeft()).toEqual([]);
    } finally {
      w.opened.close();
    }
  });

  test("mcpServersOf: the wrapped shape or the bare map, at most 32", () => {
    expect(Object.keys(mcpServersOf(`{ // a comment\n "mcpServers": { "a": { "command": "x" } } }`))).toEqual(["a"]);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(() => mcpServersOf(JSON.stringify(many))).toThrow("at most 32");
  });
});

describe("a wrapper's network grant", () => {
  test("open only with the record's grant and while the tree declares no network: host", () => {
    expect(wrapperNetworkOpen({ from: "mcp-config", network: "any" }, [])).toBe(true);
    expect(wrapperNetworkOpen({ from: "claude-plugin", network: "any" }, ["skills"])).toBe(true);
    expect(wrapperNetworkOpen({ from: "mcp-config", network: "any" }, ["network:api.example.com"])).toBe(false);
    expect(wrapperNetworkOpen({ from: "mcp-config" }, [])).toBe(false);
    // A plugin that isn't a wrapper never has it, hosts or none.
    expect(wrapperNetworkOpen(undefined, [])).toBe(false);
  });
  test("only the generated top plugin's own processes: a child shipped inside the wrapped folder never gets it", () => {
    const rec = (id: string, capabilities: string[] = []) => ({ id, capabilities, provenance: { by: "user-app", at: 0, ...(id === "claude-kit" ? { wrapped: { from: "claude-plugin", network: "any" } } : {}) } });
    const records = [rec("claude-kit"), rec("claude-kit/child")];
    const registry = { get: (id: string) => records.find((r) => r.id === id) as never, list: () => records as never };
    expect(wrapperOpensNetwork(registry, "claude-kit")).toBe(true);
    expect(wrapperOpensNetwork(registry, "claude-kit/child")).toBe(false);
    // A child naming a host turns the top's off too.
    records[1] = rec("claude-kit/child", ["network:api.example.com"]);
    expect(wrapperOpensNetwork(registry, "claude-kit")).toBe(false);
  });
});

darwinDescribe("the fence's open network, on a real process", () => {
  test("open reaches any address; with only a proxy port, another port is refused", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const home = temp("clover-wrapf-");
      const reach = (network: "open" | { proxyPort: number }) => {
        const profile = pluginFenceProfile({ cloverHome: join(home, "clover"), userHome: join(home, "user"), read: [], write: [], exec: "any", network });
        return Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/nc", "-z", "-w", "3", "127.0.0.1", String(port)], { stdout: "ignore", stderr: "ignore" }).exitCode;
      };
      expect(reach("open")).toBe(0);
      expect(reach({ proxyPort: port === 1 ? 2 : port - 1 })).not.toBe(0);
      expect(reach({ proxyPort: port })).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("wrapping a Claude Code plugin folder", () => {
  function claudePlugin(extra: { pluginJson?: Record<string, unknown> } = {}): string {
    const root = join(temp("clover-wrapc-src-"), "deploy-kit");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "deploy-kit", version: "1.2.3", description: "Ship things",
      userConfig: {
        region: { type: "string", title: "Region", default: "eu" },
        api_key: { type: "string", title: "API key", sensitive: true },
        hosts: { type: "string", multiple: true },
      },
      outputStyles: "./styles",
      ...extra.pluginJson,
    }));
    mkdirSync(join(root, "skills", "rollout"), { recursive: true });
    writeFileSync(join(root, "skills", "rollout", "SKILL.md"), "---\nname: rollout\ndescription: Roll out\n---\nDo it.\n");
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "deploy.md"), "---\ndescription: Deploy the app\n---\nDeploy $ARGUMENTS now.\n");
    writeFileSync(join(root, "commands", "status.md"), "Show the deploy status.\n");
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "deployer.md"), "---\nname: deployer\ndescription: Deploys\n---\nYou deploy.\n");
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh", timeout: 30 }] }],
        PostToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: "echo regex" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo ${user_config.region}" }, { type: "prompt", prompt: "Are you done?" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ${HOME}/x ${USER}name" }, { type: "command", command: "echo ${NAME:-anon}" }] }],
      },
    }));
    writeFileSync(join(root, "hooks", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        deployer: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--region", "${user_config.region}", "--data", "${CLAUDE_PLUGIN_DATA}"], env: { DEPLOY_KEY: "${user_config.api_key}" } },
        status: { type: "http", url: "https://status.example.com/mcp", headers: { Authorization: "Bearer ${user_config.api_key}" } },
        homebrew: { command: "${HOME}/bin/tool" },
      },
    }));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "server"), "#!/bin/sh\n", { mode: 0o755 });
    return root;
  }

  test("copied whole into claude-<name>: skills, commands as skills, agents, servers, hooks and settings, the rest named unused", async () => {
    const w = await world();
    try {
      const r = await w.install("claude-plugin", claudePlugin());
      expect([r.id, r.state]).toEqual(["claude-deploy-kit", "found"]);
      const dest = join(w.home, "plugins", "claude-deploy-kit");
      const m = w.manifest("claude-deploy-kit");
      expect(m).toMatchObject({
        id: "claude-deploy-kit", name: "deploy-kit", description: "Ship things", version: "1.2.3", namespace: "deploy-kit",
        generated: { from: "claude-plugin", by: "user" },
        settings: {
          region: { type: "string", title: "Region", default: "eu" },
          api_key: { type: "secret", title: "API key" },
          hosts: { type: "string" },
        },
        contributes: { skills: ["skills/*", "command-skills/*"], agents: ["agents/deployer.md"] },
      });
      expect(m.engines?.clover).toStartWith("^");
      // The folder as it was, beside the generated parts.
      expect(readFileSync(join(dest, "hooks", "check.sh"), "utf8")).toContain("exit 0");
      expect(readFileSync(join(dest, "command-skills", "deploy", "SKILL.md"), "utf8")).toBe("---\nname: deploy\ndescription: \"Deploy the app\"\n---\nDeploy $ARGUMENTS now.\n");
      expect(readFileSync(join(dest, "command-skills", "status", "SKILL.md"), "utf8")).toContain('description: "Show the deploy status."');
      // Servers: Claude Code's variables as Clover's, a sensitive option a secret in env and headers.
      expect(m.contributes.mcpServers.deployer).toEqual({
        type: "stdio", command: "${plugin}/bin/server", args: ["--region", "${setting:region}", "--data", "${data}"],
        env: { DEPLOY_KEY: "${secret:api_key}", CLAUDE_PLUGIN_ROOT: "${plugin}", CLAUDE_PLUGIN_DATA: "${data}" },
      });
      expect(m.contributes.mcpServers.status).toEqual({ type: "http", url: "https://status.example.com/mcp", headers: { Authorization: "Bearer ${secret:api_key}" } });
      // Hooks: under sh, with the variables from their own arguments, timeouts kept (600 s unset).
      const hooks = m.contributes.hooks as { id: string; on: string[]; tools?: string[]; command: string; args?: string[]; timeoutMs: number }[];
      expect(hooks.map((h) => [h.on[0], h.tools, h.timeoutMs])).toEqual([["tool.before", ["Write", "Edit"], 30_000], ["turn.end", undefined, 600_000], ["message.in", undefined, 600_000]]);
      // Each keeps its own line, no `args`: the core runs it under `sh -c` with its input on stdin and Claude Code's
      // variables in its environment; a placeholder is never spliced into the line (hook-command.ts).
      expect(hooks.map((h) => [h.command, h.args])).toEqual([["${plugin}/hooks/check.sh", undefined], ["echo ${setting:region}", undefined], ['echo $HOME/x $USER""name', undefined]]);
      expect(Object.keys(m.contributes.mcpServers)).toEqual(["deployer", "status"]);
      // What has no place yet: named in the provenance and on the OK card.
      const unused = (await w.detail("claude-deploy-kit")).provenance.wrapped!.unused!;
      for (const part of ["output styles", "bin/", "the hook event SessionStart", "a Stop hook of type prompt", "the option hosts's several values (it keeps one)", "the server homebrew, which reads ${HOME} from your environment", "a UserPromptSubmit hook that reads ${NAME:-anon}"]) expect(unused).toContain(part);
      expect(unused.some((u) => u.startsWith("a PostToolUse hook whose matcher is a regular expression"))).toBe(true);
      const card = w.broker.cards().find((c) => c.id === r.card)!;
      expect(JSON.stringify(card)).toContain("Left in its folder unused");
      expect(JSON.stringify(card)).toContain("Claude Code plugin");
      // Its servers and hooks run: the grant, stated.
      expect((await w.detail("claude-deploy-kit")).provenance.wrapped!.network).toBe("any");
      expect(JSON.stringify(card)).toContain("It can reach any host on the network");
    } finally {
      w.opened.close();
    }
  });

  test("a folder of skills alone runs nothing: no grant, no engines", async () => {
    const w = await world();
    try {
      const bare = join(temp("clover-wrapc-bare-"), "notes");
      mkdirSync(join(bare, "skills", "jot"), { recursive: true });
      writeFileSync(join(bare, "skills", "jot", "SKILL.md"), "---\nname: jot\ndescription: Jot\n---\n");
      const r = await w.install("claude-plugin", bare);
      expect(r.id).toBe("claude-notes");
      expect(w.manifest("claude-notes").engines).toBeUndefined();
      expect((await w.detail("claude-notes")).provenance.wrapped).toEqual({ from: "claude-plugin" });
    } finally {
      w.opened.close();
    }
  });

  test("refused: a folder that's a Clover plugin, one that's nothing Claude Code reads, a path in plugin.json that leaves the folder", async () => {
    const w = await world();
    try {
      const base = temp("clover-wrapc-bad-");
      const clover = join(base, "clover");
      mkdirSync(join(clover, "skills"), { recursive: true });
      writeFileSync(join(clover, "clover.json"), "{}");
      const empty = join(base, "empty");
      mkdirSync(empty);
      writeFileSync(join(empty, "README.md"), "hi");
      expect(await w.refused("claude-plugin", clover)).toContain("it's a plugin already");
      expect(await w.refused("claude-plugin", empty)).toContain("isn't a Claude Code plugin folder");
      expect(await w.refused("claude-plugin", claudePlugin({ pluginJson: { hooks: "../../../etc/hooks.json" } }))).toContain("leaves the plugin's folder");
      expect(w.pluginsLeft()).toEqual([]);
    } finally {
      w.opened.close();
    }
  });

  test("claudeHooks: a matcher of tool names or *, the default timeout; a secret, or a line that would run its input, left unused", () => {
    const unused: string[] = [];
    const hooks = claudeHooks({
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x" }, { type: "command", command: "python3" }, { type: "command", command: "jq . && bash -s" }, { type: "command", command: "say ${user_config.tok}" }] }],
    }, { tok: { sensitive: true } }, unused);
    expect(hooks).toEqual([{ id: "hook-1", on: ["tool.before"], command: "x", timeoutMs: 600_000 }]);
    expect(unused).toEqual([
      "the sensitive option tok in hooks (a hook's environment carries no secret)",
      "a PreToolUse hook that would run its input as a script (python3)",
      "a PreToolUse hook that would run its input as a script (jq . && bash -s)",
      "a PreToolUse hook that reads ${user_config.tok}",
    ]);
  });
});

/** Waits until the registry has applied an OK's answer (the plugin leaves "found"), on its own change signal. */
function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => {
      if (registry.get(id)?.state !== "found") {
        off();
        resolve();
      }
    });
    if (registry.get(id)?.state !== "found") {
      off();
      resolve();
    }
  });
}

// A local server, as `npx` or `node` would start one: it tries a host it never declared, a listed one through its
// proxy (Node's plain fetch, which reads the proxy's env), and a file in the Clover home.
const probeScript = (o: { undeclared: number; listed: number; token: string }) => [
  "const net = require('node:net'); const fs = require('node:fs'); const out = {};",
  "const c = (h, p) => new Promise((r) => { const s = net.connect(p, h); s.setTimeout(5000, () => { s.destroy(); r('timeout'); }); s.on('connect', () => { s.end(); r('connected'); }); s.on('error', (e) => r(e.code || e.message)); });",
  "(async () => {",
  `out.undeclared = await c('127.0.0.1', ${o.undeclared});`,
  `try { fs.readFileSync(${JSON.stringify(o.token)}); out.token = 'read'; } catch (e) { out.token = e.code; }`,
  `try { out.listed = await (await fetch('http://127.0.0.1:${o.listed}/')).text(); } catch (e) { out.listed = String((e.cause && e.cause.code) || e.message); }`,
  "console.log(JSON.stringify(out)); })();",
].join("\n");

darwinDescribe("a wrapper's grant on real processes", () => {
  test.skipIf(Bun.which("node") === null)("a wrapped server reaches a host it never declared, fenced for files; a native plugin with no hosts reaches nothing; a wrapper edited to name a host is held to it and re-asked", async () => {
    const servers: { stop(force?: boolean): void }[] = [];
    const upstream = (text: string) => {
      const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(text) });
      servers.push(s);
      return s.port!;
    };
    const undeclared = upstream("undeclared");
    const listed = upstream("hello from the listed host");
    const w = await world();
    mkdirSync(join(w.home, "run"), { recursive: true });
    const token = join(w.home, "run", "app.token");
    writeFileSync(token, "dummy-token", { mode: 0o600 });
    const script = probeScript({ undeclared, listed, token });
    const ph = await startPluginHost({ home: w.home, computer: "Studio", registry: w.opened.registry, secrets: w.secrets, userHome: temp("clover-wrapn-user-") });
    const approve = async (id: string, card: string | undefined) => {
      const shown = w.broker.cards().find((c) => c.id === card)!;
      await w.broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: w.broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await approved(w.opened.registry, id);
    };
    const guard = {
      files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], proxyFor: ph.proxyFor,
      openNetwork: (id: string) => wrapperOpensNetwork(w.opened.registry, id),
    };
    const run = async (id: string) => {
      const r = w.opened.registry.get(id)!;
      const server = Object.values(r.manifest!.contributes!.mcpServers!)[0] as { command: string; args: string[] };
      const g = guardedMcpServer({ command: server.command, args: server.args, env: {} as Record<string, string> }, r.folder, guard, id);
      const proc = Bun.spawn([g.command, ...(g.args ?? [])], { env: g.env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
    };
    try {
      // The wrapper: installed from a pasted config, the grant on its record, approved.
      const wrapped = await w.install("mcp-config", JSON.stringify({ mcpServers: { probe: { command: "node", args: ["-e", script] } } }));
      expect(wrapped.id).toBe("mcp-probe");
      await approve("mcp-probe", wrapped.card);
      // A native code plugin with a local server and no hosts.
      const native = join(w.home, "plugins", "native");
      mkdirSync(native, { recursive: true });
      writeFileSync(join(native, "clover.json"), JSON.stringify({ manifest: 1, id: "native", name: "Native", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, contributes: { mcpServers: { probe: { type: "stdio", command: "node", args: ["-e", script] } } } }));
      await w.opened.folders.scan();
      const { card: nativeCard } = await w.opened.registry.installed("native", "app");
      await approve("native", nativeCard);

      const free = await run("mcp-probe");
      expect(free.undeclared).toBe("connected");
      expect(free.token).toBe("EPERM");
      const held = await run("native");
      expect(held.undeclared).not.toBe("connected");
      expect(held.listed).not.toBe("hello from the listed host");
      expect(held.token).toBe("EPERM");

      // The user edits the wrapper to name one host: held to it, and its OK is asked again.
      const folder = w.opened.registry.get("mcp-probe")!.folder;
      const m = JSON.parse(readFileSync(join(folder, "clover.json"), "utf8"));
      writeFileSync(join(folder, "clover.json"), JSON.stringify({ ...m, capabilities: [`network:127.0.0.1:${listed}`] }));
      await w.opened.folders.refresh(folder);
      expect(w.opened.registry.get("mcp-probe")?.state).toBe("found");
      expect(wrapperOpensNetwork(w.opened.registry, "mcp-probe")).toBe(false);
      const again = w.opened.folders.okText("mcp-probe", "macos", true);
      expect(again.lines.join(" ")).not.toContain("any host on the network");
      expect(again.lines.join(" ")).toContain(`127.0.0.1:${listed}`);
      const { card: reCard } = await w.opened.registry.installed("mcp-probe", "app");
      await approve("mcp-probe", reCard);
      const listedOnly = await run("mcp-probe");
      expect(listedOnly.undeclared).not.toBe("connected");
      expect(listedOnly.listed).toBe("hello from the listed host");
      expect(listedOnly.token).toBe("EPERM");
    } finally {
      for (const s of servers) s.stop(true);
      await ph.close();
      w.opened.close();
    }
  }, 120_000);
});
