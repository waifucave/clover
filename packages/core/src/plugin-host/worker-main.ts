// A plugin's worker inside a plugin-host process (spec §5.2: each plugin in its own worker). It runs the plugin's built
// host entry under `HostRuntime`, talking to its process (`HostMux`) over the worker's port, answers the heartbeat, and
// sends what the plugin writes to the console to its log, never to the process's stdout.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  load: async (p) => (await import(pathToFileURL(join(p.folder, p.entry)).href)) as HostModule,
});
