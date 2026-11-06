import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDaemonServer } from "../../src/platform/server-check";

// Review S2: the check connects and asks the OS who serves the socket (its pid, user, executable and floor),
// beside the socket's and its folder's owner and modes. A socket nobody listens on fails.
describe.skipIf(process.platform === "win32")("the server check before a hello (macOS, Linux)", () => {
  test("ok only for this user's daemon binary, outside every floor, on a socket in a folder closed to others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-check-"));
    const path = join(dir, "core.sock");
    const image = process.execPath; // the server below is this process
    expect(await checkDaemonServer(path, { image })).toEqual({ ok: false, reason: "no daemon answers" });
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    chmodSync(dir, 0o755);
    chmodSync(path, 0o600);
    expect(await checkDaemonServer(path, { image })).toMatchObject({ ok: false, reason: "the socket or its directory is open to others" });
    chmodSync(dir, 0o700);
    expect(await checkDaemonServer(path, { image })).toMatchObject({ ok: true, pid: process.pid, uid: process.getuid!() });
    expect(await checkDaemonServer(path, { image: "/bin/sh" })).toMatchObject({ ok: false, reason: "the socket is served by another binary" });
    expect(await checkDaemonServer(path, { image: "" })).toMatchObject({ ok: false });
    server.stop(true);
    expect((await checkDaemonServer(path, { image })).ok).toBe(false); // a crashed daemon's socket: nothing answers
  });
});
