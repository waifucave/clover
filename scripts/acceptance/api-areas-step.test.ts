import { expect, test } from "bun:test";
import { apiProbePairs, apiProbeWrong } from "./api-areas-step";

test("the API areas' probe: every clause read from its answer, and each wrong one named", () => {
  const good = "acceptance-api-pong own-log=read core-log=refused:refused usage=rows:3 memory=alpha:2 routines=listed:0 own-command=pong_by_plugin other-command=refused:refused audio-play=handed audio-listen=watched keys=refused:refused";
  expect(apiProbeWrong(apiProbePairs(good))).toEqual([]);
  const bad = good.replace("core-log=refused:refused", "core-log=read:1").replace("keys=refused:refused", "keys=made:32");
  expect(apiProbeWrong(apiProbePairs(bad)).map((w) => w.split(":")[0])).toEqual(["core-log", "keys"]);
  expect(apiProbeWrong(apiProbePairs("nothing")).length).toBe(10);
});
