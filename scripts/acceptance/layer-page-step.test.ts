import { expect, test } from "bun:test";
import { checkPageReport } from "./layer-page-step";

const right = {
  files: { heard: true, bytes: "ACCEPTANCE-PAGE-FILE", text: "ACCEPTANCE-PAGE-FILE" }, memory: "a list", routines: "a list", usage: "a list", logs: "a list",
  notify: "refused: acceptance-points's notifications are muted in Settings", note: "noted", command: "its report", point: "hello page from the page's own point",
  fetch: { status: 200, body: "SITE" },
};

test("the page's answers pass only when each area answered as the core should", () => {
  expect(checkPageReport(right, { siteBody: "SITE" }).wrong).toEqual([]);
  expect(checkPageReport(right, { siteBody: "SITE" }).said.length).toBe(10);
  const bad = checkPageReport({ ...right, notify: "sent", memory: "refused: memory.list isn't available yet", fetch: "refused: x", files: { ...right.files, heard: false } }, { siteBody: "SITE" }).wrong;
  expect(bad.map((w) => w.split(":")[0])).toEqual(["files (watch, write, readBytes, readText, remove)", "memory.list", "notify.send (muted)", "net.fetch"]);
});
