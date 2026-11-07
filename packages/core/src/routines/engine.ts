// The routine engine (spec §7). Owner: lane D. It reads this computer's routine files, keeps them live, fires their
// triggers, and runs each fire in a side thread of the routine's bot (`BotService.runSideThread`), whose short result
// goes to the bot's main conversation on the computer running it (the host forwards it there, wherever that is).
//
// * **Live:** the files are read at start, on every change the folder watch sees, and once a minute besides. A new,
//   changed or deleted file takes effect at once. A file without an id gets one written into it.
// * **Once per fire:** only this computer fires its own files. Two files here with one id: the first by path runs, the
//   rest are `duplicate` and paused (the user is asked; lane H's synced list adds other computers' copies).
// * **Time zones:** a schedule runs in the routine's zone, else the user's (zone.ts), never the computer's.
// * **Missed runs:** each schedule remembers its last fire. At start (and on a wake), the fires missed while the
//   computer was off run once now (`missed: run-once`, the default) or are recorded `missed` (`skip`).
// * **Levels** (§7 "Each routine has its own approval level"): a routine runs at its computer's level unless its file
//   sets one. A level at or below the computer's applies at once. One above it waits for the user's OK on a sealed
//   change card (`routine-level`); the OK is bound to the file's hash, its bot, its place and this computer, so any
//   edit, a move or a copy (to another bot or another name) drops it back to the computer's level until a new OK. A webhook routine's card says anyone with the URL can start it.
// * **Webhooks:** the key lives in the credential store (`routine-webhook:<id>`), never in the file, and a payload
//   reaches the bot labelled as untrusted outside content. A payload the forwarder held while this computer was off
//   is a missed run, and the missed-run rule decides.
// * **States** (`RoutineView.state`): `bot-removed` while its bot isn't installed, `paused` while its file says so (a
//   routine carried over from an earlier install waits for review, §12), `duplicate`, `waiting-for-ok`, else `active`.
// * Runs are kept per routine in `<home>/transcripts/routines/runs/<id>.ndjson`, newest last; the engine's own state
//   (last fires, last runs) in `<home>/transcripts/routines/state.json`; the OKs with the core's settings, in the fenced
//   set (`<home>/settings/routine-oks.json`), so a bot can't approve its own raise.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, writeSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { isAnyPluginId, levelAbove, pluginIdFromSegment, type Level, type RoutineRunView, type RoutineView } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { SecretStore } from "../contracts/secret-store";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { botSegment, transcriptsDir } from "../sessions/ids";
import type { SideThreadRun } from "../bots/service";
import { settingsDir } from "../bots/gate";
import { readOwnFile } from "../bots/own-file";
import { parseRoutine, routineHash, triggerSummary, withId, ROUTINE_FILE_MAX_BYTES, type RoutineFile, type RoutineTrigger } from "./file";
import { firesBetween, nextRunInZone } from "./zone";
import { isLate, untrusted, WEBHOOK_LATE_MS } from "../../../../plugins/clover/plugins/trigger-webhook/src/webhook";

export { untrusted, WEBHOOK_LATE_MS };

/** The longest a timer is set for; a later fire is re-armed when it comes due. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
export const RESCAN_MS = 60_000;
/** The largest webhook payload a run gets. */
export const WEBHOOK_PAYLOAD_MAX_BYTES = 256 * 1024;
export const RUNS_KEPT = 500;
/** How long a run delivery's id is remembered: longer than an ingress holds a delivery (the forwarder's 7 days). */
export const DELIVERIES_KEPT_MS = 8 * 24 * 60 * 60 * 1000;
export const DELIVERIES_KEPT_MAX = 50_000;

/** Replaces a file's text without writing through a link a bot put at its name: a new temporary file, created
 *  exclusively and not following a link, renamed over the name (review minor). */
function replaceFile(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export function routinesDir(home: string): string {
  return join(home, "routines");
}

export function routineFilePath(home: string, bot: string, name: string): string {
  return join(routinesDir(home), botSegment(bot), `${name}.md`);
}

export interface RoutineEngineOptions {
  home: string;
  /** This computer's name. */
  computer: string;
  clock: Clock;
  bots: {
    has(id: string): boolean;
    runSideThread(id: string, run: SideThreadRun): Promise<RoutineRunView>;
    onEvent?(fn: (event: { type: string }) => void): Unsubscribe;
  };
  /** This computer's approval level (lane J's registry). */
  computerLevel(): Level;
  /** The user's time zone (an account setting); `UTC` until there is one. */
  userTimeZone?(): string;
  /** Shows the raise's card (lane C's broker); without it a raised level never applies. */
  approvals?: Pick<ApprovalBroker, "request">;
  secrets?: Pick<SecretStore, "get" | "set" | "delete">;
  /** Where the forwarder takes webhooks (lane I): `<base>/<routine>` is a routine's URL. */
  webhookBase?: string;
  /** Lane B's plugin triggers (`triggers` point): arms another type for a routine, and disarms it. */
  pluginTriggers?: {
    arm(type: string, routine: string, fields: Record<string, unknown>): Promise<void>;
    disarm(type: string, routine: string): Promise<void>;
  };
  /** Watches the folder for changes; tests turn it off and call `rescan`. */
  watchFiles?: boolean;
  /** Registers a webhook routine with the `webhook.ingress` plugins (webhooks.ts) and gives back its URL. */
  /** The plugins whose active `triggers` entry has this type: the ones that may fire it (`fire`). */
  triggerOwners?(type: string): string[];
  /** Registers a webhook routine with its ingress (its trigger's named one, else the first), giving its URL. */
  registerWebhook?(id: string, key: string, ingress?: string): Promise<string>;
  warn?: (message: string) => void;
}

interface Loaded {
  routine: RoutineFile;
  bot: string;
  path: string;
  hash: string;
  state: RoutineView["state"];
  /** The level its runs get now. */
  level: Level;
  timers: TimerHandle[];
  nextRunAt?: number;
}

interface EngineState {
  /** By routine and trigger key: the last fire. */
  fires: Record<string, number>;
  lastRunAt: Record<string, number>;
  /** The webhook deliveries already run, `<ingress plugin>:<delivery id>` to when (review S1): kept for
   *  `DELIVERIES_KEPT_MS`, longer than an ingress holds one, and at most `DELIVERIES_KEPT_MAX`, oldest first out. */
  deliveries?: Record<string, number>;
  /** The routines whose webhook key the user has been shown (`routine.webhookKey` shows it once). */
  keysShown?: Record<string, number>;
}

interface RoutineOk {
  hash: string;
  computer: string;
  /** The bot and the file the user said yes to (review B1): the same text moved or copied to another bot, or to
   *  another file, needs its own OK. */
  bot: string;
  /** Its path inside the routines folder, `<bot>/<name>.md`. */
  file: string;
  level: Level;
  cardId?: string;
}

const triggerKey = (id: string, i: number) => `${id}#${i}`;
const isEnded = (outcome: RoutineRunView["outcome"]) => outcome !== "running";

export class RoutineEngine {
  readonly #o: RoutineEngineOptions;
  readonly #loaded = new Map<string, Loaded>();
  readonly #running = new Set<string>();
  readonly #asking = new Set<string>();
  readonly #changes = new Listeners<{ bot?: string }>();
  #state: EngineState;
  #watcher: FSWatcher | undefined;
  #rescan: TimerHandle | undefined;
  #debounce: TimerHandle | undefined;
  #offBots: Unsubscribe | undefined;
  #started = false;

  constructor(opts: RoutineEngineOptions) {
    this.#o = opts;
    const saved = readJson(this.#stateFile()) as Partial<EngineState> | undefined;
    const deliveries = saved?.deliveries !== null && typeof saved?.deliveries === "object" && !Array.isArray(saved.deliveries) ? saved.deliveries : {};
    this.#state = { fires: { ...(saved?.fires ?? {}) }, lastRunAt: { ...(saved?.lastRunAt ?? {}) }, deliveries: { ...deliveries }, keysShown: { ...(saved?.keysShown ?? {}) } };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    mkdirSync(routinesDir(this.#o.home), { recursive: true });
    await this.rescan({ catchUp: true });
    if (this.#o.watchFiles !== false) {
      try {
        this.#watcher = watch(routinesDir(this.#o.home), { recursive: true }, () => this.#soon());
      } catch (err) {
        this.#warn(`the routines folder isn't watched (${err instanceof Error ? err.message : String(err)}); it is read once a minute`);
      }
    }
    const tick = () => {
      this.#rescan = this.#o.clock.setTimeout(() => {
        void this.rescan().finally(tick);
      }, RESCAN_MS);
    };
    tick();
    this.#offBots = this.#o.bots.onEvent?.((e) => {
      if (e.type === "bot_changed" || e.type === "bot_removed") this.#soon();
    });
  }

  stop(): void {
    this.#watcher?.close();
    if (this.#rescan) this.#o.clock.clearTimeout(this.#rescan);
    if (this.#debounce) this.#o.clock.clearTimeout(this.#debounce);
    this.#offBots?.();
    for (const l of this.#loaded.values()) this.#disarm(l);
    this.#started = false;
  }

  /** The computer woke from sleep: the fires missed meanwhile follow the missed-run rule. */
  async wake(): Promise<void> {
    await this.rescan({ catchUp: true });
  }

  list(bot?: string): RoutineView[] {
    return [...this.#loaded.values()].filter((l) => bot === undefined || l.bot === bot).map((l) => this.#view(l));
  }

  get(id: string): RoutineView | undefined {
    const l = this.#loaded.get(id);
    return l ? this.#view(l) : undefined;
  }

  /** A routine's runs, newest first. */
  runs(id: string, opts: { before?: number; limit?: number } = {}): { runs: RoutineRunView[]; next?: number } {
    const all = this.#readRuns(id).reverse();
    const start = opts.before ?? 0;
    const limit = opts.limit ?? 50;
    const page = all.slice(start, start + limit);
    return { runs: page, ...(start + limit < all.length ? { next: start + limit } : {}) };
  }

  watch(fn: (change: { bot?: string }) => void): Unsubscribe {
    return this.#changes.add(fn);
  }

  /** `routine.runNow`: runs it now; resolves with the side thread's id as the run starts. */
  async runNow(id: string): Promise<string> {
    const l = this.#must(id);
    if (l.state !== "active") throw new ContractError("refused", `the routine ${id} is ${l.state}`);
    return new Promise((resolve, reject) => {
      void this.#run(l, "the user", undefined, resolve).then((run) => {
        if (run.outcome === "skipped") reject(new ContractError("refused", run.summary ?? "the run was skipped"));
      }, reject);
    });
  }

  /** The routine's webhook URL and key, minting the key the first time, or a new one with `rotate` (the old one stops
   *  working once the ingress has the new key's hash). The `Routine` tool hands back the URL only. */
  async webhook(id: string, opts: { rotate?: boolean } = {}): Promise<{ url: string; key: string }> {
    const l = this.#must(id);
    const trigger = l.routine.triggers.find((t): t is Extract<RoutineTrigger, { type: "webhook" }> => t.type === "webhook");
    if (trigger === undefined) throw new ContractError("invalid", `the routine ${id} has no webhook trigger`);
    if (!this.#o.secrets) throw new ContractError("refused", "no credential store holds webhook keys here");
    const ref = { owner: { kind: "core" as const }, name: `routine-webhook:${id}` };
    let key = opts.rotate ? undefined : (await this.#o.secrets.get(ref))?.value.reveal();
    if (key === undefined) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      key = Buffer.from(bytes).toString("base64url");
      await this.#o.secrets.set(ref, key);
    }
    const url = this.#o.registerWebhook === undefined
      ? `${(this.#o.webhookBase ?? "https://hooks.waifucave.com").replace(/\/+$/, "")}/${id}`
      : await this.#o.registerWebhook(id, key, trigger.ingress);
    return { url, key };
  }

  /** `routine.webhookKey`, the user's only: the key is shown once; after that only a new one (`rotate`) is shown. */
  async revealWebhookKey(id: string, opts: { rotate?: boolean } = {}): Promise<{ url: string; key: string }> {
    const shown = (this.#state.keysShown ??= {});
    if (shown[id] !== undefined && !opts.rotate) throw new ContractError("refused", `the key of ${id} was shown once already; ask for a new one (rotate) to see a key again`);
    const out = await this.webhook(id, opts);
    shown[id] = this.#o.clock.now();
    this.#saveState();
    return out;
  }

  /** The routines here with a webhook trigger, each with the ingress its trigger names (the ingress registers each,
   *  and again when the name changes). */
  webhookRoutines(): { id: string; ingress?: string }[] {
    const out: { id: string; ingress?: string }[] = [];
    for (const [key, l] of this.#loaded) {
      if (key.includes("@") || l.state !== "active") continue;
      const t = l.routine.triggers.find((x): x is Extract<RoutineTrigger, { type: "webhook" }> => x.type === "webhook");
      if (t !== undefined) out.push({ id: key, ...(t.ingress === undefined ? {} : { ingress: t.ingress }) });
    }
    return out;
  }

  /** A delivery an ingress plugin took (its service checked the key's hash): run once per delivery id, with the
   *  missed-run rule for one held while this computer was away. */
  async deliverWebhook(d: { ingress: string; id: string; routine: string; receivedAt: number; body: string; contentType?: string }): Promise<"accepted" | "refused" | "missed" | "duplicate"> {
    const l = this.#loaded.get(d.routine);
    if (!l || l.state !== "active" || !l.routine.triggers.some((t) => t.type === "webhook")) return "refused";
    const seen = (this.#state.deliveries ??= {});
    const key = `${d.ingress}:${d.id}`;
    if (seen[key] !== undefined) return "duplicate";
    const now = this.#o.clock.now();
    seen[key] = now;
    const kept = Object.entries(seen).filter(([, at]) => now - at <= DELIVERIES_KEPT_MS).sort((a, b) => a[1] - b[1]).slice(-DELIVERIES_KEPT_MAX);
    if (kept.length !== Object.keys(seen).length) this.#state.deliveries = Object.fromEntries(kept);
    this.#saveState();
    if (isLate(d.receivedAt, this.#o.clock.now()) && l.routine.missed === "skip") {
      this.#record(l, { outcome: "missed", summary: "A webhook that arrived while this computer was away; the routine skips missed runs." });
      return "missed";
    }
    const body = Buffer.byteLength(d.body) > WEBHOOK_PAYLOAD_MAX_BYTES ? `${Buffer.from(d.body).subarray(0, WEBHOOK_PAYLOAD_MAX_BYTES).toString("utf8")}\n[cut at ${WEBHOOK_PAYLOAD_MAX_BYTES} bytes]` : d.body;
    void this.#run(l, "a webhook", untrusted("a webhook", body, d.contentType));
    return "accepted";
  }

  /** A webhook arrived for a routine here (lane I's forwarder, through the `webhook.ingress` point). */
  async receiveWebhook(w: { routine: string; key: string; body: string; contentType?: string; receivedAt?: number }): Promise<"accepted" | "refused" | "missed"> {
    const l = this.#loaded.get(w.routine);
    if (!l || !l.routine.triggers.some((t) => t.type === "webhook") || !this.#o.secrets) return "refused";
    const stored = (await this.#o.secrets.get({ owner: { kind: "core" }, name: `routine-webhook:${w.routine}` }))?.value.reveal();
    if (stored === undefined || !sameKey(stored, w.key)) return "refused";
    if (l.state !== "active") return "refused";
    const late = w.receivedAt !== undefined && isLate(w.receivedAt, this.#o.clock.now());
    if (late && l.routine.missed === "skip") {
      this.#record(l, { outcome: "missed", summary: "A webhook that arrived while this computer was off; the routine skips missed runs." });
      return "missed";
    }
    const body = Buffer.byteLength(w.body) > WEBHOOK_PAYLOAD_MAX_BYTES ? `${Buffer.from(w.body).subarray(0, WEBHOOK_PAYLOAD_MAX_BYTES).toString("utf8")}\n[cut at ${WEBHOOK_PAYLOAD_MAX_BYTES} bytes]` : w.body;
    void this.#run(l, "a webhook", untrusted("a webhook", body, w.contentType));
    return "accepted";
  }

  /** A plugin trigger fired (lane B's API, for the plugin that armed it). */
  /** A plugin's trigger fired a routine. Only a plugin that contributes that trigger type (an active `triggers`
   *  entry, `triggerOwners`) fires it; the bundled schedule and webhook types are the core's own, never fired so. */
  async fire(id: string, type: string, from: { pluginId: string }, payload?: string): Promise<void> {
    if (type === "schedule" || type === "webhook") throw new ContractError("refused", `${type} triggers are the core's own; no plugin fires them`);
    const owners = this.#o.triggerOwners?.(type) ?? [];
    if (!owners.includes(from.pluginId)) throw new ContractError("refused", `${from.pluginId} doesn't contribute the ${type} trigger, so it can't fire it`);
    const l = this.#must(id);
    if (!l.routine.triggers.some((t) => t.type === type)) throw new ContractError("refused", `the routine ${id} has no ${type} trigger`);
    if (l.state !== "active") return;
    await this.#run(l, `its ${type} trigger`, payload === undefined ? undefined : untrusted(`the ${type} trigger`, payload));
  }

  /** Reads every file again. With `catchUp`, missed fires follow the missed-run rule. */
  async rescan(opts: { catchUp?: boolean } = {}): Promise<void> {
    const found = this.#readFiles();
    const seen = new Set<string>();
    const changedBots = new Set<string>();
    for (const f of found) {
      if (seen.has(f.routine.id)) {
        const dup: Loaded = { ...f, state: "duplicate", level: this.#o.computerLevel(), timers: [] };
        const key = `${f.routine.id}@${f.path}`;
        if (!this.#loaded.has(key)) this.#warn(`${f.path} has the id ${f.routine.id}, which another routine file here has; it is paused until the user chooses one`);
        this.#loaded.set(key, dup);
        continue;
      }
      seen.add(f.routine.id);
      const before = this.#loaded.get(f.routine.id);
      if (before && before.hash === f.hash && before.path === f.path && before.state === this.#stateOf(f) && before.level === this.#levelOf(f)) continue;
      if (before) this.#disarm(before);
      const l: Loaded = { ...f, state: this.#stateOf(f), level: this.#levelOf(f), timers: [] };
      this.#loaded.set(f.routine.id, l);
      changedBots.add(l.bot);
      if (l.state === "waiting-for-ok") void this.#askForRaise(l);
      if (l.state === "active") await this.#arm(l, opts.catchUp === true || before === undefined);
    }
    for (const [key, l] of [...this.#loaded]) {
      const id = key.includes("@") ? key.slice(0, key.indexOf("@")) : key;
      const stillThere = key.includes("@") ? found.some((f) => f.path === l.path && f.routine.id === id) : seen.has(key) && this.#loaded.get(key) === l;
      if (!stillThere) {
        this.#disarm(l);
        this.#loaded.delete(key);
        changedBots.add(l.bot);
      }
    }
    for (const bot of changedBots) this.#changes.emit({ bot });
  }

  // ---------------------------------------------------------------------------------------------

  #must(id: string): Loaded {
    const l = this.#loaded.get(id);
    if (!l) throw new ContractError("not_found", `no routine ${id} on this computer`);
    return l;
  }

  #warn(message: string): void {
    this.#o.warn?.(message);
  }

  #soon(): void {
    if (this.#debounce) this.#o.clock.clearTimeout(this.#debounce);
    this.#debounce = this.#o.clock.setTimeout(() => {
      this.#debounce = undefined;
      void this.rescan();
    }, 200);
  }

  #readFiles(): { routine: RoutineFile; bot: string; path: string; hash: string }[] {
    const root = routinesDir(this.#o.home);
    if (!existsSync(root)) return [];
    const out: { routine: RoutineFile; bot: string; path: string; hash: string }[] = [];
    for (const folder of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!folder.isDirectory()) continue;
      const bot = pluginIdFromSegment(folder.name);
      if (!isAnyPluginId(bot) || botSegment(bot) !== folder.name) continue;
      for (const file of readdirSync(join(root, folder.name)).filter((n) => n.endsWith(".md")).sort()) {
        const path = join(root, folder.name, file);
        try {
          // Never through a link the bot left (toward another bot's routine or data, the fence review): the folder and
          // the file are read as the bot's own, from the Clover home down.
          const read = readOwnFile(this.#o.home, path, { maxBytes: ROUTINE_FILE_MAX_BYTES, whole: true });
          if (!read.ok) {
            if (read.why === "too-large") this.#warn(`${path} is larger than ${ROUTINE_FILE_MAX_BYTES} bytes; it isn't loaded`);
            else if (read.why === "link" || read.why === "moved") this.#warn(`${path} is a link, or under one; it isn't loaded`);
            continue;
          }
          let text = read.data.toString("utf8");
          const parsed = parseRoutine(text, basename(file, ".md"));
          if (!parsed.ok) {
            this.#warn(`${path} isn't loaded: ${parsed.reason}`);
            continue;
          }
          if (parsed.minted) {
            text = withId(text, parsed.routine.id);
            replaceFile(path, text);
          }
          out.push({ routine: parsed.routine, bot, path, hash: routineHash(text) });
        } catch (err) {
          this.#warn(`${path} isn't loaded: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return out;
  }

  #stateOf(f: { routine: RoutineFile; bot: string; path: string; hash: string }): RoutineView["state"] {
    if (!this.#o.bots.has(f.bot)) return "bot-removed";
    if (f.routine.paused) return "paused";
    const want = f.routine.level;
    if (want !== undefined && levelAbove(want, this.#o.computerLevel()) && !this.#hasOk(f, want)) return "waiting-for-ok";
    return "active";
  }

  #levelOf(f: { routine: RoutineFile; bot: string; path: string; hash: string }): Level {
    const computer = this.#o.computerLevel();
    const want = f.routine.level;
    if (want === undefined) return computer;
    if (!levelAbove(want, computer)) return want;
    return this.#hasOk(f, want) ? want : computer;
  }

  #oksFile(): string {
    return join(settingsDir(this.#o.home), "routine-oks.json");
  }

  #oks(): Record<string, RoutineOk> {
    return ((readJson(this.#oksFile()) as Record<string, RoutineOk> | undefined) ?? {});
  }

  /** The file's place in the routines folder, as an OK names it. */
  #okFile(path: string): string {
    return relative(routinesDir(this.#o.home), path).split(sep).join("/");
  }

  #hasOk(f: { routine: RoutineFile; bot: string; path: string; hash: string }, level: Level): boolean {
    const ok = this.#oks()[f.routine.id];
    return ok !== undefined && ok.hash === f.hash && ok.computer === this.#o.computer && ok.level === level
      && ok.bot === f.bot && ok.file === this.#okFile(f.path);
  }

  async #askForRaise(l: Loaded): Promise<void> {
    const approvals = this.#o.approvals;
    const level = l.routine.level;
    const asking = `${l.routine.id}:${l.hash}:${l.bot}:${this.#okFile(l.path)}`;
    if (!approvals || level === undefined || this.#asking.has(asking)) return;
    this.#asking.add(asking);
    try {
      const webhook = l.routine.triggers.some((t) => t.type === "webhook");
      const decision = await approvals.request({
        kind: "change", change: "routine-level", bot: l.bot, origin: "routine", computers: [this.#o.computer], effect: "other",
        fields: {
          title: { type: "text", text: `Let "${l.routine.name}" run at ${level}?` },
          what: { type: "text", text: `The routine asks to run at ${level}, above this computer's level (${this.#o.computerLevel()}).${webhook ? " Anyone with its webhook URL can start it." : ""}` },
          computer: { type: "text", text: this.#o.computer },
          command: { type: "code", code: l.routine.body.slice(0, 64_000), language: "markdown" },
        },
      });
      if (!decision.allowed || decision.by !== "card") return;
      const oks = this.#oks();
      oks[l.routine.id] = { hash: l.hash, computer: this.#o.computer, bot: l.bot, file: this.#okFile(l.path), level, ...(decision.cardId === undefined ? {} : { cardId: decision.cardId }) };
      writeJsonAtomic(this.#oksFile(), oks);
      await this.rescan();
    } catch (err) {
      this.#warn(`the card for ${l.routine.id}'s level wasn't shown: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#asking.delete(asking);
    }
  }

  #timeZone(r: RoutineFile): string {
    return r.timezone ?? this.#o.userTimeZone?.() ?? "UTC";
  }

  async #arm(l: Loaded, catchUp: boolean): Promise<void> {
    const now = this.#o.clock.now();
    const tz = this.#timeZone(l.routine);
    let missed = 0;
    let next: number | undefined;
    for (const [i, t] of l.routine.triggers.entries()) {
      if (t.type === "schedule" && "parsed" in t) {
        const key = triggerKey(l.routine.id, i);
        const last = this.#state.fires[key];
        if (last === undefined) this.#setFire(key, now);
        else if (catchUp) missed += firesBetween(t.parsed, last, now, tz, 1).length;
        // An interval counts from its last fire; a cron from now, in the routine's zone. A fire already due (missed,
        // and handled above) isn't fired again by the timer.
        const due = t.parsed.kind === "interval" ? (last ?? now) + t.parsed.ms : nextRunInZone(t.parsed, now, tz);
        const at = due <= now && t.parsed.kind === "interval" ? now + t.parsed.ms : due;
        next = next === undefined ? at : Math.min(next, at);
        this.#schedule(l, i, t, at);
      } else if (t.type !== "webhook" && "fields" in t) {
        try {
          await this.#o.pluginTriggers?.arm(t.type, l.routine.id, t.fields);
        } catch (err) {
          this.#warn(`${l.routine.id}'s ${t.type} trigger wasn't armed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (next === undefined) delete l.nextRunAt;
    else l.nextRunAt = next;
    if (missed > 0) {
      for (const [i, t] of l.routine.triggers.entries()) if (t.type === "schedule") this.#setFire(triggerKey(l.routine.id, i), now);
      if (l.routine.missed === "run-once") void this.#run(l, "its schedule, for the runs missed while this computer was off");
      else this.#record(l, { outcome: "missed", summary: `${missed === 1 ? "A run was" : "Runs were"} missed while this computer was off; the routine skips missed runs.` });
    }
  }

  #schedule(l: Loaded, i: number, t: RoutineTrigger & { type: "schedule" }, at: number): void {
    const delay = Math.max(0, at - this.#o.clock.now());
    const timer = this.#o.clock.setTimeout(() => {
      l.timers = l.timers.filter((x) => x !== timer);
      if (this.#loaded.get(l.routine.id) !== l) return;
      if (delay > MAX_TIMER_MS) {
        this.#schedule(l, i, t, at);
        return;
      }
      this.#setFire(triggerKey(l.routine.id, i), at);
      const tz = this.#timeZone(l.routine);
      const next = "parsed" in t ? nextRunInZone(t.parsed, at, tz) : at;
      l.nextRunAt = next;
      this.#schedule(l, i, t, next);
      void this.#run(l, "its schedule");
    }, Math.min(delay, MAX_TIMER_MS));
    l.timers.push(timer);
  }

  #disarm(l: Loaded): void {
    for (const t of l.timers) this.#o.clock.clearTimeout(t);
    l.timers = [];
    for (const t of l.routine.triggers) {
      if (t.type !== "schedule" && t.type !== "webhook") void this.#o.pluginTriggers?.disarm(t.type, l.routine.id).catch(() => {});
    }
  }

  #setFire(key: string, at: number): void {
    this.#state.fires[key] = at;
    this.#saveState();
  }

  #stateFile(): string {
    return join(transcriptsDir(this.#o.home), "routines", "state.json");
  }

  #saveState(): void {
    try {
      writeJsonAtomic(this.#stateFile(), this.#state);
    } catch (err) {
      this.#warn(`the routines' state wasn't saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #run(l: Loaded, why: string, extra?: string, onSession?: (id: string) => void): Promise<RoutineRunView> {
    const id = l.routine.id;
    if (this.#running.has(id)) return this.#record(l, { outcome: "skipped", summary: `Fired by ${why} while its last run was still going.` });
    this.#running.add(id);
    try {
      const run = await this.#o.bots.runSideThread(l.bot, {
        routine: id, name: l.routine.name, text: extra === undefined ? l.routine.body : `${l.routine.body.trimEnd()}\n\n${extra}`,
        computer: this.#o.computer, level: l.level, ...(onSession === undefined ? {} : { onSession }),
      });
      this.#state.lastRunAt[id] = run.startedAt;
      this.#saveState();
      this.#appendRun(id, run);
      this.#changes.emit({ bot: l.bot });
      // TODO(B-M2): send the result to the notifier plugins (kind "routine-result", `failed: run.outcome === "failed"`)
      // once lane B's plugin host (B-M2) carries the core's notifier calls. No core path reaches notifiers on main yet,
      // so until then no routine result reaches a notifier at all, failed or not.
      return run;
    } catch (err) {
      return this.#record(l, { outcome: "skipped", summary: `It didn't run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 4000) });
    } finally {
      this.#running.delete(id);
    }
  }

  #record(l: Loaded, r: { outcome: RoutineRunView["outcome"]; summary: string }): RoutineRunView {
    const now = this.#o.clock.now();
    const run: RoutineRunView = { routine: l.routine.id, session: "none", startedAt: now, endedAt: now, outcome: r.outcome, summary: r.summary };
    if (!isEnded(run.outcome)) return run;
    this.#appendRun(l.routine.id, run);
    this.#changes.emit({ bot: l.bot });
    return run;
  }

  #runsFile(id: string): string {
    return join(transcriptsDir(this.#o.home), "routines", "runs", `${id}.ndjson`);
  }

  #appendRun(id: string, run: RoutineRunView): void {
    try {
      mkdirSync(join(transcriptsDir(this.#o.home), "routines", "runs"), { recursive: true });
      appendFileSync(this.#runsFile(id), `${JSON.stringify(run)}\n`);
      const all = this.#readRuns(id);
      if (all.length > RUNS_KEPT * 2) writeFileSync(this.#runsFile(id), `${all.slice(-RUNS_KEPT).map((r) => JSON.stringify(r)).join("\n")}\n`);
    } catch (err) {
      this.#warn(`${id}'s run wasn't recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #readRuns(id: string): RoutineRunView[] {
    if (!existsSync(this.#runsFile(id))) return [];
    const out: RoutineRunView[] = [];
    for (const line of readFileSync(this.#runsFile(id), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as RoutineRunView);
      } catch {
        // A torn last line is skipped.
      }
    }
    return out;
  }

  #view(l: Loaded): RoutineView {
    const last = this.#state.lastRunAt[l.routine.id];
    return {
      id: l.routine.id, name: l.routine.name.slice(0, 200), bot: l.bot, computer: this.#o.computer,
      file: `home/${this.#o.computer}/.clover/routines/${botSegment(l.bot)}/${basename(l.path)}`,
      triggers: l.routine.triggers.map(triggerSummary), level: l.level, state: l.state,
      ...(last === undefined ? {} : { lastRunAt: last }),
      ...(l.state === "active" && l.nextRunAt !== undefined ? { nextRunAt: l.nextRunAt } : {}),
    };
  }
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

