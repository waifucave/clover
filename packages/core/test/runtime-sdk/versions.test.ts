import { describe, expect, test } from "bun:test";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import * as clover from "@yanlinglabs/winter-agent-sdk";
import { CLOVER_PEER_VERSIONS, installedWinterRuntimeSdkVersion, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

describe("peer versions", () => {
  test("the RESOLVED installed versions are the ones 8b was written against", () => {
    expect(SDK_VERSION).toBe(REQUIRED_WINTER_AGENT_SDK);          // resolved, not the ^ range
  });
  test("A-M1: no router package is installed; its pin names the release core's host code came from", () => {
    expect(installedWinterRuntimeSdkVersion()).toBeUndefined();
    expect(REQUIRED_WINTER_RUNTIME_SDK).toBe("0.0.16");
    expect(() => require.resolve("@yanlinglabs/winter-runtime-sdk")).toThrow();
  });
  test("CLOVER_PEER_VERSIONS is declared from SDK_VERSION", () => {
    // WS-23: the Clover SDK is the only one — no `claudeAgentSdk` key, whatever node_modules holds. A-M1:
    // no version matrix reads it any more; it stamps selections, and the embedded lock holds the runtime to it.
    expect(CLOVER_PEER_VERSIONS).toEqual({ winterAgentSdk: SDK_VERSION });
  });
  test("the spawn seam is on the INSTALLED barrel", () => {
    expect(typeof clover.resolveRuntimeExecutable).toBe("function");
    expect(typeof clover.defaultSpawn).toBe("function");
  });
});
