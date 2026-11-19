// The test-marked build's seam for the acceptance run on a packaged pair (platform/peer-signature.ts
// `withTestHarnessPeer`): the one process whose pid `MOSS_TEST_APP_PEER_PID` names may say hello in the `app` role.
// A real build has none of it: the define folds the branch, so the variable changes nothing. The test-build half runs
// in a child under the define a test build is compiled with (a test process from source is a real build).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defaultAppPeerCheck } from "../../src/platform/peer-signature";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { darwinTest } from "../helpers/darwin-only";

const facts = (pid: number | null, ancestors: number[] = []): PeerFacts => ({ pid, ancestors, probe: {}, floor: "outside-floor" });

describe("a real build (this process: no test define)", () => {
  darwinTest("the variable admits nobody: a peer with the named pid still meets the real check", () => {
    const was = process.env.MOSS_TEST_APP_PEER_PID;
    process.env.MOSS_TEST_APP_PEER_PID = String(process.pid);
    try {
      const check = defaultAppPeerCheck("darwin", "dist");
      expect(check).toBeFunction();
      expect((check as (p: PeerFacts) => unknown)(facts(process.pid))).toBe(false);
    } finally {
      if (was === undefined) delete process.env.MOSS_TEST_APP_PEER_PID; else process.env.MOSS_TEST_APP_PEER_PID = was;
    }
  });
});

const CHILD = `
  const { defaultAppPeerCheck } = await import(${JSON.stringify(join(import.meta.dir, "../../src/platform/peer-signature.ts"))});
  const facts = (pid, ancestors = []) => ({ pid, ancestors, probe: {}, floor: "outside-floor" });
  const at = (v) => { if (v === undefined) delete process.env.MOSS_TEST_APP_PEER_PID; else process.env.MOSS_TEST_APP_PEER_PID = v; return defaultAppPeerCheck("darwin", "dist"); };
  const out = {
    named: at("4242")(facts(4242)),
    otherPid: at("4242")(facts(4243)),
    child: at("4242")(facts(9001, [4242, 1])),
    noPid: at("4242")(facts(null)),
    unset: at(undefined)(facts(4242)),
    junk: ["abc", "", "0", "-4242", "42.5", "1e3x"].map((v) => at(v)(facts(4242))),
    noneStaysNone: (() => { process.env.MOSS_TEST_APP_PEER_PID = "4242"; return defaultAppPeerCheck("linux", "dist"); })(),
  };
  process.stdout.write(JSON.stringify(out));
`;

describe("a test-marked build (a child under the test build's define)", () => {
  darwinTest("only the named pid itself is let in; an ancestor, another pid, a missing or malformed variable meet the real check", () => {
    const r = spawnSync(process.execPath, ["--define", `__MOSS_TEST_BUILD__="MOSS-TEST-BUILD"`, "-e", CHILD], { encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { named: boolean; otherPid: boolean; child: boolean; noPid: boolean; unset: boolean; junk: boolean[]; noneStaysNone: string };
    expect(out.named).toBe(true);
    expect(out.otherPid).toBe(false);
    expect(out.child).toBe(false);
    expect(out.noPid).toBe(false);
    expect(out.unset).toBe(false);
    expect(out.junk).toEqual([false, false, false, false, false, false]);
    expect(out.noneStaysNone).toBe("none");
  });
});
