import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDaemonServer } from "../../src/platform/server-check";

describe.skipIf(process.platform === "win32")("the server check before a hello (macOS, Linux)", () => {
  test("ok only for this user's socket in a directory closed to others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-check-"));
    const path = join(dir, "core.sock");
    expect(await checkDaemonServer(path)).toEqual({ ok: false, reason: "no daemon socket" });
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    chmodSync(dir, 0o755);
    expect((await checkDaemonServer(path)).ok).toBe(false);
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
    expect(await checkDaemonServer(path)).toEqual({ ok: true });
    server.stop(true);
  });
});
