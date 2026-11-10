// The `app` role's peer-image check (platform/peer-signature.ts): the peer's code signature, read through its audit
// token, then its hardening. Every peer is a dummy this test starts itself (Apple's `nc`, a Bun child, an ad hoc C
// client signed here with and without the hardened runtime and entitlements); nothing is launched on screen.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRequirement, CLOVER_APP_IDENTIFIER, CLOVER_TEAM_ID, DEVELOPER_ID_CLAUSES } from "../../src/bundled-identities";
import { socketFd, type PeerFacts } from "../../src/platform/caller-probe";
import { peerHandle, type PeerHandle } from "../../src/platform/peer-handle";
import { appPeerByRequirement, appPeerRequirement, auditTokenSatisfies, defaultAppPeerCheck, OPENING_ENTITLEMENTS, type AppPeerCheck } from "../../src/platform/peer-signature";
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
const check = (policy: ReturnType<typeof defaultAppPeerCheck>): AppPeerCheck => {
  if (policy === "none") throw new Error("expected a check");
  return policy;
};

/** The C client copied and signed ad hoc as `identifier`, hardened or not, with `entitlements` (names set true). */
function signedCopy(plain: string, dir: string, name: string, o: { runtime: boolean; entitlements?: readonly string[] }): string {
  const out = join(dir, name);
  copyFileSync(plain, out);
  chmodSync(out, 0o755);
  const args = ["--force", "--sign", "-", "--identifier", name];
  if (o.runtime) args.push("--options", "runtime");
  if (o.entitlements !== undefined) {
    const plist = join(dir, `${name}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${o.entitlements.map((e) => `<key>${e}</key><true/>`).join("")}</dict></plist>
`);
    args.push("--entitlements", plist);
  }
  const sign = spawnSync("codesign", [...args, out], { encoding: "utf8" });
  if (sign.status !== 0) throw new Error(`codesign failed: ${sign.stderr}`);
  return out;
}

describe("the app peer-image check", () => {
  test("the requirement per profile: dist names a Developer ID Application leaf, dev Apple's chain and the team", () => {
    expect(DEVELOPER_ID_CLAUSES).toBe("certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]");
    expect(DIST).toBe(`identifier "com.waifucave.clover" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(DEV).toBe(`identifier "com.waifucave.clover.dev" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(CLOVER_APP_IDENTIFIER).toEqual({ dist: "com.waifucave.clover", dev: "com.waifucave.clover.dev" });
    expect(() => appRequirement("dist", 'X" or anchor apple')).toThrow();
    // A daemon that is itself Developer ID signed holds the app to Developer ID; one that isn't (the owner's
    // --sign-dev alpha, a checkout) to Apple's chain and the team, so it doesn't refuse its own app.
    expect(appPeerRequirement("dist", () => true)).toBe(DIST);
    expect(appPeerRequirement("dist", () => false)).toBe(appRequirement("dist", CLOVER_TEAM_ID, false));
    expect(appPeerRequirement("dev", () => true)).toBe(DEV);
    // The real app's entitlements open none of it.
    const ents = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packaging", "macos", "entitlements.mac.plist"), "utf8");
    for (const e of OPENING_ENTITLEMENTS) expect(ents).not.toContain(e);
  });

  test("Linux and Windows make no check (none is faked, and it is named); macOS does", () => {
    expect(defaultAppPeerCheck("linux", "dist")).toBe("none");
    expect(defaultAppPeerCheck("win32", "dev")).toBe("none");
    expect(defaultAppPeerCheck("darwin", "dist")).toBeFunction();
  });

  test("only an audit token counts: no handle, a pid-only handle or a token-less one is refused", () => {
    const pass = appPeerByRequirement(NC);
    const base = { pid: process.pid, alive: () => true, kill: () => false, probe: () => null, close() {} };
    expect(pass(facts(undefined))).toBe(false);
    expect(pass(facts({ ...base, via: "pid" }))).toBe(false);
    expect(pass(facts({ ...base, via: "token" }))).toBe(false);
    expect(pass(facts({ ...base, via: "token", auditToken: new Uint8Array(31) }))).toBe(false);
    expect(auditTokenSatisfies(new Uint8Array(32), NC, { hardened: false })).toBe(false); // a token the kernel never gave
  });

  darwinTest("an Apple-signed peer: its own requirement matches, Clover's never; unhardened, it is refused; once gone, nothing", async () => {
    const { child, handle, stop } = await connected((path) => ["/usr/bin/nc", "-U", path]);
    try {
      expect(handle?.via).toBe("token");
      expect(handle!.auditToken!.byteLength).toBe(32);
      expect(auditTokenSatisfies(handle!.auditToken, NC, { hardened: false })).toBe(true);
      // nc's signature has no hardened runtime: the full check refuses it.
      expect(auditTokenSatisfies(handle!.auditToken, NC)).toBe(false);
      expect(appPeerByRequirement(NC)(facts(handle!))).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DIST, { hardened: false })).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DEV, { hardened: false })).toBe(false);
      expect(check(defaultAppPeerCheck("darwin", "dist"))(facts(handle!))).toBe(false);
      // The same token with another pid version names no process: a reused pid never passes as the one connected.
      const other = new Uint8Array(handle!.auditToken!);
      new DataView(other.buffer).setUint32(28, new DataView(other.buffer).getUint32(28, true) + 1, true);
      expect(auditTokenSatisfies(other, NC, { hardened: false })).toBe(false);
      child.kill();
      await child.exited;
      expect(auditTokenSatisfies(handle!.auditToken, NC, { hardened: false })).toBe(false);
    } finally { stop(); }
  });

  darwinTest("a Developer ID peer of another team (Bun's): the requirement shape matches its team only, and its entitlements open it", async () => {
    if (bunTeam === undefined || bunTeam === "not set") return; // a Bun built locally carries no team
    const client = (path: string) => `const s = await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); await Bun.sleep(20000); s.end();`;
    const { handle, stop } = await connected((path) => [process.execPath, "-e", client(path)]);
    try {
      expect(handle?.via).toBe("token");
      const own = `identifier "bun" and anchor apple generic and ${DEVELOPER_ID_CLAUSES} and certificate leaf[subject.OU] = "${bunTeam}"`;
      expect(auditTokenSatisfies(handle!.auditToken, own, { hardened: false })).toBe(true);
      // Hardened, but with disable-library-validation and allow-dyld-environment-variables: refused.
      expect(auditTokenSatisfies(handle!.auditToken, own)).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, own.replace(bunTeam, CLOVER_TEAM_ID), { hardened: false })).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DIST, { hardened: false })).toBe(false);
      expect(auditTokenSatisfies(handle!.auditToken, DEV, { hardened: false })).toBe(false);
    } finally { stop(); }
  });

  darwinTest("hardening: only the hardened runtime with no opening entitlement passes; ad hoc never passes Clover's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-c-ps-bin-"));
    const plain = adHocClient(dir);
    const cases: [string, { runtime: boolean; entitlements?: readonly string[] }, boolean][] = [
      ["lane-c-hard", { runtime: true }, true],
      ["lane-c-soft", { runtime: false }, false],
      ["lane-c-jit", { runtime: true, entitlements: ["com.apple.security.cs.allow-jit"] }, true],
      ["lane-c-task", { runtime: true, entitlements: ["com.apple.security.get-task-allow"] }, false],
      ["lane-c-dyld", { runtime: true, entitlements: ["com.apple.security.cs.allow-dyld-environment-variables"] }, false],
      ["lane-c-lib", { runtime: true, entitlements: ["com.apple.security.cs.disable-library-validation"] }, false],
    ];
    for (const [name, o, passes] of cases) {
      const bin = signedCopy(plain, dir, name, o);
      const { handle, stop } = await connected((path) => [bin, path]);
      try {
        expect(handle?.via).toBe("token");
        expect(auditTokenSatisfies(handle!.auditToken, `identifier "${name}"`, { hardened: false })).toBe(true);
        expect([name, auditTokenSatisfies(handle!.auditToken, `identifier "${name}"`)]).toEqual([name, passes]);
        expect(check(defaultAppPeerCheck("darwin", "dist"))(facts(handle!))).toBe(false);
        expect(check(defaultAppPeerCheck("darwin", "dev"))(facts(handle!))).toBe(false);
      } finally { stop(); }
    }
  });

  darwinTest("an ad hoc peer that names itself com.waifucave.clover, hardened, is refused by Clover's requirements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-c-ps-bin-"));
    const plain = adHocClient(dir);
    for (const id of [CLOVER_APP_IDENTIFIER.dist, CLOVER_APP_IDENTIFIER.dev]) {
      const bin = signedCopy(plain, dir, id, { runtime: true });
      const { handle, stop } = await connected((path) => [bin, path]);
      try {
        expect(auditTokenSatisfies(handle!.auditToken, `identifier "${id}"`)).toBe(true); // the identifier alone matches
        expect(auditTokenSatisfies(handle!.auditToken, DIST)).toBe(false);
        expect(auditTokenSatisfies(handle!.auditToken, DEV)).toBe(false);
        expect(auditTokenSatisfies(handle!.auditToken, appRequirement("dist", CLOVER_TEAM_ID, false))).toBe(false);
      } finally { stop(); }
    }
  });
});
