// What the bot tests share: a plugin folder read from disk and validated by the plugin SDK, as lane B's registry
// will (B-M1), then handed to B's FakePluginRegistry; a boot of the bot service on a temp home; and drivers a test
// steers. Nothing here touches a real home or the network.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { validateTree, type PluginFolderReader, type TreeReport } from "../../../../plugin-sdk/src/manifest/tree";
import type { Manifest } from "../../contracts/sdk-types";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginRegistry, type FakePluginInput } from "../../contracts/fakes/plugin-registry";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { CacheTimedCompaction } from "../../sessions/compaction";
import type { DurableSessionHost } from "../../sessions/durable-host";
import type { BotGate } from "../gate";
import type { MainComputer } from "../main-computer";
import type { BotRelay } from "../service";
import { createBotSide, type BotSide, type BotSideOptions } from "../wiring";
import { BotService, type BotSessionContext } from "../service";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";

/** The repo's root, from `packages/core/src/bots/tests/`. */
export const REPO = resolve(import.meta.dir, "../../../../..");
export const ALPHA_FOLDER = join(REPO, "plugins", "alpha");

export function diskReader(dir: string): PluginFolderReader {
  const at = (p: string) => join(dir, ...p.split("/"));
  return {
    readText: (p) => (existsSync(at(p)) && statSync(at(p)).isFile() ? readFileSync(at(p), "utf8") : undefined),
    exists: (p) => existsSync(at(p)),
    listDirs: (p) => (existsSync(at(p)) ? readdirSync(at(p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []),
    insideFolder: (p) => {
      const real = realpathSync(at(p));
      const root = realpathSync(dir);
      return real === root || real.startsWith(root + sep);
    },
  };
}

/** A plugin folder as the registry would hold it: the top-level plugin and each child that validates. */
export async function pluginFromFolder(dir: string, opts: { bundled?: boolean } = {}): Promise<{ report: TreeReport; inputs: FakePluginInput[] }> {
  const id = dir.split(sep).pop()!;
  const report = await validateTree(diskReader(dir), { folderName: id, ...(opts.bundled === undefined ? {} : { bundled: opts.bundled }) });
  const source = opts.bundled ? "bundled" : "local";
  const inputs: FakePluginInput[] = [];
  if (report.top.manifest !== undefined) inputs.push({ id, manifest: report.top.manifest, folder: dir, source, issues: report.top.issues });
  for (const child of report.children) {
    if (!child.ok || child.report.manifest === undefined) continue;
    inputs.push({ id: `${id}/${child.folder}`, manifest: child.report.manifest, folder: join(dir, "plugins", child.folder), source, issues: child.report.issues });
  }
  return { report, inputs };
}

const temps: string[] = [];
export function tempDir(prefix = "clover-d-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
export function removeTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Writes a plugin folder: `files` maps paths inside it to their text (objects are written as JSON). */
export function writePlugin(root: string, id: string, files: Record<string, string | object>): string {
  const dir = join(root, id);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
}

export function botManifest(id: string | undefined, name: string, extra: Record<string, unknown> = {}): Manifest {
  return {
    manifest: 1, ...(id === undefined ? {} : { id }), name,
    contributes: { bot: { name, instructions: "bot/instructions.md", ...extra } },
  } as Manifest;
}

/** Drivers the bot service made, by session, newest last, and what each was told about its bot. */
export class Drivers {
  readonly made: { ctx: BotSessionContext; driver: FakeSessionDriver }[] = [];
  readonly factory = (ctx: BotSessionContext) => {
    const driver = new FakeSessionDriver({ canFold: true });
    this.made.push({ ctx, driver });
    return driver;
  };
  for(session: string): FakeSessionDriver {
    const found = [...this.made].reverse().find((m) => m.ctx.sessionId === session);
    if (!found) throw new Error(`no driver for ${session}`);
    return found.driver;
  }
}

export interface Boot {
  home: string;
  clock: FakeClock;
  registry: FakePluginRegistry;
  host: DurableSessionHost;
  bots: BotService;
  gate: BotGate;
  compaction: CacheTimedCompaction;
  drivers: Drivers;
  warnings: string[];
}

/** A daemon's bot side on `home` (wiring.ts): the durable host over the transcripts there, the gate, compaction, and
 *  the bot service over a registry holding `plugins`. Call `shutdown` to release everything, as a daemon stopping
 *  would. */
export async function boot(opts: {
  home: string; plugins: FakePluginInput[]; clock?: FakeClock; hasKeyFor?: (model: string) => boolean; computer?: string;
  main?: MainComputer; relay?: BotRelay; compaction?: BotSideOptions["compaction"]; approvals?: BotSideOptions["approvals"];
  reattach?: BotSideOptions["reattach"];
}): Promise<Boot & { side: BotSide; shutdown(): Promise<void> }> {
  const clock = opts.clock ?? new FakeClock();
  const warnings: string[] = [];
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: opts.plugins });
  const drivers = new Drivers();
  const side = createBotSide({
    home: opts.home, computer: opts.computer ?? "Studio", registry, drivers: drivers.factory, clock,
    defaultModel: () => ({ model: "fireworks/kimi-k3" }),
    ...(opts.hasKeyFor === undefined ? {} : { hasKeyFor: opts.hasKeyFor }),
    ...(opts.main === undefined ? {} : { main: opts.main }),
    ...(opts.relay === undefined ? {} : { relay: opts.relay }),
    ...(opts.compaction === undefined ? {} : { compaction: opts.compaction }),
    ...(opts.approvals === undefined ? {} : { approvals: opts.approvals }),
    ...(opts.reattach === undefined ? {} : { reattach: opts.reattach }),
    assetUrl: (pluginId, path) => `clover-asset://${pluginId.replace("/", "--")}/${path}`,
    warn: (m) => warnings.push(m),
  });
  await side.start();
  return {
    home: opts.home, clock, registry, host: side.host, bots: side.bots, gate: side.gate, compaction: side.compaction, drivers, warnings, side,
    shutdown: () => side.close(),
  };
}
