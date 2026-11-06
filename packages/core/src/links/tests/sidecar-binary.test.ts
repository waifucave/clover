// The sidecar the daemon starts is the one shipped beside it (lane M's packages).
import { describe, expect, test } from "bun:test";
import { bundledLinkBinary, linkBinaryName } from "../sidecar-binary";

describe("the bundled link sidecar", () => {
  test("lies beside the daemon's executable, as the packages ship it", () => {
    expect(bundledLinkBinary("/opt/Clover/resources/daemon/clover-core", "linux")).toBe("/opt/Clover/resources/daemon/clover-link");
    expect(bundledLinkBinary("/Applications/Clover.app/Contents/Resources/daemon/clover-core", "darwin"))
      .toBe("/Applications/Clover.app/Contents/Resources/daemon/clover-link");
    expect(bundledLinkBinary("C:\\Users\\a\\AppData\\Local\\Programs\\Clover\\resources\\daemon\\clover-core.exe", "win32"))
      .toBe("C:\\Users\\a\\AppData\\Local\\Programs\\Clover\\resources\\daemon\\clover-link.exe");
    expect(linkBinaryName("win32")).toBe("clover-link.exe");
    expect(linkBinaryName("linux")).toBe("clover-link");
  });
});
