// The plugin workshop (spec §5.6, the workshop rule): a bot builds a plugin in its scratch, installs it with its own
// tool, and edits it afterwards in place. Three core tools, for a bot's own sessions (its conversation and its side
// threads, never an agent's):
//
// * `PluginValidate { folder }`: what `clover plugin validate` says of a folder (its class, what it adds and reaches,
//   every finding, the OK card's text) and, for the bot's own installed plugin, whether that tree would apply without a
//   card against the user's last OK (`workshopAdds`). A read: nothing runs, nothing is copied.
// * `PluginInstall { folder }`: a folder inside the bot's scratch or the session's outputs, copied in as any install is
//   (staged, validated, renamed in: install-folder.ts), recorded as built by this bot, and found: the user's sealed OK
//   card, which names the bot as its builder, is the only gate, and nothing of it runs before the yes. An id that is
//   already installed is refused, unless it is this bot's own workshop plugin; then the folder takes its place as an
//   update, judged like any edit by the workshop rule. Removal stays the user's.
// * `PluginStatus { id }`: one of the bot's own workshop plugins, so it can fix it: its state and why (a client build's
//   failure is its reason), what it waits for, its validation findings, and its log's last lines.
//
// What the rule lets the bot do after the OK (folders.ts): its sessions write the plugin's folder (lane A's fence
// exception), and each edit applies at once, code included, while it asks for nothing the last OK didn't list; one that
// does asks again on a card. The bot's edits never grant its plugin anything: the card decides.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { MANIFEST_FILE } from "@waifucave/clover-plugin-sdk";
import type { Os, PluginProvenance, PluginState, ValidationIssue } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { CoreToolDef, CoreToolResult } from "../runtime-sdk/turn-loop/servers";
import { botPaths } from "../bots/paths";
import { outdirPath } from "../sessions/outdir";
import { pluginPath } from "../plugin-host/paths";
import { copyTreeInto, installStaged, installStagingDir, newStage, replaceStaged, sourceFolder } from "./install-folder";
import { renderValidation, validatePluginFolder } from "./validate";

/** How many of a plugin's log lines `PluginStatus` hands back. */
export const WORKSHOP_LOG_LINES = 50;

/** What the workshop reads of the registry. */
export interface WorkshopRegistry {
  get(id: string): { id: string; state: PluginState; reason?: string; waitingFor?: readonly string[]; treeHash?: string; okHash?: string; issues: readonly ValidationIssue[]; provenance: PluginProvenance; source: string } | undefined;
  installed(id: string, from: "bot"): Promise<{ state: PluginState; card?: string }>;
}

/** What the workshop does through the plugin folders. */
export interface WorkshopFolders {
  installed(id: string, by: "bot", from: { bot: string }): Promise<void>;
  refresh(folder: string): Promise<void>;
  provenanceOf(id: string): PluginProvenance | undefined;
  workshopTrigger(id: string, folder: string, provenance: PluginProvenance): Promise<string | undefined>;
}

export interface WorkshopOptions {
  /** The Clover home: `<home>/plugins`, the staging folder, the scratch and outputs folders, the plugin logs. */
  home: string;
  os?: Os;
  registry: WorkshopRegistry;
  folders: WorkshopFolders;
  /** What an earlier plugin under an id left, settled before a new folder lands (`leftovers.ts`). */
  leftovers?: (id: string, treeHash: string | undefined, from: Partial<PluginProvenance>) => Promise<void>;
  /** The user's home and this computer's name: a folder given as a tree path (`home/<Computer>/…`) resolves there. */
  userHome?: string;
  computer?: string;
}

/** Who calls: the bot, and the session (its outputs folder is the second place it may install from). */
export interface WorkshopCaller {
  bot: string;
  sessionId: string;
}

export interface WorkshopInstall {
  id: string;
  state: PluginState;
  card?: string;
  /** An update of the bot's own workshop plugin rather than a new install. */
  updated: boolean;
  /** For an update: what it asks for beyond the last OK, which a card then asks about; undefined when it applies. */
  asks?: string;
}

export interface WorkshopStatus {
  id: string;
  state: PluginState;
  reason?: string;
  waitingFor?: readonly string[];
  issues: readonly ValidationIssue[];
  logs: string[];
  /** The OK'd tree is the folder as it is now. */
  current: boolean;
}

const isInside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** The last `n` lines of a plugin's log (`<home>/logs/plugins/<id>.log`), each cut to 4,000 characters. */
function logTail(home: string, id: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(`${pluginPath(join(home, "logs", "plugins"), id)}.log`, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l !== "");
  return lines.slice(Math.max(0, lines.length - n)).map((l) => l.slice(0, 4000));
}

export class PluginWorkshop {
  readonly #o: WorkshopOptions;

  constructor(o: WorkshopOptions) {
    this.#o = o;
  }

  /** The folders a bot may install from: its scratch, and the calling session's outputs. */
  roots(caller: WorkshopCaller): string[] {
    return [botPaths(this.#o.home, caller.bot).scratch, outdirPath(this.#o.home, caller.sessionId)];
  }

  /** A folder the bot named: absolute, a tree path on this computer, or relative to its scratch. Its real path, which must
   *  sit inside one of its roots (`roots`) and hold a manifest. */
  resolveFolder(caller: WorkshopCaller, folder: string): string {
    const scratch = botPaths(this.#o.home, caller.bot).scratch;
    let path = folder.trim();
    if (path === "") throw new ContractError("invalid", "name the plugin's folder");
    const tree = /^home\/([^/]+)\/(.*)$/.exec(path);
    if (tree !== null && this.#o.userHome !== undefined && this.#o.computer !== undefined && tree[1] === this.#o.computer) path = join(this.#o.userHome, tree[2]!);
    if (!isAbsolute(path)) path = resolve(scratch, path);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new ContractError("not_found", `${folder} doesn't exist`);
    }
    if (!statSync(real).isDirectory()) throw new ContractError("invalid", `${folder} isn't a folder`);
    const roots = this.roots(caller).filter((r) => existsSync(r)).map((r) => realpathSync(r));
    if (!roots.some((r) => isInside(r, real))) throw new ContractError("refused", `a bot installs a plugin from its own scratch folder (${scratch}) or this conversation's outputs, not ${folder}`);
    if (roots.includes(real)) throw new ContractError("invalid", "name the plugin's own folder inside your scratch, not the scratch folder itself");
    if (!existsSync(join(real, MANIFEST_FILE))) throw new ContractError("invalid", `${folder} has no ${MANIFEST_FILE}`);
    return real;
  }

  /** Whether `id` is a plugin this bot built (its install record says so). */
  #own(caller: WorkshopCaller, id: string): PluginProvenance | undefined {
    const p = this.#o.folders.provenanceOf(id);
    return p !== undefined && p.by === "bot" && p.bot === caller.bot ? p : undefined;
  }

  async validate(caller: WorkshopCaller, folder: string): Promise<string> {
    const real = this.resolveFolder(caller, folder);
    const v = await validatePluginFolder(real, ...(this.#o.os ? [{ os: this.#o.os }] : []));
    const lines = [renderValidation(v)];
    const id = v.plugin?.id;
    if (id !== undefined && v.ok && this.#o.registry.get(id) !== undefined) {
      const own = this.#own(caller, id);
      if (own === undefined) lines.push("", `${id} is already installed and isn't one you built: PluginInstall refuses this id. Give the plugin another id.`);
      else {
        const asks = await this.#o.folders.workshopTrigger(id, real, own);
        lines.push("", asks === undefined
          ? `Installed with PluginInstall, this updates your plugin ${id} at once, with no card: it asks for nothing the user's last OK didn't list.`
          : `Installed with PluginInstall, this updates your plugin ${id}, and the user is asked again first: ${asks}.`);
      }
    }
    return lines.join("\n");
  }

  async install(caller: WorkshopCaller, folder: string): Promise<WorkshopInstall> {
    const root = this.resolveFolder(caller, folder);
    const pluginsDir = join(this.#o.home, "plugins");
    sourceFolder(root, pluginsDir);
    const stage = newStage(installStagingDir(this.#o.home));
    const staged = join(stage.dir, basename(root));
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    try {
      copyTreeInto(root, staged);
      const v = await validatePluginFolder(staged, ...(this.#o.os ? [{ os: this.#o.os }] : []));
      const id = v.plugin?.id;
      const existing = id === undefined ? undefined : this.#o.registry.get(id);
      if (id !== undefined && existing !== undefined) {
        // An id already here: only the bot's own workshop plugin, whose folder this replaces as an update.
        const own = this.#own(caller, id);
        if (own === undefined || existing.source !== "local") throw new ContractError("conflict", `${id} is already installed and isn't a plugin you built; give yours another id`);
        const asks = await this.#o.folders.workshopTrigger(id, staged, own);
        await replaceStaged(staged, { pluginsDir, ...(this.#o.os ? { os: this.#o.os } : {}) }, id);
        await this.#o.folders.refresh(join(pluginsDir, id));
        const now = this.#o.registry.get(id);
        if (now === undefined) throw new ContractError("failed", `${id} was updated but isn't found; its folder is ${join(pluginsDir, id)}`);
        const raised = now.state === "found" ? await this.#o.registry.installed(id, "bot") : { state: now.state };
        return { id, state: raised.state, ...(raised.card !== undefined ? { card: raised.card } : {}), updated: true, ...(asks !== undefined ? { asks } : {}) };
      }
      const done = await installStaged(staged, {
        pluginsDir, stagingDir: installStagingDir(this.#o.home), ...(this.#o.os ? { os: this.#o.os } : {}),
        taken: (pluginId) => this.#o.registry.get(pluginId) !== undefined,
        ...(this.#o.leftovers !== undefined ? { leftovers: this.#o.leftovers } : {}),
      }, { from: { by: "bot", bot: caller.bot } });
      await this.#o.folders.installed(done.id, "bot", { bot: caller.bot });
      if (this.#o.registry.get(done.id) === undefined) throw new ContractError("failed", `${done.id} was copied in but isn't found; its folder is ${done.folder}`);
      const raised = await this.#o.registry.installed(done.id, "bot");
      return { id: done.id, state: raised.state, ...(raised.card !== undefined ? { card: raised.card } : {}), updated: false };
    } finally {
      stage.done();
    }
  }

  status(caller: WorkshopCaller, id: string): WorkshopStatus {
    const r = this.#o.registry.get(id);
    if (r === undefined || this.#own(caller, id) === undefined) throw new ContractError("refused", `${id} isn't a plugin you built; PluginStatus reads only your own`);
    return {
      id, state: r.state, ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(r.waitingFor !== undefined && r.waitingFor.length > 0 ? { waitingFor: r.waitingFor } : {}),
      issues: r.issues, logs: logTail(this.#o.home, id, WORKSHOP_LOG_LINES), current: r.okHash !== undefined && r.okHash === r.treeHash,
    };
  }
}

/** What a plugin's state means to the bot that built it, in a line. */
const STATE_WORDS: Partial<Record<PluginState, string>> = {
  found: "waiting for the user's OK on its card",
  running: "running",
  waiting: "running, with some of what it adds waiting for a point or a setting",
  invalid: "invalid: it doesn't load until it's fixed",
  off: "off",
  refused: "refused by the user: it stays off until its folder changes",
  stopped: "stopped after crashing",
  blocked: "blocked",
};

const ok = (text: string): CoreToolResult => ({ text, isError: false });
const fail = (text: string): CoreToolResult => ({ text, isError: true });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 2000);
const folderOf = (input: unknown) => (input !== null && typeof input === "object" && typeof (input as { folder?: unknown }).folder === "string" ? (input as { folder: string }).folder : undefined);

/** The three workshop tools for one bot session. */
export function workshopToolDefs(workshop: PluginWorkshop, caller: WorkshopCaller): CoreToolDef[] {
  const folderSchema = {
    type: "object",
    properties: { folder: { type: "string", description: "The plugin's folder: inside your scratch folder (a path relative to it, or absolute), or this conversation's outputs." } },
    required: ["folder"],
    additionalProperties: false,
  };
  return [
    {
      name: "PluginValidate",
      description: [
        "Check a plugin folder you are building, as `clover plugin validate` does, without running or installing anything:",
        "what it is (data, web or code), what it adds and reaches, every error and warning, and the text the user's OK card",
        "will show. For a plugin you already installed, it also says whether installing this folder would update it at",
        "once or ask the user again. Fix every error before PluginInstall.",
      ].join(" "),
      inputSchema: folderSchema,
      run: async (input) => {
        const folder = folderOf(input);
        if (folder === undefined) return fail("PluginValidate needs `folder`.");
        try {
          return ok(await workshop.validate(caller, folder));
        } catch (err) {
          return fail(`Couldn't check ${folder}: ${errorText(err)}`);
        }
      },
    },
    {
      name: "PluginInstall",
      description: [
        "Install a plugin you built from your scratch folder (or this conversation's outputs) into Clover's plugins folder.",
        "It lands waiting for the user's OK on a card that names you as its builder; nothing of it runs before their yes.",
        "After the OK, edit the installed folder in place (the result says where): an edit that asks for nothing beyond what",
        "the card listed reloads at once, with no card; one that adds a capability, a network host, a program or anything",
        "else the card lists asks the user again. Installing the same id again replaces your own plugin with this folder",
        "as an update, judged the same way. You can't install over a plugin you didn't build, and only the user removes one.",
      ].join(" "),
      inputSchema: folderSchema,
      run: async (input) => {
        const folder = folderOf(input);
        if (folder === undefined) return fail("PluginInstall needs `folder`.");
        try {
          const r = await workshop.install(caller, folder);
          const where = join("plugins", r.id);
          const head = r.updated ? `Updated your plugin ${r.id}` : `Installed ${r.id}`;
          const state = STATE_WORDS[r.state] ?? r.state;
          const asks = r.asks !== undefined ? ` The user is asked again, since ${r.asks}.` : "";
          const edit = r.updated ? "" : ` Once it's OK'd, edit it in place at ${where} under Clover's home.`;
          return ok(`${head}: ${state}.${asks}${edit} PluginStatus ${r.id} shows its state, findings and log.`);
        } catch (err) {
          return fail(`Couldn't install ${folder}: ${errorText(err)}`);
        }
      },
    },
    {
      name: "PluginStatus",
      description: [
        "The state of a plugin you built and installed: running, waiting for the user's OK, invalid or stopped, and why",
        "(a client build's error is the reason), what it waits for, its validation findings and the last lines of its",
        "log. Use it after an install or an edit to see whether it loaded, and to fix it if it didn't.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The plugin's id." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: async (input) => {
        const id = input !== null && typeof input === "object" && typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id.trim() : "";
        if (id === "") return fail("PluginStatus needs `id`.");
        try {
          const s = workshop.status(caller, id);
          const lines = [`${s.id}: ${STATE_WORDS[s.state] ?? s.state}${s.reason ? ` (${s.reason})` : ""}`];
          if (!s.current && s.state === "found") lines.push("Its folder changed since the user's last OK, and the change waits for a new one.");
          if (s.waitingFor !== undefined) lines.push(`Waiting for: ${s.waitingFor.join(", ")}`);
          for (const i of s.issues.slice(0, 40)) lines.push(`${i.severity}: ${i.file ? `${i.file} ` : ""}${i.path ? `${i.path}: ` : ""}${i.message} [${i.code}]`);
          lines.push(s.logs.length > 0 ? `Its log's last ${s.logs.length} lines:` : "Its log is empty.");
          lines.push(...s.logs);
          return ok(lines.join("\n"));
        } catch (err) {
          return fail(errorText(err));
        }
      },
    },
  ];
}
