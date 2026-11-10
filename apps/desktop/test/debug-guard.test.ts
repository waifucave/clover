import { describe, expect, test } from "bun:test";
import { refusedLaunchSwitches } from "../src/main/debug-guard";

const run = (argv: string[], o: { packaged?: boolean; env?: Record<string, string>; has?: string[]; testBuild?: boolean; testDebug?: boolean } = {}) =>
  refusedLaunchSwitches({ argv: ["electron", ...argv], hasSwitch: (n) => (o.has ?? []).includes(n), packaged: o.packaged ?? false, env: o.env ?? {}, ...(o.testBuild !== undefined ? { testBuild: o.testBuild } : {}), ...(o.testDebug !== undefined ? { testDebug: o.testDebug } : {}) });

describe("the launch guard", () => {
  test("a plain launch starts", () => {
    expect(run(["apps/desktop", "--clover-headless", "--safe-mode"])).toEqual([]);
    expect(run([], { packaged: true })).toEqual([]);
  });

  test("every remote-debugging and inspect form is refused, on the command line or Chromium's", () => {
    for (const a of ["--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-pipe", "--remote-debugging-address=0.0.0.0", "--inspect", "--inspect=9229", "--inspect-brk", "--inspect-brk=0.0.0.0:9229", "--inspect-port=0", "--debug-port=5858"]) {
      expect(run([a]).length).toBe(1);
      expect(run([a], { packaged: true }).length).toBe(1);
    }
    expect(run([], { has: ["remote-debugging-port"] })).toEqual(["remote-debugging-port"]);
    expect(run(["--INSPECT=1", "--remote-debugging-pipe"])).toEqual(["inspect", "remote-debugging-pipe"]);
  });

  test("a value or a path that only looks like a switch is not one", () => {
    expect(run(["--clover-capture=/tmp/--inspect.png", "inspect", "-inspect", "--inspector"])).toEqual([]);
  });

  test("the dev app may debug behind CLOVER_DEV_DEBUG=1; a packaged app never does", () => {
    expect(run(["--inspect"], { env: { CLOVER_DEV_DEBUG: "1" } })).toEqual([]);
    expect(run(["--inspect"], { env: { CLOVER_DEV_DEBUG: "0" } })).toEqual(["inspect"]);
    expect(run(["--inspect"], { packaged: true, env: { CLOVER_DEV_DEBUG: "1" } })).toEqual(["inspect"]);
    expect(run(["--remote-debugging-port=1"], { packaged: true, env: { CLOVER_DEV_DEBUG: "1" } })).toEqual(["remote-debugging-port"]);
  });

  test("the secret-bearing net log is refused in the packaged app; ordinary logging is not", () => {
    expect(run(["--log-net-log=/tmp/n.json", "--net-log-capture-mode=Everything"], { packaged: true })).toEqual(["log-net-log", "net-log-capture-mode"]);
    expect(run(["--log-net-log=/tmp/n.json"])).toEqual([]);
    expect(run(["--enable-logging", "--v=1"], { packaged: true })).toEqual([]);
  });

  test("a packaged test build takes the net log only with the marker AND the opt-in, and never a debugging switch", () => {
    const net = ["--log-net-log=/tmp/n.json", "--net-log-capture-mode=Everything"];
    expect(run(net, { packaged: true, testBuild: true, env: { CLOVER_TEST_NETLOG: "1" } })).toEqual([]);
    expect(run(net, { packaged: true, testBuild: true })).toEqual(["log-net-log", "net-log-capture-mode"]);
    expect(run(net, { packaged: true, testBuild: false, env: { CLOVER_TEST_NETLOG: "1" } })).toEqual(["log-net-log", "net-log-capture-mode"]);
    expect(run(["--inspect", "--remote-debugging-port=1"], { packaged: true, testBuild: true, env: { CLOVER_TEST_NETLOG: "1" } })).toEqual(["inspect", "remote-debugging-port"]);
  });

  test("a test-marked build's DevTools port: the port alone, never an address, the pipe or --inspect; a real build never", () => {
    expect(run(["--remote-debugging-port=9301"], { packaged: true, testDebug: true })).toEqual([]);
    expect(run(["--remote-debugging-port=9301", "--remote-debugging-address=0.0.0.0"], { packaged: true, testDebug: true })).toEqual(["remote-debugging-address"]);
    expect(run(["--remote-debugging-pipe", "--inspect", "--debug-port=1"], { packaged: true, testDebug: true })).toEqual(["debug-port", "inspect", "remote-debugging-pipe"]);
    // `testDebug` is the define AND the opt-in, computed in index.ts; without it the port is refused everywhere.
    expect(run(["--remote-debugging-port=9301"], { packaged: true, testBuild: true, env: { CLOVER_TEST_DEBUG: "1" } })).toEqual(["remote-debugging-port"]);
  });
});
