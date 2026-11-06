import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { macFenceProfile } from "../../src/fence/macos-profile";
import type { FencedRunResult } from "../../src/fence/spawn";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: "macos", home, cloverHome: clover, temp });
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

describe.skipIf(!mac)("macOS: a command under the fence, on a real sandbox-exec", () => {
  test("the fenced items, however they're named, can't be written; the home and temp can; nothing else", async () => {
    const w = world();
    for (const target of ["settings.json", "SETTINGS.json", "ſettings.json", "settings/new.json", "plugins-state/oks/x.json", "PLUGINS-STATE/OKS/y.json"]) {
      expect(ok(await w.run(`echo x > '${join(w.clover, target)}'`))).toBe(false);
    }
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}' && mkdir '${join(w.clover, "scratch")}'`))).toBe(true);
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
    expect(ok(await w.run(`mkdir -p '${join(w.home, "project", "nötes")}'`))).toBe(true); // the user's own names elsewhere
    expect(ok(await w.run("/usr/bin/open -g -j /nonexistent-lane-c"))).toBe(false);
    expect(ok(await w.run("/bin/launchctl print system >/dev/null"))).toBe(false);
  }, 60_000);

  test("no network: a listening loopback port and a Unix socket (as the daemon's) are both out of reach", async () => {
    const w = world();
    let tcpSeen = 0, unixSeen = 0;
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { tcpSeen++; }, data() {} } });
    const sock = join(w.root, "d.sock");
    const unix = Bun.listen({ unix: sock, socket: { open() { unixSeen++; }, data() {} } });
    try {
      // Reachable from outside the sandbox, so a refusal inside is the sandbox's.
      const outside = Bun.spawnSync(["/usr/bin/nc", "-z", "-w", "2", "127.0.0.1", String(tcp.port)]);
      expect(outside.exitCode).toBe(0);
      expect(ok(await w.run(`/usr/bin/nc -z -w 2 127.0.0.1 ${tcp.port}`))).toBe(false);
      expect(ok(await w.run(`/usr/bin/nc -z -w 2 -U '${sock}'`))).toBe(false);
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
