// A child of the daemon that double-forks, calls `setsid` and is reparented away (launchd on macOS) is still the
// daemon's, never the user, however valid the token it holds (A's #416 gap). The user's own CLI, from a shell the
// daemon never started, still passes. Every process here is the test's own dummy: a Perl one-liner that connects to
// the test's own socket and sleeps; nothing reads another process's environment or arguments.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR } from "@waifucave/clover-protocol";
import { resolveCloverCaller, SessionProcesses } from "../../src/auth/clover-caller";
import { descendsFrom, probePeer, responsiblePid, type PeerFacts } from "../../src/platform/caller-probe";
import { selfArgv, spawnDisclaimed } from "../../src/platform/daemon-children";

const PERL = "/usr/bin/perl";
/** A dummy that connects to `$sock` after `double` (fork, setsid, fork) or straight away, writes its pid to `$pidf`
 *  once connected, and holds the connection. */
const CLIENT = `use POSIX qw(setsid); use IO::Socket::UNIX;
my ($sock, $pidf, $double) = @ARGV;
if ($double) {
  exit 0 if fork; setsid(); exit 0 if fork;
  # Connect only once reparented (the middle process gone), bounded at 20 s.
  my $mid = getppid(); my $n = 0;
  while (getppid() == $mid && $n++ < 1000) { select(undef, undef, undef, 0.02); }
}
my $c = IO::Socket::UNIX->new(Peer => $sock) or die "connect";
open(my $f, ">", "$pidf.tmp"); print $f $$; close $f; rename("$pidf.tmp", $pidf);
sleep 60;`;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* gone */ } } });

/** A Unix socket the test listens on (a short path: macOS caps it at 104 bytes), and the facts of each peer. */
async function listener() {
  const dir = mkdtempSync(join(tmpdir().length < 60 ? tmpdir() : "/tmp", "lc-"));
  const path = join(dir, "s");
  const peers: PeerFacts[] = [];
  const server = Bun.listen({ unix: path, socket: { open(s) { peers.push(probePeer(s)); }, data() {} } });
  cleanups.push(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, peers };
}

/** Waits for the dummy's pid file (the dummy writes it once connected), bounded. */
async function connectedPid(pidf: string): Promise<number> {
  const until = Date.now() + 20_000;
  while (!existsSync(pidf) && Date.now() < until) await Bun.sleep(50);
  const pid = Number(readFileSync(pidf, "utf8"));
  cleanups.push(() => process.kill(pid, "SIGKILL"));
  return pid;
}

/** The facts of the peer whose pid is `pid`, once the listener has probed it. */
async function factsOf(peers: PeerFacts[], pid: number): Promise<PeerFacts> {
  const until = Date.now() + 20_000;
  for (;;) {
    const f = peers.find((p) => p.pid === pid);
    if (f !== undefined) return f;
    if (Date.now() > until) throw new Error("the dummy's connection was never probed");
    await Bun.sleep(20);
  }
}

darwinDescribe("macOS: a reparented child is still the daemon's (A's #416 gap)", () => {
  test("a double-forked, setsid'd child of a process the daemon started on its own responsibility is refused; the user's CLI passes", async () => {
    const { dir, path, peers } = await listener();
    // The dummy "daemon spawn": started disclaimed, as the process holder and `supervise`'s daemon are, so it is its
    // own responsible process. It starts the dummy that double-forks away, then stays a little.
    const pidf = join(dir, "gc.pid");
    const spawn = spawnDisclaimed(["/bin/sh", "-c", `${PERL} -e '${CLIENT.replace(/'/g, "'\\''")}' '${path}' '${pidf}' 1; sleep 30`], { PATH: "/usr/bin:/bin" });
    expect(spawn).not.toBeNull();
    cleanups.push(() => process.kill(spawn!.pid, "SIGKILL"));
    const gc = await connectedPid(pidf);
    const facts = await factsOf(peers, gc);
    // Reparented away from the dummy (launchd), and its own session leader's child: no parent chain leads back.
    expect(facts.ancestors.includes(spawn!.pid)).toBe(false);
    expect(facts.responsible).toBe(spawn!.pid);
    expect(responsiblePid(spawn!.pid)).toBe(spawn!.pid);
    const processes = new SessionProcesses();
    processes.add(spawn!.pid); // what A's #416 notes at the spawn site
    for (const role of ["cli", "app"] as const) {
      const c = resolveCloverCaller({ binding: { role }, peer: facts, processes, daemonPid: spawn!.pid });
      expect([role, "code" in c ? c.code : c]).toEqual([role, CLOVER_ERR.NOT_THE_USER]);
    }
    // The user's own CLI: a process the dummy daemon never started, from the test's own shell (as a terminal's), double-
    // forked too, so the test process (which `probePeer` takes for this process's daemon) isn't among its parents
    // either: only the responsible process tells the two apart, and it is the test's own, not the dummy's.
    const userPidf = join(dir, "user.pid");
    const user = Bun.spawn([PERL, "-e", CLIENT, path, userPidf, "1"], { stdout: "ignore", stderr: "ignore" });
    await user.exited;
    const up = await connectedPid(userPidf);
    const userFacts = await factsOf(peers, up);
    expect(userFacts.responsible).not.toBe(spawn!.pid);
    expect(resolveCloverCaller({ binding: { role: "cli" }, peer: userFacts, processes, daemonPid: spawn!.pid })).toEqual({ kind: "user", client: "cli" });
  }, 60_000);
});

darwinDescribe("macOS: the daemon makes itself its own responsible process", () => {
  test("a process that isn't re-executes itself in place (the same pid), once, and then is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-c-own-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, "own.ts");
    const src = join(import.meta.dir, "..", "..", "src", "platform", "daemon-children.ts");
    const probe = join(import.meta.dir, "..", "..", "src", "platform", "caller-probe.ts");
    // A dummy standing in for the daemon's start: it says its pid and whether it is its own responsible process, then
    // calls becomeOwnResponsible (which re-executes it when it isn't).
    await Bun.write(script, `import { becomeOwnResponsible } from ${JSON.stringify(src)};
import { responsiblePid } from ${JSON.stringify(probe)};
console.log(\`start \${process.pid} \${responsiblePid(process.pid) === process.pid}\`);
console.log(\`result \${becomeOwnResponsible()} sentinel=\${process.env.CLOVER_REEXEC ?? "none"}\`);
`);
    const r = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: dir } });
    const lines = r.stdout.toString().trim().split("\n");
    expect(lines.length).toBe(3);
    const [first, second, result] = lines;
    const pid = first!.split(" ")[1];
    expect(first).toBe(`start ${pid} false`); // started by the test: not its own
    expect(second).toBe(`start ${pid} true`); // re-executed in place: the same pid, now its own
    expect(result).toBe("result own sentinel=none"); // the sentinel never reaches what the daemon starts
  }, 60_000);

  test("once only: a re-exec whose disclaim didn't take stops at the second start, and no child inherits the sentinel (#418's review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-c-own-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, "loop.ts");
    const src = join(import.meta.dir, "..", "..", "src", "platform", "daemon-children.ts");
    const probe = join(import.meta.dir, "..", "..", "src", "platform", "caller-probe.ts");
    // The disclaim is left out, as if it didn't take: without the sentinel this would re-exec forever.
    await Bun.write(script, `import { becomeOwnResponsible } from ${JSON.stringify(src)};
import { responsiblePid } from ${JSON.stringify(probe)};
console.log(\`start \${process.pid} \${responsiblePid(process.pid) === process.pid}\`);
console.log(\`result \${becomeOwnResponsible({ disclaim: false })} sentinel=\${process.env.CLOVER_REEXEC ?? "none"}\`);
`);
    const r = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: dir }, timeout: 30_000 });
    const lines = r.stdout.toString().trim().split("\n");
    expect(lines.length).toBe(3);
    const pid = lines[0]!.split(" ")[1];
    expect(lines).toEqual([`start ${pid} false`, `start ${pid} false`, "result failed sentinel=none"]);
  }, 60_000);
});

(process.platform === "linux" ? describe : describe.skip)("Linux: a reparented child is still the daemon's (A's #416 gap)", () => {
  test("a double-forked, setsid'd child is reparented to the subreaper daemon and refused", async () => {
    // A dummy daemon of its own (a child Bun process, so the test runner itself never becomes a subreaper): it claims
    // its children as the daemon does at start, listens, starts the double-forking dummy, and says only true or false.
    const dir = mkdtempSync(join(tmpdir(), "lc-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(import.meta.dir, "..", "..", "src");
    const script = join(dir, "daemon.ts");
    await Bun.write(script, `import { claimDaemonChildren } from ${JSON.stringify(join(root, "platform", "daemon-children.ts"))};
import { probePeer } from ${JSON.stringify(join(root, "platform", "caller-probe.ts"))};
import { resolveCloverCaller, SessionProcesses } from ${JSON.stringify(join(root, "auth", "clover-caller.ts"))};
import { darwinDescribe } from "../helpers/darwin-only";
if (!claimDaemonChildren().subreaper) { console.log("no-subreaper"); process.exit(0); }
const path = ${JSON.stringify(join(dir, "s"))};
let done = false;
Bun.listen({ unix: path, socket: { open(s) {
  const facts = probePeer(s);
  const c = resolveCloverCaller({ binding: { role: "cli" }, peer: facts, processes: new SessionProcesses(), daemonPid: process.pid });
  console.log(\`ancestors-has-daemon=\${facts.ancestors.includes(process.pid)} refused=\${"code" in c}\`);
  if (facts.pid !== null) process.kill(facts.pid, "SIGKILL");
  done = true;
}, data() {} } });
Bun.spawn([${JSON.stringify(PERL)}, "-e", ${JSON.stringify(CLIENT)}, path, ${JSON.stringify(join(dir, "gc.pid"))}, "1"], { stdout: "ignore", stderr: "ignore" });
const until = Date.now() + 20000;
while (!done && Date.now() < until) await Bun.sleep(50);
process.exit(0);
`);
    const r = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: dir } });
    const out = r.stdout.toString().trim();
    if (out === "no-subreaper") return; // the kernel refused: the floor alone tells such a child (the daemon logs it)
    expect(out).toBe("ancestors-has-daemon=true refused=true");
  }, 60_000);
});

describe("the responsible process in the caller check", () => {
  test("descendsFrom counts a peer responsible to a noted pid, wherever its parents went", () => {
    const facts = { pid: 500, ancestors: [1], responsible: 42 };
    expect(descendsFrom(facts, new Set([42]))).toBe(true);
    expect(descendsFrom(facts, new Set([7]))).toBe(false);
    expect(descendsFrom({ pid: 500, ancestors: [1] }, new Set([42]))).toBe(false);
  });

  test("selfArgv: a compiled binary reruns with its own arguments, a script under its runtime and its runtime flags", () => {
    expect(selfArgv(["bun", "/$bunfs/root/clover", "daemon", "run"], "/opt/clover/clover", [])).toEqual(["/opt/clover/clover", "daemon", "run"]);
    expect(selfArgv(["/usr/local/bin/bun", "/repo/packages/cli/src/main.ts", "daemon", "run"], "/usr/local/bin/bun", [])).toEqual(["/usr/local/bin/bun", "/repo/packages/cli/src/main.ts", "daemon", "run"]);
    expect(selfArgv(["/usr/local/bin/bun", "/repo/main.ts", "daemon", "run"], "/usr/local/bin/bun", ["--smol", "--preload", "/p.ts"])).toEqual(["/usr/local/bin/bun", "--smol", "--preload", "/p.ts", "/repo/main.ts", "daemon", "run"]);
  });
});
