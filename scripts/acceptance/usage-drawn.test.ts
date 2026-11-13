import { expect, test } from "bun:test";
import { settingsDrawnProblem, usageDrawnProblem } from "./usage-drawn";

test("a drawn usage view passes with a Today group, a Clover row and a token count, and each lack is said", () => {
  expect(usageDrawnProblem("Plans\nNo plans read yet\nToday  480 tokens\nClover  480 tokens")).toBeUndefined();
  expect(usageDrawnProblem("Today 1.2k tokens\nClover 1.2k tokens")).toBeUndefined();
  expect(usageDrawnProblem("Today\nNothing used today")).toContain("no usage");
  expect(usageDrawnProblem("No usage yet")).toContain("no usage");
  expect(usageDrawnProblem("Clover 480 tokens")).toContain("no Today");
  expect(usageDrawnProblem("Today 480 tokens")).toContain("no Clover");
  expect(usageDrawnProblem("Today Clover")).toContain("no token count");
});

test("the Settings section's drawn text passes with a Clover row and a token count", () => {
  expect(settingsDrawnProblem("Period 7 days\n1.2k tokens\n900 in · 300 out\nGroup by Source\nClover 1.2k tokens")).toBeUndefined();
  expect(settingsDrawnProblem("No usage yet")).toContain("no usage");
  expect(settingsDrawnProblem("Period 7 days Group by Source 1.2k tokens")).toContain("no Clover");
  expect(settingsDrawnProblem("Clover Period")).toContain("no token count");
});
