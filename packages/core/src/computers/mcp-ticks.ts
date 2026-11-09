// Which local MCP servers run on this computer (spec §9.1, "Plugin folders still sync to every computer… a local
// server inside a plugin runs only on the computers ticked for it, and Mirror ticks the rest"; the controller's
// ruling on J-M2's default). Each computer keeps its own ticks, never synced, in the fenced `levels/` folder (as its
// level is), so a bot can't tick a server onto a computer:
//
// * **Installed here:** the plugin install flow, after the plugin's OK card's yes on this computer, ticks every local
//   server of that plugin here (`installed(plugin)`). A synced copy that arrives on another computer never runs that
//   flow, so it isn't ticked there.
// * **Mirror** ticks one server on the computer it installs on, after that computer's own card (`set(server, true)`).
// * **Untick:** the user takes a server off this computer (`set(server, false)`), which wins over the plugin's tick.
// * **The one-time migration:** while this file doesn't exist, the first listing of the local servers installed here
//   that has any is ticked (`adopt`: a snapshot, so a plugin synced in later in that run isn't ticked), and that
//   writes the file; so plugins installed before ticks existed keep running. A run that never lists one (the host
//   still loading) writes nothing, and the next run adopts. Once the file exists, only the three ways above tick.
//   The listing is the installed plugins' declared local servers (lane A, from the registry), never the running ones.
// * **A `levels/` that can't be written** never stops the node: the reason is logged, nothing is adopted, and what
//   isn't on record is unticked; a tick that can't be saved throws to its caller (the install flow, Mirror, the user).
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `<Clover home>/levels/mcp-servers.json`. */
export function mcpTicksPath(cloverHome: string): string {
  return join(cloverHome, "levels", "mcp-servers.json");
}

/** The most entries each list keeps. */
const MAX_ENTRIES = 4096;

interface TicksFile {
  /** Plugins whose install flow ran here: their local servers are ticked here. */
  plugins: Record<string, true>;
  /** A server ticked or unticked on its own (Mirror, the user): wins over its plugin's tick. */
  servers: Record<string, boolean>;
}

export interface McpTicks {
  /** Whether `server` (of `plugin`) runs on this computer. */
  ticked(server: string, plugin: string): boolean;
  /** The one-time migration (only while there's no record yet): ticks `servers`, the first listing with any, once.
   *  Answers whether it ticked anything. */
  adopt?(servers: readonly { server: string; plugin: string }[]): boolean;
  /** The plugin install flow ran here (after its OK card's yes): its local servers run here. */
  installed(plugin: string): void;
  /** Mirror (`true`) or the user's untick (`false`), for one server. */
  set(server: string, on: boolean): void;
}

export class FileMcpTicks implements McpTicks {
  readonly #path: string;
  #file: TicksFile = { plugins: {}, servers: {} };
  /** There's no file yet and no snapshot taken: `adopt` ticks the first listing with any. */
  #adopting: boolean;
  readonly #onChange: () => void;

  /** `onChange`: told after `installed` or `set` changed something (the node tells the other computers itself).
   *  `log`: where a record that can't be written is reported. */
  constructor(path: string, onChange: () => void = () => {}, log: (line: string) => void = () => {}) {
    this.#path = path;
    this.#onChange = onChange;
    this.#adopting = !existsSync(path);
    if (this.#adopting) {
      // Not written yet (the snapshot writes it); only checked that it can be.
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        accessSync(dirname(path), constants.W_OK);
      } catch (e) {
        log(`MCP ticks: ${path} can't be written (${e instanceof Error ? e.message : String(e)}); local MCP servers stay unticked here`);
        this.#adopting = false;
      }
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TicksFile>;
      const plugins = typeof raw.plugins === "object" && raw.plugins !== null ? raw.plugins : {};
      const servers = typeof raw.servers === "object" && raw.servers !== null ? raw.servers : {};
      for (const [k, v] of Object.entries(plugins)) if (v === true) this.#file.plugins[k] = true;
      for (const [k, v] of Object.entries(servers)) if (typeof v === "boolean") this.#file.servers[k] = v;
    } catch {
      // Unreadable: nothing is ticked until the install flow, Mirror or the user says (never all at once).
    }
  }

  ticked(server: string, plugin: string): boolean {
    const own = this.#file.servers[server];
    if (own !== undefined) return own;
    return this.#file.plugins[plugin] === true;
  }

  adopt(servers: readonly { server: string; plugin: string }[]): boolean {
    if (!this.#adopting || servers.length === 0) return false;
    this.#adopting = false;
    let ticked = false;
    for (const { server } of servers.slice(0, MAX_ENTRIES)) {
      if (this.#file.servers[server] === undefined) {
        this.#file.servers[server] = true;
        ticked = true;
      }
    }
    try {
      this.#save();
    } catch {
      // Kept for this run; not on disk, so the next run adopts again (the same installs).
    }
    return ticked;
  }

  installed(plugin: string): void {
    if (this.#file.plugins[plugin] === true) return;
    // A tick before any listing is a record of its own: the migration is over.
    this.#adopting = false;
    if (Object.keys(this.#file.plugins).length >= MAX_ENTRIES) throw new Error("too many plugins ticked on this computer");
    this.#file.plugins[plugin] = true;
    this.#save();
    this.#onChange();
  }

  set(server: string, on: boolean): void {
    if (this.#file.servers[server] === on) return;
    this.#adopting = false;
    if (!(server in this.#file.servers) && Object.keys(this.#file.servers).length >= MAX_ENTRIES) throw new Error("too many servers ticked on this computer");
    this.#file.servers[server] = on;
    this.#save();
    this.#onChange();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
