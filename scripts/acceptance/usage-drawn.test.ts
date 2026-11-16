import { expect, test } from "bun:test";
import { settingsDrawnProblem, usageDrawnProblem } from "./usage-drawn";

test("a drawn usage view passes with a Today group, a MOSS row and a token count, and each lack is said", () => {
  expect(usageDrawnProblem("Plans\nNo plans read yet\nToday  480 tokens\nMOSS  480 tokens")).toBeUndefined();
  expect(usageDrawnProblem("Today 1.2k tokens\nMOSS 1.2k tokens")).toBeUndefined();
  expect(usageDrawnProblem("Today\nNothing used today")).toContain("no usage");
  expect(usageDrawnProblem("No usage yet")).toContain("no usage");
  expect(usageDrawnProblem("MOSS 480 tokens")).toContain("no Today");
  expect(usageDrawnProblem("Today 480 tokens")).toContain("no MOSS");
  expect(usageDrawnProblem("Today MOSS")).toContain("no ");
});

test("the Settings section's drawn text passes with a MOSS row and a token count", () => {
  expect(settingsDrawnProblem("Period 7 days\n900 in · 300 out\nGroup by Source\nMOSS 900 300")).toBeUndefined();
  expect(settingsDrawnProblem("No usage yet")).toContain("no usage");
  expect(settingsDrawnProblem("Period 7 days Group by Source 900 in · 300 out")).toContain("no MOSS");
  expect(settingsDrawnProblem("MOSS Period")).toContain("no ");
});
