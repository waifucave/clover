// Try 14c, acceptance row 48 clause 4: after Alpha's plugin was installed on its OK card, her Edit of
// `<home>/plugins/ws-greeter/host/index.ts` passed Clover's approvals (the workshop, `insideWorkshop`) and came back
// "Edit failed: Error: protected host path access refused". The runtime's file tools check two lists: the session's
// sandbox (`botSandbox`), which opened the plugin, and the Worker's host protection (`embeddedHostPathProtection`),
// which write-denies `<home>/plugins` whole for every Worker (`selfGrantDenyWrite`) and so refused it.
//
// Now the Worker's host protection opens a plugin a bot built for the session whose own sandbox names it as a write
// root (`withWorkshopOpen`), and nothing else in `<home>/plugins`. Drawn here as the daemon draws it (the real fence
// following the registry's records, `botSandboxSettings`, `botSandbox`, the embedded host's spawn) and checked with
// the installed runtime's own `hostCodePathAllowed`, with the Worker's protection installed as the Worker installs it.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import type { EmbeddedWorkerProcess, SpawnEmbeddedWorkerOptions } from "@waifucave/clover-agent-runtime/embedded-host";
import { CloverFence } from "../../src/fence/fence";
import { botSandboxSettings } from "../../src/fence/sandbox-settings";
import { createEmbeddedSessionHost } from "../../src/runtime-sdk/embedded";
import { embeddedHostPathProtection, withWorkshopOpen, type EmbeddedHostPathProtection, type EmbeddedProtectionCapability } from "../../src/runtime-sdk/embedded-path-protection";
import { botSandbox } from "../../src/runtime-sdk/turn-loop/driver";

type Settings = { filesystem?: { allowWrite?: string[]; denyRead?: string[]; denyWrite?: string[] } };
interface Runtime {
  hostCodePathAllowed(path: string, access: "read" | "write", settings?: Settings, cwd?: string): boolean;
  installHostCodeProtection(value: EmbeddedHostPathProtection): { close(): void };
}

/** The installed runtime's own path check and host protection (its bundle chunk exports them; the package doesn't). */
async function runtime(): Promise<Runtime> {
  const dist = dirname(Bun.resolveSync("@waifucave/clover-agent-runtime", import.meta.dir));
  for (const f of readdirSync(dist)) {
    if (!f.endsWith(".js") || !readFileSync(join(dist, f), "utf8").includes("function hostCodePathAllowed(")) continue;
    const mod = await import(join(dist, f)) as Partial<Runtime>;
    if (typeof mod.hostCodePathAllowed === "function" && typeof mod.installHostCodeProtection === "function") return mod as Runtime;
  }
  throw new Error("the installed runtime has no hostCodePathAllowed");
}

const capability: EmbeddedProtectionCapability = { contractVersion: 1, capability: "host-code-path-protection-v1", coverage: {
  fileTools: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"], ordinarySandboxPathChecks: true, approvedEscapesKeepMainBehavior: true, contextReadChecksVersion: 1,
  sourceReaderFamilies: ["instructions-imports-memory", "rules", "output-styles", "settings-mcp", "skills", "agent-definitions", "plugin-components-manifests-installed", "commands", "workflow-source"],
} };

const ALPHA: Caller = { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" };
const LUNA: Caller = { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" };

const temps: { dir: string; locked: string[] }[] = [];
const leases: { close(): void }[] = [];
const hosts: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  for (const l of leases.splice(0)) l.close();
  for (const h of hosts.splice(0)) await h.shutdown();
});
afterAll(() => {
  for (const t of temps.splice(0)) {
    for (const l of t.locked) { try { chmodSync(l, 0o700); } catch { /* gone */ } }
    rmSync(t.dir, { recursive: true, force: true });
  }
});

/** A user's home on this disk (its Mail closed to this process, as on a Mac without Full Disk Access), a Clover home
 *  with Alpha's installed plugin and two others, and the registry's records. */
function world() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "workshop-host-")));
  const t = { dir: user, locked: [] as string[] };
  temps.push(t);
  const clover = join(user, ".clover");
  for (const d of ["plugins/ws-greeter/host", "plugins/fish-audio", "plugins/sol-tool", "scratch/alpha", "scratch/luna", "bots/alpha/memory", "Desktop", "Library/Mail"]) {
    mkdirSync(join(d.startsWith("Desktop") || d.startsWith("Library") ? user : clover, d), { recursive: true });
  }
  writeFileSync(join(clover, "plugins/ws-greeter/host/index.ts"), "export {}");
  chmodSync(join(user, "Library/Mail"), 0o000);
  t.locked.push(join(user, "Library/Mail"));
  let records = [
    { id: "ws-greeter", folder: join(clover, "plugins/ws-greeter"), provenance: { by: "bot", bot: "alpha" } },
    { id: "fish-audio", folder: join(clover, "plugins/fish-audio"), provenance: { by: "found" } },
    { id: "sol-tool", folder: join(clover, "plugins/sol-tool"), provenance: { by: "bot", bot: "sol" } },
  ];
  const fns = new Set<() => void>();
  const registry = { list: () => records, watch: (fn: () => void) => { fns.add(fn); return () => fns.delete(fn); } };
  const fence = new CloverFence({ home: user, cloverHome: clover });
  fence.followWorkshop(registry);
  const workshopFolders = () => records.filter((r) => r.provenance.by === "bot").map((r) => r.folder);
  const takeBack = (id: string) => { records = records.filter((r) => r.id !== id); for (const fn of fns) fn(); };
  return { user, clover, fence, workshopFolders, takeBack };
}

/** A session's sandbox as the daemon draws it (`sandboxOf`, then the driver's `botSandbox`), and the host protection its
 *  Worker is started with (the embedded host's own spawn, its config carrying that sandbox). */
function drawn(w: ReturnType<typeof world>, caller: Caller & { kind: "session" }) {
  const bot = caller.bot!;
  const sandbox = botSandbox(botSandboxSettings(w.fence.forCaller(caller).policy(), {
    cloverHome: w.clover, userHome: w.user, level: undefined, ownFolders: [join(w.clover, "scratch", bot), join(w.clover, "bots", bot)], pathFolders: [],
  }), { userHome: w.user, os: process.platform === "darwin" ? "macos" : "linux" });
  const prepared: Array<SpawnEmbeddedWorkerOptions & { hostCodeProtection?: EmbeddedHostPathProtection }> = [];
  let close!: (exit: { code: number; signal: null }) => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => { close = resolve; });
  const proc = { stdin: { write() {}, end() {} }, stdout: (async function* () {})(), exited, pid: null, state: "running",
    updateHostCodeProtection: async (p: EmbeddedHostPathProtection) => p.revision,
    kill() { close({ code: 0, signal: null }); }, terminate() { close({ code: 0, signal: null }); } } as unknown as EmbeddedWorkerProcess;
  const host = createEmbeddedSessionHost({ home: w.clover, hostPathProtectionCapability: capability, acceptedContextCoverageVersion: 1, workshopFolders: w.workshopFolders,
    spawnWorker: (o) => { prepared.push(o); return proc; } });
  host.spawn({ command: "clover-embedded", args: ["--run", "--config-json", JSON.stringify({ sessionId: caller.sessionId, sandbox })], cwd: w.clover, env: {} });
  hosts.push(host);
  return { sandbox: sandbox as Settings, protection: prepared[0]!.hostCodeProtection! };
}

test("Alpha's Edit of her installed plugin: allowed by both lists; a neighbour, another bot's plugin and the plugins folder stay refused", async () => {
  const rt = await runtime();
  const w = world();
  const file = join(w.clover, "plugins/ws-greeter/host/index.ts");
  // As it was: the host protection drawn without the workshop refuses it, whatever the session's sandbox says.
  const { sandbox, protection } = drawn(w, ALPHA as never);
  expect(sandbox.filesystem!.allowWrite).toContain(join(w.clover, "plugins/ws-greeter"));
  leases.push(rt.installHostCodeProtection({ ...embeddedHostPathProtection(w.clover, 1) }));
  expect(rt.hostCodePathAllowed(file, "write", sandbox, w.clover)).toBe(false);
  leases.splice(0).forEach((l) => l.close());
  // Now: the Worker's own protection opens it.
  leases.push(rt.installHostCodeProtection(protection));
  expect(rt.hostCodePathAllowed(file, "write", sandbox, w.clover)).toBe(true);
  expect(rt.hostCodePathAllowed(file, "read", sandbox, w.clover)).toBe(true);
  expect(rt.hostCodePathAllowed(join(w.clover, "plugins/ws-greeter/host/new.ts"), "write", sandbox, w.clover)).toBe(true);
  expect(rt.hostCodePathAllowed(join(w.user, "Desktop/a.md"), "write", sandbox, w.clover)).toBe(true);
  for (const p of [
    join(w.clover, "plugins/fish-audio/index.ts"), join(w.clover, "plugins/sol-tool/index.ts"),
    join(w.clover, "plugins/ws-greeter/.git/config"), join(w.clover, "plugins/node_modules/x/index.js"), join(w.user, "Library/Mail/x"),
  ]) expect([p, rt.hostCodePathAllowed(p, "write", sandbox, w.clover)]).toEqual([p, false]);
  // A new name in the plugins folder isn't in either list (the host protection now names the folder's entries one by
  // one): it is outside every write root, so the runtime runs a write there only on Clover's allow, and Clover's fence
  // refuses it (`plugins`) before any card.
  const fresh = join(w.clover, "plugins/new-plugin/index.ts");
  expect(sandbox.filesystem!.allowWrite!.some((r) => fresh.startsWith(`${r}/`))).toBe(false);
  expect(w.fence.forCaller(ALPHA).check({ op: "write", path: fresh })).toMatchObject({ allowed: false, reason: "plugins" });
  expect(w.fence.forCaller(ALPHA).check({ op: "write", path: file })).toEqual({ allowed: true });
});

test("another bot's session: its Worker opens nothing in the plugins folder", async () => {
  const rt = await runtime();
  const w = world();
  const { sandbox, protection } = drawn(w, LUNA as never);
  leases.push(rt.installHostCodeProtection(protection));
  expect(rt.hostCodePathAllowed(join(w.clover, "plugins/ws-greeter/host/index.ts"), "write", sandbox, w.clover)).toBe(false);
  expect(protection.denyWritePaths).toEqual(embeddedHostPathProtection(w.clover, 0).denyWritePaths);
});

test("taken back or uninstalled: the next draw (the driver reopens on the changed sandbox) refuses it again", async () => {
  const rt = await runtime();
  const w = world();
  const file = join(w.clover, "plugins/ws-greeter/host/index.ts");
  w.takeBack("ws-greeter");
  const { sandbox, protection } = drawn(w, ALPHA as never);
  expect(sandbox.filesystem!.allowWrite).not.toContain(join(w.clover, "plugins/ws-greeter"));
  leases.push(rt.installHostCodeProtection(protection));
  expect(rt.hostCodePathAllowed(file, "write", sandbox, w.clover)).toBe(false);
  // A sandbox that still named it (a session drawn before the take-back) opens nothing either: the records decide.
  const stale = withWorkshopOpen(embeddedHostPathProtection(w.clover, 0), w.clover, [join(w.clover, "plugins/ws-greeter")], w.workshopFolders());
  expect(stale.denyWritePaths).toEqual(embeddedHostPathProtection(w.clover, 0).denyWritePaths);
});
