#!/usr/bin/env bun
// S6, macOS only (review S6): what macOS itself writes into another computer's folders through
// the NFS mount, and whether Spotlight and Time Machine look at the volume.
//
//   bun bench/volume.ts --root <export> --tree <mountpoint> --nfs-helper <clover-nfs> --out <json>
//
// NFSv3 has no extended attributes, so macOS keeps them in AppleDouble "._name" files beside the
// file, and Finder writes .DS_Store into the folders it shows. Both would land on the holder's
// disk, in its repos. This mounts the tree as the other checks do, sets an attribute on a file,
// copies in a file that carries one, and lists the folder on the holder's side. It does that with
// the default options and again with each mount flag that might turn the AppleDouble files off.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Rig, log, machine, nfsFromArgs, parseArgs, redactExport, run, summary, writeJson } from "./lib";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root!);
const OUT = path.resolve(args.out ?? "volume.json");
const rig = new Rig({
  root: ROOT, tree: path.resolve(args.tree!), helperBin: "none", logs: path.join(path.dirname(OUT), "logs", path.basename(OUT, ".json")),
  remoteName: "Desktop1", selfName: "Runner", selfHome: path.dirname(ROOT),
});
rig.nfs = nfsFromArgs(args);
const runs: Array<Record<string, unknown>> = [];
const out: Record<string, unknown> = { spike: "S6", question: "volume", machine: machine(), started: new Date().toISOString(), runs };

const text = (r: { stdout: string; stderr: string; ok: boolean }) => `${r.ok ? "" : "FAILED: "}${(r.stdout + r.stderr).trim().slice(0, 400)}`;

async function once(label: string, extra?: string) {
  const r: Record<string, unknown> = { label, extra: extra ?? "" };
  runs.push(r);
  rig.nfs!.extra = extra;
  try { await rig.mount("cached"); } catch (e) { r.mountError = String(e).slice(0, 400); return; }
  try {
    r.mountLine = redactExport((await run(["/sbin/mount"], { timeoutMs: 5000 })).stdout.split("\n").find((l) => l.includes(` on ${rig.nfs!.mountpoint} `)) ?? "");
    const dir = `vol-${label}`;
    const inMount = rig.remotePath(dir);
    fs.mkdirSync(inMount);
    fs.writeFileSync(path.join(inMount, "a.txt"), "a\n");
    r.xattrWrite = text(await run(["xattr", "-w", "org.clover.s6", "1", path.join(inMount, "a.txt")], { timeoutMs: 10000 }));
    r.xattrRead = text(await run(["xattr", "-l", path.join(inMount, "a.txt")], { timeoutMs: 10000 }));
    // A file that carries an attribute, as a download does, copied in the ways people copy.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "s6-vol-"));
    fs.writeFileSync(path.join(local, "b.txt"), "b\n");
    await run(["xattr", "-w", "com.apple.metadata:kMDItemWhereFroms", "s6", path.join(local, "b.txt")], { timeoutMs: 10000 });
    r.cpP = text(await run(["cp", "-p", path.join(local, "b.txt"), path.join(inMount, "b-cp.txt")], { timeoutMs: 10000 }));
    r.ditto = text(await run(["ditto", path.join(local, "b.txt"), path.join(inMount, "b-ditto.txt")], { timeoutMs: 10000 }));
    fs.rmSync(local, { recursive: true, force: true });
    const holder = path.join(ROOT, dir);
    r.holderSees = fs.readdirSync(holder).sort();
    r.appleDouble = (r.holderSees as string[]).filter((n) => n.startsWith("._"));
    r.mountSees = fs.readdirSync(inMount).sort();
    // Spotlight and Time Machine on this volume
    r.mdutil = text(await run(["mdutil", "-s", rig.nfs!.mountpoint], { timeoutMs: 20000 }));
    r.tmutilIsExcluded = text(await run(["tmutil", "isexcluded", rig.nfs!.mountpoint], { timeoutMs: 20000 }));
    fs.rmSync(holder, { recursive: true, force: true });
  } catch (e) {
    r.error = String(e).slice(0, 400);
  } finally {
    await rig.unmount();
  }
  log(`${label}: holder sees ${JSON.stringify(r.holderSees ?? r.mountError ?? r.error)}`);
}

async function main() {
  // Finder's .DS_Store on network volumes is a per-user default; CI can't open Finder.
  out.dsDontWriteNetworkStores = text(await run(["defaults", "read", "com.apple.desktopservices", "DSDontWriteNetworkStores"], { timeoutMs: 5000 }));
  await rig.startService();
  await rig.startLink(0);
  try {
    await once("default");
    await once("nouserxattr", "nouserxattr");
    await once("noappledouble", "noappledouble");
  } finally {
    await rig.stopAll();
  }
  out.finished = new Date().toISOString();
  writeJson(OUT, out);
  let md = `\n### S6 volume checks on ${machine().release}\n\n| mount | AppleDouble files on the holder | xattr -w | mdutil -s | tmutil isexcluded |\n| :- | :- | :- | :- | :- |\n`;
  for (const r of runs as any[]) {
    md += `| ${r.label} | ${r.mountError ? `mount failed: ${String(r.mountError).slice(0, 80)}` : (r.appleDouble ?? []).join(", ") || "none"} | ${String(r.xattrWrite ?? "–").slice(0, 60)} | ${String(r.mdutil ?? "–").replace(/\n/g, " ").slice(0, 80)} | ${String(r.tmutilIsExcluded ?? "–").slice(0, 40)} |\n`;
  }
  summary(md);
}

main().catch(async (e) => { console.error(e); await rig.stopAll(); writeJson(OUT, out); process.exit(1); });
