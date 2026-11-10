// The state one acceptance run leaves for the next (`--keep-state <dir>` → `--upgrade-from <dir>`): the home, the
// user's home and the throwaway keychain FILE the first run made, at fixed places under the dir, and state.json with
// what the second run needs to find them again (the keychain service its items are under, the dummy key, the
// conversation, the plugin and the setting the first run left). The second run starts on the same paths, so nothing
// that names a path in the home moves. The dir holds no real key: the only key is the run's random dummy, for the fake
// provider, and state.json is the run's own (0600).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATE_FILE = "state.json";

export interface KeptState {
  v: 1;
  /** The tree (commit) or app that made the state, for the tables. */
  made: string;
  target: "source" | "packaged";
  /** The keychain service the run's items are under (`CLOVER_KEYCHAIN_SERVICE`). */
  service: string;
  /** The run's dummy model key (for the fake provider; never a real key). */
  key: string;
  /** The bot's main conversation the run talked in. */
  session?: string;
  /** The plugin the run installed from a folder and approved. */
  pluginId?: string;
  /** `notifications.needsYou` as the run left it (its Settings step flips it, and records what it set). */
  needsYou?: boolean;
  /** Why there is no `needsYou`: the old build's own Settings step didn't pass (its status and detail). Absent with
   *  no `needsYou`, the record is missing on the harness's side, and the upgrade step fails. */
  needsYouMissing?: string;
  /** Whether the run's app kept its answer key in the run's file (`CLOVER_TEST_ANSWER_KEY`; a build before it keeps
   *  it in memory only): an upgrade's app then registers the same key, and its cards are pressed for real. */
  answerKeyKept?: boolean;
}

/** Where the kept things live under the state dir. */
export function statePaths(dir: string): { home: string; user: string; keychain: string } {
  return { home: join(dir, "home"), user: join(dir, "user"), keychain: join(dir, "kc", "acceptance.keychain-db") };
}

/** The test app's kept answer key (`CLOVER_TEST_ANSWER_KEY`): a file beside the run's throwaway keychain file. */
export function answerKeyFileFor(keychain: string): string {
  return join(dirname(keychain), "answer-key");
}

/** The daemon's socket must fit a Unix socket path (104 bytes on macOS, with its NUL). */
export const SOCKET_PATH_MAX = 103;
export function socketPathProblem(home: string): string | undefined {
  const sock = join(home, "run", "core.sock");
  const len = Buffer.byteLength(sock);
  return len > SOCKET_PATH_MAX ? `the daemon's socket ${sock} would be ${len} bytes, more than a Unix socket path takes (${SOCKET_PATH_MAX}): use a shorter state dir (the wrapper makes one under the temp folder)` : undefined;
}

/** A dir `--keep-state` may fill: absent or empty. */
export function keepStateProblem(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).length > 0 ? `${dir} isn't empty: --keep-state fills a new or empty dir` : undefined;
}

export function writeState(dir: string, s: KeptState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  chmodSync(join(dir, STATE_FILE), 0o600);
}

/** The state a `--keep-state` run left, checked; throws with what is wrong. */
export function readState(dir: string): KeptState {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) throw new Error(`${file} isn't there: --upgrade-from takes a dir a --keep-state run left`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`${file} isn't JSON (${err instanceof Error ? err.message : String(err)})`); }
  const s = raw as Partial<KeptState> | null;
  if (s === null || typeof s !== "object" || s.v !== 1) throw new Error(`${file} isn't a v1 state file`);
  if (s.target !== "source" && s.target !== "packaged") throw new Error(`${file} names no target`);
  if (typeof s.service !== "string" || !/^com\.waifucave\.clover\.core\.test\./.test(s.service)) throw new Error(`${file}'s keychain service isn't a test service`);
  if (typeof s.key !== "string" || !s.key.startsWith("sk-ant-acceptance-dummy-")) throw new Error(`${file}'s key isn't the run's dummy`);
  if (typeof s.made !== "string") throw new Error(`${file} doesn't say what made it`);
  for (const k of ["session", "pluginId"] as const) if (s[k] !== undefined && typeof s[k] !== "string") throw new Error(`${file}'s ${k} isn't a string`);
  if (s.needsYou !== undefined && typeof s.needsYou !== "boolean") throw new Error(`${file}'s needsYou isn't a boolean`);
  if (s.needsYouMissing !== undefined && typeof s.needsYouMissing !== "string") throw new Error(`${file}'s needsYouMissing isn't a string`);
  if (s.answerKeyKept !== undefined && typeof s.answerKeyKept !== "boolean") throw new Error(`${file}'s answerKeyKept isn't a boolean`);
  const missing = Object.values(statePaths(dir)).filter((p) => !existsSync(p));
  if (missing.length > 0) throw new Error(`the state dir lacks ${missing.join(", ")}`);
  return s as KeptState;
}

/** The home's settings with Anthropic's endpoint set to this run's fake, everything else as the earlier build left it
 *  (an upgrade keeps the user's settings). A missing file starts empty; one that isn't a JSON object throws. */
export function settingsWithFake(existing: string | undefined, fakeUrl: string): string {
  let s: Record<string, unknown> = { schemaVersion: 1 };
  if (existing !== undefined && existing.trim() !== "") {
    const parsed = JSON.parse(existing) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json isn't a JSON object");
    s = parsed as Record<string, unknown>;
  }
  const providers = (typeof s.providers === "object" && s.providers !== null && !Array.isArray(s.providers) ? s.providers : {}) as Record<string, unknown>;
  const anthropic = (typeof providers.anthropic === "object" && providers.anthropic !== null && !Array.isArray(providers.anthropic) ? providers.anthropic : {}) as Record<string, unknown>;
  return `${JSON.stringify({ ...s, providers: { ...providers, anthropic: { ...anthropic, baseUrl: fakeUrl } } }, null, 2)}\n`;
}

/** The daemon's lines that say it distrusts state an earlier build signed (the registry's MAC, the device key). */
export const DISTRUST = /[^\n]*(?:was changed outside Clover|belongs to another device key|isn't trusted)[^\n]*/;
