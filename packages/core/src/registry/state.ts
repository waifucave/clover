// The registry's own records (spec §5.1, §8.5; review S8), in the fenced `plugins-state/` folder of the Clover home:
// * `installed.json`: the synced list, in its order (which plugin keeps a clashing entry id or a namespace), with
//   each plugin's switch, source and who installed it, the tree hash last OK'd or refused, and development folders;
// * `oks/<id>.json`: what each OK'd tree held (`OkSnapshot`), so a later change can be told apart (§5.6);
// * `adult.json`: the user's confirmation that they are 18 or older (§5.7).
// A child's id names a file with `--` for its `/` (§5.1). Writes go through a temporary file and a rename.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginProvenance, PluginSource } from "@waifucave/clover-protocol";
import type { OkSnapshot } from "./changes";

export interface PluginState {
  /** The user's switch; absent until they set one. */
  enabled?: boolean;
  source?: PluginSource;
  provenance?: PluginProvenance;
  /** The tree hash the user last OK'd. */
  okHash?: string;
  /** The tree hash the user refused; it stays off until its folder changes. */
  refusedHash?: string;
  /** A card-styling change waits for its OK (§5.5). */
  cardHeld?: boolean;
}

export interface DevFolderState {
  path: string;
  /** Who added it: the user's own terminal, or the app (after its sealed card). */
  by: "cli" | "app";
  addedAt: number;
  /** It turns off after 24 hours unless renewed (§5.6). */
  expiresAt: number;
}

export interface RegistryStateFile {
  v: 1;
  /** Top-level ids and their children, in the synced list's order. */
  order: string[];
  plugins: Record<string, PluginState>;
  dev: DevFolderState[];
}

export interface RegistryStore {
  load(): RegistryStateFile;
  save(state: RegistryStateFile): void;
  loadOk(id: string): OkSnapshot | undefined;
  saveOk(id: string, snapshot: OkSnapshot | undefined): void;
  adultConfirmed(): boolean;
  confirmAdult(at: number): void;
}

export const emptyState = (): RegistryStateFile => ({ v: 1, order: [], plugins: {}, dev: [] });
const fileId = (id: string) => id.replace("/", "--");

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The records on disk, under `<cloverHome>/plugins-state/`. */
export function fileRegistryStore(stateDir: string): RegistryStore {
  const installed = join(stateDir, "installed.json");
  const ok = (id: string) => join(stateDir, "oks", `${fileId(id)}.json`);
  const adult = join(stateDir, "adult.json");
  return {
    load() {
      const s = readJson<RegistryStateFile>(installed);
      return s?.v === 1 ? { v: 1, order: s.order ?? [], plugins: s.plugins ?? {}, dev: s.dev ?? [] } : emptyState();
    },
    save(state) {
      writeAtomic(installed, `${JSON.stringify(state, null, 2)}\n`);
    },
    loadOk(id) {
      return readJson<OkSnapshot>(ok(id));
    },
    saveOk(id, snapshot) {
      if (snapshot === undefined) rmSync(ok(id), { force: true });
      else writeAtomic(ok(id), JSON.stringify(snapshot));
    },
    adultConfirmed() {
      return readJson<{ confirmedAt?: number }>(adult)?.confirmedAt !== undefined;
    },
    confirmAdult(at) {
      writeAtomic(adult, `${JSON.stringify({ confirmedAt: at })}\n`);
    },
  };
}

/** The records in memory, for tests. */
export function memoryRegistryStore(init: { adult?: boolean } = {}): RegistryStore & { state: RegistryStateFile; oks: Map<string, OkSnapshot> } {
  let adult = init.adult ?? false;
  const store = {
    state: emptyState(),
    oks: new Map<string, OkSnapshot>(),
    load: () => structuredClone(store.state),
    save: (s: RegistryStateFile) => void (store.state = structuredClone(s)),
    loadOk: (id: string) => store.oks.get(id),
    saveOk: (id: string, snap: OkSnapshot | undefined) => void (snap === undefined ? store.oks.delete(id) : store.oks.set(id, snap)),
    adultConfirmed: () => adult,
    confirmAdult: () => void (adult = true),
  };
  return store;
}
