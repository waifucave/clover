// A plugin's worker inside a plugin-host process (spec §5.2: each plugin in its own worker). It runs the plugin's built
// host entry under `HostRuntime`, talking to its process (`HostMux`) over the worker's port, answers the heartbeat, and
// sends what the plugin writes to the console to its log, never to the process's stdout.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
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
    if (p.entrySha256 !== undefined) runVerifiedBytes(p.pluginId, p.entry, file, p.entrySha256);
    return (await import(pathToFileURL(file).href)) as HostModule;
  },
});

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/** A bundled plugin's entry runs from the bytes checked against the SHA-256 recorded when it was staged (#322's
 *  review, S2): read once here, refused when they differ, and handed to Bun for this one file (`onLoad`), so a file
 *  rewritten after the check (or between the check and the import) never runs. */
function runVerifiedBytes(pluginId: string, entry: string, file: string, sha256: string): void {
  const refuse = (why: string): never => {
    throw new ContractError("refused", `${pluginId}'s ${entry} ${why}; it doesn't run`);
  };
  if (sha256 === "") refuse("is a bundled plugin's with no verified copy recorded");
  let real: string;
  let bytes: Buffer;
  try {
    real = realpathSync(file);
    bytes = readFileSync(real);
  } catch (err) {
    return refuse(`can't be read (${(err as Error).message})`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) refuse("isn't the bundled code Clover verified (its SHA-256 changed after staging)");
  const contents = bytes.toString("utf8");
  const ext = extname(real).toLowerCase();
  const loader = ext === ".ts" || ext === ".mts" || ext === ".cts" ? "ts" : "js";
  const exact = new RegExp(`^${real.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}$`);
  Bun.plugin({
    name: `clover-verified-${pluginId}`,
    setup(build) {
      build.onLoad({ filter: exact }, () => ({ contents, loader }));
    },
  });
}
