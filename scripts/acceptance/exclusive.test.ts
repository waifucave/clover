// The acceptance's hold on the machine (exclusive.ts): run again under scripts/heavy's exclusive lock unless it already
// runs under it, a packaged run (--app) as packaged.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { exclusiveArgs } from "./exclusive";

const REPO = resolve(import.meta.dir, "..", "..");
const HEAVY = join(REPO, "scripts", "heavy");

describe.if(process.platform !== "win32")("the acceptance's exclusive hold", () => {
  test("a run not under the hold runs again under heavy --exclusive, a packaged one as packaged", () => {
    expect(exclusiveArgs(REPO, ["run.ts", "--only-stage"], {})).toEqual([HEAVY, "--exclusive", process.execPath, "run.ts", "--only-stage"]);
    expect(exclusiveArgs(REPO, ["run.ts", "--app", "/x/Clover.app", "--verbose"], {})).toEqual([HEAVY, "--exclusive", "--packaged", process.execPath, "run.ts", "--app", "/x/Clover.app", "--verbose"]);
  });

  test("a run under the hold (a try's watch.sh starting it) runs as it is", () => {
    expect(exclusiveArgs(REPO, ["run.ts", "--app", "/x/Clover.app"], { CLOVER_HEAVY_EXCLUSIVE: "4242" })).toBeUndefined();
  });
});
