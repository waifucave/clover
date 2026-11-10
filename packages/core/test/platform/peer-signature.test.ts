// The `app` role's peer-image check (platform/peer-signature.ts): the peer's code signature, read through its audit
// token. Every peer is a dummy this test starts itself (Apple's `nc`, a Bun child, an ad hoc C client); nothing is
// launched on screen and no real app runs.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRequirement, CLOVER_APP_IDENTIFIER, CLOVER_TEAM_ID } from "../../src/bundled-identities";
import { socketFd, type PeerFacts } from "../../src/platform/caller-probe";
import { peerHandle, type PeerHandle } from "../../src/platform/peer-handle";
import { appPeerByRequirement, auditTokenSatisfies, defaultAppPeerCheck } from "../../src/platform/peer-signature";
import { resolveEndpoint } from "../../src/platform/transport";
import { darwinTest } from "../helpers/darwin-only";

const DIST = appRequirement("dist");
const DEV = appRequirement("dev");
const NC = `identifier "com.apple.nc" and anchor apple`;

/** A peer process connects; the handle is taken in the listener's open, as the daemon takes it. `argv` gets the
 *  socket's path. */
async function connected(argv: (path: string) => string[]) {
  const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "lane-c-ps-"))).path;
  let got!: (h: PeerHandle | null) => void;
  const handle = new Promise<PeerHandle | null>((r) => { got = r; });
  const server = Bun.listen({ unix: path, socket: { open(s) { got(peerHandle(socketFd(s), "darwin")); }, data() {} } });
  const child = Bun.spawn(argv(path), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const h = await Promise.race([handle, child.exited.then(() => null)]);
  return { child, handle: h, stop: () => { child.kill(); server.stop(true); } };
}

const facts = (handle: PeerHandle | undefined): PeerFacts => ({ pid: handle?.pid ?? 1, ancestors: [], probe: {}, floor: "outside-floor", ...(handle ? { handle } : {}) });

/** A tiny client compiled here: linker-signed ad hoc, as any unsigned arm64 build is. */
function adHocClient(dir: string): string {
  const src = join(dir, "client.c");
  writeFileSync(src, `#include <sys/socket.h>
#include <sys/un.h>
#include <string.h>
#include <unistd.h>
int main(int c, char **v) { int s = socket(AF_UNIX, SOCK_STREAM, 0); struct sockaddr_un a; memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX; strncpy(a.sun_path, v[1], sizeof a.sun_path - 1);
  if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) return 1; sleep(20); return 0; }
`);
  const out = join(dir, "lane-c-client");
  const cc = spawnSync("cc", ["-o", out, src], { encoding: "utf8" });
  if (cc.status !== 0) throw new Error(`cc failed: ${cc.stderr}`);
  return out;
}

const bunTeam = process.platform === "darwin" ? /^TeamIdentifier=(\w+)$/m.exec(spawnSync("codesign", ["-dv", process.execPath], { encoding: "utf8" }).stderr ?? "")?.[1] : undefined;

describe("the app peer-image check", () => {
  test("the requirement per profile: the app's identifier, Apple's chain, Clover's team", () => {
    expect(DIST).toBe(`identifier "com.waifucave.clover" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(DEV).toBe(`identifier "com.waifucave.clover.dev" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(CLOVER_APP_IDENTIFIER).toEqual({ dist: "com.waifucave.clover", dev: "com.waifucave.clover.dev" });
    expect(() => appRequirement("dist", 'X" or anchor apple')).toThrow();
  });

  test("Linux and Windows make no check (none is faked); macOS does", () => {
    expect(defaultAppPeerCheck("linux", "dist")).toBeNull();
    expect(defaultAppPeerCheck("win32", "dev")).toBeNull();
    expect(defaultAppPeerCheck("darwin", "dist")).toBeFunction();
  });

  test("only an audit token counts: no handle, a pid-only handle or a token-less one is refused", () => {
    const pass = appPeerByRequirement(NC);
    const base = { pid: process.pid, alive: () => true, kill: () => false, probe: () => null, close() {} };
    expect(pass(facts(undefined))).toBe(false);
    expect(pass(facts({ ...base, via: "pid" }))).toBe(false);
    expect(pass(facts({ ...base, via: "token" }))).toBe(false);
    expect(pass(facts({ ...base, via: "token", auditToken: new Uint8Array(31) }))).toBe(false);
    expect(auditTokenSatisfies(new Uint8Array(32), NC)).toBe(false); // a token the kernel never gave names nothing
  });

  darwinTest("an Apple-signed peer passes its own requirement and neither of Clover's; once it's gone, nothing", async () => {
    const { child, handle, stop } = await connected((path) => ["/usr/bin/nc", "-U", path]);
    try {
      expect(handle?.via).toBe("token");
      expect(handle!.auditToken!.byteLength).toBe(32);
      expect(auditTokenSatisfies(handle!.auditToken, NC)).toBe(true);
      expect(appPeerByRequirement(NC)(facts(handle!))).toBe(true);
      expect(auditTokenSatisfies(handle!.auditToken, DIST)).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DEV)).toBe(false);
      expect(defaultAppPeerCheck("darwin", "dist")!(facts(handle!))).toBe(false);
      // The same token with another pid version names no process: a reused pid never passes as the one connected.
      const other = new Uint8Array(handle!.auditToken!);
      new DataView(other.buffer).setUint32(28, new DataView(other.buffer).getUint32(28, true) + 1, true);
      expect(auditTokenSatisfies(other, NC)).toBe(false);
      child.kill();
      await child.exited;
      expect(auditTokenSatisfies(handle!.auditToken, NC)).toBe(false);
    } finally { stop(); }
  });

  darwinTest("a Developer ID peer of another team (Bun's): the same requirement shape passes for its team, never Clover's", async () => {
    if (bunTeam === undefined || bunTeam === "not set") return; // a Bun built locally carries no team
    const client = (path: string) => `const s = await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); await Bun.sleep(20000); s.end();`;
    const { handle, stop } = await connected((path) => [process.execPath, "-e", client(path)]);
    try {
      expect(handle?.via).toBe("token");
      expect(auditTokenSatisfies(handle!.auditToken, `identifier "bun" and anchor apple generic and certificate leaf[subject.OU] = "${bunTeam}"`)).toBe(true);
      expect(auditTokenSatisfies(handle!.auditToken, `identifier "bun" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`)).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DIST)).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DEV)).toBe(false);
    } finally { stop(); }
  });

  darwinTest("an unsigned (ad hoc) peer is refused, even one that names itself com.waifucave.clover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-c-ps-bin-"));
    const plain = adHocClient(dir);
    const named = join(dir, "lane-c-client-named");
    copyFileSync(plain, named);
    chmodSync(named, 0o755);
    const sign = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", CLOVER_APP_IDENTIFIER.dist, named], { encoding: "utf8" });
    expect(sign.status).toBe(0);
    for (const [bin, id] of [[plain, undefined], [named, CLOVER_APP_IDENTIFIER.dist]] as const) {
      const { handle, stop } = await connected((path) => [bin, path]);
      try {
        expect(handle?.via).toBe("token");
        expect(auditTokenSatisfies(handle!.auditToken, DIST)).toBe(false);
        expect(auditTokenSatisfies(handle!.auditToken, DEV)).toBe(false);
        expect(defaultAppPeerCheck("darwin", "dist")!(facts(handle!))).toBe(false);
        // Not a token the check couldn't read: the identifier alone matches; Apple's chain and the team refuse it.
        if (id !== undefined) expect(auditTokenSatisfies(handle!.auditToken, `identifier "${id}"`)).toBe(true);
      } finally { stop(); }
    }
  });
});
