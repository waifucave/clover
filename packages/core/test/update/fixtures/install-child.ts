// One "app start": installs a copy under the home's install lock and prints what happened as one JSON line.
// argv: home release build holdMs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../../src/contracts/clock";
import { placeEngine } from "../../../src/update/engine-copy";
import { EngineReleaseHome } from "../../../src/update/release-home";

const [home, release, build, holdMs] = process.argv.slice(2) as [string, string, string, string];
const clock: Clock = {
  now: () => Date.now(), monotonic: () => performance.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return { id: Number(t) } as never; },
  clearTimeout: () => {}, status: () => ({ reference: "public", offsetMs: 0, accuracyMs: 0, synced: true }),
};
mkdirSync(home, { recursive: true });
const source = join(home, `source-${process.pid}`);
writeFileSync(source, `engine ${release} ${build}`);
const h = new EngineReleaseHome({
  home, engine: release, clock, place: (copy) => placeEngine(home, { binary: source }, copy),
  hold: () => new Promise<void>((r) => setTimeout(r, Number(holdMs))), lockPollMs: 20,
});
const r = await h.install({ release, build, from: `/app-${process.pid}` });
console.log(JSON.stringify({ installed: r.installed, current: r.current }));
