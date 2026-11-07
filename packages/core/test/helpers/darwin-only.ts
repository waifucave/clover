// Tests that need macOS (Seatbelt, the Keychain, codesign, sips, Finder, an Apple-silicon-only file call…) inside a
// test file that otherwise runs on Linux. CI runs the core suite on Linux, except the files named `*.darwin.test.ts`
// (macOS through and through), which the macOS job runs together with every file that imports this module
// (scripts/platform-tests.ts). So a macOS-only test in a mixed file is written `darwinTest(…)` or `darwinDescribe(…)`:
// it skips on Linux and runs on the macOS job. A raw `process.platform` gate in a Linux file would run nowhere, and
// the Linux shards refuse a skip they can't account for.
import { describe, test } from "bun:test";

export const onDarwin = process.platform === "darwin";
export const darwinTest = test.if(onDarwin);
export const darwinDescribe = describe.if(onDarwin);
