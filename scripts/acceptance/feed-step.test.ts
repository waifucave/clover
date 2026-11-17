import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEED_CARD_LINES, feedCardWrong, feedProbePairs, feedProbeWrong, followsThroughTurn } from "./feed-step";

const good = "acceptance-feed-pong states=alpha/idle>thinking>working>thinking>done,x/idle keys=since,state,subject,tool tool=show list=bots:2 other-activity=refused:refused pictures=acceptance-feed:show:64x48:screen-false:session-set stream=frame:120:ffd8 other-pictures=refused:refused no-declare=refused:invalid made-up-session=refused:invalid frame-bytes=120";

test("the feed row's probe: every clause read from its answer, and each wrong one named", () => {
  expect(feedProbeWrong(feedProbePairs(good))).toEqual([]);
  const bad = good.replace("other-activity=refused:refused", "other-activity=read:3").replace("keys=since,state,subject,tool", "keys=since,state,subject,text");
  expect(feedProbeWrong(feedProbePairs(bad)).map((w) => w.split(":")[0])).toEqual(["keys", "other-activity"]);
  expect(feedProbeWrong(feedProbePairs("nothing")).length).toBe(10);
});

test("a bot followed through thinking, working and done, in that order", () => {
  expect(followsThroughTurn("a/thinking>working>done")).toBe(true);
  expect(followsThroughTurn("a/done>thinking,b/thinking>working>done")).toBe(true);
  expect(followsThroughTurn("a/working>thinking>done")).toBe(false);
  expect(followsThroughTurn("none")).toBe(false);
});

test("the card's lines: each missing one named", () => {
  expect(feedCardWrong(FEED_CARD_LINES.join(" "))).toEqual([]);
  expect(feedCardWrong(FEED_CARD_LINES.slice(1).join(" ")).length).toBe(1);
});

test("the fixture follows the feed from a host half that starts at once, so no turn it follows begins before its watch", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "acceptance-feed", "moss.json"), "utf8")) as { host?: { start?: string } };
  expect(manifest.host?.start).toBe("each");
});
