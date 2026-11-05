#!/usr/bin/env bun
// S6 question 2, as a test: what does a reader see when a file changes size on the computer that
// holds it, behind the mount's back? This is the FSKit data-corruption case (macFUSE #1188,
// #1222, #1231): FSKit keeps the old size and pads a short read with bytes the module never sent.
// Linux FUSE shortens the file to the short read. The same checks also time how long a remote
// change takes to show: a new file after a failed lookup (FSKit pinned such misses for the life
// of the vnode until macOS 27.2, FB24419825) and a new size.
//
//   bun bench/coherence.ts --root <export> --tree <mountpoint> --helper <clover-mount> --out <json> [--policies plain,cached]
//   bun bench/coherence.ts --root <export> --external <mounted computer folder> --out <json>   (the FSKit gate)

import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WIN, Rig, log, machine, parseArgs, sleep, summary, writeJson } from "./lib";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root ?? ".");
const OUT = path.resolve(args.out ?? "coherence.json");
const POLICIES = (args.policies ?? "plain,cached").split(",");
const EXTERNAL = args.external;
const results: Array<Record<string, unknown>> = [];
const out: { [k: string]: any } = { spike: "S6", question: "coherence", machine: machine(), started: new Date().toISOString(), results };

/** What a program sees reading the whole file through the mount. */
function readThrough(p: string) {
  try {
    const b = fs.readFileSync(p);
    const counts: Record<string, number> = {};
    for (const x of b) { const k = String.fromCharCode(x).replace(/[^A-Za-z]/, "·"); counts[k] = (counts[k] ?? 0) + 1; }
    return { ok: true, length: b.length, bytes: counts, head: [...b.subarray(0, 8)], tail: [...b.subarray(Math.max(0, b.length - 8))] };
  } catch (e: any) { return { ok: false, code: e.code, message: String(e.message).slice(0, 120) }; }
}

/** Classifies what a reader saw after the file went from 200 'A' to 46 'B' behind the mount. */
export function shrinkVerdict(sr: any): string {
  if (!sr.ok) return `error ${sr.code} (no wrong bytes)`;
  if (sr.length === 46 && sr.bytes.B === 46) return "correct: 46 'B'";
  if (sr.length === 200 && sr.bytes.A === 200) return "old version: 200 'A' (stale, but bytes the holder sent)";
  if (sr.bytes.B === 46) return `WRONG: 46 'B' then ${sr.length - 46} bytes the holder never sent`;
  return `WRONG: ${JSON.stringify(sr.bytes)}`;
}

async function until(fn: () => boolean, ms: number): Promise<number> {
  const t = performance.now();
  while (performance.now() - t < ms) { if (fn()) return Math.round(performance.now() - t); await sleep(25); }
  return -1;
}

async function checks(label: string, mountDir: string) {
  const local = (n: string) => path.join(ROOT, n);
  const remote = (n: string) => path.join(mountDir, n);
  const r: Record<string, unknown> = { label };
  // 1. shrink: 200 'A' -> 46 'B', the same inode, read at once through the mount
  fs.writeFileSync(local("sr.txt"), "A".repeat(200));
  await sleep(300);
  r.before = { stat: fs.statSync(remote("sr.txt")).size, read: readThrough(remote("sr.txt")) };
  const fd = fs.openSync(local("sr.txt"), "r+");
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, "B".repeat(46), 0);
  fs.closeSync(fd);
  r.shrunkStatAtOnce = (() => { try { return fs.statSync(remote("sr.txt")).size; } catch (e: any) { return e.code; } })();
  r.shrunkRead = readThrough(remote("sr.txt"));
  const sr = r.shrunkRead as any;
  r.shrinkVerdict = shrinkVerdict(sr);
  r.sizeFreshAfterMs = await until(() => { try { return fs.statSync(remote("sr.txt")).size === 46; } catch { return false; } }, 10000);
  // 2. grow: 46 'B' -> 300 'C'
  fs.writeFileSync(local("sr.txt"), "C".repeat(300));
  r.grownRead = readThrough(remote("sr.txt"));
  const gr = r.grownRead as any;
  r.growVerdict = !gr.ok ? `error ${gr.code}` : gr.length === 300 && gr.bytes.C === 300 ? "correct: 300 'C'" : `stale: ${gr.length} bytes ${JSON.stringify(gr.bytes)}`;
  r.grownFreshAfterMs = await until(() => { try { return fs.readFileSync(remote("sr.txt")).length === 300; } catch { return false; } }, 10000);
  // 3. a name that did not exist when it was looked up
  const late = `late-${Date.now()}.txt`;
  r.missingFirst = (() => { try { fs.statSync(remote(late)); return "exists?"; } catch (e: any) { return e.code; } })();
  fs.writeFileSync(local(late), "late");
  r.newNameVisibleAfterMs = await until(() => fs.existsSync(remote(late)), 10000);
  // 4. a file deleted on the holder
  fs.rmSync(local(late));
  r.deletedGoneAfterMs = await until(() => !fs.existsSync(remote(late)), 10000);
  fs.rmSync(local("sr.txt"), { force: true });
  results.push(r);
  writeJson(OUT, out);
  log(`${label}: shrink ${r.shrinkVerdict}; size fresh after ${r.sizeFreshAfterMs} ms; grow ${r.growVerdict}; new name after ${r.newNameVisibleAfterMs} ms; delete after ${r.deletedGoneAfterMs} ms`);
}

async function main() {
  if (EXTERNAL) {
    await checks(args.label ?? "external mount", EXTERNAL);
  } else {
    const rig = new Rig({
      root: ROOT, tree: IS_WIN ? args.tree! : path.resolve(args.tree!), helperBin: path.resolve(args.helper!),
      logs: path.join(path.dirname(OUT), "logs", path.basename(OUT, ".json")), remoteName: "Desktop1", selfName: "Runner", selfHome: path.dirname(ROOT),
    });
    if (args["nfs-helper"]) rig.nfs = { bin: path.resolve(args["nfs-helper"]), port: 12049, mountpoint: path.resolve(args.tree!) };
    await rig.startService();
    await rig.startLink(0);
    try {
      for (const p of POLICIES) {
        await rig.mount(p);
        if (!rig.nfs) {
          // This computer's own entry is a link to its home folder: programs here use it natively.
          const self = path.join(rig.treeRoot, "home", "Runner");
          let link: unknown;
          try { link = { target: fs.readlinkSync(self), entries: fs.readdirSync(self).length }; } catch (e: any) { link = { error: `${e.code}: ${e.message}` }; }
          out.selfLink = link;
          log(`self link home/Runner: ${JSON.stringify(link)}`);
        }
        await checks(rig.nfs ? `nfs ${p}` : p, rig.remotePath());
        await rig.unmount();
      }
    } finally { await rig.stopAll(); }
  }
  out.finished = new Date().toISOString();
  writeJson(OUT, out);
  let md = `\n### S6 coherence on ${out.machine.os} (${out.machine.release})\n\n| mount | file shrinks behind it | new size seen after | file grows | new name seen after | delete seen after |\n| :- | :- | -: | :- | -: | -: |\n`;
  for (const r of results as any[]) md += `| ${r.label} | ${r.shrinkVerdict} | ${r.sizeFreshAfterMs} ms | ${r.growVerdict} | ${r.newNameVisibleAfterMs} ms | ${r.deletedGoneAfterMs} ms |\n`;
  summary(md);
}

if (import.meta.main) main().catch((e) => { console.error(e); writeJson(OUT, out); process.exit(1); });
