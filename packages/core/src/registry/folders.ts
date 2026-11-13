// Where plugins come from (spec §5.1, §5.6): the plugins folder, which the registry watches and reads once a plugin's
// folder has been unchanged for 2 seconds and its manifest parses; the app's bundled plugins, read-only and OK'd;
// and development folders, which reload on every change without asking, exist only on this computer, never sync,
// turn off after 24 hours unless renewed, and replace an installed plugin with their id while they are on.
//
// Each top-level folder is read without running anything: its tree hash, `validateTree`'s report for it and its
// children, and what changed since its tree was last OK'd (`classifyChange`), which the state machine applies.
import { shownCode } from "../approvals/strings";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MANIFEST_FILE, PLUGIN_API_VERSION, backgroundOkLines, catalogPointDecl, describeOk, hookOkLines, parseJsonc, treeHash, validateTree, type TreeReport } from "@waifucave/clover-plugin-sdk";
import type { PluginProvenance, PluginSource, ValidationIssue } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { parentOf } from "../contracts/plugin-registry-rules";
import type { Manifest } from "../contracts/sdk-types";
import { classifyChange, codeFieldsFrom, okSnapshot, updateAddsTrigger, workshopAdds, type CodeFieldsOf, type OkSnapshot } from "./changes";
import type { Leftovers } from "./leftovers";

/** The code fields of the catalog's points; a point the catalog doesn't declare counts as code whole. */
export const catalogCodeFields: CodeFieldsOf = (point) => codeFieldsFrom(catalogPointDecl(point));

/** The code fields of a point the tree itself declares (its host's `declares`, or an entry's, in the plugin or a child),
 *  read from the tree: a plugin's own points are known whether or not the plugin runs now. Before, the registry knew
 *  them only while the plugin was on, so a tree read while it waited for its OK (its install, an edit's card) counted
 *  each entry of its own points as code whole, and the next read while it ran didn't: every bot edit after an OK asked
 *  again (the owner's reel, 14f). A well-known name keeps the catalog's declaration, as the registry records it. */
export function ownPointsFirst(tree: TreeReport, fallback: CodeFieldsOf): CodeFieldsOf {
  const own = new Map<string, { fields?: unknown }>();
  const add = (declares: unknown) => {
    if (declares === null || typeof declares !== "object") return;
    for (const [name, decl] of Object.entries(declares as Record<string, unknown>)) if (!own.has(name) && decl !== null && typeof decl === "object") own.set(name, decl as { fields?: unknown });
  };
  for (const m of [tree.top.manifest, ...tree.children.map((c) => c.report.manifest)]) {
    if (m === undefined) continue;
    add((m.host as { declares?: unknown } | undefined)?.declares);
    for (const raw of Object.values((m.contributes ?? {}) as Record<string, unknown>)) {
      for (const e of Array.isArray(raw) ? raw : [raw]) if (e !== null && typeof e === "object") add((e as { declares?: unknown }).declares);
    }
  }
  return (point) => {
    if (catalogPointDecl(point) !== undefined) return fallback(point);
    const decl = own.get(point);
    return decl !== undefined ? codeFieldsFrom(decl) : fallback(point);
  };
}
import type { RegistryCore, RegistryInput } from "./core";
import type { OkText } from "./ok-cards";
import { wrapperNetworkOpen } from "./wrap";
import type { DevFolderState, RegistryStore } from "./state";

/** Who wrote a plugin, from the core's own record (§5.6), as the OK says it. */
/** What the core wrapped a plugin around, as the OK says it (§5.1). */
export const WRAPPED_FROM_TEXT: Readonly<Record<NonNullable<PluginProvenance["wrapped"]>["from"], string>> = {
  "mcp-config": "an MCP server's config",
  "mcp-url": "an MCP server's address",
  "skill-folder": "a skill folder (SKILL.md)",
  "agent-file": "an agent file",
  "claude-plugin": "a Claude Code plugin folder",
};

/** The OK's lines for a wrapped plugin: what Clover made it around, and the parts that stay in its folder unused. */
export function wrappedLines(wrapped: PluginProvenance["wrapped"]): string[] {
  if (wrapped === undefined) return [];
  const out = [`Clover made this plugin around ${WRAPPED_FROM_TEXT[wrapped.from]}; you can open and edit it in the plugins folder.`];
  if ((wrapped.unused ?? []).length > 0) out.push(`Left in its folder unused, since Clover has no place for them yet: ${wrapped.unused!.join(", ")}.`);
  // Paths as a card shows a name it didn't write: every character that hides or reorders text as a visible escape.
  const shown = (p: string) => shownCode(p).replace(/[\n\t]/g, (c) => (c === "\n" ? "\\n" : "\\t"));
  if ((wrapped.reads ?? []).length > 0) out.push(`It will read: ${wrapped.reads!.map(shown).join(", ")} (never a .git folder or an .env file in them). Its config runs a program there; it reads it, never writes it.`);
  if ((wrapped.unreadable ?? []).length > 0) {
    out.push(`It can't read ${wrapped.unreadable!.map(shown).join(", ")}, so its server may not start: Clover never opens your whole home folder, its Documents, Desktop or Downloads folders whole, a place that keeps keys, a .git folder or an .env file. Move the program into a folder of its own and paste the config again. If its server needs a folder beside its own, its log says which.`);
  }
  return out;
}

/** Whether an OK snapshot's tree holds `approvals` (it places sealed card frames in its components). */
function placesCards(ok: OkSnapshot): boolean {
  try {
    return (JSON.parse(ok.cards) as { approvals?: unknown }).approvals === true;
  } catch {
    return true;
  }
}

/** A bot-built plugin's OK card source line (the workshop rule, §5.6): who built it, and that its later edits within
 *  what the card lists apply without asking. */
export function builtByText(bot: string): string {
  return `Built by ${bot}. ${bot} can change its code later without asking, within what this card lists.`;
}

export const PROVENANCE_TEXT: Readonly<Record<PluginProvenance["by"], string>> = {
  "user-app": "You added it in the app.",
  "user-terminal": "You added it in your terminal.",
  bot: "A bot added it with its tools.",
  migration: "It came over in the migration from the old app.",
  found: "It was found on disk.",
  bundled: "It ships with Clover.",
  plugin: "A plugin asked to add it.",
};

/** The OK card's source line for a plugin a component asked to install (`plugins.install`): which plugin asked. */
export function askedByPluginText(asker: string, name: string): string {
  return `${asker} wants to add ${name}.`;
}
import { TreeProblem, folderReader, treeEntries } from "./tree";
import { folderLoaderReach, loaderOutsideIssues } from "./loader-config";

/** How long a folder must be unchanged before it is read (§5.1). */
export const SETTLE_MS = 2_000;
/** The catch-up look (`#catchUp`): the OS's file watch can drop an event (Bun's `fs.watch` on macOS loses some, under
 *  load and as a watch starts), so every few seconds the folders a change must reach are looked at too, and one that
 *  changed is read as a watched change is. */
export const CATCH_UP_MS = 5_000;
/** The most entries a catch-up fingerprint looks at in one folder (`node_modules` and `.git` are never walked). */
const CATCH_UP_ENTRIES = 5_000;
/** How long a development folder stays on unless renewed (§5.6). */
export const DEV_FOLDER_MS = 24 * 60 * 60 * 1000;

export interface PluginFoldersOptions {
  core: RegistryCore;
  store: RegistryStore;
  /** `<cloverHome>/plugins`. */
  pluginsDir: string;
  /** The app's read-only plugin folders (each subfolder a plugin: `clover`, `alpha`). */
  bundledDirs?: readonly string[];
  /** The plugin API the app has (`PLUGIN_API_VERSION`). */
  apiVersion?: string;
  /** The fields of a plugin point whose format is `program` or `code`. */
  codeFieldsOf?: CodeFieldsOf;
  settleMs?: number;
  /** How often the catch-up look runs (`CATCH_UP_MS`; 0: never). */
  catchUpMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** One top-level folder as read: its inputs (top-level first), the snapshot its OK would keep, and whether its
 *  manifest parses (a folder whose manifest doesn't is left as it was until it does, §5.1). */
export interface ReadFolder {
  id: string;
  inputs: RegistryInput[];
  snapshot?: OkSnapshot;
  parses: boolean;
  /** The validator's report, for the OK's text. */
  tree?: TreeReport;
}

const firstError = (issues: readonly ValidationIssue[]) => issues.find((i) => i.severity === "error" && i.refuses === "plugin")?.message;

/** Reads a top-level plugin folder. */
export async function readPluginFolder(
  folder: string,
  opts: { source: PluginSource; dev?: boolean; bundled?: boolean; apiVersion?: string; codeFieldsOf?: CodeFieldsOf; provenance?: PluginProvenance },
): Promise<ReadFolder> {
  const name = basename(folder);
  const base = { source: opts.source, folder, ...(opts.dev ? { dev: true } : {}), ...(opts.provenance ? { provenance: opts.provenance } : {}) };
  const placeholder = (): Manifest => ({ manifest: 1, name } as Manifest);
  // A manifest that doesn't parse yet is a write in progress: the folder is left as it was until it does (§5.1).
  let parses = true;
  if (existsSync(join(folder, MANIFEST_FILE))) {
    try {
      parses = parseJsonc(readFileSync(join(folder, MANIFEST_FILE), "utf8")).ok;
    } catch {
      parses = false;
    }
  }
  let entries;
  try {
    entries = treeEntries(folder, { allowHardLinks: opts.dev === true });
  } catch (e) {
    const reason = e instanceof TreeProblem ? e.message : `the folder can't be read: ${(e as Error).message}`;
    return { id: name, parses, inputs: [{ ...base, id: name, manifest: placeholder(), invalid: reason, treeHash: `sha256:invalid:${name}` }] };
  }
  const hash = await treeHash(entries);
  const tree: TreeReport = await validateTree(folderReader(folder), { folderName: name, bundled: opts.bundled ?? false, apiVersion: opts.apiVersion ?? PLUGIN_API_VERSION });
  const id = tree.top.id ?? name;
  // Loader configs: what their `extends`, `paths` and package maps reach is code; reaching outside the tree makes the
  // whole plugin invalid (#234's review, F2): a plugin never pulls code or config in from elsewhere.
  const loader = folderLoaderReach(folder, entries.map((e) => e.path));
  // Every plugin but a bundled one, which ships with the app and extends the repository's shared tsconfig: a development
  // folder's code runs in plugin processes too (#234's check 5, K3).
  const judged = opts.bundled !== true;
  const loaderIssues = judged ? loaderOutsideIssues(loader) : [];
  const topIssues = [...tree.top.issues, ...tree.issues.filter((i) => !i.file.startsWith("plugins/")), ...loaderIssues];
  const treeOk = tree.ok && loaderIssues.length === 0;
  const topInvalid = treeOk ? undefined : (firstError(topIssues) ?? "the plugin doesn't validate");
  const top: RegistryInput = {
    ...base, id, manifest: tree.top.manifest ?? placeholder(), treeHash: hash, class: tree.top.class, issues: topIssues,
    ...(topInvalid === undefined ? {} : { invalid: topInvalid }),
  };
  const inputs: RegistryInput[] = [top];
  for (const child of tree.children) {
    const childId = child.report.id ?? `${id}/${child.folder}`;
    const file = `plugins/${child.folder}/`;
    const issues = [...child.report.issues, ...tree.issues.filter((i) => i.file.startsWith(file))];
    const invalid = child.ok ? undefined : (firstError(issues) ?? "the plugin doesn't validate");
    inputs.push({
      ...base, id: childId, manifest: child.report.manifest ?? ({ manifest: 1, name: child.folder } as Manifest), treeHash: hash,
      class: child.report.class, issues, folder: join(folder, "plugins", child.folder), ...(invalid === undefined ? {} : { invalid }),
    });
  }
  const snapshot = treeOk ? { ...okSnapshot(hash, entries, tree, ownPointsFirst(tree, opts.codeFieldsOf ?? catalogCodeFields), loader.inside), okLines: treeOkLines(folder, tree) } : undefined;
  return { id, inputs, ...(snapshot ? { snapshot } : {}), parses, tree };
}

interface Source {
  folder: string;
  source: PluginSource;
  dev?: DevFolderState;
  bundled?: boolean;
}

/** What each agent backend the plugin contributes takes from the user's environment and sets in its own (lane K's
 *  #233 lists them on the agent's OK card; the plugin's own OK shows them too, so the user sees them when approving the
 *  plugin, not only when delegating). Read from each backend's quirks file as main has it today
 *  (`{ quirks: { launch: { envAllow, envSet } } }`). K: keep this reader's shape aligned with #233's entries. */
/** The OK card's lines that come from the tree alone, as `okText` builds them, with nothing of this computer or of where
 *  it came from: the lines an update may not add or alter without a new OK (`updateAddsTrigger`). Left out on purpose:
 *  the source line and the wrapper's lines (the install record's, never the tree's; wrappers don't
 *  update), and the per-computer lines (non-macOS logins, no sandbox here, host code held), which follow the class. */
export function treeOkLines(folder: string, tree: TreeReport): string[] {
  const all = [tree.top, ...tree.children.map((c) => c.report)];
  return [
    ...describeOk(tree.top, { restylesCards: tree.restylesCards, treeCapabilities: all.flatMap((m) => m.capabilities) }),
    ...hookOkLines(all),
    ...backgroundOkLines(all),
    ...agentEnvLines(folder, tree),
  ];
}

export function agentEnvLines(folder: string, tree: TreeReport): string[] {
  const lines: string[] = [];
  const reports = [{ dir: "", report: tree.top }, ...tree.children.map((c) => ({ dir: `plugins/${c.folder}/`, report: c.report }))];
  for (const { dir, report } of reports) {
    for (const backend of report.manifest?.contributes?.agentBackends ?? []) {
      if (backend.quirks === undefined) continue;
      let launch: { envAllow?: unknown; envSet?: unknown } | undefined;
      try {
        const doc = JSON.parse(readFileSync(join(folder, dir, backend.quirks), "utf8")) as { quirks?: { launch?: unknown }; launch?: unknown };
        launch = (doc.quirks?.launch ?? doc.launch) as typeof launch;
      } catch {
        launch = undefined;
      }
      const name = typeof backend.name === "string" ? backend.name : backend.id;
      const allow = Array.isArray(launch?.envAllow) ? launch.envAllow.filter((n): n is string => typeof n === "string") : [];
      const set = launch?.envSet !== null && typeof launch?.envSet === "object" ? Object.keys(launch.envSet as object) : [];
      if (allow.length > 0) lines.push(`Its agent backend ${name} gets from your environment: ${allow.join(", ")}.`);
      if (set.length > 0) lines.push(`Its agent backend ${name} sets in its environment: ${set.join(", ")}.`);
    }
  }
  return lines;
}

export class PluginFolders {
  readonly #o: PluginFoldersOptions;
  readonly #now: () => number;
  /** The tree each held plugin has now, for its OK's snapshot. */
  readonly #current = new Map<string, OkSnapshot>();
  /** The tree each plugin's "asks again" line was last said for. */
  readonly #askedSaid = new Map<string, string>();
  /** Top-level id → the folder it came from; and what each folder held last read. */
  readonly #byFolder = new Map<string, string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Who installed a folder just copied in (`plugin.install`), until its record keeps it. */
  readonly #installedBy = new Map<string, PluginProvenance>();
  /** The drop (the owner's ask on 14c: a bot moves or copies a plugin it built into the plugins folder, and Clover
   *  indexes it and asks the OK): each top-level name a bot's session made there, by name, until the registry's first
   *  read records it. A name two bots claimed is nobody's (`#dropConflicts`). */
  readonly #droppedBy = new Map<string, string>();
  readonly #dropConflicts = new Set<string>();
  /** The plugins-folder names a bundled plugin holds that were logged as ignored (once each). */
  readonly #bundledNamesLogged = new Set<string>();
  /** The top-level names in the plugins folder when the watch started: a folder already there at start keeps its card
   *  on the user's switch; one that appears while Clover runs gets its OK card at once (the coordinator's ruling). */
  #bootNames: Set<string> | undefined;
  /** An update being applied (`updated`): the tree it brings and its new provenance, until its record keeps them. */
  readonly #updating = new Map<string, { treeHash: string; provenance: PluginProvenance }>();
  /** An update's files line for its OK card, by the tree it put in place (`updated`). */
  readonly #updateLines = new Map<string, { treeHash: string; line: string }>();
  readonly #watchers = new Map<string, FSWatcher>();
  /** The catch-up look's timer, and what it saw last: the plugins folder's names, each development folder's and each
   *  waiting plugin folder's fingerprint. */
  #catchUpTimer: ReturnType<typeof setInterval> | undefined;
  #seenNames: Set<string> | undefined;
  readonly #seenPrints = new Map<string, string>();
  /** Each folder's read generation, and its newest read (`refresh`). */
  readonly #gens = new Map<string, number>();
  readonly #newest = new Map<string, Promise<void>>();
  #expiry: ReturnType<typeof setTimeout> | undefined;
  readonly #devListeners = new Set<() => void>();
  /** Each development folder's plugin's tree as last read, to tell a save that changed it (`lastReloadAt`). */
  readonly #devHashes = new Map<string, string | undefined>();
  readonly #reports = new Map<string, { tree: TreeReport; source: PluginSource; provenance: PluginProvenance; folder: string }>();

  constructor(opts: PluginFoldersOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  #leftovers: Leftovers | undefined;

  /** What a plugin leaves when its folder goes without `plugin.remove` (`leftovers.ts`): recorded when it goes, and
   *  settled before a tree next comes under its id. */
  setLeftovers(l: Leftovers): void {
    this.#leftovers = l;
  }

  /** A top-level plugin's folder went (not a development folder's, not a bundled one's): what it leaves is recorded. */
  #wentAway(id: string): void {
    const r = this.#o.core.get(id);
    if (this.#leftovers === undefined || r === undefined || r.dev || r.source === "bundled" || r.parent !== undefined) return;
    this.#leftovers.left(r, this.#o.core.list().filter((c) => c.parent === id).map((c) => c.id));
  }
  /** The OK for a tree was given: keep what it held (`oks/<id>.json`). */
  okGiven(id: string, treeHash: string): void {
    const top = parentOf(id) ?? id;
    // A development folder's tree never replaces the installed plugin's OK snapshot under the id.
    const holder = this.#byFolder.get(top);
    if (holder !== undefined && this.#isDevFolder(holder)) return;
    const snap = this.#current.get(top);
    if (snap?.okHash === treeHash) this.#o.store.saveOk(top, snap);
  }

  /** Reads every folder once: the bundled plugins, the plugins folder, and the development folders that are on. */
  async scan(): Promise<void> {
    mkdirSync(this.#o.pluginsDir, { recursive: true });
    const reads: ReadFolder[] = [];
    for (const s of this.#sources()) {
      const r = await this.#read(s);
      if (r) reads.push(r);
    }
    const seen = new Set(reads.map((r) => r.id));
    const removed = this.#o.core.list().filter((p) => p.parent === undefined && !seen.has(p.id)).map((p) => p.id);
    for (const id of removed) this.#wentAway(id);
    for (const r of reads) if (r.snapshot) this.#current.set(r.id, r.snapshot);
    this.#o.core.putAll(reads.flatMap((r) => r.inputs), removed);
    this.#armExpiry();
  }

  /** A bot's session made `name` in the plugins folder (its file tools' write, or a shell call it ran): the folder's
   *  first read records it as `{by: "bot", bot}`, so its OK card says who built it and that bot edits it in place after
   *  the OK. A name the records already hold, or one another bot claimed too, is nobody's drop. */
  dropped(name: string, bot: string): boolean {
    if (name.startsWith(".") || this.#bundledNames().has(name) || this.#o.store.load().plugins[name] !== undefined || this.#dropConflicts.has(name)) return false;
    const was = this.#droppedBy.get(name);
    if (was !== undefined && was !== bot) {
      this.#droppedBy.delete(name);
      this.#dropConflicts.add(name);
      return false;
    }
    this.#droppedBy.set(name, bot);
    // Read once it settles even if the watch missed the change (a move into the folder right as the watch starts).
    this.#settle(join(this.#o.pluginsDir, name));
    return true;
  }

  /** A path Clover's own tools just wrote (a bot's Write or Edit the fence let through): the plugins-folder folder it is
   *  in is read once it settles, without waiting for the watch or the catch-up look. Any other path is ignored. */
  touched(path: string): void {
    // As written, or by real paths (the fence hands real ones; the plugins folder may sit under a link, as /var does).
    const inside = (dir: string, p: string) => { const r = relative(dir, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : undefined; };
    const rel = inside(resolve(this.#o.pluginsDir), resolve(path)) ?? inside(realPath(this.#o.pluginsDir), resolve(path));
    const name = rel?.split(/[\\/]/)[0];
    if (name === undefined || name === "" || name.startsWith(".")) return;
    this.#settle(join(this.#o.pluginsDir, name));
  }

  /** The names a bot dropped that the registry hasn't recorded yet (its sessions write inside them meanwhile); every
   *  bot's without one. */
  pendingDrops(bot?: string): string[] {
    return [...this.#droppedBy].filter(([, b]) => bot === undefined || b === bot).map(([name]) => name);
  }

  /** Watches the plugins folder and the development folders; each change is read once it settles. */
  start(): void {
    this.#bootNames = new Set(listDirs(this.#o.pluginsDir));
    this.#watch(this.#o.pluginsDir, (rel) => {
      const name = rel.split(/[/\\]/)[0];
      // A dot-name is never a plugin (`#sources` skips them too): an install's staging folder, a system file.
      if (name && !name.startsWith(".")) this.#settle(join(this.#o.pluginsDir, name));
    });
    for (const d of this.devFolders()) {
      this.#devHashes.set(d.path, this.#devTreeHash(d.path));
      this.#watchDev(d.path);
    }
    this.#catchUp();
    const every = this.#o.catchUpMs ?? CATCH_UP_MS;
    if (every > 0 && this.#catchUpTimer === undefined) {
      this.#catchUpTimer = setInterval(() => this.#catchUp(), every);
      (this.#catchUpTimer as { unref?: () => void }).unref?.();
    }
  }

  /** The watch's safety net: a change it dropped is read anyway, within `CATCH_UP_MS` (5 s: a look over three bot-built
   *  plugins of 300 files each took about 4.5 ms, 0.09% of a core at 5 s against 0.15% at 3 s; the listing alone 0.03 ms). One listing of the plugins
   *  folder (a name that appeared or went), and a fingerprint (each file's path, size and time) of every development
   *  folder, of every plugins-folder folder still waiting to be a plugin (no record yet, or found or invalid: a copy
   *  in progress, a card waiting), and of every plugin a bot built ("Built by …"), running or not. Other installed
   *  plugins aren't looked at. With none of those, the listing is all it does. The first look only records what is
   *  there. */
  #catchUp(): void {
    const first = this.#seenNames === undefined;
    const names = new Set(listDirs(this.#o.pluginsDir).filter((n) => !n.startsWith(".")));
    const changed = new Set<string>();
    if (!first) for (const n of new Set([...names, ...this.#seenNames!])) if (names.has(n) !== this.#seenNames!.has(n)) changed.add(join(this.#o.pluginsDir, n));
    this.#seenNames = names;
    const dev = new Set(this.devFolders().map((d) => d.path));
    const looked = new Set<string>(dev);
    for (const n of names) {
      const folder = join(this.#o.pluginsDir, n);
      const id = [...this.#byFolder].find(([, f]) => f === resolve(folder))?.[0];
      const record = id === undefined ? undefined : this.#o.core.get(id);
      const state = record?.state;
      // Waiting to be a plugin, or one a bot built here, running or not (its builder edits it in place, with its shell
      // or a build step too, which no tool path tells the registry about).
      if (state === undefined || state === "found" || state === "invalid" || record?.provenance.by === "bot") looked.add(folder);
    }
    for (const folder of [...this.#seenPrints.keys()]) if (!looked.has(folder)) this.#seenPrints.delete(folder);
    for (const folder of looked) {
      const print = fingerprint(folder);
      const was = this.#seenPrints.get(folder);
      this.#seenPrints.set(folder, print);
      if (was !== undefined && was !== print) changed.add(folder);
    }
    for (const folder of changed) this.#settle(folder, dev.has(folder) ? () => this.#reloadedIfChanged(folder) : undefined);
  }

  stop(): void {
    if (this.#catchUpTimer !== undefined) clearInterval(this.#catchUpTimer);
    this.#catchUpTimer = undefined;
    this.#seenNames = undefined;
    this.#seenPrints.clear();
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    if (this.#expiry) clearTimeout(this.#expiry);
  }

  /** Reads one folder now (what a settled change does): it appeared, changed or went away. */
  /** A folder `plugin.install` just copied into the plugins folder: read now, with who installed it as its provenance
   *  (the OK card's "from" line). A plugin the core generated around a bare item is `wrapped`: its source says so, and
   *  its provenance keeps what it was made from and the parts left unused (§5.1). */
  async installed(id: string, by: "user-app" | "user-terminal" | "bot" | "plugin", from: { wrapped?: NonNullable<PluginProvenance["wrapped"]>; index?: NonNullable<PluginProvenance["index"]>; npm?: NonNullable<PluginProvenance["npm"]>; bot?: string; plugin?: string } = {}): Promise<void> {
    // A bot's install (the workshop's `PluginInstall`) names its builder: its edits are judged by the workshop rule.
    if (by === "bot" && from.bot === undefined) throw new Error("a bot's install names the bot");
    // A component's (`plugins.install`) names the plugin that asked: its OK card says so.
    if (by === "plugin" && from.plugin === undefined) throw new Error("a plugin's install names the plugin");
    this.#installedBy.set(id, { by, at: this.#now(), ...(from.bot !== undefined ? { bot: from.bot } : {}), ...(from.plugin !== undefined ? { plugin: from.plugin } : {}), ...(from.wrapped !== undefined ? { wrapped: from.wrapped } : {}), ...(from.index !== undefined ? { index: from.index } : {}), ...(from.npm !== undefined ? { npm: from.npm } : {}) });
    try {
      await this.refresh(join(this.#o.pluginsDir, id));
    } finally {
      this.#installedBy.delete(id);
    }
  }

  /** An update from an index or npm was put in place (`indexes/update.ts`): read it with its new provenance; the OK
   *  given carries over to this exact tree unless it adds a trigger (`updateAddsTrigger`), when it asks again. */
  async updated(id: string, treeHash: string, provenance: PluginProvenance, changed?: string): Promise<void> {
    this.#updating.set(id, { treeHash, provenance });
    // What changed in its files, for the OK card an update that asks again raises (the user's click was an informed one).
    if (changed !== undefined) this.#updateLines.set(id, { treeHash, line: changed });
    else this.#updateLines.delete(id);
    try {
      await this.refresh(join(this.#o.pluginsDir, id));
    } finally {
      this.#updating.delete(id);
    }
  }

  /** For a plugin a bot built: what the tree in `folder` adds against the user's last OK of `id` by the workshop rule
   *  (`workshopAdds`), or undefined when it would apply without a card. No OK kept: everything asks. */
  async workshopTrigger(id: string, folder: string, provenance: PluginProvenance): Promise<string | undefined> {
    const ok = this.#o.store.loadOk(id);
    if (ok === undefined) return "it has no OK on this computer yet";
    const r = await readPluginFolder(folder, {
      source: "local", bundled: false, provenance,
      ...(this.#o.apiVersion ? { apiVersion: this.#o.apiVersion } : {}),
      ...(this.#o.codeFieldsOf ? { codeFieldsOf: this.#o.codeFieldsOf } : {}),
    });
    if (r.snapshot === undefined) return "its tree couldn't be read";
    return r.snapshot.okHash === ok.okHash ? undefined : workshopAdds(ok, r.snapshot);
  }

  /** The record of who wrote a plugin, as this computer holds it (`plugin.get`'s provenance). */
  provenanceOf(id: string): PluginProvenance | undefined {
    return this.#o.store.load().plugins[id]?.provenance ?? this.#installedBy.get(id);
  }

  #botName: ((id: string) => string | undefined) | undefined;

  /** The bots' names as the user sees them, for a bot-built plugin's OK card ("Built by <bot>"). */
  setBotNames(fn: (id: string) => string | undefined): void {
    this.#botName = fn;
  }

  /** What an update to `snapshot`'s tree adds that asks for a new OK, against the OK'd tree's; undefined for none.
   *  No OK kept: everything asks. The staged folder is read as the registry reads its own. */
  async updateTrigger(id: string, folder: string, provenance: PluginProvenance): Promise<string | undefined> {
    const ok = this.#o.store.loadOk(id);
    if (ok === undefined) return "it has no OK on this computer";
    const r = await readPluginFolder(folder, {
      source: provenance.npm !== undefined ? "npm" : "index", bundled: false, provenance,
      ...(this.#o.apiVersion ? { apiVersion: this.#o.apiVersion } : {}),
      ...(this.#o.codeFieldsOf ? { codeFieldsOf: this.#o.codeFieldsOf } : {}),
    });
    return r.snapshot === undefined ? "its tree couldn't be read" : updateAddsTrigger(ok, r.snapshot);
  }

  async refresh(folder: string): Promise<void> {
    const abs = resolve(folder);
    // Each read of a folder is one generation: a read that a newer one overtook (a removal's, an install's, the next
    // settle's) puts nothing, so a folder removed while an older read awaited its tree never comes back from it. Its
    // caller waits for the newest read instead, which has the last word.
    const gen = (this.#gens.get(abs) ?? 0) + 1;
    this.#gens.set(abs, gen);
    const run = this.#refreshOnce(abs, () => this.#gens.get(abs) === gen);
    this.#newest.set(abs, run);
    try {
      await run;
    } finally {
      for (let newest = this.#newest.get(abs); newest !== undefined && newest !== run; newest = this.#newest.get(abs)) {
        const waited = newest;
        await waited.catch(() => undefined);
        if (this.#newest.get(abs) === waited) break;
      }
      if (this.#gens.get(abs) === gen) this.#newest.delete(abs);
    }
  }

  async #refreshOnce(abs: string, current: () => boolean): Promise<void> {
    const s = this.#sources().find((x) => resolve(x.folder) === abs);
    const was = [...this.#byFolder].find(([, f]) => f === abs)?.[0];
    if (!s) {
      // Gone: a folder made again under its name later is one that appeared (its card comes at once).
      if (resolve(dirname(abs)) === resolve(this.#o.pluginsDir)) this.#bootNames?.delete(basename(abs));
      if (was !== undefined && !this.#shadowed(was, abs)) {
        this.#wentAway(was);
        this.#byFolder.delete(was);
        this.#current.delete(was);
        this.#o.core.remove(was);
        await this.#restoreShadowed(was);
      } else if (was === undefined && resolve(dirname(abs)) === resolve(this.#o.pluginsDir)) {
        // An installed folder deleted while a development folder stands over its id: its kept record goes.
        const id = basename(abs);
        const holder = this.#byFolder.get(id);
        if (holder !== undefined && this.#isDevFolder(holder)) this.#o.core.forgetInstalled(id);
      }
      return;
    }
    const r = await this.#read(s);
    if (!r || !current()) return;
    if (!r.parses && was !== undefined) return; // wait until the manifest parses (§5.1)
    if (r.snapshot) this.#current.set(r.id, r.snapshot);
    const removed = was !== undefined && was !== r.id ? [was] : [];
    for (const id of removed) this.#wentAway(id);
    this.#o.core.putAll(r.inputs, [...removed, ...this.#staleChildren(r)]);
    // The workshop rule (§5.6, the controller's ruling): a bot's in-place change that asks for more stops the plugin and
    // puts its sealed OK card before the user at once, as an install does; a later change while it waits replaces that
    // card (the core keeps one per plugin).
    const held = this.#o.core.get(r.id);
    if (held !== undefined && held.state === "found" && held.okHash !== undefined && held.provenance.by === "bot" && held.source === "local") {
      void this.#o.core.installed(r.id, "bot").catch((err: unknown) => this.#o.log?.(`plugins: ${r.id}'s OK card for its change wasn't raised: ${(err as Error)?.message ?? String(err)}`));
    }
    // The drop: a folder that appeared in the plugins folder while Clover runs (a bot's `mv` or `cp -R`, its file tools'
    // writes, or the user's own copy) is asked about at once, with the same sealed OK card as an install, once its tree
    // has settled and its manifest is valid. Its card shows the tree as last read: a folder that changes while its card
    // waits gets a new card for the new tree (the core withdraws the old one), so no OK covers a tree the user didn't see.
    const top = resolve(dirname(abs)) === resolve(this.#o.pluginsDir);
    const appeared = top && this.#bootNames !== undefined && !this.#bootNames.has(basename(abs));
    if (held !== undefined && held.state === "found" && held.okHash === undefined && held.source === "local" && (appeared || this.#o.core.okCards().some((c) => c.id === r.id))) {
      const from = held.provenance.by === "bot" ? "bot" : "app";
      void this.#o.core.installed(r.id, from).catch((err: unknown) => this.#o.log?.(`plugins: ${r.id}'s OK card wasn't raised: ${(err as Error)?.message ?? String(err)}`));
    }
    // Recorded now (the store keeps its provenance from here): the claim is spent.
    if (held !== undefined && held.state !== "invalid") this.#droppedBy.delete(r.id);
  }

  /** The OK's text for a top-level plugin as last read (§5.6): what it is, adds and reaches, and who wrote it. */
  okText(id: string, os: "macos" | "windows" | "linux", hostNetworkHeld = false, sandboxed?: boolean): OkText {
    const r = this.#reports.get(id);
    if (!r) return { title: id, lines: [`${id} was found on disk.`], source: PROVENANCE_TEXT.found };
    const name = r.tree.top.manifest?.name;
    const title = typeof name === "string" ? name : (name as { en?: string } | undefined)?.en ?? id;
    return {
      title,
      lines: [
        ...describeOk(r.tree.top, {
          os, restylesCards: r.tree.restylesCards, restylesWindow: r.tree.restylesWindow, hostNetworkHeld,
          ...(sandboxed !== undefined ? { sandboxed } : {}),
          // The fence reads the same fact (`wrapperOpensNetwork`): the record's grant, and no `network:` host in the tree.
          ...(wrapperNetworkOpen(r.provenance.wrapped, [r.tree.top, ...r.tree.children.map((c) => c.report)].flatMap((m) => m.capabilities)) ? { networkOpen: true } : {}),
          // Its read-only tools still ask where its tree can reach the network (`pluginToolReadOnly` reads the same).
          treeCapabilities: [r.tree.top, ...r.tree.children.map((c) => c.report)].flatMap((m) => m.capabilities),
          wrappedNetwork: r.provenance.wrapped?.network !== undefined,
        }),
        // What its hooks see of the conversation (the plugin's and its children's), in Clover's words.
        ...hookOkLines([r.tree.top, ...r.tree.children.map((c) => c.report)]),
        // What it runs without being asked: its routine triggers, and where its host code runs in the background.
        ...backgroundOkLines([r.tree.top, ...r.tree.children.map((c) => c.report)]),
        ...agentEnvLines(r.folder, r.tree),
        ...wrappedLines(r.provenance.wrapped),
        ...gainsNetworkLines(this.#o.store.loadOk(id), [r.tree.top, ...r.tree.children.map((c) => c.report)]),
        ...this.#updateLineOf(id),
      ],
      source: r.provenance.by === "bot" && r.provenance.bot !== undefined ? builtByText(this.#botName?.(r.provenance.bot) ?? r.provenance.bot)
        : r.provenance.by === "plugin" && r.provenance.plugin !== undefined ? askedByPluginText(this.#pluginName(r.provenance.plugin), title)
        : PROVENANCE_TEXT[r.provenance.by],
    };
  }

  /** The files line of the update that put this tree in place, while the record is on that tree. */
  #updateLineOf(id: string): string[] {
    const u = this.#updateLines.get(id);
    if (u === undefined) return [];
    const now = this.#o.core.get(id)?.treeHash;
    return now === undefined || now === u.treeHash ? [u.line] : [];
  }

  /** A plugin's name as its record has it (its id when it has none, or isn't installed). */
  #pluginName(id: string): string {
    const n = this.#o.core.get(id)?.name as unknown;
    const text = typeof n === "string" ? n : (n as { en?: unknown } | undefined)?.en;
    return typeof text === "string" && text.trim() !== "" ? text : id;
  }

  // ---- development folders (§5.6) ----

  devFolders(): DevFolderState[] {
    return this.#o.core.devFolders.filter((d) => d.expiresAt > this.#now());
  }

  /** The paths the fence keeps bots out of, and no agent root may hold (§9.1). */
  devFolderPaths(): string[] {
    return this.devFolders().map((d) => d.path);
  }

  /** The development folders changed: the fence's set changes with them. */
  onDevFoldersChanged(fn: () => void): () => void {
    this.#devListeners.add(fn);
    return () => this.#devListeners.delete(fn);
  }

  /** Adds a development folder. From the app, the RPC layer's sealed card has already been answered (§5.6). */
  async addDevFolder(path: string, by: "cli" | "app"): Promise<DevFolderState> {
    // The real path, symlinks resolved, is what reloads and what the fence keeps bots out of (#197's review).
    const abs = realPath(path);
    if (!existsSync(join(abs, MANIFEST_FILE)) || !statSync(abs).isDirectory()) throw new ContractError("invalid", `${abs} has no ${MANIFEST_FILE}`);
    const plugins = realPath(this.#o.pluginsDir);
    if (abs === plugins || abs.startsWith(plugins + sep) || plugins.startsWith(abs + sep)) {
      throw new ContractError("invalid", "a development folder is kept outside the plugins folder");
    }
    const at = this.#now();
    const entry: DevFolderState = { path: abs, by, addedAt: at, expiresAt: at + DEV_FOLDER_MS };
    this.#o.core.devFolders = [...this.#o.core.devFolders.filter((d) => d.path !== abs), entry];
    this.#devChanged();
    this.#watchDev(abs);
    // The catch-up look's starting point is the folder as added: a save from here on is read even if the watch misses it.
    this.#seenPrints.set(abs, fingerprint(abs));
    await this.refresh(abs);
    // The tree as added: a save that changes it later is a reload.
    this.#devHashes.set(abs, this.#devTreeHash(abs));
    return entry;
  }

  async removeDevFolder(path: string): Promise<void> {
    const abs = realPath(path);
    if (!this.#o.core.devFolders.some((d) => d.path === abs)) throw new ContractError("not_found", `${abs} isn't a development folder`);
    this.#o.core.devFolders = this.#o.core.devFolders.filter((d) => d.path !== abs);
    this.#watchers.get(abs)?.close();
    this.#watchers.delete(abs);
    this.#devChanged();
    await this.refresh(abs);
  }

  async renewDevFolder(path: string): Promise<number> {
    const abs = realPath(path);
    const d = this.#o.core.devFolders.find((x) => x.path === abs);
    if (!d) throw new ContractError("not_found", `${abs} isn't a development folder`);
    const expiresAt = this.#now() + DEV_FOLDER_MS;
    this.#o.core.devFolders = this.#o.core.devFolders.map((x) => (x.path === abs ? { ...x, expiresAt } : x));
    this.#armExpiry();
    return expiresAt;
  }

  /** Turns off the development folders whose 24 hours are up. */
  async expireDevFolders(): Promise<void> {
    const now = this.#now();
    const gone = this.#o.core.devFolders.filter((d) => d.expiresAt <= now);
    if (gone.length === 0) return;
    this.#o.core.devFolders = this.#o.core.devFolders.filter((d) => d.expiresAt > now);
    this.#devChanged();
    for (const d of gone) {
      this.#watchers.get(d.path)?.close();
      this.#watchers.delete(d.path);
      await this.refresh(d.path);
    }
  }

  // ---- inside ----

  /** Every folder that holds a plugin now: development folders first, so one with an installed plugin's id replaces it
   *  on this computer; then the bundled plugins and the plugins folder. */
  #sources(): Source[] {
    const out: Source[] = [];
    for (const d of this.devFolders()) if (existsSync(join(d.path, MANIFEST_FILE))) out.push({ folder: d.path, source: "local", dev: d });
    const bundled = this.#bundledNames();
    for (const dir of this.#o.bundledDirs ?? []) for (const name of listDirs(dir)) out.push({ folder: join(dir, name), source: "bundled", bundled: true });
    for (const name of listDirs(this.#o.pluginsDir)) {
      if (name.startsWith(".")) continue;
      // A folder named like a plugin Clover ships (`alpha`, `clover`) is not a plugin, whoever put it there (a bot's
      // `mv`, the user's copy): read, it would take the bundled plugin's place in the registry. Ignored, with a log line
      // once, no card; the bundled plugin stays as it is.
      if (bundled.has(name)) {
        if (!this.#bundledNamesLogged.has(name)) {
          this.#bundledNamesLogged.add(name);
          this.#o.log?.(`plugins: ${join(this.#o.pluginsDir, name)} is ignored: "${name}" is a bundled plugin's id`);
        }
        continue;
      }
      const stored = this.#o.store.load().plugins[name];
      const prov = stored?.provenance ?? this.#installedBy.get(name);
      out.push({ folder: join(this.#o.pluginsDir, name), source: stored?.source ?? (prov?.wrapped !== undefined ? "wrapped" : prov?.index !== undefined ? "index" : prov?.npm !== undefined ? "npm" : "local") });
    }
    return out;
  }

  /** Reads a source, unless another one already holds its id (a development folder replaces an installed plugin). */
  async #read(s: Source): Promise<ReadFolder | undefined> {
    const id = basename(s.folder);
    const holder = this.#byFolder.get(id);
    if (holder !== undefined && holder !== resolve(s.folder) && this.#isDevFolder(holder) && !s.dev) return undefined;
    const stored = this.#o.store.load().plugins[id];
    const update = !s.dev && !s.bundled ? this.#updating.get(id) : undefined;
    const drop = !s.dev && !s.bundled && stored === undefined ? this.#droppedBy.get(id) : undefined;
    const provenance: PluginProvenance = update?.provenance ?? stored?.provenance ?? this.#installedBy.get(id)
      ?? (drop !== undefined ? { by: "bot", at: this.#now(), bot: drop } : { by: s.bundled ? "bundled" : "found", at: this.#now() });
    const r = await readPluginFolder(s.folder, {
      source: s.source, bundled: s.bundled ?? false, provenance,
      ...(s.dev ? { dev: true } : {}),
      ...(this.#o.apiVersion ? { apiVersion: this.#o.apiVersion } : {}),
      ...(this.#o.codeFieldsOf ? { codeFieldsOf: this.#o.codeFieldsOf } : {}),
    });
    // A tree new to the records, found on disk (copied in by hand, or there at start): what an earlier plugin under its
    // id left is kept for the same tree or source, else forgotten first; a forget that fails leaves this one unread.
    // An install settles before its folder lands (`installStaged`), an update keeps its record.
    if (this.#leftovers !== undefined && !s.dev && !s.bundled && stored === undefined && !this.#installedBy.has(id) && update === undefined && !this.#leftovers.settled(id)) {
      try {
        await this.#leftovers.settle(id, { ...(r.inputs[0]?.treeHash?.startsWith("sha256:invalid") ? {} : { treeHash: r.inputs[0]?.treeHash }), provenance });
      } catch (err) {
        this.#o.log?.(`plugins: ${id} isn't read: ${(err as Error).message}`);
        return undefined;
      }
    }
    // Bundled plugins and development folders are OK'd as they are; a found folder waits for the user's OK unless the
    // records hold one (an install the user made, or an earlier OK), in which case what changed since then decides.
    const ok = this.#o.store.loadOk(r.id);
    const known = stored?.okHash !== undefined || stored?.refusedHash !== undefined;
    // An update that put back the very tree the user OK'd (its new version refused or failed) runs on that OK again.
    const restored = update !== undefined && stored?.okHash !== undefined && stored.okHash === update.treeHash && r.inputs.find((i) => i.id === r.id)?.treeHash === update.treeHash;
    const approved = s.bundled || s.dev || restored ? true : known ? undefined : false;
    let change = ok && r.snapshot ? classifyChange(ok, r.snapshot) : undefined;
    // An update the core put in place (§5.1): its OK covers this exact tree when it adds no trigger, code changes
    // included. Anything else about it (a tree other than the one fetched) is judged as any change.
    if (ok && r.snapshot && update !== undefined && r.snapshot.okHash === update.treeHash) {
      if (updateAddsTrigger(ok, r.snapshot) !== undefined) {
        // It adds to its OK card (a new name or author, more capabilities…): it asks again, whatever else changed, so
        // nothing new runs on the old OK (the owner's ruling, 2026-11-13).
        change = "asks-again";
      } else if (change === "asks-again") change = r.snapshot.cards !== ok.cards ? "card-styling" : "applies";
    }
    // The workshop rule (§5.6): a plugin a bot built, which that bot's sessions edit in place. Its edits, code included,
    // apply without a card while they ask for nothing the user's last OK didn't list (`workshopAdds`); one that does
    // asks again as any change. Card styling still waits for its own OK. An applied edit becomes the OK snapshot, so the
    // ceiling only goes down. Never a development folder's or a bundled tree's. A tree the user OK'd with `approvals`
    // places its bot's sealed cards in its own components and writes its own words around them, which its card
    // styling (`OkSnapshot.cards`) doesn't cover: there a code change is held as card styling for its OK (§5.5), so the
    // builder can't redress those cards without a card (the controller's ruling).
    if (change === "asks-again" && ok && r.snapshot && update === undefined && !s.dev && !s.bundled && provenance.by === "bot" && provenance.bot !== undefined && workshopAdds(ok, r.snapshot) === undefined) {
      change = r.snapshot.cards !== ok.cards || placesCards(ok) ? "card-styling" : "applies";
    }
    const workshop = !s.dev && !s.bundled && provenance.by === "bot" && provenance.bot !== undefined;
    // An OK'd plugin whose change asks again says why, once per tree (its log line; PluginStatus tells its builder the
    // same through `workshopTrigger`).
    const tree = r.inputs.find((i) => i.id === r.id)?.treeHash;
    if ((change === "asks-again" || change === "card-styling") && ok && r.snapshot && stored?.okHash !== undefined && tree !== undefined && this.#askedSaid.get(r.id) !== tree) {
      this.#askedSaid.set(r.id, tree);
      const why = change === "card-styling" ? "it changes how its approval cards look (or a tree that places its own cards changed its code)"
        : (workshop && update === undefined ? workshopAdds(ok, r.snapshot) : update !== undefined ? updateAddsTrigger(ok, r.snapshot) : undefined)
          ?? "its code changed, and its OK covers only the tree it was given for";
      this.#o.log?.(`${r.id}: asks again: ${why}`);
    }
    for (const input of r.inputs) {
      if (approved !== undefined) input.approved = approved;
      if (change !== undefined) input.change = change;
      if (workshop) input.workshop = true;
    }
    this.#byFolder.set(r.id, resolve(s.folder));
    if (r.tree) this.#reports.set(r.id, { tree: r.tree, source: s.source, provenance, folder: s.folder });
    return r;
  }

  /** The ids of the plugins Clover ships (the bundled folders' names). */
  #bundledNames(): Set<string> {
    return new Set((this.#o.bundledDirs ?? []).flatMap((dir) => listDirs(dir)));
  }

  #isDevFolder(folder: string): boolean {
    return this.devFolders().some((d) => d.path === folder);
  }

  /** Whether another folder now holds the id `was` (a development folder over an installed one, or the reverse). */
  #shadowed(id: string, folder: string): boolean {
    const holder = this.#byFolder.get(id);
    return holder !== undefined && holder !== folder;
  }

  /** A development folder went away: the installed plugin with its id comes back. */
  async #restoreShadowed(id: string): Promise<void> {
    const installed = join(this.#o.pluginsDir, id);
    if (existsSync(installed)) await this.refresh(installed);
    // The installed folder went while the development folder stood over it: nothing to bring back, nothing kept.
    else this.#o.core.forgetInstalled(id);
  }

  /** Children the folder held last time and doesn't now. */
  #staleChildren(r: ReadFolder): string[] {
    const now = new Set(r.inputs.map((i) => i.id));
    return this.#o.core.list().filter((p) => p.parent === r.id && !now.has(p.id)).map((p) => p.id);
  }

  #settle(folder: string, after?: () => void): void {
    const key = resolve(folder);
    const t = this.#timers.get(key);
    if (t) clearTimeout(t);
    this.#timers.set(key, setTimeout(() => {
      this.#timers.delete(key);
      this.refresh(key).then(() => after?.(), (e) => this.#o.log?.(`plugins: ${key} can't be read: ${(e as Error).message}`));
    }, this.#o.settleMs ?? SETTLE_MS));
  }

  #watch(dir: string, onChange: (rel: string) => void): void {
    if (this.#watchers.has(dir)) return;
    try {
      const w = watch(dir, { recursive: true }, (_event, file) => onChange(file === null ? "" : String(file)));
      w.on("error", (e) => this.#o.log?.(`plugins: watching ${dir} stopped: ${e.message}`));
      this.#watchers.set(dir, w);
    } catch (e) {
      this.#o.log?.(`plugins: ${dir} can't be watched: ${(e as Error).message}`);
    }
  }

  #watchDev(path: string): void {
    this.#watch(path, () => this.#settle(path, () => this.#reloadedIfChanged(path)));
  }

  /** The tree of the plugin a development folder holds, as the registry read it last. */
  #devTreeHash(path: string): string | undefined {
    const id = [...this.#byFolder].find(([, f]) => f === resolve(path))?.[0];
    return id === undefined ? undefined : this.#o.core.get(id)?.treeHash;
  }

  /** After a settled save in a development folder: when its plugin's tree changed, it was loaded again, and the
   *  folder says when (`plugin.dev.list`'s `lastReloadAt`, the Plugins page's "Loaded again" line). */
  #reloadedIfChanged(path: string): void {
    const now = this.#devTreeHash(path);
    const before = this.#devHashes.get(path);
    this.#devHashes.set(path, now);
    if (now === undefined || before === undefined || now === before) return;
    const at = this.#now();
    this.#o.core.devFolders = this.#o.core.devFolders.map((d) => (d.path === path ? { ...d, lastReloadAt: at } : d));
    for (const fn of this.#devListeners) fn();
  }

  #devChanged(): void {
    this.#armExpiry();
    for (const fn of this.#devListeners) fn();
  }

  #armExpiry(): void {
    if (this.#expiry) clearTimeout(this.#expiry);
    const next = Math.min(...this.#o.core.devFolders.map((d) => d.expiresAt));
    if (!Number.isFinite(next)) return;
    const delay = Math.max(0, Math.min(next - this.#now(), 2 ** 31 - 1));
    this.#expiry = setTimeout(() => void this.expireDevFolders(), delay);
    this.#expiry.unref?.();
  }
}

/** A path with its symlinks resolved, or as given when it doesn't exist (yet, or any more). */
function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** A folder's files as they are now (each one's path, size and time), for the catch-up look: `node_modules` and `.git`
 *  aren't walked, links aren't followed, and it stops at `CATCH_UP_ENTRIES`. Empty when the folder isn't there. */
function fingerprint(folder: string): string {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= CATCH_UP_ENTRIES) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) { out.push(`${rel}${e.name}/`); walk(path, `${rel}${e.name}/`); continue; }
      try { const st = lstatSync(path); out.push(`${rel}${e.name}:${st.size}:${st.mtimeMs}`); } catch { /* gone meanwhile */ }
    }
  };
  walk(folder, "");
  return out.sort().join("\n");
}

function listDirs(dir: string): string[] {
  try {
    return folderReader(dir).listDirs("") as string[];
  } catch {
    return [];
  }
}

/** The line for an update that lets a tree reach the network where the tree the user OK'd, with tools that ran
 *  without asking (`readOnly` or `contained`), couldn't: what those tools were handed may sit in its data and store,
 *  and the network would let it send it. Empty otherwise. */
export function gainsNetworkLines(ok: OkSnapshot | undefined, now: readonly { capabilities: readonly string[]; networkHosts: readonly string[] }[]): string[] {
  if (ok === undefined) return [];
  const prints = Object.values(ok.plugins);
  const listed = prints.some((p) => {
    try {
      const runs = p.runs === "" ? {} : (JSON.parse(p.runs) as { readOnly?: unknown; contained?: unknown });
      return runs.readOnly !== undefined || runs.contained !== undefined;
    } catch {
      return false;
    }
  });
  const reached = (r: { capabilities: readonly string[]; networkHosts: readonly string[] }) => r.networkHosts.length > 0 || r.capabilities.some((c) => c.startsWith("network:"));
  if (!listed || prints.some(reached) || !now.some(reached)) return [];
  return ["This update lets it reach the network, which it couldn't when you OK'd the tools it runs without asking, so it could then send what its tools were given earlier."];
}
