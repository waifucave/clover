import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePeer, socketFd } from "../../src/platform/caller-probe";
import { peerHandle, type PeerHandle } from "../../src/platform/peer-handle";
import { resolveEndpoint } from "../../src/platform/transport";

const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const CLIENT = (path: string) => `const s = await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); await Bun.sleep(20000); s.end();`;

/** A child connects; the handle is taken in the listener's open, as the daemon takes it. */
async function connectedChild(argv: (client: string) => string[] = (c) => [process.execPath, "-e", c]) {
  const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-ph-"))).path;
  let got!: (h: PeerHandle | null) => void;
  const handle = new Promise<PeerHandle | null>((r) => { got = r; });
  const server = Bun.listen({ unix: path, socket: { open(s) { got(peerHandle(socketFd(s), os)); }, data() {} } });
  const child = Bun.spawn(argv(CLIENT(path)), { stdout: "ignore", stderr: "ignore", windowsHide: true });
  return { child, handle: await handle, stop: () => server.stop(true) };
}

describe("a connection's peer, held by what names the process (review S5)", () => {
  test("a handle that no longer names the connected process fences the caller, whatever its pid looks like now", () => {
    const fake = (alive: boolean): PeerHandle => ({ pid: process.pid, via: "pidfd", alive: () => alive, kill: () => false, probe: () => ({ inHostNamespacesLinux: true }), close() {} });
    expect(probePeer(null, "linux", undefined, fake(true))).toMatchObject({ pid: process.pid, floor: "outside-floor" });
    expect(probePeer(null, "linux", undefined, fake(false))).toMatchObject({ pid: process.pid, floor: "fenced" });
    // A pid the probe would otherwise read is ignored for the handle's.
    expect(probePeer(null, "linux", 1, fake(true)).pid).toBe(process.pid);
  });

  test.skipIf(os === "win32")("macOS and Linux: the peer's token or pidfd; alive while it runs, killed through it, then gone", async () => {
    const { child, handle, stop } = await connectedChild();
    try {
      expect(handle).not.toBeNull();
      expect(handle!.pid).toBe(child.pid);
      expect(handle!.via).toBe(os === "darwin" ? "token" : handle!.via === "pid" ? "pid" : "pidfd");
      if (os === "linux") console.log(`[peer-handle] linux held by ${handle!.via}`);
      expect(handle!.alive()).toBe(true);
      if (os === "darwin" && process.arch === "arm64") expect(handle!.probe()).toEqual({ sandboxedMac: false });
      if (handle!.via === "pidfd") expect(handle!.probe()).toEqual({ inHostNamespacesLinux: true });
      expect(handle!.kill()).toBe(true);
      await child.exited;
      expect(handle!.alive()).toBe(false);
      expect(handle!.kill()).toBe(false); // never a signal to whatever has the pid next
      expect(probePeer(null, os, undefined, handle).floor).toBe("fenced");
      handle!.close();
    } finally { child.kill(); stop(); }
  });

  test.skipIf(os !== "darwin" || process.arch !== "arm64")("macOS: a sandboxed peer is fenced through its audit token", async () => {
    const { child, handle, stop } = await connectedChild((c) => ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", process.execPath, "-e", c]);
    try {
      expect(handle!.pid).toBe(child.pid); // sandbox-exec execs the command, so the peer is the child itself
      expect(handle!.probe()).toEqual({ sandboxedMac: true });
      expect(probePeer(null, "darwin", undefined, handle).floor).toBe("fenced");
    } finally { child.kill(); stop(); }
  });

  test.skipIf(os !== "win32")("Windows: the client's process handle, opened at once and held; the kill goes through it", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(20000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    const handle = peerHandle(null, "win32", child.pid)!;
    try {
      expect(handle.via).toBe("handle");
      expect(handle.alive()).toBe(true);
      expect(handle.kill()).toBe(true);
      await child.exited;
      expect(handle.alive()).toBe(false);
      expect(handle.kill()).toBe(false);
      handle.close();
      expect(handle.alive()).toBe(false);
    } finally { child.kill(); }
  });
});
