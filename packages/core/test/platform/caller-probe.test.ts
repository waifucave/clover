import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestry, descendsFrom, parentPid, probePeer, socketFd, spawnedByDaemon, WindowsPipePeers, type PeerFacts } from "../../src/platform/caller-probe";
import { claimDaemonChildren, spawnDisclaimed } from "../../src/platform/daemon-children";
import { resolveEndpoint } from "../../src/platform/transport";


/** Listen on a fresh endpoint and resolve with the probe of the first connection's peer. */
function listenOnce(): { path: string; peer: Promise<PeerFacts & { fd: number | null }>; stop(): void } {
  const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-peer-"))).path;
  let resolve!: (f: PeerFacts & { fd: number | null }) => void;
  const peer = new Promise<PeerFacts & { fd: number | null }>((r) => { resolve = r; });
  const server = Bun.listen({ unix: path, socket: { open(s) { resolve({ ...probePeer(s), fd: socketFd(s) }); }, data() {} } });
  return { path, peer, stop: () => server.stop(true) };
}

const CLIENT = (path: string) => `const s = await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); await Bun.sleep(4000); s.end();`;

describe("the caller check's OS probe", () => {
  test("an unknown peer is fenced, never the user", () => {
    expect(socketFd(null)).toBeNull();
    expect(socketFd({ fd: -1 })).toBeNull();
    expect(probePeer({})).toEqual({ pid: null, ancestors: [], probe: {}, floor: "fenced" });
  });

  test("the process-tree half: a peer under a process the daemon started is that process's command", () => {
    const facts = { pid: 40, ancestors: [30, 20, 1] };
    expect(descendsFrom(facts, new Set([30]))).toBe(true);
    expect(descendsFrom(facts, new Set([40]))).toBe(true);
    expect(descendsFrom(facts, new Set([99]))).toBe(false);
    expect(descendsFrom({ pid: null, ancestors: [] }, new Set([1]))).toBe(false);
  });

  test("a parent chain: ours starts at our parent", () => {
    expect(parentPid(process.pid)).toBe(process.ppid);
    const chain = ancestry(process.pid);
    expect(chain[0]).toBe(process.ppid);
    expect(new Set(chain).size).toBe(chain.length);
    expect(parentPid(2 ** 30)).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("Windows: the pipe's peer from the daemon's own handles, then its token", async () => {
    const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-peer-"))).path;
    const peers = new WindowsPipePeers();
    const seen: Array<number | null> = [];
    const server = Bun.listen({ unix: path, socket: {
      open(s) { seen.push(peers.opened(s)); },
      close(s) { peers.closed(s); },
      data() {},
    } });
    const until = async (n: number) => { for (let i = 0; i < 200 && seen.length < n; i++) await Bun.sleep(10); };
    const self = await Bun.connect({ unix: path, socket: { data() {} } });
    await until(1);
    expect(seen[0]).toBe(process.pid); // the first instance's end (access 0x1e019f) as well as later ones
    const a = Bun.spawn([process.execPath, "-e", CLIENT(path)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    await until(2);
    const b = Bun.spawn([process.execPath, "-e", CLIENT(path)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    await until(3);
    expect(seen.slice(1)).toEqual([a.pid, b.pid]);
    const facts = probePeer(null, "win32", seen[1]!);
    expect(facts.probe).toEqual({ tokenRestrictedWin: false, appContainerWin: false });
    expect(facts.floor).toBe("outside-floor");
    expect(descendsFrom(facts, new Set([process.pid]))).toBe(true);
    a.kill(); b.kill(); self.end(); server.stop(true);
  });

  test.skipIf(process.platform !== "win32")("Windows: only this endpoint's ends count; another pipe the daemon serves never does (review S4)", async () => {
    const pathA = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-peer-"))).path;
    const pathB = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-peer-"))).path;
    const peers = new WindowsPipePeers(pathA);
    const seen: Array<number | null> = [];
    const other = Bun.listen({ unix: pathB, socket: { data() {} } }); // its ends are this process's too
    const server = Bun.listen({ unix: pathA, socket: { open(s) { seen.push(peers.opened(s)); }, close(s) { peers.closed(s); }, data() {} } });
    const b = Bun.spawn([process.execPath, "-e", CLIENT(pathB)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    await Bun.sleep(500); // b's end on the other pipe is connected before a's
    const a = Bun.spawn([process.execPath, "-e", CLIENT(pathA)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    for (let i = 0; i < 200 && seen.length < 1; i++) await Bun.sleep(10);
    expect(seen).toEqual([a.pid]);
    a.kill(); b.kill(); server.stop(true); other.stop(true);
  });

  test.skipIf(process.platform === "win32")("a client in this process: its pid, outside every floor", async () => {
    const l = listenOnce();
    const c = await Bun.connect({ unix: l.path, socket: { data() {} } });
    const peer = await l.peer;
    expect(peer.fd).not.toBeNull();
    expect(peer.pid).toBe(process.pid);
    expect(peer.floor).toBe("outside-floor");
    expect(peer.ancestors[0]).toBe(process.ppid);
    c.end(); l.stop();
  });

  test.skipIf(process.platform === "win32")("a client in a child process: the child's pid, under us in the tree", async () => {
    const l = listenOnce();
    const child = Bun.spawn([process.execPath, "-e", CLIENT(l.path)], { stdout: "ignore", stderr: "ignore" });
    const peer = await l.peer;
    expect(peer.pid).toBe(child.pid);
    expect(descendsFrom(peer, new Set([process.pid]))).toBe(true);
    expect(peer.floor).toBe("outside-floor");
    child.kill(); l.stop();
  });

  test.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("macOS: a client under a Seatbelt profile is fenced, even one that allows everything", async () => {
    const l = listenOnce();
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", process.execPath, "-e", CLIENT(l.path)], { stdout: "ignore", stderr: "ignore" });
    const peer = await l.peer;
    expect(peer.pid).toBe(child.pid); // sandbox-exec execs in place
    expect(peer.probe).toEqual({ sandboxedMac: true });
    expect(peer.floor).toBe("fenced");
    child.kill(); l.stop();
  });

  test.skipIf(process.platform !== "linux")("Linux: a client in its own namespaces (unshare, or bubblewrap) is fenced", async () => {
    // Ubuntu 24.04 turns unprivileged user namespaces off for unshare but lets bubblewrap make them.
    const wrappers = [["unshare", "-Ur"], ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid"]];
    const wrap = wrappers.find((w) => { try { return Bun.spawnSync([...w, "true"]).exitCode === 0; } catch { return false; } });
    if (wrap === undefined) return; // no way to make a namespace here
    const l = listenOnce();
    const child = Bun.spawn([...wrap, process.execPath, "-e", CLIENT(l.path)], { stdout: "ignore", stderr: "ignore" });
    const peer = await l.peer;
    expect(peer.probe).toEqual({ inHostNamespacesLinux: false });
    expect(peer.floor).toBe("fenced");
    expect(descendsFrom(peer, new Set([child.pid]))).toBe(true); // the wrapper is in its tree
    child.kill(); l.stop();
  });

  test("review B1: what the daemon starts stays its own, a double fork included (Linux's subreaper, Windows' job)", async () => {
    const claimed = claimDaemonChildren();
    if (process.platform === "linux") expect(claimed.subreaper).toBe(true);
    if (process.platform === "win32") expect(claimed.job).toBe(true);
    // A child that starts a grandchild. On POSIX it exits at once, orphaning the grandchild (a double fork); on
    // Windows it stays, since libuv's own job ends a child's children with it (measured), so a grandchild there
    // outlives its parent only by breaking away, which the daemon's job refuses.
    const leave = process.platform === "win32" ? "" : "process.exit(0);";
    const script = `const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 20000)"], { stdio: ["ignore", "ignore", "ignore"] }); g.unref(); console.log(g.pid); ${leave} setTimeout(() => {}, 20000);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const reader = child.stdout.getReader();
    let text = "";
    while (!/\n/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    reader.releaseLock();
    const g = Number(text.trim());
    if (process.platform !== "win32") await child.exited;
    await Bun.sleep(200);
    const ancestors = ancestry(g);
    if (process.platform === "linux") expect(ancestors[0]).toBe(process.pid); // re-parented to us, not to init
    if (process.platform !== "darwin") expect(spawnedByDaemon(g, ancestors)).toBe(true);
    expect(spawnedByDaemon(child.pid, [process.pid])).toBe(true);
    expect(spawnedByDaemon(process.pid, ancestry(process.pid))).toBe(false); // the daemon itself
    try { process.kill(g); } catch { /* gone */ }
    child.kill();
  }, 30_000);

  test.skipIf(process.platform !== "darwin")("review B1 on macOS: under supervise's disclaimed start, a double-forked grandchild still names the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-resp-"));
    const out = join(dir, "result.json");
    const probe = JSON.stringify(join(import.meta.dir, "..", "..", "src", "platform", "caller-probe.ts"));
    // The "daemon": started as supervise starts it, it double-forks a grandchild (its child exits at once, so
    // launchd adopts the grandchild), then asks the caller check about it.
    const daemon = `
      import { ancestry, spawnedByDaemon } from ${probe};
      import { dlopen, FFIType } from "bun:ffi";
      const resp = dlopen("/usr/lib/libSystem.B.dylib", { responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 } }).symbols.responsibility_get_pid_responsible_for_pid;
      const c = Bun.spawn([process.execPath, "-e", 'const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 20000)"], { stdio: ["ignore", "ignore", "ignore"] }); g.unref(); console.log(g.pid); process.exit(0);'], { stdout: "pipe" });
      const g = Number((await new Response(c.stdout).text()).trim());
      await c.exited; await Bun.sleep(300);
      const a = ancestry(g);
      await Bun.write(${JSON.stringify(out)}, JSON.stringify({ self: resp(process.pid) === process.pid, adopted: !a.includes(process.pid), spawned: spawnedByDaemon(g, a), outsider: spawnedByDaemon(process.ppid, ancestry(process.ppid)) }));
      process.kill(g);`;
    const d = spawnDisclaimed([process.execPath, "-e", daemon]);
    expect(d).not.toBeNull();
    expect(await d!.exited).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ self: true, adopted: true, spawned: true, outsider: false });
  }, 30_000);

  test.skipIf(process.platform !== "win32")("review B1 on Windows: an orphan whose parent isn't Bun and exits first stays in the daemon's job", async () => {
    expect(claimDaemonChildren().job).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "clover-orphan-"));
    const pidFile = join(dir, "pid");
    const sleeper = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000);`;
    // cmd's `start /b` starts the grandchild and cmd exits at once; libuv's job, which holds cmd, allows silent breakaway.
    const cmd = Bun.spawn(["cmd.exe", "/c", "start", "", "/b", process.execPath, "-e", sleeper], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    await cmd.exited;
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const g = Number(readFileSync(pidFile, "utf8"));
    expect(spawnedByDaemon(g, ancestry(g))).toBe(true);
    try { process.kill(g); } catch { /* gone */ }
  }, 30_000);
});
