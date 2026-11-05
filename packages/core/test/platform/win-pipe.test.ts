import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUserSid, isOurDaemon, lockPipeDacl, ownerOnlyPipeSddl, pipeDaclSddl, pipeServerIdentity } from "../../src/platform/win-pipe";
import { checkDaemonProof, proveDaemon } from "../../src/platform/pair/run-files";
import { bunRunner, windowsUserSid } from "../../src/platform/login/live";
import { resolveEndpoint } from "../../src/platform/transport";

describe("dialling the daemon safely (E-M1's review)", () => {
  test("the pipe's DACL: the user and SYSTEM, protected; never built from something that isn't a SID", () => {
    expect(ownerOnlyPipeSddl("S-1-5-21-1-2-3-1001")).toBe("D:P(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)");
    expect(() => ownerOnlyPipeSddl("S-1-5-21-1)(A;;GA;;;WD")).toThrow();
  });

  test("a server is ours only with the same user and, when given, the same binary", () => {
    const s = { pid: 9, userSid: "S-1-5-21-1-2-3-1001", image: "C:\\\\Clover\\\\daemon\\\\clover-core.exe" };
    expect(isOurDaemon(s, { userSid: "s-1-5-21-1-2-3-1001" })).toBe(true);
    expect(isOurDaemon(s, { userSid: s.userSid, image: "c:\\\\clover\\\\daemon\\\\CLOVER-CORE.EXE" })).toBe(true);
    expect(isOurDaemon(s, { userSid: "S-1-5-21-9" })).toBe(false);
    expect(isOurDaemon(s, { userSid: s.userSid, image: "C:\\\\Temp\\\\clover-core.exe" })).toBe(false);
    expect(isOurDaemon(null, { userSid: s.userSid })).toBe(false);
  });

  test("the daemon proves it holds the app token without the app sending it", () => {
    const token = "t".repeat(43);
    const proof = proveDaemon(token, "nonce-1");
    expect(checkDaemonProof(token, "nonce-1", proof)).toBe(true);
    expect(checkDaemonProof(token, "nonce-2", proof)).toBe(false); // bound to the app's nonce
    expect(checkDaemonProof("u".repeat(43), "nonce-1", proof)).toBe(false); // a squatter without the token
    expect(checkDaemonProof(token, "nonce-1", "short")).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("Windows: first instance only, an owner-only DACL, and the server's identity from the client", async () => {
    const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "clover-pipe-"))).path;
    const sid = (await windowsUserSid(bunRunner))!;
    expect(currentUserSid()).toBe(sid); // the daemon's own read, with no child process
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    expect(() => Bun.listen({ unix: path, socket: { data() {} } })).toThrow(); // FILE_FLAG_FIRST_PIPE_INSTANCE
    expect(lockPipeDacl(path, sid)).toBeGreaterThan(0);
    expect(pipeDaclSddl(path)).toBe(`D:P(A;;FA;;;${sid})(A;;FA;;;SY)`);
    const client = await Bun.connect({ unix: path, socket: { data() {} } });
    await Bun.sleep(100);
    expect(pipeDaclSddl(path, "client")).toBe(`D:P(A;;FA;;;${sid})(A;;FA;;;SY)`); // the pipe's, not one instance's
    const who = pipeServerIdentity(path);
    expect(who?.pid).toBe(process.pid);
    expect(isOurDaemon(who, { userSid: sid, image: process.execPath })).toBe(true);
    client.end(); server.stop(true);
  });
});
