// What a fenced tree call is told names the caller's kind: a plugin isn't told the fence keeps bots out.
import { expect, test } from "bun:test";
import { fencedOutText } from "../../src/contracts/fence";

test("the refusal names plugins, bots, agents or another computer's calls, by the caller", () => {
  expect(fencedOutText({ kind: "plugin", pluginId: "editor" }, "/h/.clover/run")).toBe("the fence keeps plugins out of /h/.clover/run");
  expect(fencedOutText({ kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" }, "/x")).toBe("the fence keeps bots out of /x");
  expect(fencedOutText({ kind: "session", sessionId: "t_1", sessionKind: "side-thread", bot: "alpha" }, "/x")).toBe("the fence keeps bots out of /x");
  expect(fencedOutText({ kind: "session", sessionId: "s_1", sessionKind: "coding" }, "/x")).toBe("the fence keeps agents out of /x");
  expect(fencedOutText({ kind: "session", sessionId: "a_1", sessionKind: "agent" }, "/x")).toBe("the fence keeps agents out of /x");
  expect(fencedOutText({ kind: "peer", device: "d_1" }, "/x")).toBe("the fence keeps another computer's calls out of /x");
});
