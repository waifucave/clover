import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestry, descendsFrom, parentPid, probePeer, socketFd, type PeerFacts } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";

const posix = process.platform === "darwin" || process.platform === "linux";

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

  test.skipIf(!posix)("a parent chain: ours starts at our parent", () => {
    expect(parentPid(process.pid)).toBe(process.ppid);
    const chain = ancestry(process.pid);
    expect(chain[0]).toBe(process.ppid);
    expect(new Set(chain).size).toBe(chain.length);
    expect(parentPid(2 ** 30)).toBeNull();
  });

  test.skipIf(!posix)("a client in this process: its pid, outside every floor", async () => {
    const l = listenOnce();
    const c = await Bun.connect({ unix: l.path, socket: { data() {} } });
    const peer = await l.peer;
    expect(peer.fd).not.toBeNull();
    expect(peer.pid).toBe(process.pid);
    expect(peer.floor).toBe("outside-floor");
    expect(peer.ancestors[0]).toBe(process.ppid);
    c.end(); l.stop();
  });

  test.skipIf(!posix)("a client in a child process: the child's pid, under us in the tree", async () => {
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

  test.skipIf(process.platform !== "linux")("Linux: a client in its own user namespace is fenced", async () => {
    const probe = Bun.spawnSync(["unshare", "-Ur", "true"]);
    if (probe.exitCode !== 0) return; // unprivileged user namespaces are off here (Ubuntu's AppArmor default)
    const l = listenOnce();
    const child = Bun.spawn(["unshare", "-Ur", process.execPath, "-e", CLIENT(l.path)], { stdout: "ignore", stderr: "ignore" });
    const peer = await l.peer;
    expect(peer.probe).toEqual({ inHostNamespacesLinux: false });
    expect(peer.floor).toBe("fenced");
    child.kill(); l.stop();
  });
});
