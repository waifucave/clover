// The registry's own records (spec §5.1, §8.5; review S8), in the fenced `plugins-state/` folder of the Clover home:
// * `installed.json`: the synced list, in its order (which plugin keeps a clashing entry id or a namespace), with
//   each plugin's switch, source and who installed it, the tree hash last OK'd or refused, and development folders;
// * `oks/<id>.json`: what each OK'd tree held (`OkSnapshot`), so a later change can be told apart (§5.6);
// * `adult.json`: the user's confirmation that they are 18 or older (§5.7).
// A child's id names a file with `--` for its `/` (§5.1). Writes go through a temporary file and a rename.
//
// The fence keeps sessions out of `plugins-state/`; past it (#197's review), each file is schema-checked and, with a key
// from the secret store, carries an HMAC-SHA256 over its name, its write counter and its body. The counters live in the
// secret store too (#197's check 2), so an edit made outside the registry, a file copied over another, or an older copy
// put back all fail closed: the records read as empty (every plugin asks for its OK again) and the adult confirmation
// as not given.
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { PluginProvenance as PluginProvenanceSchema, PluginSource as PluginSourceSchema, type PluginProvenance, type PluginSource } from "@waifucave/clover-protocol";
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

const StoredPlugin = z.object({
  enabled: z.boolean().optional(),
  source: PluginSourceSchema.optional(),
  provenance: PluginProvenanceSchema.optional(),
  okHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  refusedHash: z.string().optional(),
  cardHeld: z.boolean().optional(),
});
const StateSchema = z.object({
  v: z.literal(1),
  order: z.array(z.string()),
  plugins: z.record(z.string(), StoredPlugin),
  dev: z.array(z.object({ path: z.string().min(1), by: z.enum(["cli", "app"]), addedAt: z.number(), expiresAt: z.number() })),
});
const Fingerprint = z.object({
  class: z.enum(["data", "web", "code"]), capabilities: z.array(z.string()), networkHosts: z.array(z.string()), helperPermissions: z.array(z.string()),
  hookEvents: z.array(z.string()), fetchesCode: z.array(z.string()), addons: z.boolean(), adult: z.boolean(), runs: z.string(), defaults: z.string(),
  reaches: z.string(), dynamicHosts: z.boolean(),
});
const OkSchema = z.object({
  okHash: z.string(),
  files: z.array(z.object({ path: z.string(), executable: z.boolean(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  plugins: z.record(z.string(), Fingerprint),
  cards: z.string(),
  codePaths: z.array(z.string()),
});
const AdultSchema = z.object({ confirmedAt: z.number() });

/** The file envelope: its body as written, and with a key, its write counter and the HMAC over both and its name. */
interface Envelope {
  body: string;
  gen?: number;
  mac?: string;
}

/** The records on disk, under `<cloverHome>/plugins-state/`. With `macKey` (32 bytes from the secret store) every file
 *  is signed, and one whose MAC doesn't verify, or that fails its schema, reads as absent (`onTampered` says which). */
export interface RegistryStoreOptions {
  /** 32 bytes from the secret store; required where the daemon opens the registry (`openPluginRegistry`). */
  macKey?: Uint8Array;
  /** Each file's write counter, by its name under `plugins-state/`, as the secret store last kept them. */
  counters?: Record<string, number>;
  /** The counters after a write, for the secret store. */
  onCounters?: (counters: Record<string, number>) => void;
  onTampered?: (file: string) => void;
}

export function fileRegistryStore(stateDir: string, opts: RegistryStoreOptions = {}): RegistryStore {
  const installed = join(stateDir, "installed.json");
  const ok = (id: string) => join(stateDir, "oks", `${fileId(id)}.json`);
  const adult = join(stateDir, "adult.json");
  const counters: Record<string, number> = { ...(opts.counters ?? {}) };
  const nameOf = (file: string) => relative(stateDir, file).split(sep).join("/");
  const mac = (name: string, gen: number, body: string) =>
    createHmac("sha256", opts.macKey!).update(`clover/plugin-registry/1\0${name}\0${gen}\0${body}`).digest("hex");
  const write = (file: string, value: unknown) => {
    const body = JSON.stringify(value);
    let env: Envelope = { body };
    if (opts.macKey) {
      const name = nameOf(file);
      const gen = (counters[name] ?? 0) + 1;
      counters[name] = gen;
      opts.onCounters?.({ ...counters });
      env = { body, gen, mac: mac(name, gen, body) };
    }
    writeAtomic(file, `${JSON.stringify(env)}\n`);
  };
  const read = <T>(file: string, schema: z.ZodType<T>): T | undefined => {
    const env = readJson<Envelope>(file);
    if (env === undefined) return undefined;
    const bad = () => (opts.onTampered?.(file), undefined);
    if (typeof env !== "object" || env === null || typeof env.body !== "string") return bad();
    if (opts.macKey) {
      const name = nameOf(file);
      // The counter the secret store kept for this name: an older copy put back has an older one.
      if (typeof env.gen !== "number" || env.gen !== counters[name]) return bad();
      const want = Buffer.from(mac(name, env.gen, env.body), "hex");
      const got = Buffer.from(typeof env.mac === "string" ? env.mac : "", "hex");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return bad();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.body);
    } catch {
      return bad();
    }
    const r = schema.safeParse(parsed);
    return r.success ? r.data : bad();
  };
  return {
    load() {
      return (read(installed, StateSchema) as RegistryStateFile | undefined) ?? emptyState();
    },
    save(state) {
      write(installed, state);
    },
    loadOk(id) {
      return read(ok(id), OkSchema) as OkSnapshot | undefined;
    },
    saveOk(id, snapshot) {
      if (snapshot === undefined) rmSync(ok(id), { force: true });
      else write(ok(id), snapshot);
    },
    adultConfirmed() {
      return read(adult, AdultSchema) !== undefined;
    },
    confirmAdult(at) {
      write(adult, { confirmedAt: at });
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
