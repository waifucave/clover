// A plugin's worker inside a plugin-host process (spec §5.2: each plugin in its own worker). It runs the plugin's built
// host entry under `HostRuntime`, talking to its process (`HostMux`) over the worker's port, answers the heartbeat, and
// sends what the plugin writes to the console to its log, never to the process's stdout.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError } from "../contracts/common";
import type { HostModule } from "../contracts/sdk-types";
import { portPeer } from "./link";
import { API_CALL_OF, HostRuntime } from "./runtime";

declare const self: { postMessage(m: unknown): void; addEventListener(type: "message", fn: (e: { data: unknown }) => void): void };

const peer = portPeer(self);
const computer = String((globalThis as { workerData?: { computer?: string } }).workerData?.computer ?? process.env.CLOVER_COMPUTER ?? "");
peer.handle("ping", () => "pong");

// The console goes to the plugin's log (`pluginHost.log`), one line per call.
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => peer.notify("log", { line: args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ").slice(0, 4000) });
}

// A plugin-API call that failed and that the plugin neither awaited nor caught: a line in its log naming the call, and
// the worker goes on (a failed call is the call's failure, not a crash; contracts/plugin-host.ts). Any other unhandled
// rejection is the plugin's own error and ends the worker as before: a crash, with that error.
process.on("unhandledRejection", (reason: unknown) => {
  const call = reason !== null && typeof reason === "object" ? (reason as { [API_CALL_OF]?: unknown })[API_CALL_OF] : undefined;
  if (typeof call !== "string") throw reason;
  const code = (reason as { code?: unknown }).code;
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`the plugin API call ${call} failed and nothing awaited it: ${typeof code === "string" ? `${code}: ` : ""}${message}`.slice(0, 2000));
});

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
  // Bun keeps a module's CommonJS interop only when it reads the file itself (measured: contents an onLoad returns are
  // taken as ESM), so a CommonJS file (`.cjs`, `.cts`, or `.js` outside a `"type": "module"` package) is checked when
  // it's resolved, just before Bun reads it, and every other module is served from the checked bytes. The CommonJS
  // check leaves a same-user race between the check and Bun's read; the ESM one leaves none.
  const typeModule = new Map<string, boolean>();
  const isModuleDir = (dir: string): boolean => {
    if (!(dir + sep).startsWith(prefix) && dir !== v.root) return false;
    const known = typeModule.get(dir);
    if (known !== undefined) return known;
    const pkg = join(dir, "package.json");
    let found: boolean;
    if (files.has(pkg)) {
      try {
        found = JSON.parse(checked(pkg).toString("utf8")).type === "module";
      } catch {
        found = false;
      }
    } else found = dir === v.root || dirname(dir) === dir ? false : isModuleDir(dirname(dir));
    typeModule.set(dir, found);
    return found;
  };
  const esm = (path: string): boolean => {
    const ext = extname(path).toLowerCase();
    if (ext === ".cjs" || ext === ".cts" || ext === ".node") return false;
    if (ext === ".js") return isModuleDir(dirname(path));
    return LOADERS[ext] !== undefined;
  };
  const served = [...files.keys()].filter(esm);
  const esc = (p: string) => p.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  const exact = served.length === 0 ? /^$^/ : new RegExp(`^(?:${served.map(esc).join("|")})$`);
  Bun.plugin({
    name: `clover-verified-${pluginId}`,
    setup(build) {
      build.onLoad({ filter: exact }, (args) => ({ contents: checked(args.path).toString("utf8"), loader: LOADERS[extname(args.path).toLowerCase()] ?? "text" }));
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith("bun:") || args.path.startsWith("node:")) return undefined;
        let resolved: string;
        try {
          resolved = realpathSync(Bun.resolveSync(args.path, args.importer ? dirname(args.importer) : v.root));
        } catch {
          return undefined;
        }
        // A file with no digest (planted after staging) is refused here, whatever its kind; a CommonJS one is checked.
        if (resolved.startsWith(prefix) && (!files.has(resolved) || !esm(resolved))) checked(resolved);
        return undefined;
      });
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
