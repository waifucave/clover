// A plugin's worker inside a plugin-host process (spec §5.2: each plugin in its own worker). It runs the plugin's built
// host entry under `HostRuntime`, talking to its process (`HostMux`) over the worker's port, answers the heartbeat, and
// sends what the plugin writes to the console to its log, never to the process's stdout.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "../contracts/common";
import type { HostModule } from "../contracts/sdk-types";
import { portPeer } from "./link";
import { HostRuntime } from "./runtime";

declare const self: { postMessage(m: unknown): void; addEventListener(type: "message", fn: (e: { data: unknown }) => void): void };

const peer = portPeer(self);
const computer = String((globalThis as { workerData?: { computer?: string } }).workerData?.computer ?? process.env.CLOVER_COMPUTER ?? "");
peer.handle("ping", () => "pong");

// The console goes to the plugin's log (`pluginHost.log`), one line per call.
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => peer.notify("log", { line: args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ").slice(0, 4000) });
}

new HostRuntime({
  peer,
  computer,
  load: async (p) => {
    // By its real path: under the fence a folder above the plugin's may only be stat'ed, which this resolution needs
    // and Bun's own (it opens the folders) doesn't get (2f).
    const file = join(realFolder(p.folder), p.entry);
    let real = file;
    if (p.verified !== undefined) real = verifyTree(p.pluginId, p.entry, file, p.verified);
    return (await import(pathToFileURL(real).href)) as HostModule;
  },
});

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const LOADERS: Record<string, "js" | "jsx" | "ts" | "tsx" | "json" | "toml" | "text"> = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".json": "json", ".toml": "toml",
};

/** A bundled plugin runs only the bytes its staging verified (#322's review, S2): every module Bun loads from under its
 *  tree is read once, checked against its digest and handed to Bun from those bytes (`onLoad`), so a file rewritten
 *  after staging, or between a check and its load, never runs; one with no digest is refused. A native addon is
 *  checked the same way in the load guard's dlopen hook, through the function this publishes. Returns the entry's real
 *  path, to import. A data file read with `fs` isn't a module load and isn't checked. */
function verifyTree(pluginId: string, entry: string, file: string, v: { root: string; files: Record<string, string> }): string {
  const refuse = (what: string, why: string): never => {
    throw new ContractError("refused", `${pluginId}'s ${what} ${why}; it doesn't run`);
  };
  const files = new Map(Object.entries(v.files));
  const checked = (path: string): Buffer => {
    const expected = files.get(path);
    if (expected === undefined) refuse(path, "is a bundled plugin's file with no verified copy recorded");
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      return refuse(path, `can't be read (${(err as Error).message})`);
    }
    if (sha256(bytes) !== expected) refuse(path, "isn't the bundled code Clover verified (its SHA-256 changed after staging)");
    return bytes;
  };
  let real: string;
  try {
    real = realpathSync(file);
  } catch (err) {
    return refuse(entry, `can't be read (${(err as Error).message})`);
  }
  if (!files.has(real)) refuse(entry, "is a bundled plugin's with no verified copy recorded");
  const prefix = v.root.endsWith(sep) ? v.root : v.root + sep;
  const under = new RegExp(`^${prefix.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}`);
  Bun.plugin({
    name: `clover-verified-${pluginId}`,
    setup(build) {
      build.onLoad({ filter: under }, (args) => ({ contents: checked(args.path).toString("utf8"), loader: LOADERS[extname(args.path).toLowerCase()] ?? "text" }));
    },
  });
  const check = (filename: string): void => {
    let r: string;
    try {
      r = realpathSync(filename);
    } catch {
      r = filename;
    }
    if (r.startsWith(prefix)) checked(r);
  };
  Object.defineProperty(globalThis, Symbol.for("clover.verifiedFile"), { value: check, writable: false, configurable: false, enumerable: false });
  checked(real);
  return real;
}
