// The bot side's close and its `beforeRelease` (INT: the fence's end-pass notes, recorded before the host lets go of
// the sessions; #369's review: bounded, so the release always comes).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEFORE_RELEASE_MS } from "../wiring";
import { boot } from "./fixtures";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), "clover-before-release-")); dirs.push(d); return d; };

test("beforeRelease runs in the close, before the host lets go of the sessions", async () => {
  const order: string[] = [];
  const b = await boot({ home: home(), plugins: [], beforeRelease: async () => { order.push("before"); } });
  const close = b.host.close.bind(b.host);
  b.host.close = async () => { order.push("release"); return close(); };
  await b.shutdown();
  expect(order).toEqual(["before", "release"]);
});

test("a beforeRelease that never ends holds the close only so long: the release comes, with a warning", async () => {
  let released = false;
  const b = await boot({ home: home(), plugins: [], beforeRelease: () => new Promise<void>(() => {}) });
  const close = b.host.close.bind(b.host);
  b.host.close = async () => { released = true; return close(); };
  const started = Date.now();
  await b.shutdown();
  expect(released).toBe(true);
  expect(Date.now() - started).toBeLessThan(BEFORE_RELEASE_MS + 2_000);
  expect(b.warnings.some((w) => w.includes("releasing them anyway"))).toBe(true);
}, BEFORE_RELEASE_MS + 5_000);
