// Runs the PluginHost conformance suite against FakePluginHost, and checks the suite's account-token name against the
// plugin SDK's.
import { expect, test } from "bun:test";
import { WAIFUCAVE_AUTH } from "../../../../plugin-sdk/src/api/plugin-api";
import { RESERVED_HANDLER_NAMES } from "../../../../plugin-sdk/src/manifest/fields";
import { runPluginHostConformance } from "../conformance/plugin-host";
import { FakePluginHost } from "../fakes/plugin-host";
import { RESERVED_EXPORTS } from "../plugin-host";

runPluginHostConformance((...args) => new FakePluginHost(...args));

test("the suite's account-token name and the reserved exports agree with the plugin SDK", () => {
  expect(WAIFUCAVE_AUTH).toBe("waifucave");
  expect([...RESERVED_EXPORTS].sort()).toEqual([...RESERVED_HANDLER_NAMES].sort());
});
