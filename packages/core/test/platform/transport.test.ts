import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveEndpoint, homePipeId, isPipe, WINDOWS_PIPE_PREFIX } from "../../src/platform/transport";

describe("resolveEndpoint", () => {
  test("a Unix socket under the run directory on macOS and Linux", () => {
    for (const os of ["darwin", "linux"] as const) {
      const e = resolveEndpoint("/home/x/.clover/run", os);
      expect(e.kind).toBe("unix");
      expect(e.path).toBe(join("/home/x/.clover/run", "core.sock"));
      expect(e.listen).toEqual({ unix: e.path });
      expect(isPipe(e.path)).toBe(false);
    }
  });

  test("a named pipe in the pipe namespace on Windows, not a file under the run directory", () => {
    const e = resolveEndpoint("C:\\Users\\x\\.clover\\run", "win32");
    expect(e.kind).toBe("pipe");
    expect(e.path.startsWith(WINDOWS_PIPE_PREFIX)).toBe(true);
    expect(e.path).not.toContain("run");
    expect(e.listen).toEqual({ unix: e.path });
    expect(isPipe(e.path)).toBe(true);
  });

  test("one pipe name per home: dev and dist run directories differ", () => {
    const dist = resolveEndpoint("/home/x/.clover/run", "win32").path;
    const dev = resolveEndpoint("/home/x/.clover-dev/run", "win32").path;
    expect(dist).not.toBe(dev);
  });

  test("the pipe name is stable for one run directory", () => {
    expect(resolveEndpoint("/a/run", "win32").path).toBe(resolveEndpoint("/a/run", "win32").path);
  });

  test("homePipeId is 16 lower-case hex characters", () => {
    expect(homePipeId("/a/run")).toMatch(/^[0-9a-f]{16}$/);
  });
});
